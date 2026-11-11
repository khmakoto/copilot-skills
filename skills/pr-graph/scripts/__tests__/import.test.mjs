import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import * as state from "../lib/state.mjs";
import { context, refId } from "../lib/git.mjs";
import { loadPolicy } from "../lib/publication.mjs";

function setup(t) {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  const prs = {};
  for (const [index, node] of graph.nodes.entries()) {
    node.pr = { id: index + 1, branch: node.branch, head: node.head, base: node.base,
      baseBranch: node.baseBranch, state: "open", draft: true, body: "Human description" };
    prs[node.pr.id] = structuredClone(node.pr);
    git(f.root, "push", "-q", "upstream", node.branch);
  }

  state.save(f.ctx, graph);
  const sourceRoot = path.join(f.dir, "newer-clone");
  git(f.dir, "clone", "-q", "--origin", "upstream", f.bare, sourceRoot);
  git(sourceRoot, "fetch", "-q", f.root, ...new Set([
    graph.targetSha, graph.combined, graph.source?.base, graph.source?.head,
    ...graph.nodes.flatMap((n) => [n.change.base, n.change.head, n.head, n.base]),
  ].filter(Boolean)));
  const source = context(sourceRoot);
  for (const n of graph.nodes) git(sourceRoot, "branch", n.branch, n.head);
  const incoming = structuredClone(graph);
  const b = incoming.nodes[1];
  b.dependencies = ["a"];
  b.base = incoming.nodes[0].head;
  b.baseBranch = `pr-graph/${graph.id}/bases/b`;
  b.head = git(f.root, "commit-tree", `${f.head}^{tree}`, "-p", b.base, "-m", "New dependent b");
  git(f.root, "push", "-q", "--force-with-lease", "upstream", `${b.head}:refs/heads/${b.branch}`,
    `${b.base}:refs/heads/${b.baseBranch}`);
  git(sourceRoot, "fetch", "-q", "upstream", `+${b.head}:refs/heads/${b.branch}`);
  prs[b.pr.id] = { ...prs[b.pr.id], head: b.head, base: b.base, baseBranch: b.baseBranch };
  b.pr = structuredClone(prs[b.pr.id]);
  incoming.combined = b.head;
  b.validations = [{ command: "untrusted-executable", args: [] }];
  state.save(source, incoming);
  f.ctx.providerFactory = () => ({ kind: "ado", get: (id) => structuredClone(prs[id]) });
  const plan = () => createPlan(f.ctx, "import-graph", { graph: graph.id, sourceRepo: sourceRoot });
  return { ...f, graph, source, incoming, prs, b, plan };
}

test("graph import unions source and destination exclusions without importing release authorization", (t) => {
  const f = setup(t);
  f.apply("publication-policy", { graph: "example",
    spec: { exclude: ["a"], release: [], reason: "Destination restriction." } });
  const privateNode = { ...structuredClone(f.incoming.nodes[0]), id: "private",
    branch: "pr-graph/example/nodes/private", retired: true, title: "Source-only historical work" };
  delete privateNode.pr;
  privateNode.head = git(f.source.root, "-c", "user.name=Import Test",
    "-c", "user.email=import@example.invalid", "commit-tree", `${privateNode.head}^{tree}`,
    "-p", privateNode.base, "-m", "Source-only retained version");
  privateNode.change.head = privateNode.head;
  git(f.source.root, "branch", privateNode.branch, privateNode.head);
  f.incoming.nodes.push(privateNode);
  state.save(f.source, f.incoming);
  const sourceSpec = { exclude: ["b", "private"], release: [], reason: "Source restriction." };
  const sourcePlan = createPlan(f.source, "publication-policy", { graph: "example", spec: sourceSpec });
  applyPlan(f.source, sourcePlan, sourcePlan.approval, true);
  const plan = f.plan();
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.deepEqual(result.graph.publicationPolicy.exclusions.map((e) => [e.id, e.active]),
    [["a", true], ["b", true], ["private", true]]);
  assert.equal(loadPolicy(f.ctx, "example").exclusions.length, 3);
  assert.equal(refId(f.root, `refs/heads/${privateNode.branch}`), privateNode.head);
  assert.equal(applyPlan(f.ctx, plan, plan.approval, true).alreadyDone, true);
});

test("local import recovers changed DAG shape, preserves dirty checkout and clears executable metadata", (t) => {
  const f = setup(t);
  git(f.root, "checkout", f.graph.nodes[0].branch);
  fs.appendFileSync(path.join(f.root, "shared.txt"), "staged\n");
  git(f.root, "add", "shared.txt");
  fs.appendFileSync(path.join(f.root, "shared.txt"), "unstaged\n");
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "preserve");
  const before = {
    branch: git(f.root, "branch", "--show-current"),
    index: git(f.root, "diff", "--cached", "--binary"),
    work: git(f.root, "diff", "--binary"),
    remote: git(f.root, "ls-remote", "--heads", "upstream"),
    source: state.load(f.source, f.graph.id),
  };
  const plan = f.plan();
  assert.throws(() => applyPlan(f.ctx, plan, "wrong", true), /approval/);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.deepEqual(result.graph.nodes[1].dependencies, ["a"]);
  assert.equal(refId(f.root, `refs/heads/${f.b.branch}`), f.b.head);
  assert.equal(refId(f.root, `refs/heads/${f.b.baseBranch}`), f.b.base);
  assert.equal(refId(f.root, "refs/heads/trunk"), f.base);
  assert.equal(result.graph.import.composition, "unverified");
  assert.ok(result.graph.nodes.every((n) =>
    n.validations.length === 0 && n.validation === null && n.ready === false && !n.signature));
  assert.equal(result.graph.combined, undefined);
  assert.equal(result.graph.integration.verifiedAt, undefined);
  assert.equal(git(f.root, "branch", "--show-current"), before.branch);
  assert.equal(git(f.root, "diff", "--cached", "--binary"), before.index);
  assert.equal(git(f.root, "diff", "--binary"), before.work);
  assert.equal(fs.readFileSync(path.join(f.root, "untracked.txt"), "utf8"), "preserve");
  assert.equal(git(f.root, "ls-remote", "--heads", "upstream"), before.remote);
  assert.deepEqual(state.load(f.source, f.graph.id), before.source);
  assert.deepEqual(state.readJson(state.journalFile(f.ctx, plan.approval)).plan.previous, f.graph);
  assert.equal(refId(f.root, `refs/pr-graph/${plan.approval}/original/${f.graph.nodes[1].head}`),
    f.graph.nodes[1].head);
  assert.equal(applyPlan(f.ctx, plan, plan.approval, true).alreadyDone, true);
});

