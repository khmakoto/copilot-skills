import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import { createPlan, applyPlan, inspect } from "../lib/operations.mjs";
import { atomicJson, journalFile, readJson } from "../lib/state.mjs";

test("CLI reuse keeps the retained worktree and tooling, transfers ownership, and rejects old cleanup", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec });
  const cleanup = createPlan(f.ctx, "cleanup", {
    operation: original.operation, spec: { branches: [], worktree: true },
  });
  fs.appendFileSync(path.join(f.ctx.common, "info", "exclude"), "\nnode_modules/\n");
  const tool = path.join(original.worktree, "node_modules", "installed-tool");
  fs.mkdirSync(path.dirname(tool));
  fs.writeFileSync(tool, "retain installed tooling\n");
  const worktrees = () => git(f.root, "worktree", "list", "--porcelain")
    .split("\n").filter((line) => line.startsWith("worktree "));
  const originalWorktrees = worktrees();
  const planned = cli(f.root, "plan", "sync", "--graph", "example",
    "--reuse-worktree", original.operation);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.reuseWorktree.path, original.worktree);
  assert.equal(plan.reuseWorktree.head, git(original.worktree, "rev-parse", "HEAD"));
  const done = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(done.worktree, original.worktree);
  assert.equal(fs.readFileSync(tool, "utf8"), "retain installed tooling\n");
  assert.deepEqual(worktrees(), originalWorktrees);
  assert.equal(fs.existsSync(path.join(f.ctx.dir, "trees", done.operation)), false);
  assert.equal(readJson(journalFile(f.ctx, original.operation)).worktreeReusedBy, done.operation);
  assert.throws(() => createPlan(f.ctx, "cleanup", {
    operation: original.operation, spec: { branches: [], worktree: true },
  }), /transferred/);
  assert.throws(() => applyPlan(f.ctx, cleanup, cleanup.approval, true), /changed after recovery approval/);
  assert.throws(() => createPlan(f.ctx, "sync", {
    graph: "example", reuseWorktree: original.operation,
  }), /transferred/);
  const next = f.apply("sync", { graph: "example", reuseWorktree: done.operation });
  assert.equal(next.worktree, original.worktree);
  assert.equal(inspect(f.ctx, "example").operations.find((j) => j.id === next.operation).worktree,
    original.worktree);
  assert.equal(git(f.root, "branch", "--show-current"), "source");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
});

test("reuse resumes an interrupted ownership transfer without accepting a second owner", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec });
  const plan = createPlan(f.ctx, "sync", { graph: "example", reuseWorktree: original.operation });
  const source = readJson(journalFile(f.ctx, original.operation));
  atomicJson(journalFile(f.ctx, plan.approval), {
    id: plan.approval, plan, status: "running", local: {}, remote: {}, prs: {},
    commits: {}, pendingChange: null, remoteStarted: false,
  });
  source.worktreeReusedBy = plan.approval;
  atomicJson(journalFile(f.ctx, original.operation), source);
  assert.throws(() => createPlan(f.ctx, "sync", {
    graph: "example", reuseWorktree: original.operation,
  }), /transferred/);
  const done = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(done.worktree, original.worktree);
  assert.equal(readJson(journalFile(f.ctx, plan.approval)).worktreeReuseClaimed, true);
});

for (const kind of ["untracked", "unstaged", "staged", "attached"]) {
  test(`reuse refuses a retained worktree with ${kind} user work`, (t) => {
    const f = fixture({ names: ["a"] });
    t.after(() => f.dispose());
    const original = f.apply("split", { spec: f.spec });
    if (kind === "attached") git(original.worktree, "checkout", "-b", "user-work");
    else {
      fs.writeFileSync(path.join(original.worktree, kind === "untracked" ? "user.txt" : "shared.txt"),
        "preserve user work\n");
      if (kind === "staged") git(original.worktree, "add", "shared.txt");
    }
    assert.throws(() => createPlan(f.ctx, "sync", {
      graph: "example", reuseWorktree: original.operation,
    }), kind === "attached" ? /detached/ : /has changes/);
    assert.equal(readJson(journalFile(f.ctx, original.operation)).worktreeReusedBy, undefined);
    assert.ok(git(original.worktree, "status", "--porcelain") || kind === "attached");
  });
}

