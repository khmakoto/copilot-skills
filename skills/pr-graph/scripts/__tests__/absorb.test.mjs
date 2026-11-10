import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import { inspectAbsorb } from "../lib/absorb.mjs";
import { load, save, journals } from "../lib/state.mjs";
import { tree } from "../lib/git.mjs";
import { digest } from "../lib/graph.mjs";

function followUp(f, { separate = false, binary = false } = {}) {
  if (separate) {
    for (const id of ["a", "b", "c"]) {
      git(f.root, "checkout", "--detach", f.base);
      fs.writeFileSync(path.join(f.root, `${id}.txt`), `${id}=1\n`);
      git(f.root, "add", ".");
      git(f.root, "commit", "-qm", `Add ${id}`);
      f.spec.nodes.find((node) => node.id === id).change = {
        base: f.base, head: git(f.root, "rev-parse", "HEAD"),
      };
    }
    delete f.spec.source;
  }
  const graph = f.apply(separate ? "init" : "split", { spec: f.spec }).graph;
  git(f.root, "checkout", "-b", "follow-up", graph.combined);
  if (separate) {
    for (const id of ["a", "b"]) fs.writeFileSync(path.join(f.root, `${id}.txt`), `${id}=2\n`);
  } else {
    fs.writeFileSync(path.join(f.root, "shared.txt"), f.text(["a", "b", "c"])
      .replace("a=1", "a=2").replace("b=1", "b=2"));
  }
  if (binary) fs.writeFileSync(path.join(f.root, "new.bin"), Buffer.from([0, 1, 2, 255]));
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Follow-up edits");
  const head = git(f.root, "rev-parse", "HEAD");
  const inventory = inspectAbsorb(f.ctx, graph.id, graph.combined, "follow-up");
  const replacements = {};
  if (!separate) {
    for (const id of ["a", "b"]) {
      git(f.root, "checkout", "--detach", graph.nodes.find((node) => node.id === id).head);
      fs.writeFileSync(path.join(f.root, "shared.txt"), f.text([id]).replace(`${id}=1`, `${id}=2`));
      git(f.root, "add", ".");
      git(f.root, "commit", "-qm", `Updated own change ${id}`);
      replacements[id] = git(f.root, "rev-parse", "HEAD");
    }
    git(f.root, "checkout", "follow-up");
  }
  const spec = {
    id: graph.id, source: { base: f.base, head },
    followUp: { base: graph.combined, head: "follow-up" },
    nodes: graph.nodes.map((node) => ({
      id: node.id, change: ["a", "b"].includes(node.id) ? {
        base: f.base,
        ...(separate ? { head, paths: [`${node.id}.txt`] } : {
          head: replacements[node.id],
        }),
      } : node.change,
    })),
    allocations: inventory.units.map((unit) => ({
      unit: unit.id, node: unit.path === "new.bin" ? "a" :
        separate ? unit.path[0] : unit.body.includes("+a=2") ? "a" : "b",
      evidence: "Retained own patch and follow-up hunk inspected.",
      rationale: "This edit updates the behavior owned by this node.",
    })),
  };
  return { graph, head, inventory, spec };
}

test("absorb allocates distinct owners, reconstructs the descendant closure and preserves dirty user work", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const { graph, head, inventory, spec } = followUp(f, { separate: true });
  assert.deepEqual(inventory.units.map((unit) => unit.suggestedOwner), ["a", "b"]);
  assert.ok(inventory.units.every((unit) => unit.owner === null));
  fs.writeFileSync(path.join(f.root, "staged.txt"), "staged\n");
  git(f.root, "add", "staged.txt");
  fs.writeFileSync(path.join(f.root, "staged.txt"), "unstaged\n");
  const status = git(f.root, "status", "--porcelain");
  const index = git(f.root, "write-tree");
  const branch = git(f.root, "symbolic-ref", "HEAD");
  const refs = git(f.root, "show-ref");
  const preview = cli(f.root, "absorb", "--graph", graph.id, "--base", graph.combined, "--head", "follow-up");
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout), inventory);
  assert.equal(git(f.root, "show-ref"), refs);
  const specFile = path.join(f.dir, "absorb-spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const planned = cli(f.root, "plan", "absorb", "--graph", graph.id, "--spec", specFile);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.deepEqual(plan.absorption.affected, ["a", "b", "c"]);
  assert.deepEqual(plan.absorption.dependencyChanges, []);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, head));
  for (const id of ["a", "b"]) {
    const node = result.graph.nodes.find((n) => n.id === id);
    assert.equal(git(f.root, "show", `${node.head}:${id}.txt`), `${id}=2`);
    const other = id === "a" ? "b" : "a";
    assert.equal(git(f.root, "ls-tree", node.head, `${other}.txt`), "");
    assert.equal(node.branch, graph.nodes.find((n) => n.id === id).branch);
    assert.equal(node.ready, false);
  }
  const descendant = result.graph.nodes.find((n) => n.id === "c");
  assert.notEqual(descendant.base, graph.nodes.find((n) => n.id === "c").base);
  assert.equal(git(f.root, "show", `${descendant.base}:a.txt`), "a=2");
  assert.equal(git(f.root, "show", `${descendant.base}:b.txt`), "b=2");
  assert.equal(descendant.change.fingerprint, graph.nodes.find((n) => n.id === "c").change.fingerprint);
  assert.equal(git(f.root, "status", "--porcelain"), status);
  assert.equal(git(f.root, "write-tree"), index);
  assert.equal(git(f.root, "symbolic-ref", "HEAD"), branch);
  assert.equal(fs.readFileSync(path.join(f.root, "staged.txt"), "utf8"), "unstaged\n");
  assert.equal(load(f.ctx, graph.id).lastOperation, plan.approval);
});

