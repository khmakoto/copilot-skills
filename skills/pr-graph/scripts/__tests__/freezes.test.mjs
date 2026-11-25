import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import * as state from "../lib/state.mjs";
import { context } from "../lib/git.mjs";
import { createPlan, applyPlan, inspect } from "../lib/operations.mjs";
import { digest, updateFooter, footer } from "../lib/graph.mjs";
import { freezeReport, mergeFreezes, validateFreezes } from "../lib/freezes.mjs";
import { history } from "../lib/history.mjs";

const apply = (f, plan) => applyPlan(f.ctx, plan, plan.approval, true);
const freeze = (f, node, mode = "authored-content") => f.apply("review-freeze", {
  graph: "example", spec: { freeze: [{ node, mode }], unfreeze: [], reason: "Preserve active review." },
});
const unfreeze = (f, node) => f.apply("review-freeze", {
  graph: "example", spec: { freeze: [], unfreeze: [node], reason: "Explicitly release the review baseline." },
});
const refs = (f) => git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
function advance(f) {
  git(f.root, "checkout", "-qb", "target-update", "trunk");
  fs.writeFileSync(path.join(f.root, "target.txt"), "New integration content.\n");
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "advance target");
  git(f.root, "branch", "-f", "trunk", "HEAD");
  return git(f.root, "rev-parse", "HEAD");
}
function hosted(f) {
  const graph = state.load(f.ctx, "example");
  for (const [index, node] of graph.nodes.entries()) node.pr = { id: index + 1, state: "open",
    branch: node.branch, head: node.head, base: node.base, baseBranch: node.baseBranch,
    title: node.title, body: updateFooter("Human review text", footer(graph, node)), draft: true };
  state.save(f.ctx, graph);
  const prs = new Map(graph.nodes.map((n) => [n.pr.id, structuredClone(n.pr)]));
  let writes = 0;
  f.ctx.providerFactory = () => ({ kind: "github", get: (id) => structuredClone(prs.get(id)),
    capabilities: () => ({ strategies: ["merge"] }),
    update: () => { writes++; throw new Error("Unexpected hosting write"); } });
  return { graph, prs, writes: () => writes };
}

test("freeze and explicit unfreeze are digest-bound local history actions, not freshness or validation", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec }).graph;
  const before = refs(f);
  const plan = createPlan(f.ctx, "review-freeze", { graph: "example",
    spec: { freeze: [{ node: "a", mode: "authored-content" }], unfreeze: [], reason: "Active review" } });
  assert.throws(() => applyPlan(f.ctx, plan, "0".repeat(64), true), /approval/);
  const result = apply(f, plan);
  assert.equal(apply(f, plan).alreadyDone, true);
  assert.equal(refs(f), before);
  assert.deepEqual(result.graph.nodes, original.nodes);
  assert.deepEqual(result.graph.integration, original.integration);
  assert.equal(result.freezes[0].status, "frozen");
  assert.match(cli(f.root, "view", "--graph", "example").stdout, /freeze: authored-content/);
  const record = result.graph.reviewFreezes.records[0];
  assert.equal(record.operation, plan.approval);
  const released = unfreeze(f, "a").graph;
  assert.equal(released.reviewFreezes.records[0].release.operation, released.lastOperation);
  assert.ok(history(f.ctx, "example", "a").events.some((e) => e.action === "review-freeze" && e.changes.metadata));
  assert.ok(history(f.ctx, "example", "b").events.filter((e) => e.action === "review-freeze")
    .every((e) => !e.changes.metadata));
  assert.equal(refs(f), before);
});

