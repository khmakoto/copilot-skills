import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import { createPlan, applyPlan, inspect } from "../lib/operations.mjs";
import { atomicJson, journalFile, readJson } from "../lib/state.mjs";

test("worktree transfer reuses exact reconstruction receipts without rerunning commit hooks", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  const count = path.join(f.dir, "commit-count");
  const hook = path.join(f.ctx.common, "hooks", "pre-commit");
  fs.writeFileSync(hook, `#!/bin/sh\nprintf 'commit\\n' >> ${JSON.stringify(count)}\n`, { mode: 0o755 });
  const original = f.apply("split", { spec: f.spec });
  const before = fs.readFileSync(count, "utf8");
  const done = f.apply("fold", {
    graph: "example", spec: f.spec, reuseWorktree: original.operation,
  });
  assert.equal(fs.readFileSync(count, "utf8"), before);
  const journal = readJson(journalFile(f.ctx, done.operation));
  assert.ok(journal.reconstruction.inheritedCached > 0);
  assert.equal(journal.reconstruction.applied, 0);
  assert.equal(git(f.root, "rev-parse", `${done.graph.combined}^{tree}`),
    git(f.root, "rev-parse", `${f.head}^{tree}`));
  assert.equal(git(f.root, "branch", "--show-current"), "source");
  assert.equal(git(f.root, "status", "--porcelain"), "");

  fs.appendFileSync(hook, "# changed hook context\n");
  const changed = f.apply("fold", {
    graph: "example", spec: f.spec, reuseWorktree: done.operation,
  });
  assert.notEqual(fs.readFileSync(count, "utf8"), before);
  assert.ok(readJson(journalFile(f.ctx, changed.operation)).reconstruction.applied > 0);
});

test("changed commit messages and integration parents do not reuse old reconstruction recipes", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec });
  const spec = { ...f.spec, nodes: f.spec.nodes.map((node) =>
    ({ ...node, title: `${node.title} with revised metadata` })) };
  const changed = f.apply("fold", { graph: "example", spec, reuseWorktree: original.operation });
  assert.ok(readJson(journalFile(f.ctx, changed.operation)).reconstruction.applied > 0);
  git(f.root, "checkout", "trunk");
  fs.writeFileSync(path.join(f.root, "main.txt"), "new target content\n");
  git(f.root, "add", "main.txt");
  git(f.root, "commit", "-qm", "Advance target");
  git(f.root, "checkout", "source");
  const synced = f.apply("sync", { graph: "example", reuseWorktree: changed.operation });
  assert.ok(readJson(journalFile(f.ctx, synced.operation)).reconstruction.applied > 0);
  assert.equal(git(f.root, "show", `${synced.graph.combined}:main.txt`), "new target content");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
});

test("corrupt reconstruction receipts cannot be transferred as valid cached results", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec });
  const file = journalFile(f.ctx, original.operation);
  const source = readJson(file);
  const receipt = Object.values(source.reconstructionReceipts)[0];
  receipt.tree = git(f.root, "rev-parse", `${f.base}^{tree}`);
  atomicJson(file, source);
  assert.throws(() => f.apply("fold", {
    graph: "example", spec: f.spec, reuseWorktree: original.operation,
  }), /receipt no longer matches/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("unknown hook layouts disable inherited caching without disabling local reconstruction", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  fs.mkdirSync(path.join(f.ctx.common, "hooks", "external-tooling"));
  const original = f.apply("split", { spec: f.spec });
  const source = readJson(journalFile(f.ctx, original.operation));
  assert.ok(Object.values(source.reconstructionReceipts).every((receipt) =>
    receipt.recipe.execution === null));
  const done = f.apply("fold", {
    graph: "example", spec: f.spec, reuseWorktree: original.operation,
  });
  const journal = readJson(journalFile(f.ctx, done.operation));
  assert.equal(journal.reconstruction.inheritedCached, 0);
  assert.ok(journal.reconstruction.applied > 0);
  assert.ok(journal.reconstruction.cached > 0);
  assert.equal(git(f.root, "rev-parse", `${done.graph.combined}^{tree}`),
    git(f.root, "rev-parse", `${f.head}^{tree}`));
});

test("legacy retained journals transfer ownership but no unverified reconstruction cache", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec });
  const file = journalFile(f.ctx, original.operation);
  const source = readJson(file);
  delete source.commitCacheVersion;
  delete source.reconstructionReceipts;
  atomicJson(file, source);
  const done = f.apply("fold", {
    graph: "example", spec: f.spec, reuseWorktree: original.operation,
  });
  const journal = readJson(journalFile(f.ctx, done.operation));
  assert.equal(journal.reconstruction.inheritedCached, 0);
  assert.ok(journal.reconstruction.applied > 0);
  assert.equal(readJson(file).worktreeReusedBy, done.operation);
  assert.equal(git(f.root, "rev-parse", `${done.graph.combined}^{tree}`),
    git(f.root, "rev-parse", `${f.head}^{tree}`));
});

