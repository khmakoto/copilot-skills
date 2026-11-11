import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
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

function selectiveFixture(t) {
  const f = fixture({ remote: true, names: ["a", "b", "c", "d"] });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  const prs = {};
  for (const [index, node] of graph.nodes.entries()) {
    node.pr = { id: index + 1, branch: node.branch, head: node.head, base: node.base,
      baseBranch: node.baseBranch, state: "open", draft: true, body: "Human description" };
    prs[node.pr.id] = structuredClone(node.pr);
    git(f.root, "push", "-q", "upstream", node.branch);
    if (node.baseBranch !== graph.target) {
      git(f.root, "push", "-q", "upstream", `${node.base}:refs/heads/${node.baseBranch}`);
    }
  }
  const [a, b, c, d] = graph.nodes;
  b.head = git(f.root, "commit-tree", `${b.head}^{tree}`, "-p", b.head, "-m", "Unpublished b");
  b.change.head = b.head;
  b.ready = true;
  b.signature = "preserve-unrelated-validation";
  git(f.root, "update-ref", `refs/heads/${b.branch}`, b.head);
  c.ready = true;
  c.signature = "invalidate-dependent-validation";
  d.retired = true;
  delete d.pr;
  state.save(f.ctx, graph);
  const rewritten = git(f.root, "commit-tree", `${a.head}^{tree}`, "-p", a.head, "-m", "Updated a");
  git(f.root, "push", "-q", "upstream", `${rewritten}:refs/heads/${a.branch}`);
  prs[a.pr.id].head = rewritten;
  f.ctx.providerFactory = () => ({ kind: "ado", get(id) {
    return structuredClone(prs[id]);
  } });
  const spec = { id: graph.id, selective: true, targetSnapshot: graph.targetSha,
    nodes: [{ id: a.id, head: rewritten, base: a.base, baseBranch: a.baseBranch }] };
  return { ...f, graph, prs, spec, a, b, c, d, rewritten,
    plan: () => createPlan(f.ctx, "adopt", { graph: graph.id, spec }) };
}

test("selective adoption preserves unpublished nodes and no-PR retired snapshots", (t) => {
  const f = selectiveFixture(t);
  const remote = git(f.root, "ls-remote", "--heads", "upstream");
  const plan = f.plan();
  assert.deepEqual(plan.updates, [{ branch: f.a.branch, expected: f.a.head, head: f.rewritten }]);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.nodes[0].head, f.rewritten);
  assert.deepEqual(result.graph.nodes[1], f.b);
  assert.deepEqual(result.graph.nodes[3], f.d);
  assert.equal(refId(f.root, `refs/heads/${f.b.branch}`), f.b.head);
  assert.equal(refId(f.root, `refs/heads/${f.c.branch}`), f.c.head);
  assert.equal(result.graph.nodes[2].head, f.c.head);
  assert.deepEqual(result.graph.nodes[2].change, f.c.change);
  assert.equal(result.graph.nodes[2].validation, null);
  assert.equal(result.graph.nodes[2].ready, false);
  assert.equal(result.graph.nodes[2].signature, undefined);
  assert.equal(result.graph.targetSha, f.graph.targetSha);
  assert.equal(result.graph.integration.verifiedAt, undefined);
  assert.equal(git(f.root, "ls-remote", "--heads", "upstream"), remote);
  assert.equal(refId(f.root, `refs/pr-graph/${plan.approval}/adoption/${f.b.head}`), f.b.head);
});

test("selective adoption requires explicit valid selection and unchanged unselected observations", (t) => {
  const f = selectiveFixture(t);
  const selected = f.spec.nodes;
  f.spec.nodes = [];
  assert.throws(f.plan, /cannot add, remove, or duplicate/);
  f.spec.nodes = [...selected, ...selected];
  assert.throws(f.plan, /cannot add, remove, or duplicate/);
  f.spec.nodes = [{ ...selected[0], id: "unknown" }];
  assert.throws(f.plan, /cannot add, remove, or duplicate/);
  f.spec.nodes = selected;
  f.spec.helperBranchPrefix = "different-bases";
  assert.throws(f.plan, /cannot change the helper namespace/);
  delete f.spec.helperBranchPrefix;
  f.spec.targetSnapshot = f.head;
  assert.throws(f.plan, /must preserve.*integration snapshot/);
  f.spec.targetSnapshot = f.graph.targetSha;
  const plan = f.plan();
  f.prs[f.b.pr.id].head = f.b.head;
  assert.throws(f.plan, /Unselected PR identity changed/);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /PR changed/);
  assert.equal(refId(f.root, `refs/heads/${f.a.branch}`), f.a.head);
});

