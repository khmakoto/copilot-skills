import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fixture, git } from "./fixtures.mjs";
import { context, tree, refId } from "../lib/git.mjs";
import { createPlan, applyPlan, inspect } from "../lib/operations.mjs";
import { load, graphFile } from "../lib/state.mjs";

test("remote snapshot restores full DAG and committed no-PR changes in another clone", (t) => {
  const f = fixture({ remote: true });
  t.after(() => f.dispose());
  f.spec.backup = { enabled: true, branch: "pr-graph/example/metadata" };
  f.apply("split", { spec: f.spec });
  const saved = f.apply("backup", { graph: "example" });
  assert.ok(saved.graph.backup.head);
  assert.ok(saved.graph.nodes.every((n) => !n.pr));
  const second = path.join(f.dir, "second clone");
  git(f.dir, "clone", "-q", f.bare, second);
  git(second, "config", "user.name", "Second Test");
  git(second, "config", "user.email", "second@example.invalid");
  git(second, "config", "commit.gpgsign", "false");
  const ctx = context(second);
  const download = createPlan(ctx, "fetch-backup", { graph: "example", remote: "origin" });
  const fetched = applyPlan(ctx, download, download.approval, true);
  const plan = createPlan(ctx, "restore", { graph: "example", remote: "origin", backupRef: fetched.downloaded });
  const result = applyPlan(ctx, plan, plan.approval, true);
  assert.equal(result.graph.nodes.length, 6);
  assert.equal(tree(second, result.graph.combined), tree(second, f.head));
  assert.deepEqual(result.graph.nodes.map((n) => n.dependencies), saved.graph.nodes.map((n) => n.dependencies));
  assert.ok(result.graph.nodes.every((n) => n.validations.length === 0 && n.validation === null));
  assert.equal(result.graph.backup.head, saved.graph.backup.head);
  f.apply("backup", { graph: "example" });
  assert.throws(() => createPlan(ctx, "backup", { graph: "example" }), /metadata advanced/);
});

test("failed validation retains journal; explicit abort preserves source and new resources", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.spec.nodes[0].validations = [{ command: process.execPath, args: ["-e", "process.exit(7)"] }];
  assert.throws(() => f.apply("split", { spec: f.spec }), /Validation failed/);
  const pending = inspect(f.ctx, "example").operations[0];
  assert.equal(pending.status, "running");
  assert.equal(refId(f.root, "refs/heads/pr-graph/example/nodes/a"), null);
  f.apply("abort", { operation: pending.id });
  assert.equal(git(f.root, "branch", "--show-current"), "source");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
  assert.ok(fs.existsSync(pending.worktree));
});

test("conflicts require a staged resolution approval and resume without losing work", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  git(f.root, "checkout", "-qb", "overlap", f.base);
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text([]).replace("a=0", "a=2"));
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "overlapping change");
  const other = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "source");
  f.spec.source = undefined;
  f.spec.nodes[1].change = { base: f.base, head: other };
  f.spec.nodes[1].dependencies = ["a"];
  const original = createPlan(f.ctx, "init", { spec: f.spec });
  assert.throws(() => applyPlan(f.ctx, original, original.approval, true), /conflict/);
  const pending = inspect(f.ctx, "example").operations[0];
  assert.ok(pending.pending);
  fs.writeFileSync(path.join(pending.worktree, "shared.txt"), f.text([]).replace("a=0", "a=2"));
  git(pending.worktree, "add", "shared.txt");
  const resolution = createPlan(f.ctx, "resolve", { operation: original.approval });
  applyPlan(f.ctx, resolution, resolution.approval, true);
  const done = applyPlan(f.ctx, original, original.approval, true);
  assert.equal(done.graph.nodes.length, 2);
  assert.ok(git(f.root, "show", `${done.graph.combined}:shared.txt`).includes("a=2"));
});

