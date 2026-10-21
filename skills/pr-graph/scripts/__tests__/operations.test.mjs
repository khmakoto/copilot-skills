import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, git, cli } from "./fixtures.mjs";
import { tree, context } from "../lib/git.mjs";
import { load, lock } from "../lib/state.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";

test("CLI pins reconstruction trailers without changing PR titles or rereading the input", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  const spec = path.join(f.dir, "spec.json");
  const trailersFile = path.join(f.dir, "trailers.json");
  const planFile = path.join(f.dir, "plan.json");
  const trailers = ["Co-authored-by: Copilot <copilot@example.invalid>", "Copilot-Session: fixture"];
  fs.writeFileSync(spec, JSON.stringify(f.spec));
  fs.writeFileSync(trailersFile, JSON.stringify(trailers));
  const planned = cli(f.root, "plan", "split", "--spec", spec,
    "--commit-trailers-file", trailersFile, "--out", planFile);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.deepEqual(plan.commitTrailers, trailers);
  fs.writeFileSync(trailersFile, JSON.stringify(["Other: changed"]));
  const applied = cli(f.root, "apply", "--plan", planFile, "--yes", "--approve", plan.approval);
  assert.equal(applied.status, 0, applied.stderr);
  const { graph } = JSON.parse(applied.stdout);
  for (const node of graph.nodes) {
    assert.equal(node.title, `Implement ${node.id}`);
    assert.equal(git(f.root, "show", "-s", "--format=%B", node.head),
      `${node.title}\n\n${trailers.join("\n")}`);
  }
});

test("reconstruction trailer input rejects injected messages and unsupported actions", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  for (const trailers of [null, [], "Other: value", ["Other: value\nInjected: line"], ["not a trailer"]]) {
    assert.throws(() => createPlan(f.ctx, "split", { spec: f.spec, commitTrailers: trailers }),
      /Commit trailers require/);
  }
  assert.throws(() => createPlan(f.ctx, "checkpoint", { commitTrailers: ["Other: value"] }),
    /Commit trailers require/);
});

test("fold, split-node, dependency edits and removal preserve explicit ownership", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const foldSpec = {
    id: "example", nodes: [{
      id: "ab", title: "Combined change", dependencies: [],
      supersedes: ["a", "b"],
      change: { base: f.base, head: f.head }, validationReason: "No build system.",
    }],
  };
  const folded = f.apply("fold", { graph: "example", spec: foldSpec });
  assert.ok(folded.graph.nodes.find((n) => n.id === "a").retired);
  assert.equal(tree(f.root, folded.graph.combined), tree(f.root, f.head));
  const splitSpec = {
    id: "example", nodes: [
      { id: "a2", title: "First own change", dependencies: [], supersedes: ["ab"], change: f.changes.a, validationReason: "No build system." },
      { id: "b2", title: "Second own change", dependencies: [], supersedes: ["ab"], change: f.changes.b, validationReason: "No build system." },
    ],
  };
  let result = f.apply("split-node", { graph: "example", spec: splitSpec });
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, f.head));
  splitSpec.nodes[1].dependencies = ["a2"];
  result = f.apply("deps", { graph: "example", spec: splitSpec });
  assert.deepEqual(result.graph.nodes.find((n) => n.id === "b2").dependencies, ["a2"]);
  const removeSpec = { id: "example", nodes: [splitSpec.nodes[0]] };
  result = f.apply("remove", { graph: "example", spec: removeSpec });
  assert.ok(result.graph.nodes.find((n) => n.id === "b2").retired);
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, f.changes.a.head));
});

test("stale source and ref changes invalidate the exact operation approval", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const plan = createPlan(f.ctx, "split", { spec: f.spec });
  git(f.root, "update-ref", "refs/heads/trunk", f.head, f.base);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Local ref changed/);
});