test("authored freezes allow prerequisite reconstruction; exact snapshots block target and indirect closure changes before writes", (t) => {
  for (const mode of ["authored-content", "exact-review-snapshot"]) {
    const f = fixture({ names: ["a", "b", "c"] });
    t.after(() => f.dispose());
    const original = f.apply("split", { spec: f.spec }).graph;
    freeze(f, "c", mode);
    const target = advance(f);
    const before = refs(f);
    if (mode === "exact-review-snapshot") {
      assert.throws(() => createPlan(f.ctx, "sync", { graph: "example", localOnly: true }),
        /freeze blocks c.*indirect prerequisite reconstruction/);
      assert.equal(refs(f), before);
      unfreeze(f, "c");
    }
    const plan = createPlan(f.ctx, "sync", { graph: "example", localOnly: true });
    if (mode === "authored-content") assert.match(plan.freezes[0].reconstruction, /permitted/);
    const result = apply(f, plan).graph;
    assert.equal(result.targetSha, target);
    assert.notEqual(result.nodes[2].base, original.nodes[2].base);
    assert.notEqual(result.nodes[2].head, original.nodes[2].head);
    assert.deepEqual(result.nodes[2].change, original.nodes[2].change);
    assert.equal(result.reviewFreezes.records[0].mode, mode);
  }
});

test("dependency edits and same-target prerequisite edits distinguish content from exact review snapshots", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  freeze(f, "c", "exact-review-snapshot");
  const spec = structuredClone(f.spec);
  delete spec.source;
  spec.nodes[2].dependencies = ["a"];
  assert.throws(() => createPlan(f.ctx, "deps", { graph: "example", spec }), /freeze blocks c.*dependencies/);
  const changed = structuredClone(f.spec);
  delete changed.source;
  changed.nodes[0].change = { base: f.base, head: f.head };
  assert.throws(() => createPlan(f.ctx, "fold", { graph: "example", spec: changed }),
    /freeze blocks c.*indirect prerequisite reconstruction/);
  unfreeze(f, "c");
  freeze(f, "c");
  const result = f.apply("deps", { graph: "example", spec });
  assert.deepEqual(result.graph.nodes[2].dependencies, ["a"]);
  assert.equal(result.graph.reviewFreezes.records[1].release, null);
});

test("both modes block direct ownership, identity retirement, split and fold, including attempts to hide policy in a shape spec", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  for (const mode of ["authored-content", "exact-review-snapshot"]) {
    freeze(f, "a", mode);
    const before = refs(f);
    const changed = structuredClone(f.spec);
    delete changed.source;
    changed.nodes[0].change = { base: f.base, head: f.head };
    changed.reviewFreezes = { version: 1, records: [] };
    assert.throws(() => createPlan(f.ctx, "fold", { graph: "example", spec: changed }), /freeze blocks a.*ownChange/);
    for (const action of ["remove", "split-node", "fold"]) {
      const spec = { id: "example", nodes: [f.spec.nodes[1], { id: "replacement", title: "Replacement",
        dependencies: [], change: f.changes.a, supersedes: ["a"], validationReason: "Fixture" }] };
      assert.throws(() => createPlan(f.ctx, action, { graph: "example", spec }), /freeze blocks a.*retirement/);
    }
    assert.equal(refs(f), before);
    unfreeze(f, "a");
  }
  const result = f.apply("fold", { graph: "example", spec: { id: "example", nodes: [{ id: "combined",
    title: "Combined", dependencies: [], supersedes: ["a", "b"],
    change: { base: f.base, head: f.head }, validationReason: "Fixture" }] } });
  assert.equal(result.graph.nodes.find((n) => n.id === "a").retired, true);
  f.apply("remove-retired", { graph: "example", node: "a" });
  assert.equal(state.load(f.ctx, "example").reviewFreezes.records.length, 2);
});

