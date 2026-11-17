import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { analyzeDependencies, inspectDependencies } from "../lib/dependencies.mjs";
import { digest } from "../lib/graph.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import * as state from "../lib/state.mjs";
import { fixture, git, cli } from "./fixtures.mjs";
import { dag, generatedCase, reference, seeds } from "./generated.mjs";

function graph(edges) {
  return { version: 1, id: "advice", revision: 1, target: "trunk",
    nodes: Object.entries(edges).map(([id, dependencies]) => ({
      id, title: id, branch: `nodes/${id}`, dependencies,
      change: { base: "unavailable", patch: `retained own patch for ${id}` },
    })) };
}

test("redundant edges retain alternate paths and unchanged diamond/shared-ancestor closures", () => {
  const g = graph({ a: [], b: ["a"], c: ["a"], d: ["a", "b", "c"], e: ["d", "b"] });
  const before = structuredClone(g);
  const report = analyzeDependencies(g);
  assert.deepEqual(report.redundantEdges.map((edge) => [edge.prerequisite, edge.node, edge.alternatePath]), [
    ["a", "d", ["a", "b", "d"]],
    ["b", "e", ["b", "d", "e"]],
  ]);
  const edge = report.redundantEdges[0];
  assert.deepEqual(edge.removal.dependenciesBefore, ["a", "b", "c"]);
  assert.deepEqual(edge.removal.dependenciesAfter, ["b", "c"]);
  assert.deepEqual(edge.removal.affected.map((n) => n.id), ["d", "e"]);
  for (const n of edge.removal.affected) {
    assert.deepEqual(n.before, n.after);
    assert.deepEqual(n.removedPrerequisites, []);
  }
  assert.deepEqual(report.sequencingCandidates.map((e) => `${e.prerequisite}->${e.node}`),
    ["a->b", "a->c", "b->d", "c->d", "d->e"]);
  assert.match(edge.assessment, /intent; retain unless approved/);
  assert.deepEqual(g, before);
  g.nodes.reverse();
  for (const n of g.nodes) n.dependencies.reverse();
  const reordered = analyzeDependencies(g);
  assert.deepEqual(reordered.redundantEdges, report.redundantEdges);
  assert.deepEqual(reordered.sequencingCandidates, report.sequencingCandidates);
});

test("sequencing candidates expose lost ancestors and descendant eligibility, not proven sibling specs", () => {
  const g = graph({ a: [], b: ["a"], c: ["b"], d: ["a", "c"], e: [] });
  const report = analyzeDependencies(g);
  const edge = report.sequencingCandidates.find((e) => e.prerequisite === "b" && e.node === "c");
  assert.equal(edge.assessment, "unassessed");
  assert.equal(edge.missingEvidence.length, 2);
  assert.deepEqual(edge.removal.affected, [
    { id: "c", before: { prerequisites: ["a", "b"], unlandedPrerequisites: ["a", "b"], eligible: false },
      after: { prerequisites: [], unlandedPrerequisites: [], eligible: true }, removedPrerequisites: ["a", "b"] },
    { id: "d", before: { prerequisites: ["a", "b", "c"], unlandedPrerequisites: ["a", "b", "c"], eligible: false },
      after: { prerequisites: ["a", "c"], unlandedPrerequisites: ["a", "c"], eligible: false }, removedPrerequisites: ["b"] },
  ]);
  assert.match(report.warning, /independent, not a recommended sibling spec/);
  assert.match(report.warning, /object availability and semantic independence are unverified/);
  assert.equal(report.evidence.find((n) => n.id === "c").recordedValidation, null);
});

test("inactive endpoints are excluded while traversal preserves shared landed and retired context", () => {
  const g = graph({ a: [], b: ["a"], c: ["a", "b"], d: ["c"], r: ["a"] });
  g.nodes[0].landing = { commit: "receipt", target: "trunk" };
  g.nodes[4].retired = true;
  const report = analyzeDependencies(g);
  assert.deepEqual(report.excludedEdges.map((e) => [e.prerequisite, e.node]),
    [["a", "b"], ["a", "c"], ["a", "r"]]);
  const edge = report.sequencingCandidates.find((e) => e.node === "c");
  assert.deepEqual(edge.removal.affected[0].before,
    { prerequisites: ["a", "b"], unlandedPrerequisites: ["b"], eligible: false });
  assert.deepEqual(edge.removal.affected[0].after,
    { prerequisites: ["a"], unlandedPrerequisites: [], eligible: true });
  assert.deepEqual(report.evidence[0].landing, g.nodes[0].landing);
  assert.equal(report.evidence.find((n) => n.id === "r").state, "retired");
});