for (const target of ["main", "master"]) {
  test(`${target} grace starts before a slow fetch, including initial planning against a moving target`, (t) => {
    const f = fixture({ remote: true, names: ["a"] });
    t.after(() => f.dispose());
    const startedAt = Date.UTC(2026, 9, 21);
    let clock = startedAt;
    f.ctx.now = () => clock;
    git(f.root, "branch", target, f.base);
    git(f.root, "push", "-q", "upstream", target);
    f.spec.target = target;
    const fetchObservation = { target, sha: f.base, startedAt };
    git(f.root, "fetch", "--no-tags", "upstream", `refs/heads/${target}:refs/preflight/target`);
    const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Target advanced during fetch");
    git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/${target}`);
    clock += 1800000;
    const split = createPlan(f.ctx, "split", { spec: f.spec, fetchObservation });
    assert.equal(split.target, f.base);
    assert.deepEqual(split.fetchObservation, fetchObservation);
    assert.equal(split.graph.integration.verifiedAt, startedAt);
    clock += 600000;
    const result = applyPlan(f.ctx, split, split.approval, true);
    assert.equal(result.graph.nodes[0].integration.verifiedAt, startedAt);
    assert.equal(result.freshness.a.integration.ageMs, 2400000);
    assert.equal(result.freshness.a.integration.expiresAt, startedAt + 5400000);
    assert.equal(result.freshness.a.integration.status, "grace");
    const repeated = createPlan(f.ctx, "publish", { graph: f.spec.id,
      fetchObservation: { ...fetchObservation, startedAt: clock } });
    assert.equal(repeated.graph.integration.verifiedAt, startedAt);
    const latest = createPlan(f.ctx, "publish", { graph: f.spec.id,
      fetchObservation: { target, sha: advanced, startedAt: clock } });
    assert.equal(latest.target, f.base);
    assert.equal(latest.graph.integration.verifiedAt, startedAt);
    clock = startedAt + 5399999;
    f.apply("ready", { graph: f.spec.id, node: "a" });
    const ready = createPlan(f.ctx, "ready", { graph: f.spec.id, node: "a" });
    clock++;
    assert.throws(() => applyPlan(f.ctx, ready, ready.approval, true), /freshness expired/);
  });
}

test("fetch observations reject invalid evidence, expired moving snapshots, and non-current merges", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  const startedAt = Date.UTC(2026, 9, 21);
  f.ctx.now = () => startedAt + 5400000;
  git(f.root, "branch", "main", f.base);
  git(f.root, "push", "-q", "upstream", "main");
  f.spec.target = "main";
  const fetchObservation = { target: "main", sha: f.base, startedAt };
  for (const invalid of [null, {}, { ...fetchObservation, target: "master" },
    { ...fetchObservation, sha: "main" }, { ...fetchObservation, startedAt: -1 },
    { ...fetchObservation, startedAt: startedAt + 5400001 }]) {
    assert.throws(() => createPlan(f.ctx, "split", { spec: f.spec, fetchObservation: invalid }),
      /Fetch observation requires/);
  }
  const graph = f.apply("split", { spec: f.spec, fetchObservation }).graph;
  const later = createPlan(f.ctx, "publish", { graph: graph.id });
  assert.equal(later.graph.integration.verifiedAt, startedAt);
  const refreshed = createPlan(f.ctx, "publish", { graph: graph.id,
    fetchObservation: { ...fetchObservation, startedAt: startedAt + 5400000 } });
  assert.equal(refreshed.graph.integration.verifiedAt, startedAt + 5400000);
  const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Main advanced");
  git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/main`);
  assert.throws(() => createPlan(f.ctx, "split", { spec: { ...f.spec, id: "expired" }, fetchObservation }),
    /Fetch observation freshness expired/);
  assert.throws(() => createPlan(f.ctx, "merge", { graph: graph.id, node: "a", fetchObservation }),
    /Merge requires the current/);
  assert.throws(() => createPlan(f.ctx, "sync", { graph: graph.id,
    fetchObservation: { ...fetchObservation, sha: f.head } }), /rewound or rewritten/);
});

test("CLI pins the fetch-start observation in the approved plan rather than rereading it on apply", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  git(f.root, "branch", "main", f.base);
  git(f.root, "push", "-q", "upstream", "main");
  f.spec.target = "main";
  const startedAt = Date.now() - 60000;
  const spec = path.join(f.dir, "spec.json");
  const observation = path.join(f.dir, "fetch.json");
  const planPath = path.join(f.dir, "plan.json");
  fs.writeFileSync(spec, JSON.stringify(f.spec));
  fs.writeFileSync(observation, JSON.stringify({ target: "main", sha: f.base, startedAt }));
  const planned = cli(f.root, "plan", "split", "--spec", spec,
    "--fetch-observation", observation, "--out", planPath);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.graph.integration.verifiedAt, startedAt);
  fs.writeFileSync(observation, JSON.stringify({ target: "main", sha: f.base, startedAt: Date.now() }));
  const applied = cli(f.root, "apply", "--plan", planPath, "--yes", "--approve", plan.approval);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).graph.nodes[0].integration.verifiedAt, startedAt);
});