test("policy, ref and PR observation drift invalidate plans; exact freezes detect external human metadata without adoption", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const old = createPlan(f.ctx, "sync", { graph: "example", localOnly: true });
  freeze(f, "a", "exact-review-snapshot");
  assert.throws(() => apply(f, old), /freeze history changed|Graph state changed/);
  const unfreezePlan = createPlan(f.ctx, "review-freeze", { graph: "example",
    spec: { freeze: [], unfreeze: ["a"], reason: "Release" } });
  git(f.root, "update-ref", "refs/heads/pr-graph/example/nodes/a", f.head);
  assert.throws(() => apply(f, unfreezePlan), /observations changed/);
  assert.equal(inspect(f.ctx, "example").freezes[0].status, "drifted");
  git(f.root, "update-ref", "refs/heads/pr-graph/example/nodes/a", state.load(f.ctx, "example").nodes[0].head);
  unfreeze(f, "a");
  const p = hosted(f);
  freeze(f, "a", "exact-review-snapshot");
  for (const action of ["ready", "describe"]) assert.throws(() => createPlan(f.ctx, action, {
    graph: "example", node: "a", ...(action === "describe" ? { body: "New human text" } : {}),
  }), /freeze blocks a/);
  const before = state.load(f.ctx, "example");
  const plan = createPlan(f.ctx, "sync", { graph: "example", localOnly: true });
  p.prs.get(1).body = "Externally edited human text";
  assert.equal(inspect(f.ctx, "example").freezes[0].status, "drifted");
  assert.throws(() => apply(f, plan), /Review freeze drift/);
  assert.equal(p.writes(), 0);
  assert.deepEqual(state.load(f.ctx, "example"), before);
  f.apply("abort", { graph: "example", operation: plan.approval });
  unfreeze(f, "a");
  assert.equal(p.writes(), 0);
});

test("exact freezes permit unchanged sync, standalone validation and managed-footer observation but protect check definitions", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const p = hosted(f);
  freeze(f, "a", "exact-review-snapshot");
  const before = state.load(f.ctx, "example").nodes[0];
  f.apply("sync", { graph: "example", localOnly: true });
  f.apply("validate", { graph: "example", selector: "node:a" });
  const graph = state.load(f.ctx, "example");
  assert.equal(graph.nodes[0].head, before.head);
  assert.equal(graph.nodes[0].base, before.base);
  p.prs.get(1).body = updateFooter("Human review text", "<!-- pr-graph:begin -->\nUpdated generated footer\n<!-- pr-graph:end -->");
  assert.equal(inspect(f.ctx, "example").freezes[0].status, "frozen");
  assert.throws(() => createPlan(f.ctx, "sync", { graph: "example", spec: { id: "example",
    validations: { a: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }] } } }), /freeze blocks a.*checks/);
});

test("exact-frozen publication may add a managed footer without changing human text, but malformed external footers drift", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  f.apply("publish", { graph: "example" });
  const { graph, prs } = hosted(f);
  for (const node of graph.nodes) {
    node.pr.body = "Human review text";
    prs.set(node.pr.id, structuredClone(node.pr));
  }
  state.save(f.ctx, graph);
  let writes = 0;
  f.ctx.providerFactory = () => ({ kind: "github", get: (id) => structuredClone(prs.get(id)),
    capabilities: () => ({ strategies: ["merge"] }), diffPaths: () => ["shared.txt"],
    update: (id, changes) => {
      writes++;
      Object.assign(prs.get(id), changes);
      return structuredClone(prs.get(id));
    } });
  freeze(f, "a", "exact-review-snapshot");
  const result = f.apply("publish", { graph: "example" });
  assert.ok(writes > 0);
  assert.equal(result.graph.nodes[0].head, graph.nodes[0].head);
  assert.match(prs.get(1).body, /^Human review text\n\n<!-- pr-graph:begin -->/);
  assert.equal(inspect(f.ctx, "example").freezes[0].status, "frozen");
  prs.get(1).body += "\n<!-- pr-graph:begin -->\nAnother footer\n<!-- pr-graph:end -->";
  assert.equal(inspect(f.ctx, "example").freezes[0].status, "drifted");
});

