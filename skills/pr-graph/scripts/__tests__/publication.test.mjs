import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import * as state from "../lib/state.mjs";
import * as gitLib from "../lib/git.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import { digest } from "../lib/graph.mjs";
import { assertOutbound, effectivePolicy, loadPolicy, mergePolicies } from "../lib/publication.mjs";

function exclude(f, ids = ["a"]) {
  return f.apply("publication-policy", { graph: "example",
    spec: { exclude: ids, release: [], reason: "Keep explicitly local." } });
}

const remote = (f) => git(f.root, `--git-dir=${f.bare}`, "for-each-ref", "--format=%(refname) %(objectname)");
const apply = (f, plan) => applyPlan(f.ctx, plan, plan.approval, true);

test("direct, transitive and multi-parent publication block before writes; unrelated exact scope remains publishable", (t) => {
  const f = fixture({ remote: true });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  exclude(f);
  const before = remote(f);
  for (const id of ["a", "c", "f"]) {
    const graph = state.load(f.ctx, "example");
    const node = graph.nodes.find((n) => n.id === id);
    assert.throws(() => assertOutbound(f.ctx, effectivePolicy(f.ctx, graph.id, graph), [{
      route: `product:${id}`, nodes: [id], roots: [node.head], metadata: [],
    }]), new RegExp(`Publication excluded: a via product:${id}`));
    assert.equal(remote(f), before);
  }
  assert.throws(() => createPlan(f.ctx, "publish", { graph: "example" }), /Publication excluded/);
  const plan = createPlan(f.ctx, "publish", { graph: "example", publishNodes: ["b", "d"] });
  assert.ok(plan.outboundScope.some((s) => s.route === "helper:d"));
  const result = apply(f, plan);
  assert.equal(gitLib.remoteRefs(f.root, "upstream")[`refs/heads/${result.graph.nodes[1].branch}`],
    result.graph.nodes[1].head);
  assert.equal(gitLib.remoteRefs(f.root, "upstream")["refs/heads/pr-graph/example/nodes/a"], undefined);
});

test("enabled backup blocks the whole operation before otherwise-safe product or provider writes", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.spec.backup = { enabled: true };
  f.apply("split", { spec: f.spec });
  exclude(f);
  const before = remote(f);
  for (const action of ["publish", "backup"]) {
    assert.throws(() => createPlan(f.ctx, action, { graph: "example",
      ...(action === "publish" ? { publishNodes: ["b"] } : {}) }), /via backup/);
    assert.equal(remote(f), before);
  }
  assert.equal(f.apply("sync", { graph: "example", localOnly: true }).graph.backup.enabled, true);
});

test("reachability includes helper bases, discarded ancestors, copied blobs and text in combined blobs", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  f.apply("publish", { graph: "example", publishNodes: ["a"] });
  exclude(f);
  const policy = effectivePolicy(f.ctx, graph.id, graph);
  const check = (root, route) => assertOutbound(f.ctx, policy,
    [{ route, roots: [root], nodes: [], metadata: [] }]);
  assert.throws(() => check(graph.nodes[0].head, "helper:b"), /via helper:b/);
  assert.throws(() => createPlan(f.ctx, "publish", { graph: "example", publishNodes: ["a"] }),
    /Publication excluded/);
  assert.throws(() => check(f.head, "unrelated-copy"), /content fingerprint/);
  git(f.root, "checkout", "-qb", "discarded", f.changes.a.head);
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text([]));
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Remove local-only data from tip");
  assert.throws(() => check(git(f.root, "rev-parse", "HEAD"), "old-history"), /via old-history/);
  const blob = git(f.root, "rev-parse", `${f.changes.a.head}:shared.txt`);
  assert.ok(policy.exclusions[0].objects.includes(blob));
  assert.throws(() => check("f".repeat(40), "missing-history"), /Cannot prove outbound scope/);
});

test("hosted lifecycle metadata and merge routes cannot bypass exclusion or write after a block", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  f.apply("publish", { graph: "example" });
  for (const [index, node] of graph.nodes.entries()) {
    node.pr = { id: index + 1, state: "open", branch: node.branch, head: node.head,
      base: node.base, baseBranch: node.baseBranch, draft: true, body: node.description, title: node.title };
  }
  state.save(f.ctx, graph);
  let writes = 0;
  f.ctx.providerFactory = () => ({
    kind: "github", get: (id) => structuredClone(graph.nodes.find((n) => n.pr.id === id).pr),
    capabilities: () => ({ strategies: ["merge"] }),
    create: () => { writes++; }, update: () => { writes++; }, merge: () => { writes++; },
  });
  exclude(f);
  const before = remote(f);
  for (const action of ["ready", "merge", "describe"]) {
    assert.throws(() => createPlan(f.ctx, action, { graph: "example", node: "a",
      ...(action === "describe" ? { body: "New body" } : {}) }), /Publication excluded/);
    assert.equal(writes, 0);
    assert.equal(remote(f), before);
  }
  assert.throws(() => createPlan(f.ctx, "describe", { graph: "example", node: "b",
    body: "Reference Implement a inside another node." }), /metadata fingerprint/);
  assert.equal(writes, 0);
});