test("custom helper prefixes reject invalid refs and product branch collisions", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.spec.helperBranchPrefix = "user/test/bases/";
  assert.throws(() => createPlan(f.ctx, "split", { spec: f.spec }), /Invalid helper branch prefix/);
  f.spec.helperBranchPrefix = "user/test/../bases";
  assert.throws(() => createPlan(f.ctx, "split", { spec: f.spec }), /check-ref-format/);
  f.spec.helperBranchPrefix = "user/test/bases";
  f.spec.nodes[1].branch = "user/test/bases/a";
  assert.throws(() => createPlan(f.ctx, "split", { spec: f.spec }), /Product\/helper branch collision/);
  delete f.spec.nodes[1].branch;
  git(f.root, "update-ref", "refs/heads/user/test/bases/a", f.base);
  assert.throws(() => createPlan(f.ctx, "split", { spec: f.spec }), /existing refs are not implicitly adopted/);
});

test("graph over ten nodes and CLI help need no hosting tooling", (t) => {
  const f = fixture({ names: Array.from({ length: 11 }, (_, i) => `n${i}`) });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  assert.equal(graph.nodes.length, 11);
  assert.equal(tree(f.root, graph.combined), tree(f.root, f.head));
  assert.equal(cli(f.root, "help").status, 0);
  assert.equal(cli(f.root, "view", "--graph", "example").status, 0);
  assert.equal(cli(f.root, "plan", "sync", "--graph", "example", "--bogus", "x").status, 1);
});

test("CLI plans apply unchanged and installed skill copies resolve resources independently", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const spec = path.join(f.dir, "spec.json");
  const planPath = path.join(f.dir, "plan.json");
  fs.writeFileSync(spec, JSON.stringify(f.spec));
  const planned = cli(f.root, "plan", "split", "--spec", spec, "--out", planPath);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(cli(f.root, "apply", "--plan", planPath, "--yes", "--approve", plan.approval).status, 0);
  const original = path.resolve(import.meta.dirname, "../..");
  for (const agent of [".copilot", ".claude"]) {
    const installed = path.join(f.dir, agent, "skills", "pr-graph");
    fs.cpSync(original, installed, { recursive: true });
    const result = cli(f.root, "status", "--graph", "example");
    assert.equal(result.status, 0, result.stderr);
    const relocated = spawnSync(process.execPath, [
      path.join(installed, "scripts", "pr-graph.mjs"), "--repo", f.root, "check", "--graph", "example",
    ], { encoding: "utf8" });
    assert.equal(relocated.status, 0, relocated.stderr);
    assert.ok(fs.existsSync(path.join(installed, "references", "commands.md")));
  }
});

test("linked worktrees share graph state and locks", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const user = path.join(f.dir, "user worktree");
  git(f.root, "worktree", "add", user, "pr-graph/example/nodes/a");
  const linked = context(user);
  assert.equal(linked.common, f.ctx.common);
  assert.deepEqual(load(linked, "example"), load(f.ctx, "example"));
  lock(f.ctx, () => assert.throws(() => lock(linked, () => {}), /Repository locked/));
});

test("external local squash landing needs an exact approved mapping, not SHA guessing", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  const result = f.apply("split", { spec: f.spec });
  const a = result.graph.nodes.find((n) => n.id === "a");
  const landing = git(f.root, "commit-tree", tree(f.root, a.head), "-p", f.base, "-m", "External squash");
  git(f.root, "update-ref", "refs/heads/trunk", landing, f.base);
  const recorded = f.apply("record-landing", { graph: "example", node: "a", landing, strategy: "squash" });
  assert.equal(recorded.graph.nodes.find((n) => n.id === "a").landing.commit, landing);
  const synced = f.apply("sync", { graph: "example" });
  assert.deepEqual(synced.eligible, ["b"]);
  assert.equal(tree(f.root, synced.graph.combined), tree(f.root, f.head));
});
