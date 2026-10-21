import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git } from "./fixtures.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import * as state from "../lib/state.mjs";
import { refId } from "../lib/git.mjs";

function adoptedFixture(t) {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  const prs = {};
  for (const [index, node] of graph.nodes.entries()) {
    node.pr = { id: index + 1, branch: node.branch, head: node.head, base: node.base,
      baseBranch: "trunk", state: "open", draft: true, body: "Human description" };
    prs[node.pr.id] = structuredClone(node.pr);
    git(f.root, "push", "-q", "upstream", node.branch);
  }
  state.save(f.ctx, graph);
  f.ctx.providerFactory = () => ({ kind: "ado", get(id) {
    return structuredClone(prs[id]);
  } });
  const a = graph.nodes[0];
  git(f.root, "push", "-q", "upstream", `${a.head}:trunk`);
  prs[a.pr.id] = { ...prs[a.pr.id], state: "merged", landing: a.head };
  const b = graph.nodes[1];
  const rewritten = git(f.root, "commit-tree", `${b.head}^{tree}`, "-p", b.base, "-m", "Recovered b");
  git(f.root, "push", "-q", "--force-with-lease", "upstream", `${rewritten}:refs/heads/${b.branch}`);
  prs[b.pr.id].head = rewritten;
  const spec = { id: graph.id, targetSnapshot: a.head, nodes: [
    { id: a.id, head: a.head, base: a.base, baseBranch: a.baseBranch, landing: a.head },
    { id: b.id, head: rewritten, base: b.base, baseBranch: b.baseBranch },
  ] };
  return { ...f, graph, prs, spec, a, b, rewritten,
    plan: () => createPlan(f.ctx, "adopt", { graph: graph.id, spec }) };
}

test("adoption pins old state and updates rewritten branches without touching dirty work or hosting", (t) => {
  const f = adoptedFixture(t);
  git(f.root, "checkout", f.a.branch);
  const file = path.join(f.root, "shared.txt");
  fs.appendFileSync(file, "staged content\n");
  git(f.root, "add", "shared.txt");
  fs.appendFileSync(file, "unstaged content\n");
  const index = git(f.root, "diff", "--cached", "--binary");
  const work = git(f.root, "diff", "--binary");
  const branch = git(f.root, "branch", "--show-current");
  const remote = git(f.root, "ls-remote", "--heads", "upstream");
  const plan = f.plan();
  assert.throws(() => createPlan(f.ctx, "adopt", { graph: f.graph.id, spec: f.spec, fetchObservation: {} }),
    /do not accept fetch-start observations/);
  assert.throws(() => applyPlan(f.ctx, plan, "wrong", true), /approval/);
  assert.equal(refId(f.root, `refs/heads/${f.b.branch}`), f.b.head);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.nodes[0].landing.commit, f.a.head);
  assert.equal(result.graph.nodes[1].change.head, f.rewritten);
  assert.equal(refId(f.root, `refs/heads/${f.b.branch}`), f.rewritten);
  assert.ok(result.graph.nodes.every((n) => n.validation === null && n.ready === false));
  assert.equal(result.graph.combined, undefined);
  assert.equal(result.graph.source, undefined);
  assert.equal(result.graph.adoption.composition, "unverified");
  assert.equal(git(f.root, "diff", "--cached", "--binary"), index);
  assert.equal(git(f.root, "diff", "--binary"), work);
  assert.equal(git(f.root, "branch", "--show-current"), branch);
  assert.equal(git(f.root, "ls-remote", "--heads", "upstream"), remote);
  assert.equal(refId(f.root, `refs/pr-graph/${plan.approval}/adoption/${f.b.head}`), f.b.head);
  assert.deepEqual(state.readJson(state.journalFile(f.ctx, plan.approval)).plan.previous, f.graph);
  assert.equal(applyPlan(f.ctx, plan, plan.approval, true).alreadyDone, true);
});

test("adoption refuses occupied rewrites, mismatched bases and unproven landings", (t) => {
  const f = adoptedFixture(t);
  f.spec.nodes[1].base = f.a.head;
  assert.throws(f.plan, /Own-change base/);
  f.spec.nodes[1].base = f.b.base;
  f.spec.nodes[0].landing = f.b.head;
  assert.throws(f.plan, /Unexpected source or landing/);
  f.spec.nodes[0].landing = f.a.head;
  git(f.root, "checkout", f.b.branch);
  assert.throws(f.plan, /checked out/);
  assert.deepEqual(state.load(f.ctx, f.graph.id), f.graph);
});