test("graph transfer merges preserve destination freezes; archives retain policy history without importing authority", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const active = freeze(f, "a").graph.reviewFreezes;
  const released = unfreeze(f, "a").graph.reviewFreezes;
  assert.equal(mergeFreezes(active, released).records[0].release, null);
  assert.deepEqual(mergeFreezes(active, released).records[0].observedReleases, [released.records[0].release]);
  assert.ok(mergeFreezes(released, active).records[0].release);
  const bad = structuredClone(active);
  bad.records[0].baseline.ownChange = "0".repeat(64);
  assert.throws(() => mergeFreezes(active, bad), /Conflicting review freeze/);
  bad.records[0].mode = "inferred-from-draft";
  assert.throws(() => validateFreezes(bad), /Invalid review freeze/);
  freeze(f, "b", "exact-review-snapshot");
  const archive = path.join(f.dir, "frozen-history.json");
  f.apply("export-history", { graph: "example", archive });
  const destination = fixture({ names: ["a", "b"] });
  t.after(() => destination.dispose());
  const imported = destination.apply("import-history", { graph: "example", archive });
  assert.equal(state.load(destination.ctx, "example", true), null);
  const timeline = history(destination.ctx, "example", "b", imported.imported);
  assert.ok(timeline.versions.some((v) => v.snapshot.reviewFreezes?.records.some((r) => r.node === "b" && !r.release)));
  assert.equal(timeline.current, null);
  assert.match(timeline.warning, /never establishes current/);
});

test("freeze history cannot be omitted or released by resealing a different mutation plan", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  freeze(f, "a", "exact-review-snapshot");
  const graph = state.load(f.ctx, "example");
  const changed = structuredClone(graph);
  delete changed.reviewFreezes;
  assert.throws(() => state.save(f.ctx, changed), /freeze history changed/);
  const restored = structuredClone(graph);
  restored.nodes[0].validationReason = null;
  restored.nodes[0].validation = null;
  assert.ok(freezeReport(restored)[0].drift.includes("checks"));
  const { approval, ...payload } = createPlan(f.ctx, "sync", { graph: "example", localOnly: true });
  payload.graph.reviewFreezes.records[0].release = { operation: "0".repeat(64), reason: "Not explicit unfreeze" };
  const forged = { ...payload, approval: digest(payload) };
  assert.throws(() => apply(f, forged), /freeze history changed/);
});

test("metadata-only removal of an unrelated retired node preserves an active freeze", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  f.apply("remove", { graph: "example", spec: { id: "example", nodes: [f.spec.nodes[1]] } });
  const frozen = freeze(f, "b").graph;
  const before = refs(f);
  const result = f.apply("remove-retired", { graph: "example", node: "a" });
  assert.deepEqual(result.graph.reviewFreezes, frozen.reviewFreezes);
  assert.equal(refs(f), before);
  assert.equal(inspect(f.ctx, "example").freezes[0].status, "frozen");
});

test("real backup and restore retain exact freeze baselines but clear execution authority and expose check drift", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.spec.backup = { enabled: true };
  f.apply("split", { spec: f.spec });
  const frozen = freeze(f, "a", "exact-review-snapshot").graph;
  const backedUp = f.apply("backup", { graph: "example" }).graph;
  const clone = path.join(f.dir, "restored");
  git(f.dir, "clone", "-q", "--origin", "upstream", f.bare, clone);
  git(clone, "config", "user.name", "Restore Test");
  git(clone, "config", "user.email", "restore@example.invalid");
  git(clone, "config", "commit.gpgsign", "false");
  const ctx = context(clone);
  const plan = createPlan(ctx, "restore", { graph: "example", remote: "upstream", backupRef: backedUp.backup.head });
  const result = applyPlan(ctx, plan, plan.approval, true);
  assert.deepEqual(result.graph.reviewFreezes, frozen.reviewFreezes);
  assert.equal(result.graph.nodes[0].validation, null);
  assert.equal(result.graph.nodes[0].ready, false);
  assert.deepEqual(result.graph.nodes[0].validations, []);
  assert.ok(inspect(ctx, "example").freezes[0].drift.includes("checks"));
  assert.throws(() => createPlan(ctx, "sync", { graph: "example", localOnly: true }), /freeze blocks a.*checks/);
  const release = createPlan(ctx, "review-freeze", { graph: "example",
    spec: { freeze: [], unfreeze: ["a"], reason: "Approve reconfiguration after restore." } });
  assert.equal(applyPlan(ctx, release, release.approval, true).freezes.length, 0);
});