test("seeded dependency diagnostics match independent reachability and eligibility after every edge removal", () => {
  for (const seed of seeds(32)) {
    const g = dag(seed);
    generatedCase(seed, g, () => {
      const report = analyzeDependencies(g);
      const before = reference(g);
      const findings = [...report.redundantEdges, ...report.sequencingCandidates];
      assert.equal(findings.length + report.excludedEdges.length,
        g.nodes.reduce((sum, n) => sum + n.dependencies.length, 0));
      for (const edge of findings) {
        const proposed = structuredClone(g);
        const consumer = proposed.nodes.find((n) => n.id === edge.node);
        consumer.dependencies = consumer.dependencies.filter((id) => id !== edge.prerequisite);
        const after = reference(proposed);
        const redundant = after.closure(edge.node).includes(edge.prerequisite);
        assert.equal(Boolean(edge.alternatePath), redundant);
        if (redundant) {
          assert.equal(edge.alternatePath[0], edge.prerequisite);
          assert.equal(edge.alternatePath.at(-1), edge.node);
          assert.ok(edge.alternatePath.length > 2);
          for (let i = 1; i < edge.alternatePath.length; i++) {
            assert.ok(proposed.nodes.find((n) => n.id === edge.alternatePath[i])
              .dependencies.includes(edge.alternatePath[i - 1]));
          }
        }
        const affected = g.nodes.filter((n) => !n.retired && !n.landing &&
          (n.id === edge.node || before.closure(n.id).includes(edge.node))).map((n) => n.id).sort();
        assert.deepEqual(edge.removal.affected.map((n) => n.id).sort(), affected);
        for (const effect of edge.removal.affected) {
          assert.deepEqual(effect.before.prerequisites, before.closure(effect.id).sort());
          assert.deepEqual(effect.after.prerequisites, after.closure(effect.id).sort());
          for (const [phase, model] of [["before", before], ["after", after]]) {
            assert.equal(effect[phase].eligible, Boolean(model.eligible(effect.id)));
            assert.deepEqual(effect[phase].unlandedPrerequisites, model.closure(effect.id)
              .filter((id) => !g.nodes.find((n) => n.id === id).landing).sort());
          }
        }
      }
    });
  }
});

function retainedFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [entry.name, entry.isDirectory() ? retainedFiles(path.join(dir, entry.name)) :
      fs.readFileSync(path.join(dir, entry.name), "hex")]);
}

test("CLI dependency diagnostics preserve dirty files, index, refs, journals and hooks without running checks or providers", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  f.spec.nodes[1].dependencies = ["a"];
  const g = f.apply("split", { spec: f.spec }).graph;
  const marker = path.join(f.dir, "must-not-run");
  g.nodes[2].validations = [{
    command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
  }];
  g.nodes[2].validation = null;
  g.repository = { ...g.repository, remote: "unavailable", provider: { kind: "github" } };
  state.save(f.ctx, g);
  fs.writeFileSync(path.join(f.root, "staged.txt"), "staged\n");
  git(f.root, "add", "staged.txt");
  fs.appendFileSync(path.join(f.root, "shared.txt"), "dirty\n");
  const hook = path.join(f.ctx.common, "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const before = {
    refs: git(f.root, "show-ref"), head: git(f.root, "symbolic-ref", "HEAD"),
    worktrees: git(f.root, "worktree", "list", "--porcelain"),
    index: fs.readFileSync(path.join(f.ctx.common, "index"), "hex"),
    retained: retainedFiles(f.ctx.dir),
  };
  const result = cli(f.root, "dependencies", "--graph", g.id);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.graphDigest, digest(g));
  assert.deepEqual(report, inspectDependencies(f.ctx, g.id));
  assert.deepEqual(report.evidence.find((n) => n.id === "c").change, g.nodes[2].change);
  assert.deepEqual(report.evidence.find((n) => n.id === "a").consumers, ["b", "c"]);
  assert.equal(report.sequencingCandidates.find((e) => e.node === "b").assessment, "unassessed");
  assert.equal(fs.existsSync(marker), false);
  assert.equal(git(f.root, "show-ref"), before.refs);
  assert.equal(git(f.root, "symbolic-ref", "HEAD"), before.head);
  assert.equal(git(f.root, "worktree", "list", "--porcelain"), before.worktrees);
  assert.equal(fs.readFileSync(path.join(f.ctx.common, "index"), "hex"), before.index);
  assert.deepEqual(retainedFiles(f.ctx.dir), before.retained);
  assert.ok(fs.readFileSync(path.join(f.root, "shared.txt"), "utf8").endsWith("dirty\n"));
  assert.equal(fs.readFileSync(path.join(f.root, "staged.txt"), "utf8"), "staged\n");
  assert.equal(fs.readFileSync(hook, "utf8"), "#!/bin/sh\nexit 1\n");
  for (const args of [[], ["--graph", "missing"], ["--graph", g.id, "--yes"],
    ["--graph", g.id, "--node", "a"], ["--graph", g.id, "--spec", "unused.json"]]) {
    assert.equal(cli(f.root, "dependencies", ...args).status, 1);
  }
});