test("corrupt state fails loudly and missing reconstruction content never publishes", (t) => {
  const f = fixture({ names: ["a", "b"], remote: true });
  t.after(() => f.dispose());
  f.spec.nodes = f.spec.nodes.slice(0, 1);
  assert.throws(() => f.apply("split", { spec: f.spec }), /not lossless/);
  assert.equal(git(f.root, "ls-remote", "--heads", "upstream", "pr-graph/example/nodes/a"), "");
  const pending = inspect(f.ctx, "example").operations[0];
  f.apply("abort", { operation: pending.id });
  f.spec.nodes.push({
    id: "b", title: "Implement b", dependencies: [], change: f.changes.b,
    validationReason: "No build system.",
  });
  f.apply("split", { spec: f.spec });
  fs.writeFileSync(graphFile(f.ctx, "example"), "{corrupt");
  assert.throws(() => load(f.ctx, "example"), /Cannot read/);
});

test("live locks cannot be broken and dead same-host locks require exact approval", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  fs.mkdirSync(f.ctx.dir, { recursive: true });
  const file = path.join(f.ctx.dir, "mutation.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "live" }));
  assert.throws(() => createPlan(f.ctx, "unlock"), /still alive/);
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, host: os.hostname(), token: "dead" }));
  const plan = createPlan(f.ctx, "unlock");
  applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(fs.existsSync(file), false);
});

test("non-atomic push fallback requires approved disclosure and resumes partial writes", (t) => {
  const f = fixture({ names: ["a", "b"], remote: true });
  t.after(() => f.dispose());
  git(f.root, `--git-dir=${f.bare}`, "config", "receive.advertiseAtomic", "false");
  f.apply("split", { spec: f.spec });
  let plan = createPlan(f.ctx, "publish", { graph: "example" });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Push failed/);
  f.apply("abort", { operation: plan.approval });
  const hook = path.join(f.bare, "hooks", "update");
  fs.writeFileSync(hook, "#!/bin/sh\ncase \"$1\" in */nodes/b) echo rejected >&2; exit 1;; esac\nexit 0\n", { mode: 0o755 });
  plan = createPlan(f.ctx, "publish", { graph: "example", allowNonAtomic: true });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /rejected/);
  assert.ok(git(f.root, "ls-remote", "--heads", "upstream", "pr-graph/example/nodes/a"));
  assert.equal(git(f.root, "ls-remote", "--heads", "upstream", "pr-graph/example/nodes/b"), "");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const done = applyPlan(f.ctx, plan, plan.approval, true);
  assert.ok(done.graph);
  assert.ok(git(f.root, "ls-remote", "--heads", "upstream", "pr-graph/example/nodes/b"));
});

test("hook rewrites are errors rather than success-shaped source changes", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const hook = path.join(f.root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nprintf '\\nhook rewrite\\n' >> shared.txt\ngit add shared.txt\n", { mode: 0o755 });
  assert.throws(() => f.apply("split", { spec: f.spec }), /hooks changed the approved tree/);
  assert.equal(refId(f.root, "refs/heads/pr-graph/example/nodes/a"), null);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
});

test("a landing snapshot restores even before descendants have been synced", (t) => {
  const f = fixture({ names: ["a", "b"], remote: true });
  t.after(() => f.dispose());
  f.spec.backup = { enabled: true, branch: "pr-graph/example/metadata" };
  f.apply("split", { spec: f.spec });
  f.apply("ready", { graph: "example", node: "b" });
  const merged = f.apply("merge", { graph: "example", node: "b", strategy: "squash" });
  const second = path.join(f.dir, "after landing");
  git(f.dir, "clone", "-q", f.bare, second);
  git(second, "config", "user.name", "Restore Test");
  git(second, "config", "user.email", "restore@example.invalid");
  git(second, "config", "commit.gpgsign", "false");
  const ctx = context(second);
  const download = createPlan(ctx, "fetch-backup", { graph: "example", remote: "origin" });
  applyPlan(ctx, download, download.approval, true);
  const restore = createPlan(ctx, "restore", {
    graph: "example", remote: "origin", backupRef: merged.graph.backup.head,
  });
  const result = applyPlan(ctx, restore, restore.approval, true);
  assert.ok(result.graph.nodes.find((n) => n.id === "b").landing);
  assert.ok(result.graph.nodes.every((n) => n.ready === false));
});