test("adoption fails before writes when approved PR or local ref observations change", (t) => {
  const f = adoptedFixture(t);
  const plan = f.plan();
  f.prs[f.b.pr.id].body = "Changed by human";
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /PR changed/);
  assert.equal(refId(f.root, `refs/heads/${f.b.branch}`), f.b.head);
  f.prs[f.b.pr.id].body = "Human description";
  git(f.root, "update-ref", `refs/heads/${f.b.branch}`, f.base, f.b.head);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Local ref changed/);
  assert.deepEqual(state.load(f.ctx, f.graph.id), f.graph);
});

test("metadata adoption allows moving target previews without claiming freshness or validation", (t) => {
  const f = adoptedFixture(t);
  const plan = f.plan();
  const advanced = git(f.root, "commit-tree", `${f.head}^{tree}`, "-p", f.a.head, "-m", "Target advanced");
  git(f.root, "push", "-q", "upstream", `${advanced}:trunk`);
  f.prs[f.b.pr.id].base = advanced;
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.targetSha, f.a.head);
  assert.equal(result.graph.nodes[1].base, f.base);
  assert.equal(result.graph.integration.verifiedAt, undefined);
  assert.equal(result.graph.nodes[1].validation, null);
});

test("adoption rejects pending operations, duplicate nodes and stale remote products", (t) => {
  const f = adoptedFixture(t);
  f.spec.nodes[1] = f.spec.nodes[0];
  assert.throws(f.plan, /cannot add, remove, or duplicate/);
  f.spec.nodes[1] = { id: f.b.id, head: f.rewritten, base: f.b.base, baseBranch: f.b.baseBranch };
  const plan = f.plan();
  git(f.root, "push", "-q", "--force-with-lease", "upstream", `${f.b.head}:refs/heads/${f.b.branch}`);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Remote ref changed/);
  state.atomicJson(state.journalFile(f.ctx, "a".repeat(64)), { id: "a".repeat(64), status: "running" });
  assert.throws(f.plan, /Interrupted operation/);
});

test("adoption imports newer merged submissions and creates only the approved recovery base", (t) => {
  const f = adoptedFixture(t);
  const source = git(f.root, "commit-tree", `${f.a.head}^{tree}`, "-p", f.base, "-m", "New submitted a");
  const landing = git(f.root, "commit-tree", `${f.a.head}^{tree}`, "-p", f.base, "-m", "Squashed a");
  git(f.root, "push", "-q", "--force-with-lease", "upstream", `${landing}:trunk`);
  f.prs[f.a.pr.id].head = source;
  f.prs[f.a.pr.id].landing = landing;
  f.spec.targetSnapshot = landing;
  f.spec.nodes[0].head = source;
  f.spec.nodes[0].landing = landing;
  const helper = `recovery-bases/${f.b.id}`;
  git(f.root, "push", "-q", "upstream", `${f.base}:refs/heads/${helper}`);
  f.prs[f.b.pr.id].baseBranch = helper;
  f.spec.nodes[1].baseBranch = helper;
  f.spec.helperBranchPrefix = "recovery-bases";
  const plan = f.plan();
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.nodes[0].landing.source, source);
  assert.equal(result.graph.nodes[0].change.head, source);
  assert.equal(refId(f.root, `refs/heads/${f.a.branch}`), source);
  assert.equal(refId(f.root, `refs/heads/${helper}`), f.base);
  assert.equal(refId(f.root, `refs/pr-graph/${plan.approval}/adoption/${f.a.head}`), f.a.head);
});

test("adoption resumes the same journal after its atomic branch transaction", (t) => {
  const f = adoptedFixture(t);
  const plan = f.plan();
  const file = state.journalFile(f.ctx, plan.approval);
  state.atomicJson(file, { id: plan.approval, plan, status: "running",
    local: {}, remote: {}, prs: {}, commits: {}, remoteStarted: false });
  git(f.root, "update-ref", `refs/heads/${f.b.branch}`, f.rewritten, f.b.head);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.nodes[1].head, f.rewritten);
  assert.equal(state.readJson(file).status, "done");
});