test("shared-file hunks remain unassigned until explicit allocation and reconstruct without loss", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const { graph, inventory, spec, head } = followUp(f);
  assert.equal(inventory.units.length, 2);
  assert.ok(inventory.units.every((unit) => unit.suggestedOwner === null &&
    unit.candidates.length === 3));
  const result = f.apply("absorb", { graph: graph.id, spec });
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, head));
  assert.equal(git(f.root, "show", `${result.graph.nodes[0].head}:shared.txt`),
    f.text(["a"]).replace("a=1", "a=2").trim());
});

test("explicit cross-node allocation groups same-file hunks in source order using existing dependencies", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  f.spec.nodes[0].dependencies = ["b"];
  const { graph, spec, head } = followUp(f);
  const owner = graph.nodes.find((node) => node.id === "a");
  git(f.root, "checkout", "--detach", owner.head);
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text(["a", "b"])
    .replace("a=1", "a=2").replace("b=1", "b=2"));
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Explicit cross-node follow-up owner");
  spec.nodes[0].change = { base: owner.base, head: git(f.root, "rev-parse", "HEAD") };
  spec.nodes[1].change = graph.nodes.find((node) => node.id === "b").change;
  for (const assignment of spec.allocations) assignment.node = "a";
  spec.allocations.reverse();
  git(f.root, "checkout", "follow-up");
  const result = f.apply("absorb", { graph: graph.id, spec });
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, head));
  assert.equal(result.graph.nodes.find((node) => node.id === "b").head,
    graph.nodes.find((node) => node.id === "b").head);
  assert.deepEqual(result.graph.nodes.find((node) => node.id === "a").dependencies, ["b"]);
});

test("absorb rejects missing/duplicate assignments, inactive owners, inferred edges and unsupported identity changes", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const { graph, spec } = followUp(f);
  for (const revise of [
    (s) => { s.allocations.pop(); },
    (s) => { s.allocations[1].unit = s.allocations[0].unit; },
    (s) => { s.allocations[0].node = null; },
    (s) => { s.allocations[0].evidence = ""; },
    (s) => { s.allocations[0].rationale = ""; },
    (s) => { s.nodes[0].dependencies = ["b"]; },
    (s) => { s.nodes.push({ ...s.nodes[0], id: "new" }); },
    (s) => { delete s.followUp; },
    (s) => { delete s.source; },
    (s) => { s.source.head = f.head; },
    (s) => { s.followUp.base = f.base; },
    (s) => { s.allocations.forEach((unit) => { unit.node = "a"; }); },
  ]) {
    const changed = structuredClone(spec);
    revise(changed);
    assert.throws(() => createPlan(f.ctx, "absorb", { graph: graph.id, spec: changed }));
  }
  for (const state of ["landed", "retired"]) {
    const inactive = structuredClone(graph);
    const old = inactive.nodes[0];
    if (state === "landed") old.landing = { commit: old.head, source: old.head, target: graph.target };
    else old.retired = true;
    save(f.ctx, inactive);
    const inventory = inspectAbsorb(f.ctx, graph.id, graph.combined, "follow-up");
    assert.equal(inventory.provenance[0].state, state);
    const changed = structuredClone(spec);
    changed.nodes[0].change = old.change;
    assert.throws(() => createPlan(f.ctx, "absorb", { graph: graph.id, spec: changed }),
      /retired|unlanded/i);
  }
});

test("binary and cross-node file edits need explicit whole-file decisions, not nearest-line assignments", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const { graph, spec, inventory, head } = followUp(f, { separate: true, binary: true });
  const binary = inventory.units.find((unit) => unit.path === "new.bin");
  assert.equal(binary.kind, "whole-file");
  assert.equal(binary.suggestedOwner, null);
  spec.nodes[0].change.paths.push("new.bin");
  const result = f.apply("absorb", { graph: graph.id, spec });
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, head));
  assert.equal(git(f.root, "rev-parse", `${result.graph.nodes[0].head}:new.bin`),
    git(f.root, "rev-parse", `${head}:new.bin`));
});