test("metadata copies block without including protected text in errors, including describe payloads", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.spec.nodes[0].description = "local-disclosure-canary";
  f.apply("split", { spec: f.spec });
  exclude(f);
  const policy = effectivePolicy(f.ctx, "example");
  assert.throws(() => assertOutbound(f.ctx, policy, [{
    route: "describe:b", roots: [], nodes: ["b"], metadata: ["See local-disclosure-canary for details."],
  }]), (error) => /via describe:b/.test(error.message) && !error.message.includes("local-disclosure-canary"));
  const graph = state.load(f.ctx, "example");
  graph.nodes[1].description = "See local-disclosure-canary for details.";
  state.save(f.ctx, graph);
  assert.throws(() => createPlan(f.ctx, "publish", { graph: "example", publishNodes: ["b"] }),
    /metadata fingerprint/);
});

test("policy and outbound payload drift invalidate approval and continuation without claiming prior effects absent", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const planned = createPlan(f.ctx, "publish", { graph: "example", publishNodes: ["b"] });
  const changed = structuredClone(planned);
  changed.outboundScope[0].roots = [f.head];
  assert.throws(() => applyPlan(f.ctx, changed, changed.approval, true), /approval/);
  const { approval, ...payload } = changed;
  changed.approval = digest(payload);
  assert.throws(() => apply(f, changed), /Outbound payload scope changed/);
  state.atomicJson(state.journalFile(f.ctx, planned.approval), {
    id: planned.approval, plan: planned, status: "running", remoteStarted: true,
    local: {}, remote: {}, prs: {}, commits: {},
  });
  exclude(f);
  const before = remote(f);
  assert.throws(() => apply(f, planned), /Publication policy changed.*Prior outbound effects/);
  const continued = cli(f.root, "continue", "--operation", planned.approval,
    "--yes", "--approve", planned.approval);
  assert.equal(continued.status, 1);
  assert.match(continued.stderr, /Prior outbound effects/);
  assert.equal(remote(f), before);
  assert.equal(state.readJson(state.journalFile(f.ctx, planned.approval)).status, "running");
});

test("continuation rejects drift in realized ref roots or hosted metadata before outbound writes", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  exclude(f);
  const plan = createPlan(f.ctx, "publish", { graph: "example", publishNodes: ["b"] });
  const before = remote(f);
  for (const field of ["roots", "metadata"]) {
    const scope = structuredClone(plan.outboundScope);
    scope[0][field] = field === "roots" ? [f.head] : ["Different approved text"];
    state.atomicJson(state.journalFile(f.ctx, plan.approval), {
      id: plan.approval, plan, candidate: plan.graph, outboundScope: scope,
      status: "running", remoteStarted: true, local: {}, remote: {}, prs: {}, commits: {},
    });
    const continued = cli(f.root, "continue", "--operation", plan.approval,
      "--yes", "--approve", plan.approval);
    assert.equal(continued.status, 1);
    assert.match(continued.stderr, /Realized outbound payload changed during continuation/);
    assert.equal(remote(f), before);
    assert.equal(state.readJson(state.journalFile(f.ctx, plan.approval)).status, "running");
  }
});

test("split/fold lineage and retired metadata removal preserve exclusions and historical export blocks", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  exclude(f);
  f.apply("fold", { graph: "example", spec: { id: "example", nodes: [{
    id: "combined", title: "Combined", dependencies: [], supersedes: ["a", "b"],
    change: { base: f.base, head: f.head }, validationReason: "No build.",
  }] } });
  f.apply("split-node", { graph: "example", spec: { id: "example", nodes: [
    { id: "first", title: "First", dependencies: [], supersedes: ["combined"],
      change: f.changes.a, validationReason: "No build." },
    { id: "second", title: "Second", dependencies: [], supersedes: ["combined"],
      change: f.changes.b, validationReason: "No build." },
  ] } });
  assert.ok(loadPolicy(f.ctx, "example").exclusions[0].members.includes("second"));
  assert.throws(() => createPlan(f.ctx, "publish", { graph: "example", publishNodes: ["second"] }),
    /Publication excluded/);
  f.apply("remove-retired", { graph: "example", node: "a" });
  assert.ok(!state.load(f.ctx, "example").nodes.some((n) => n.id === "a"));
  const archive = path.join(f.dir, "blocked.json");
  assert.throws(() => createPlan(f.ctx, "export-history", { graph: "example", archive }),
    /via history-export/);
  assert.equal(fs.existsSync(archive), false);
  assert.ok(loadPolicy(f.ctx, "example").exclusions[0].members.includes("a"));
});

