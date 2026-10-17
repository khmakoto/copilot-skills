import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, git, cli } from "./fixtures.mjs";
import { tree, context } from "../lib/git.mjs";
import { load, lock } from "../lib/state.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";

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
