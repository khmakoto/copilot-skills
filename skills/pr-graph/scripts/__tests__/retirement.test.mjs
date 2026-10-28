import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git } from "./fixtures.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import * as state from "../lib/state.mjs";

function retiredFixture(t, remote = false) {
  const f = fixture({ remote, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const graph = f.apply("remove", { graph: f.spec.id,
    spec: { id: f.spec.id, nodes: [f.spec.nodes[0]] } }).graph;
  graph.nodes[0].supersedes = ["b"];
  state.save(f.ctx, graph);
  return { ...f, graph,
    plan: () => createPlan(f.ctx, "remove-retired", { graph: graph.id, node: "b" }) };
}

test("retired removal preserves dirty work, all refs, active evidence and previous metadata", (t) => {
  const f = retiredFixture(t);
  const file = path.join(f.root, "shared.txt");
  fs.appendFileSync(file, "staged\n");
  git(f.root, "add", "shared.txt");
  fs.appendFileSync(file, "unstaged\n");
  const before = {
    refs: git(f.root, "show-ref"),
    index: git(f.root, "diff", "--cached"),
    work: git(f.root, "diff"),
    branch: git(f.root, "branch", "--show-current"),
  };
  const plan = f.plan();
  assert.throws(() => applyPlan(f.ctx, plan, "wrong", true), /approval/);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.deepEqual(result.graph.nodes, [{ ...f.graph.nodes[0], supersedes: [] }]);
  assert.equal(result.graph.revision, f.graph.revision + 1);
  assert.deepEqual({
    refs: git(f.root, "show-ref"),
    index: git(f.root, "diff", "--cached"),
    work: git(f.root, "diff"),
    branch: git(f.root, "branch", "--show-current"),
  }, before);
  assert.deepEqual(state.readJson(state.journalFile(f.ctx, plan.approval)).plan.previous, f.graph);
  assert.equal(applyPlan(f.ctx, plan, plan.approval, true).alreadyDone, true);
});

test("retired removal rejects active, hosted, referenced and remotely published nodes", (t) => {
  const f = retiredFixture(t, true);
  assert.throws(() => createPlan(f.ctx, "remove-retired", { graph: f.graph.id, node: "a" }),
    /retired unpublished/);
  const b = f.graph.nodes.find((n) => n.id === "b");
  b.pr = { id: 1 };
  state.save(f.ctx, f.graph);
  assert.throws(f.plan, /retired unpublished/);
  delete b.pr;
  f.graph.nodes[0].dependencies = ["b"];
  state.save(f.ctx, f.graph);
  assert.throws(f.plan, /dependents/);
  f.graph.nodes[0].dependencies = [];
  state.save(f.ctx, f.graph);
  git(f.root, "push", "-q", "upstream", b.branch);
  assert.throws(f.plan, /published remote branch/);
});

test("retired removal rejects stale plans and pending operations before writes", (t) => {
  const f = retiredFixture(t);
  const plan = f.plan();
  const b = f.graph.nodes.find((n) => n.id === "b");
  git(f.root, "update-ref", `refs/heads/${b.branch}`, f.base, b.head);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /branch changed/);
  assert.deepEqual(state.load(f.ctx, f.graph.id), f.graph);
  git(f.root, "update-ref", `refs/heads/${b.branch}`, b.head, f.base);
  f.graph.revision++;
  state.save(f.ctx, f.graph);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Graph changed/);
  state.atomicJson(state.journalFile(f.ctx, "a".repeat(64)), { id: "a".repeat(64), status: "running" });
  assert.throws(f.plan, /Interrupted operation/);
});

test("retired removal resumes after graph persistence without repeating mutations", (t) => {
  const f = retiredFixture(t);
  const plan = f.plan();
  const graph = { ...plan.graph, revision: plan.graph.revision + 1, lastOperation: plan.approval };
  state.atomicJson(state.journalFile(f.ctx, plan.approval),
    { id: plan.approval, plan, status: "running", candidate: graph });
  state.save(f.ctx, graph);
  assert.equal(applyPlan(f.ctx, plan, plan.approval, true).alreadyDone, true);
  assert.equal(state.readJson(state.journalFile(f.ctx, plan.approval)).status, "done");
});