test("complete adoption retains retired nodes without requiring a PR", (t) => {
  const f = selectiveFixture(t);
  git(f.root, "update-ref", `refs/heads/${f.b.branch}`, f.prs[f.b.pr.id].head, f.b.head);
  f.spec.selective = false;
  f.spec.nodes = f.graph.nodes.map((node) => node.retired
    ? { id: node.id, head: node.head, base: node.base, baseBranch: node.baseBranch }
    : { id: node.id, head: f.prs[node.pr.id].head, base: node.base, baseBranch: node.baseBranch });
  const plan = f.plan();
  assert.deepEqual(plan.graph.nodes[3], f.d);
  f.spec.nodes[3].head = f.base;
  assert.throws(f.plan, /Retired snapshot is immutable/);
});

function landingFixture(t) {
  const f = fixture({ remote: true, names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  const prs = {};
  for (const [index, node] of graph.nodes.entries()) {
    node.pr = { id: index + 1, branch: node.branch, head: node.head, base: node.base,
      baseBranch: node.baseBranch, state: "open", draft: true, body: "Human description" };
    prs[node.pr.id] = structuredClone(node.pr);
    node.ready = true;
    node.signature = `validation-${node.id}`;
    git(f.root, "push", "-q", "upstream", node.branch);
    if (node.baseBranch !== graph.target) {
      git(f.root, "push", "-q", "upstream", `${node.base}:refs/heads/${node.baseBranch}`);
    }
  }
  state.save(f.ctx, graph);
  const [a, b, c] = graph.nodes;
  const landing = git(f.root, "commit-tree", `${a.head}^{tree}`, "-p", f.base, "-m", "Squashed a");
  git(f.root, "push", "-q", "upstream", `${landing}:trunk`);
  git(f.root, "push", "-q", "upstream", "--delete", a.branch);
  prs[a.pr.id] = { ...prs[a.pr.id], state: "merged", landing };
  f.ctx.providerFactory = () => ({ kind: "ado", get(id) {
    return structuredClone(prs[id]);
  } });
  const spec = { id: graph.id, targetSnapshot: landing, nodes: [
    { id: a.id, head: a.head, base: a.base, baseBranch: a.baseBranch, landing },
  ] };
  return { ...f, graph, prs, spec, a, b, c, landing,
    plan: () => createPlan(f.ctx, "adopt", { graph: graph.id, spec, landingsOnly: true }) };
}

test("landing-only adoption records a squash landing without changing owned deltas, refs or dirty work", (t) => {
  const f = landingFixture(t);
  git(f.root, "checkout", f.a.branch);
  fs.appendFileSync(path.join(f.root, "shared.txt"), "staged\n");
  git(f.root, "add", "shared.txt");
  fs.appendFileSync(path.join(f.root, "shared.txt"), "unstaged\n");
  const index = git(f.root, "diff", "--cached", "--binary");
  const work = git(f.root, "diff", "--binary");
  const refs = git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const remote = git(f.root, "ls-remote", "--heads", "upstream");
  const plan = f.plan();
  assert.equal(plan.landingsOnly, true);
  assert.deepEqual(plan.updates, []);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  const [a, b, c] = result.graph.nodes;
  assert.equal(a.landing.commit, f.landing);
  assert.equal(a.landing.source, f.a.head);
  for (const node of result.graph.nodes) {
    const old = f.graph.nodes.find((n) => n.id === node.id);
    assert.deepEqual(node.change, old.change);
    assert.equal(node.head, old.head);
    assert.equal(node.base, old.base);
    assert.equal(node.baseBranch, old.baseBranch);
  }
  assert.deepEqual(b, f.b);
  assert.equal(a.ready, false);
  assert.equal(c.ready, false);
  assert.equal(c.signature, undefined);
  assert.equal(result.graph.targetSha, f.landing);
  assert.equal(result.graph.integration.verifiedAt, undefined);
  assert.equal(result.graph.combined, undefined);
  assert.equal(result.graph.source, undefined);
  assert.equal(git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"), refs);
  assert.equal(git(f.root, "ls-remote", "--heads", "upstream"), remote);
  assert.equal(git(f.root, "branch", "--show-current"), f.a.branch);
  assert.equal(git(f.root, "diff", "--cached", "--binary"), index);
  assert.equal(git(f.root, "diff", "--binary"), work);
});

test("landing-only adoption refuses rewritten sources, other PR changes and missing prerequisite refs", (t) => {
  const f = landingFixture(t);
  f.spec.nodes[0].head = f.changes.a.head;
  assert.throws(f.plan, /unchanged source identity/);
  f.spec.nodes[0].head = f.a.head;
  const b = f.prs[f.b.pr.id];
  b.state = "merged";
  b.landing = f.landing;
  assert.throws(f.plan, /Unselected PR identity changed/);
  b.state = "open";
  delete b.landing;
  f.spec.nodes = [{ id: f.b.id, head: f.b.head, base: f.b.base, baseBranch: f.b.baseBranch }];
  assert.throws(f.plan, /Unselected PR identity changed|new landing/);
  f.spec.nodes = [{ id: f.a.id, head: f.a.head, base: f.a.base,
    baseBranch: f.a.baseBranch, landing: f.landing }];
  f.spec.helperBranchPrefix = f.graph.helperBranchPrefix;
  assert.throws(f.plan, /cannot replace the graph or change the helper namespace/);
  delete f.spec.helperBranchPrefix;
  git(f.root, "update-ref", `refs/heads/${f.c.baseBranch}`, f.base, f.c.base);
  assert.throws(f.plan, /cannot repair prerequisite refs/);
  assert.deepEqual(state.load(f.ctx, f.graph.id), f.graph);
});

test("landing-only adoption rechecks target ancestry, PR readback and pinned mode before writes", (t) => {
  const f = landingFixture(t);
  assert.throws(() => createPlan(f.ctx, "sync", { graph: f.graph.id, landingsOnly: true }),
    /only for adopt/);
  assert.equal(cli(f.root, "plan", "sync", "--graph", f.graph.id, "--landings-only").status, 1);
  assert.match(cli(f.root, "plan", "adopt", "--graph", f.graph.id, "--landings-only").stderr,
    /Adoption requires this graph/);
  const plan = f.plan();
  f.prs[f.a.pr.id].body = "Human edit";
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /PR changed/);
  f.prs[f.a.pr.id].body = "Human description";
  git(f.root, "push", "-q", "--force-with-lease", "upstream", `${f.base}:trunk`);
  assert.throws(f.plan, /left the pinned history/);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /left the pinned history/);
  assert.deepEqual(state.load(f.ctx, f.graph.id), f.graph);
});

test("landing-only adoption allows proved remote-only fast-forwards but refuses a rewind above its snapshot", (t) => {
  const f = landingFixture(t);
  const observed = git(f.root, "commit-tree", `${f.landing}^{tree}`, "-p", f.landing, "-m", "Observed target");
  git(f.root, "push", "-q", "upstream", `${observed}:trunk`);
  const plan = f.plan();
  git(f.root, "push", "-q", "--force-with-lease", "upstream", `${f.landing}:trunk`);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /left the pinned history/);
  const forward = git(f.root, `--git-dir=${f.bare}`, "commit-tree",
    `${f.landing}^{tree}`, "-p", observed, "-m", "Remote-only target");
  git(f.root, `--git-dir=${f.bare}`, "update-ref", "refs/heads/trunk", forward, f.landing);
  let ancestryChecks = 0;
  f.ctx.providerFactory = () => ({ kind: "github",
    get: (id) => structuredClone(f.prs[id]),
    mergeBase(before, after) {
      ancestryChecks++;
      return git(f.root, `--git-dir=${f.bare}`, "merge-base", before, after);
    },
  });
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.ok(ancestryChecks > 0);
  assert.equal(result.graph.targetSha, f.landing);
  assert.equal(result.graph.nodes[0].landing.commit, f.landing);
  assert.equal(refId(f.root, "refs/heads/trunk"), f.base);
});
