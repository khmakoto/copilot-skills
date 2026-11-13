import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git } from "./fixtures.mjs";
import { dag, generatedCase, reference, seeds } from "./generated.mjs";
import { applyChange, normalizeChange } from "../lib/changes.mjs";
import { tree, checkoutClean } from "../lib/git.mjs";
import { digest } from "../lib/graph.mjs";
import { atomicJson, journalFile, readJson } from "../lib/state.mjs";

function specFor(f, seed) {
  const graph = dag(seed, 4);
  const ids = [...graph.nodes].map((n) => n.id).sort();
  const names = Object.fromEntries(ids.map((id, i) => [id, f.spec.nodes[i].id]));
  f.spec.nodes = graph.nodes.map((n) => ({
    ...f.spec.nodes.find((node) => node.id === names[n.id]),
    dependencies: n.dependencies.map((id) => names[id]),
  }));
  if (seed % 3 !== 1) {
    for (const [i, id] of ["a", "b", "c", "d"].entries()) {
      f.spec.nodes.find((n) => n.id === id).dependencies =
        seed % 3 === 2 && i ? [["a", "b", "c"][i - 1]] : [];
    }
  }
  return f.spec;
}

function replay(f, spec, trailers) {
  const cwd = path.join(f.dir, "uncached");
  git(f.root, "worktree", "add", "--detach", cwd, "trunk");
  const target = git(f.root, "rev-parse", "trunk");
  const model = reference(spec);
  const nodes = spec.nodes.map((n) => ({ ...n, change: normalizeChange(f.root, n.change) }));
  const apply = (id) => {
    const node = nodes.find((n) => n.id === id);
    return applyChange(cwd, node.change, `${node.title}\n\n${trailers.join("\n")}`);
  };
  const snapshots = {};
  for (const id of model.order) {
    checkoutClean(cwd, target);
    for (const dep of model.closure(id)) apply(dep);
    const base = tree(cwd, "HEAD");
    const head = apply(id);
    snapshots[id] = { base, head: tree(cwd, head) };
  }
  checkoutClean(cwd, target);
  for (const id of model.order) apply(id);
  return { snapshots, combined: tree(cwd, "HEAD"),
    messages: git(cwd, "log", "--reverse", "--format=%B", `${target}..HEAD`) };
}

const cases = ["matching", "missing", "unknown-context", "context", "message", "target",
  "patch", "order", "invalid-receipt", "missing-pin", "missing-object", "validation", "conflict"];