test("absorb preserves hosted PRs, remote refs and enabled backup configuration without publishing", (t) => {
  const f = fixture({ remote: true, names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const { graph, spec, head } = followUp(f, { separate: true });
  graph.nodes.push({ ...structuredClone(graph.nodes[0]), id: "retired", retired: true,
    branch: "pr-graph/example/nodes/retired" });
  graph.backup.enabled = true;
  const prs = {};
  for (const [index, node] of graph.nodes.entries()) {
    node.pr = { id: index + 1, branch: node.branch, head: node.head, base: node.base,
      baseBranch: node.baseBranch, state: "open", draft: node.id === "c" || node.retired,
      body: "Preserve human content", url: `https://example.invalid/pr/${index + 1}` };
    prs[node.pr.id] = structuredClone(node.pr);
  }
  save(f.ctx, graph);
  f.ctx.providerFactory = () => ({
    kind: "github",
    get: (id) => structuredClone(prs[id]),
    update: () => assert.fail("Absorb must not update PRs, including retired drafts."),
  });
  const remote = git(f.root, "ls-remote", "--refs", "upstream");
  const plan = createPlan(f.ctx, "absorb", { graph: graph.id, spec });
  const tampered = structuredClone(plan);
  tampered.absorption.allocations[0].node = "b";
  assert.throws(() => applyPlan(f.ctx, tampered, plan.approval, true), /approval/);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, head));
  assert.deepEqual(result.graph.backup, graph.backup);
  assert.deepEqual(result.graph.nodes.map((node) => node.pr), graph.nodes.map((node) => node.pr));
  assert.equal(git(f.root, "ls-remote", "--refs", "upstream"), remote);
});

test("absorb rejects allocation lies even when the approved combined tree would match", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const { graph, spec } = followUp(f);
  [spec.allocations[0].node, spec.allocations[1].node] = ["b", "a"];
  const plan = createPlan(f.ctx, "absorb", { graph: graph.id, spec });
  const refs = git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /ownership mismatch|conflict/i);
  assert.equal(git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), refs);
  assert.equal(digest(load(f.ctx, graph.id)), digest(graph));
});

test("follow-up drift invalidates approval; occupied worktrees are never moved", (t) => {
  for (const scenario of ["drift", "occupied"]) {
    const f = fixture({ names: ["a", "b", "c"] });
    t.after(() => f.dispose());
    const { graph, spec } = followUp(f);
    const plan = createPlan(f.ctx, "absorb", { graph: graph.id, spec });
    const occupied = path.join(f.dir, "occupied");
    if (scenario === "drift") git(f.root, "update-ref", "refs/heads/follow-up", f.head);
    else {
      git(f.root, "worktree", "add", occupied, graph.nodes[1].branch);
      fs.writeFileSync(path.join(occupied, "dirty.txt"), "leave this alone\n");
    }
    const refs = git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
    assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true),
      scenario === "drift" ? /Source reference changed/ : /checked out/);
    assert.equal(git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), refs);
    assert.equal(digest(load(f.ctx, graph.id)), digest(graph));
    if (scenario === "occupied") assert.equal(fs.readFileSync(path.join(occupied, "dirty.txt"), "utf8"),
      "leave this alone\n");
  }
});

test("failed validation and cross-node conflicts retain recovery state without changing product refs", (t) => {
  for (const scenario of ["validation", "conflict"]) {
    const f = fixture({ names: ["a", "b", "c"] });
    t.after(() => f.dispose());
    const { graph, spec } = followUp(f, { separate: true });
    if (scenario === "validation") {
      spec.nodes[0].validations = [{ command: process.execPath, args: ["-e", "process.exit(1)"] }];
    } else {
      spec.allocations.forEach((unit) => { unit.node = "a"; });
      spec.nodes[0].change.paths.push("b.txt");
      spec.nodes[1].change = graph.nodes[1].change;
    }
    const plan = createPlan(f.ctx, "absorb", { graph: graph.id, spec });
    const refs = git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
    assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true),
      scenario === "validation" ? /Validation failed/ : /conflict/i);
    const journal = journals(f.ctx).find((item) => item.id === plan.approval);
    assert.equal(journal.status, "running");
    assert.ok(journal.error);
    if (scenario === "conflict") assert.ok(journal.pendingChange);
    assert.equal(git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), refs);
    assert.equal(digest(load(f.ctx, graph.id)), digest(graph));
  }
});

test("split/fold cannot use source to authorize new follow-up content", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const { graph, spec } = followUp(f);
  delete spec.followUp;
  delete spec.allocations;
  const plan = createPlan(f.ctx, "fold", { graph: graph.id, spec });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /not lossless/);
  assert.equal(digest(load(f.ctx, graph.id)), digest(graph));
});