for (const kind of ["tree", "blob", "target-blob"]) {
  test(`prefix reuse refuses a missing ${kind} even with a complete final tree`, (t) => {
    const f = fixture({ names: ["a", "b", "c"] });
    t.after(() => f.dispose());
    for (const [i, node] of f.spec.nodes.entries()) {
      node.dependencies = i ? [f.spec.nodes[i - 1].id] : [];
    }
    const original = f.apply("split", { spec: f.spec });
    const plan = createPlan(f.ctx, "fold", {
      graph: "example", spec: f.spec, reuseWorktree: original.operation,
    });
    const intermediate = original.graph.nodes[1].head;
    const snapshot = kind === "target-blob" ? f.base : intermediate;
    const object = git(f.root, "rev-parse",
      kind === "tree" ? `${snapshot}^{tree}` : `${snapshot}:shared.txt`);
    fs.unlinkSync(path.join(f.ctx.common, "objects", object.slice(0, 2), object.slice(2)));
    assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true),
      /missing|bad tree|unable to read tree|rev-parse failed/i);
    for (const node of original.graph.nodes) {
      assert.equal(git(f.root, "rev-parse", node.branch), node.head);
    }
    assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
  });
}

test("a corrupt ordered prefix cannot be transferred with otherwise valid commit receipts", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.spec.nodes[1].dependencies = ["a"];
  const original = f.apply("split", { spec: f.spec });
  const file = journalFile(f.ctx, original.operation);
  const source = readJson(file);
  Object.values(source.compositionPrefixes).at(-1).recipe.input.message += " changed";
  atomicJson(file, source);
  assert.throws(() => f.apply("fold", {
    graph: "example", spec: f.spec, reuseWorktree: original.operation,
  }), /Invalid composition prefix/);
  assert.equal(readJson(file).worktreeReusedBy, undefined);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
});

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

test("CLI add and fold reuse the latest worktree owner while preserving source, tooling, and validation", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec });
  fs.appendFileSync(path.join(f.ctx.common, "info", "exclude"), "\nnode_modules/\n");
  const tool = path.join(original.worktree, "node_modules", "installed-tool");
  fs.mkdirSync(path.dirname(tool));
  fs.writeFileSync(tool, "keep tooling\n");
  const worktrees = () => git(f.root, "worktree", "list", "--porcelain")
    .split("\n").filter((line) => line.startsWith("worktree "));
  const retainedWorktrees = worktrees();
  const extra = "follow-on change\n";
  fs.writeFileSync(path.join(f.root, "extra.txt"), extra);
  git(f.root, "add", "extra.txt");
  git(f.root, "commit", "-qm", "Additional source");
  const head = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "-qb", "input-b-extra", f.changes.b.head);
  fs.writeFileSync(path.join(f.root, "extra.txt"), extra);
  git(f.root, "add", "extra.txt");
  git(f.root, "commit", "-qm", "Folded owner source");
  const ownerHead = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "source");
  const marker = path.join(f.dir, "validated-in");
  const validations = [{
    command: process.execPath,
    args: ["-e",
      "const fs=require('node:fs'); fs.accessSync('extra.txt'); fs.writeFileSync(process.argv[1],process.cwd())",
      marker],
  }];
  const addSpec = {
    ...f.spec, source: { base: f.base, head },
    nodes: [...f.spec.nodes, {
      id: "extra", title: "Additional source", dependencies: ["a", "b"],
      change: { base: f.head, head }, validations,
    }],
  };
  const foldSpec = {
    id: "example", source: { base: f.base, head },
    nodes: [f.spec.nodes[0], {
      ...f.spec.nodes[1], supersedes: ["extra"],
      change: { base: f.base, head: ownerHead }, validations,
    }],
  };
  let owner = original.operation;
  for (const [action, spec] of [["add", addSpec], ["fold", foldSpec]]) {
    const userFile = path.join(original.worktree, "user.txt");
    fs.writeFileSync(userFile, "preserve untracked work\n");
    assert.throws(() => createPlan(f.ctx, action, {
      graph: "example", spec, reuseWorktree: owner,
    }), /has changes/);
    assert.equal(readJson(journalFile(f.ctx, owner)).worktreeReusedBy, undefined);
    fs.unlinkSync(userFile);
    const specFile = path.join(f.dir, `${action}-spec.json`);
    fs.writeFileSync(specFile, JSON.stringify(spec));
    const planned = cli(f.root, "plan", action, "--graph", "example",
      "--spec", specFile, "--reuse-worktree", owner);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.reuseWorktree.path, original.worktree);
    const done = applyPlan(f.ctx, plan, plan.approval, true);
    assert.equal(done.worktree, original.worktree);
    assert.deepEqual(worktrees(), retainedWorktrees);
    assert.equal(git(f.root, "rev-parse", `${done.graph.combined}^{tree}`),
      git(f.root, "rev-parse", `${head}^{tree}`));
    assert.equal(fs.readFileSync(tool, "utf8"), "keep tooling\n");
    assert.equal(fs.readFileSync(marker, "utf8"), original.worktree);
    fs.unlinkSync(marker);
    assert.equal(readJson(journalFile(f.ctx, owner)).worktreeReusedBy, done.operation);
    assert.throws(() => createPlan(f.ctx, "cleanup", {
      operation: owner, spec: { branches: [], worktree: true },
    }), /transferred/);
    if (action === "fold") {
      assert.deepEqual(done.graph.nodes.filter((n) => !n.retired).map((n) => n.id), ["a", "b"]);
      assert.deepEqual(done.graph.nodes.find((n) => n.id === "extra").replacedBy, ["b"]);
    }
    owner = done.operation;
  }
  assert.equal(git(f.root, "branch", "--show-current"), "source");
  assert.equal(git(f.root, "rev-parse", "HEAD"), head);
  assert.equal(git(f.root, "status", "--porcelain"), "");
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
      const gitFile = path.join(original.worktree, ".git");
      // Git hides this file on Windows, where opening it with "w" fails.
      fs.truncateSync(gitFile, 0);
      fs.writeFileSync(gitFile, `gitdir: ${foreign.ctx.common}\n`, { flag: "r+" });
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