test("import rejects occupied rewrites and stale source, local, remote or human PR observations", (t) => {
  const f = setup(t);
  git(f.root, "checkout", f.b.branch);
  assert.throws(f.plan, /checked out/);
  git(f.root, "checkout", "source");
  const plan = f.plan();
  f.prs[1].body = "Human edit";
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /PR changed/);
  f.prs[1].body = "Human description";
  const original = structuredClone(f.incoming);
  f.incoming.title = "Changed manifest";
  state.save(f.source, f.incoming);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Source graph changed/);
  state.save(f.source, original);
  git(f.root, "update-ref", `refs/heads/${f.b.branch}`, f.base);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Local ref changed/);
  git(f.root, "update-ref", `refs/heads/${f.b.branch}`, f.graph.nodes[1].head);
  git(f.root, "push", "-q", "--force-with-lease", "upstream",
    `${f.graph.nodes[1].head}:refs/heads/${f.b.branch}`);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Remote ref changed/);
  assert.deepEqual(state.load(f.ctx, f.graph.id), f.graph);
});

test("import preserves omitted branches and adds pinned unpublished retired snapshots", (t) => {
  const f = setup(t);
  const omitted = f.graph.nodes[0];
  omitted.retired = true;
  delete omitted.pr;
  f.graph.nodes[1].retired = true;
  delete f.graph.nodes[1].pr;
  state.save(f.ctx, f.graph);
  f.incoming.nodes = [f.incoming.nodes[1]];
  const b = f.incoming.nodes[0];
  b.retired = true;
  b.dependencies = [];
  delete b.pr;
  state.save(f.source, f.incoming);
  const plan = f.plan();
  assert.deepEqual(plan.omittedNodes, [omitted.id]);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.nodes.length, 1);
  assert.equal(refId(f.root, `refs/heads/${omitted.branch}`), omitted.head);
});

test("import refuses omitted active PRs and changed source branch identities", (t) => {
  const f = setup(t);
  const plan = f.plan();
  git(f.source.root, "update-ref", `refs/heads/${f.b.branch}`, f.base);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Source node branch changed/);
  git(f.source.root, "update-ref", `refs/heads/${f.b.branch}`, f.b.head);
  f.incoming.nodes[1].retired = true;
  delete f.incoming.nodes[1].pr;
  state.save(f.source, f.incoming);
  assert.throws(f.plan, /hosted PR identity changed/);
  f.incoming.nodes[1].retired = false;
  f.incoming.nodes[1].pr = structuredClone(f.prs[f.graph.nodes[1].pr.id]);
  f.incoming.nodes = [f.incoming.nodes[1]];
  f.incoming.nodes[0].dependencies = [];
  state.save(f.source, f.incoming);
  assert.throws(f.plan, /cannot omit/);
});

test("import refuses different repository identities, malformed changes and pending source operations", (t) => {
  const f = setup(t);
  f.incoming.nodes[0].change.fingerprint = "tampered";
  state.save(f.source, f.incoming);
  assert.throws(f.plan, /fingerprint/);
  f.incoming.nodes[0].change = structuredClone(f.graph.nodes[0].change);
  state.save(f.source, f.incoming);
  git(f.source.root, "remote", "set-url", "upstream", f.root);
  assert.throws(f.plan, /remote URL changed/);
  git(f.source.root, "remote", "set-url", "upstream", f.bare);
  state.atomicJson(state.journalFile(f.source, "a".repeat(64)),
    { id: "a".repeat(64), status: "running" });
  assert.throws(f.plan, /Interrupted operation/);
  const result = cli(f.root, "plan", "sync", "--source-repo", f.source.root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only when planning import-graph/);
});

test("import adds a missing node and resumes after its branch transaction", (t) => {
  const f = setup(t);
  f.graph.nodes = [f.graph.nodes[0]];
  state.save(f.ctx, f.graph);
  const plan = f.plan();
  state.atomicJson(state.journalFile(f.ctx, plan.approval), { id: plan.approval, plan,
    status: "running", local: {}, remote: {}, prs: {}, commits: {}, remoteStarted: false });
  for (const update of plan.updates) git(f.root, "update-ref", `refs/heads/${update.branch}`, update.head);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.nodes.length, 2);
  assert.equal(result.graph.nodes[1].pr.id, f.b.pr.id);
  assert.equal(state.readJson(state.journalFile(f.ctx, plan.approval)).status, "done");
});

test("import allows verified forward target previews without renewing snapshot freshness", (t) => {
  const f = setup(t);
  const plan = f.plan();
  const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "New target");
  git(f.root, "push", "-q", "upstream", `${advanced}:trunk`);
  f.prs[1].base = advanced;
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.targetSha, f.base);
  assert.equal(result.graph.integration.verifiedAt, undefined);
  assert.equal(refId(f.root, "refs/heads/trunk"), f.base);
});