test("accepted advice uses exact-approved deps reconstruction with stable ownership and complete-tree preservation", (t) => {
  const f = fixture({ names: ["a", "b", "c", "d"] });
  t.after(() => f.dispose());
  f.spec.nodes[1].dependencies = ["a"];
  const original = f.apply("split", { spec: f.spec }).graph;
  const report = inspectDependencies(f.ctx, original.id);
  assert.ok(report.redundantEdges.some((e) => e.prerequisite === "a" && e.node === "c"));
  const spec = { id: original.id, nodes: original.nodes.map((n) =>
    ({ id: n.id, dependencies: n.id === "c" ? ["b"] : n.dependencies })) };
  const plan = createPlan(f.ctx, "deps", { graph: original.id, spec });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, false), /approval|--yes/);
  assert.throws(() => applyPlan(f.ctx, plan, "not-the-digest", true), /approval/);
  assert.deepEqual(state.load(f.ctx, original.id), original);
  const result = applyPlan(f.ctx, plan, plan.approval, true).graph;
  assert.equal(git(f.root, "rev-parse", `${result.combined}^{tree}`),
    git(f.root, "rev-parse", `${original.combined}^{tree}`));
  for (const n of result.nodes) {
    const old = original.nodes.find((p) => p.id === n.id);
    assert.equal(n.branch, old.branch);
    assert.deepEqual(n.change, old.change);
  }
  assert.equal(inspectDependencies(f.ctx, result.id).redundantEdges.length, 0);
});

for (const kind of ["same-file", "cross-file"]) {
  test(`${kind} semantic dependencies remain unassessed and approved removals still require validation`, (t) => {
    const f = fixture({ names: ["a", "b"] });
    t.after(() => f.dispose());
    f.spec.nodes[1].dependencies = ["a"];
    if (kind === "cross-file") {
      for (const [id, file, content] of [
        ["a", "producer.mjs", "export const value = 42;\n"],
        ["b", "consumer.mjs", "import { value } from './producer.mjs';\nif (value !== 42) throw Error('contract');\n"],
      ]) {
        git(f.root, "checkout", `input-${id}`);
        fs.writeFileSync(path.join(f.root, file), content);
        git(f.root, "add", file);
        git(f.root, "commit", "-qm", `Add ${file}`);
        f.spec.nodes.find((n) => n.id === id).change.head = git(f.root, "rev-parse", "HEAD");
      }
      git(f.root, "checkout", "source");
      for (const file of ["producer.mjs", "consumer.mjs"]) {
        fs.writeFileSync(path.join(f.root, file), git(f.root, "show",
          `input-${file === "producer.mjs" ? "a" : "b"}:${file}`) + "\n");
      }
      git(f.root, "add", ".");
      git(f.root, "commit", "-qm", "Complete cross-file feature");
      f.spec.source.head = git(f.root, "rev-parse", "HEAD");
    }
    f.spec.nodes[1].validations = [{ command: process.execPath, args: kind === "cross-file"
      ? ["consumer.mjs"] : ["-e",
        "if (!require('node:fs').readFileSync('shared.txt','utf8').startsWith('a=1\\n')) throw Error('producer required')"] }];
    const original = f.apply("split", { spec: f.spec }).graph;
    const report = inspectDependencies(f.ctx, original.id);
    assert.deepEqual(report.redundantEdges, []);
    assert.equal(report.sequencingCandidates[0].assessment, "unassessed");
    assert.match(report.sequencingCandidates[0].missingEvidence[0], /consumers/);
    assert.ok(report.evidence.find((n) => n.id === "b").recordedValidation);
    const plan = createPlan(f.ctx, "deps", { graph: original.id,
      spec: { id: original.id, nodes: original.nodes.map((n) => ({ id: n.id, dependencies: [] })) } });
    const refs = git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
    assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Validation failed for b/);
    assert.deepEqual(state.load(f.ctx, original.id), original);
    assert.equal(git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), refs);
  });
}