test("release requires exact approval and retains evidence; archive roundtrip cannot release destination exclusions", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  exclude(f);
  const active = loadPolicy(f.ctx, "example");
  const plan = createPlan(f.ctx, "publication-policy", { graph: "example",
    spec: { exclude: [], release: ["a"], reason: "Explicitly permit disclosure." } });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, false), /approval/);
  assert.equal(loadPolicy(f.ctx, "example").exclusions[0].active, true);
  apply(f, plan);
  const released = loadPolicy(f.ctx, "example");
  assert.equal(released.exclusions[0].active, false);
  assert.deepEqual(released.exclusions[0].objects, active.exclusions[0].objects);
  assert.equal(released.exclusions[0].receipts.at(-1).operation, plan.approval);
  const archive = path.join(f.dir, "released.json");
  apply(f, createPlan(f.ctx, "export-history", { graph: "example", archive }));
  const incoming = state.readJson(archive).publicationPolicy;
  assert.equal(incoming.exclusions[0].active, false);
  assert.equal(mergePolicies(active, incoming).exclusions[0].active, true);
  const recipient = path.join(f.dir, "recipient");
  git(f.dir, "clone", "-q", "--no-local", f.root, recipient);
  const ctx = gitLib.context(recipient);
  const imported = createPlan(ctx, "import-history", { graph: "example", archive });
  applyPlan(ctx, imported, imported.approval, true);
  assert.deepEqual(loadPolicy(ctx, "example"), incoming);
  const activeArchive = state.readJson(archive);
  activeArchive.publicationPolicy.exclusions[0].active = true;
  const { id, ...content } = activeArchive;
  activeArchive.id = digest(content);
  const activeFile = path.join(f.dir, "incoming-restriction.json");
  state.atomicJson(activeFile, activeArchive);
  const intake = createPlan(ctx, "import-history", { graph: "example", archive: activeFile });
  applyPlan(ctx, intake, intake.approval, true);
  assert.equal(loadPolicy(ctx, "example").exclusions[0].active, true);
  assert.equal(applyPlan(ctx, intake, intake.approval, true).alreadyImported, true);
  const oldRelease = createPlan(ctx, "import-history", { graph: "example", archive });
  applyPlan(ctx, oldRelease, oldRelease.approval, true);
  assert.equal(loadPolicy(ctx, "example").exclusions[0].active, true);
});

test("incoming active policy is restrictive state and saving older snapshots cannot remove it", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  exclude(f);
  const protectedGraph = state.load(f.ctx, "example");
  const root = path.join(f.dir, "restore");
  git(f.dir, "clone", "-q", "--no-local", f.root, root);
  const ctx = gitLib.context(root);
  const incoming = structuredClone(protectedGraph);
  incoming.publicationPolicy.exclusions[0].receipts = [];
  state.save(ctx, incoming);
  state.save(ctx, { ...graph, publicationPolicy: { version: 1, exclusions: [] } });
  assert.equal(loadPolicy(ctx, "example").exclusions[0].active, true);
  assert.equal(state.load(ctx, "example").publicationPolicy.exclusions[0].active, true);
});

test("restore carries snapshot exclusions without granting disclosure or restoring validation authority", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  exclude(f);
  const graph = state.load(f.ctx, "example");
  const blob = gitLib.out(f.root, ["hash-object", "-w", "--stdin"], JSON.stringify(graph));
  const tree = gitLib.out(f.root, ["mktree"], `100644 blob ${blob}\tgraph.json\n`);
  const parents = [...new Set([graph.combined, graph.source.head,
    ...graph.nodes.flatMap((n) => [n.change.base, n.change.head, n.head, n.base])])];
  const snapshot = git(f.root, "commit-tree", tree, ...parents.flatMap((sha) => ["-p", sha]),
    "-m", "Local recovery fixture");
  const root = path.join(f.dir, "restored");
  git(f.dir, "clone", "-q", "--origin", "upstream", f.bare, root);
  git(root, "fetch", "-q", f.root, snapshot);
  git(root, "config", "user.name", "Restore Test");
  git(root, "config", "user.email", "restore@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  const ctx = gitLib.context(root);
  const plan = createPlan(ctx, "restore", { graph: "example", remote: "upstream", backupRef: snapshot });
  const result = applyPlan(ctx, plan, plan.approval, true);
  assert.equal(result.graph.publicationPolicy.exclusions[0].active, true);
  assert.equal(result.graph.nodes[0].validation, null);
  assert.equal(loadPolicy(ctx, "example").exclusions[0].active, true);
  assert.throws(() => createPlan(ctx, "publish", { graph: "example" }), /Publication excluded/);
});