for (const [index, kind] of cases.entries()) {
  test(`seeded retained reconstruction versus uncached replay: ${kind}`, (t) => {
    for (const key of ["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) {
      const previous = process.env[key];
      process.env[key] = "2020-01-01T00:00:00Z";
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    const seed = seeds(3)[index % seeds(3).length];
    const input = { kind, nodes: null };
    generatedCase(seed, input, () => {
      const cached = fixture({ names: ["a", "b", "c", "d"] });
      const baseline = fixture({ names: ["a", "b", "c", "d"] });
      t.after(() => cached.dispose());
      t.after(() => baseline.dispose());
      const trailers = ["Test-Recipe: differential"];
      const spec = specFor(cached, seed);
      const baselineSpec = specFor(baseline, seed);
      input.nodes = spec.nodes.map(({ id, dependencies }) => ({ id, dependencies }));
      const original = cached.apply("split", { spec, commitTrailers: trailers });
      const file = journalFile(cached.ctx, original.operation);
      const source = readJson(file);
      if (kind === "missing") {
        delete source.reconstructionReceipts;
        atomicJson(file, source);
      }
      if (["invalid-receipt", "missing-pin", "missing-object"].includes(kind)) {
        const [key, receipt] = Object.entries(source.reconstructionReceipts)[0];
        if (kind === "invalid-receipt") {
          receipt.tree = tree(cached.root, cached.base);
          atomicJson(file, source);
        } else if (kind === "missing-pin") {
          git(cached.root, "update-ref", "-d", `refs/pr-graph/${source.id}/commits/${key}`);
        } else {
          receipt.head = "f".repeat(40);
          receipt.tree = "f".repeat(40);
          atomicJson(file, source);
        }
        assert.throws(() => cached.apply("fold", {
          graph: "example", spec, commitTrailers: trailers, reuseWorktree: original.operation,
        }), kind === "invalid-receipt" ? /receipt no longer matches/ :
          kind === "missing-pin" ? /lost its source operation pin/ : /rev-parse failed/);
        assert.equal(readJson(file).worktreeReusedBy, undefined);
        for (const node of original.graph.nodes) {
          assert.equal(git(cached.root, "rev-parse", node.branch), node.head);
        }
        assert.equal(git(cached.root, "rev-parse", "HEAD"), cached.head);
        return;
      }
      for (const f of [cached, baseline]) {
        if (kind === "unknown-context") fs.mkdirSync(path.join(f.ctx.common, "hooks", "unknown-directory"));
        if (kind === "context") git(f.root, "config", "commit.cleanup", "verbatim");
        if (kind === "target") {
          git(f.root, "checkout", "trunk");
          fs.writeFileSync(path.join(f.root, "target.txt"), "advanced target\n");
          git(f.root, "add", "target.txt");
          git(f.root, "commit", "-qm", "advance target");
          git(f.root, "checkout", "source");
          delete f.spec.source;
        }
        if (kind === "message") {
          for (const node of f.spec.nodes) node.title += " revised";
        }
        if (kind === "patch") {
          const node = f.spec.nodes.find((n) => n.id === "a");
          git(f.root, "checkout", "--detach", node.change.head);
          fs.writeFileSync(path.join(f.root, "extra.txt"), "changed own patch\n");
          git(f.root, "add", "extra.txt");
          git(f.root, "commit", "-qm", "new own patch");
          node.change.head = git(f.root, "rev-parse", "HEAD");
          git(f.root, "checkout", "source");
          delete f.spec.source;
        }
        if (kind === "conflict") {
          git(f.root, "checkout", "--detach", f.base);
          fs.writeFileSync(path.join(f.root, "shared.txt"), f.text([]).replace("a=0", "a=2"));
          git(f.root, "add", "shared.txt");
          git(f.root, "commit", "-qm", "overlapping own patch");
          const node = f.spec.nodes.find((n) => n.id === "b");
          node.change = { base: f.base, head: git(f.root, "rev-parse", "HEAD") };
          node.dependencies = ["a"];
          git(f.root, "checkout", "source");
          delete f.spec.source;
        }
        if (kind === "order") {
          f.spec.nodes.find((n) => n.id === "b").dependencies = ["c"];
          f.spec.nodes.find((n) => n.id === "c").dependencies = ["a"];
        }
      }
      const options = {
        graph: "example", ...(kind === "target" ? {} : { spec }),
        commitTrailers: trailers, reuseWorktree: original.operation,
      };
      if (kind === "conflict" || kind === "validation") {
        if (kind === "conflict") {
          assert.throws(() => replay(baseline, baselineSpec, trailers), /Change conflict/);
        } else {
          spec.nodes.find((n) => n.id === "a").validations = [
            { command: process.execPath, args: ["-e", "process.exit(9)"] },
          ];
        }
        assert.throws(() => cached.apply("fold", options),
          kind === "conflict" ? /Change conflict/ : /Validation failed/);
        for (const node of original.graph.nodes) {
          assert.equal(git(cached.root, "rev-parse", node.branch), node.head);
        }
        assert.equal(git(cached.root, "rev-parse", "HEAD"), cached.head);
        return;
      }
      const expected = replay(baseline, baselineSpec, trailers);
      if (kind === "patch") {
        assert.notEqual(expected.combined, tree(cached.root, original.graph.combined));
        assert.throws(() => cached.apply("fold", options), /not lossless/);
        for (const node of original.graph.nodes) {
          assert.equal(git(cached.root, "rev-parse", node.branch), node.head);
        }
        assert.equal(git(cached.root, "rev-parse", "HEAD"), cached.head);
        return;
      }
      const done = cached.apply(kind === "target" ? "sync" : "fold", options);
      const journal = readJson(journalFile(cached.ctx, done.operation));
      assert.equal(tree(cached.root, done.graph.combined), expected.combined);
      assert.equal(git(cached.root, "log", "--reverse", "--format=%B",
        `${done.graph.targetSha}..${done.graph.combined}`), expected.messages);
      const model = reference(spec);
      for (const node of done.graph.nodes) {
        assert.deepEqual({ base: tree(cached.root, node.base), head: tree(cached.root, node.head) },
          expected.snapshots[node.id]);
        assert.equal(node.requiresDraft, model.closure(node.id).length > 0);
        assert.equal(node.baseBranch, model.closure(node.id).length
          ? `pr-graph/example/bases/${node.id}` : "trunk");
        assert.equal(node.validation.head, node.head);
        assert.equal(node.validation.commands, digest(node.validations));
        assert.equal(Boolean(node.ready), false);
        assert.deepEqual(node.integration, done.graph.integration);
      }
      if (kind === "matching") {
        assert.ok(journal.reconstruction.inheritedCached > 0);
        assert.equal(journal.reconstruction.applied, 0);
        assert.ok(journal.reconstruction.prefixHits > 0);
        assert.ok(journal.reconstruction.prefixAvoided > 0);
      } else {
        assert.ok(journal.reconstruction.applied > 0);
        if (["missing", "unknown-context", "context", "target"].includes(kind)) {
          assert.equal(journal.reconstruction.inheritedCached, 0);
        }
      }
      for (const key of journal.inheritedReconstructions ?? []) {
        assert.deepEqual(journal.reconstructionReceipts[key], source.reconstructionReceipts[key]);
        assert.equal(git(cached.root, "rev-parse", `refs/pr-graph/${done.operation}/commits/${key}`),
          source.reconstructionReceipts[key].head);
      }
      assert.equal(readJson(file).worktreeReusedBy, done.operation);
      assert.equal(git(cached.root, "branch", "--show-current"), "source");
      assert.equal(git(cached.root, "status", "--porcelain"), "");
    });
  });
}
