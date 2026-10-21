import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import * as state from "../lib/state.mjs";
import { refId } from "../lib/git.mjs";

function checkpointFixture(t) {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const graph = f.apply("split", { spec: f.spec }).graph;
  const node = graph.nodes[0];
  git(f.root, "checkout", node.branch);
  fs.appendFileSync(path.join(f.root, "shared.txt"), "Session work\n");
  git(f.root, "add", "shared.txt");
  const spec = { id: graph.id, branch: "user/test/preservation-checkpoint",
    message: "Preserve session source\n\nCo-authored-by: Copilot <copilot@example.invalid>\n" };
  return { ...f, graph, node, spec,
    plan: () => createPlan(f.ctx, "checkpoint", { graph: graph.id, spec }) };
}

test("checkpoint commits exactly staged work with hooks while leaving graph branch and metadata intact", (t) => {
  const f = checkpointFixture(t);
  const hook = path.join(f.root, ".git", "hooks", "pre-commit");
  const marker = path.join(f.dir, "hook-ran");
  fs.writeFileSync(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  const patch = git(f.root, "diff", "--cached", "--binary", "--full-index");
  const plan = f.plan();
  assert.throws(() => createPlan(f.ctx, "checkpoint", { graph: f.graph.id, spec: f.spec, fetchObservation: {} }),
    /do not accept fetch-start observations/);
  assert.throws(() => applyPlan(f.ctx, plan, "wrong", true), /approval/);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(refId(f.root, `refs/heads/${f.node.branch}`), f.node.head);
  assert.deepEqual(state.load(f.ctx, f.graph.id), f.graph);
  assert.equal(git(f.root, "branch", "--show-current"), f.spec.branch);
  assert.equal(git(f.root, "diff", "--binary", "--full-index", f.node.head, result.commit), patch);
  assert.equal(git(f.root, "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(marker, "utf8"), "ran");
  assert.equal(applyPlan(f.ctx, plan, plan.approval, true).alreadyDone, true);
});

test("checkpoint blocks changed staged content and preserves unstaged or untracked work", (t) => {
  const f = checkpointFixture(t);
  const plan = f.plan();
  fs.appendFileSync(path.join(f.root, "shared.txt"), "Unstaged user work\n");
  assert.throws(f.plan, /unstaged work/);
  git(f.root, "add", "shared.txt");
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /staged content changed/);
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "Untracked user work");
  assert.throws(f.plan, /untracked work/);
  assert.equal(git(f.root, "branch", "--show-current"), f.node.branch);
});

test("failed checkpoint hooks retain staged work and retry through the same journal", (t) => {
  const f = checkpointFixture(t);
  const hook = path.join(f.root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  const plan = f.plan();
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /commit failed/);
  assert.equal(git(f.root, "branch", "--show-current"), f.spec.branch);
  assert.equal(refId(f.root, `refs/heads/${f.node.branch}`), f.node.head);
  assert.ok(git(f.root, "diff", "--cached", "--name-only"));
  assert.equal(state.readJson(state.journalFile(f.ctx, plan.approval)).status, "running");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.ok(result.commit);
  assert.equal(state.readJson(state.journalFile(f.ctx, plan.approval)).status, "done");
});

test("checkpoint refuses graph-owned helper and metadata branch names", (t) => {
  const f = checkpointFixture(t);
  for (const branch of [f.graph.backup.branch, `${f.graph.helperBranchPrefix}/${f.node.id}`]) {
    f.spec.branch = branch;
    assert.throws(f.plan, /cannot reuse a graph-owned branch/);
  }
  assert.equal(git(f.root, "branch", "--show-current"), f.node.branch);
});

test("CLI checkpoint plans preserve staged work through an approved continue after hook failure", (t) => {
  const f = checkpointFixture(t);
  const spec = path.join(f.dir, "checkpoint.json");
  const planPath = path.join(f.dir, "checkpoint-plan.json");
  fs.writeFileSync(spec, JSON.stringify(f.spec));
  const planned = cli(f.root, "plan", "checkpoint", "--graph", f.graph.id, "--spec", spec, "--out", planPath);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  const hook = path.join(f.root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  const failed = cli(f.root, "apply", "--plan", planPath, "--yes", "--approve", plan.approval);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Checkpoint operation/);
  fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const continued = cli(f.root, "continue", "--operation", plan.approval, "--yes", "--approve", plan.approval);
  assert.equal(continued.status, 0, continued.stderr);
  const result = JSON.parse(continued.stdout);
  assert.equal(result.branch, f.spec.branch);
  assert.equal(git(f.root, "rev-parse", `${result.commit}^`), f.node.head);
  assert.equal(refId(f.root, `refs/heads/${f.node.branch}`), f.node.head);
  assert.deepEqual(state.load(f.ctx, f.graph.id), f.graph);
});