for (const change of ["HEAD", "untracked", "repository"]) {
  test(`reuse rechecks ${change} after planning and cannot clean an unclaimed source`, (t) => {
    const f = fixture({ names: ["a"] });
    t.after(() => f.dispose());
    const original = f.apply("split", { spec: f.spec });
    const plan = createPlan(f.ctx, "sync", { graph: "example", reuseWorktree: original.operation });
    if (change === "HEAD") git(original.worktree, "checkout", "--detach", f.base);
    else if (change === "untracked") fs.writeFileSync(path.join(original.worktree, "user.txt"), "keep\n");
    else {
      const foreign = fixture({ names: ["b"] });
      t.after(() => foreign.dispose());
      fs.writeFileSync(path.join(original.worktree, ".git"), `gitdir: ${foreign.ctx.common}\n`);
    }
    assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true),
      change === "HEAD" ? /HEAD changed/ : change === "untracked" ? /has changes/ : /another repository/);
    assert.equal(readJson(journalFile(f.ctx, original.operation)).worktreeReusedBy, undefined);
    f.apply("abort", { operation: plan.approval });
    assert.throws(() => createPlan(f.ctx, "cleanup", {
      operation: plan.approval, spec: { branches: [], worktree: true },
    }), /has not claimed/);
    assert.ok(fs.existsSync(original.worktree));
  });
}

test("reuse rejects running operations and resumes failed validation in the claimed worktree", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const marker = path.join(f.dir, "allow-validation");
  f.spec.nodes[0].validations = [{
    command: process.execPath,
    args: ["-e", "if (!require('node:fs').existsSync(process.argv[1])) process.exit(7)", marker],
  }];
  fs.writeFileSync(marker, "allowed\n");
  const original = f.apply("split", { spec: f.spec });
  fs.unlinkSync(marker);
  const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Advance target");
  git(f.root, "update-ref", "refs/heads/trunk", advanced, f.base);
  const plan = createPlan(f.ctx, "sync", { graph: "example", reuseWorktree: original.operation });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Validation failed/);
  assert.throws(() => createPlan(f.ctx, "sync", {
    graph: "example", reuseWorktree: plan.approval,
  }), /completed or explicitly aborted/);
  fs.writeFileSync(marker, "allowed again\n");
  const done = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(done.worktree, original.worktree);
  assert.equal(done.graph.targetSha, advanced);
  assert.ok(done.graph.nodes[0].validation);
  fs.unlinkSync(marker);
  const nextTarget = git(f.root, "commit-tree", `${advanced}^{tree}`, "-p", advanced, "-m", "Advance again");
  git(f.root, "update-ref", "refs/heads/trunk", nextTarget, advanced);
  const next = createPlan(f.ctx, "sync", { graph: "example", reuseWorktree: done.operation });
  assert.throws(() => applyPlan(f.ctx, next, next.approval, true), /Validation failed/);
  f.apply("abort", { operation: next.approval });
  fs.writeFileSync(marker, "allowed after abort\n");
  const recovered = f.apply("sync", { graph: "example", reuseWorktree: next.approval });
  assert.equal(recovered.worktree, original.worktree);
  assert.equal(recovered.graph.targetSha, nextTarget);
});

test("conflict resolution, continuation, and abort use the reused worktree path", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec });
  git(f.root, "checkout", "-b", "overlap", f.base);
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text([]).replace("a=0", "a=2"));
  git(f.root, "add", "shared.txt");
  git(f.root, "commit", "-qm", "Advance with overlapping change");
  const advanced = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "source");
  git(f.root, "update-ref", "refs/heads/trunk", advanced, f.base);
  const plan = createPlan(f.ctx, "sync", { graph: "example", reuseWorktree: original.operation });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /conflict/);
  const journal = readJson(journalFile(f.ctx, plan.approval));
  assert.equal(journal.pendingChange.worktree, original.worktree);
  fs.writeFileSync(path.join(original.worktree, "shared.txt"), f.text([]).replace("a=0", "a=3"));
  git(original.worktree, "add", "shared.txt");
  f.apply("resolve", { operation: plan.approval });
  const done = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(done.worktree, original.worktree);
  assert.match(git(f.root, "show", `${done.graph.combined}:shared.txt`), /a=3/);
  const next = createPlan(f.ctx, "sync", { graph: "example", reuseWorktree: done.operation });
  fs.writeFileSync(path.join(done.worktree, "user.txt"), "preserved\n");
  assert.throws(() => applyPlan(f.ctx, next, next.approval, true), /has changes/);
  const aborted = f.apply("abort", { operation: next.approval });
  assert.equal(aborted.retained, original.worktree);
  assert.equal(fs.readFileSync(path.join(original.worktree, "user.txt"), "utf8"), "preserved\n");
});
