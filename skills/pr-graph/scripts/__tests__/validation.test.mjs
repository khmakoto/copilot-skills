import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import { digest } from "../lib/graph.mjs";
import { createPlan, applyPlan, inspect } from "../lib/operations.mjs";
import * as state from "../lib/state.mjs";
import { history } from "../lib/history.mjs";

const command = (script) => ({ command: process.execPath, args: ["-e", script] });
const apply = (f, plan) => applyPlan(f.ctx, plan, plan.approval, true);
const planValidation = (f, selector = "unpublished") => createPlan(f.ctx, "validate", { graph: "example", selector });
const journal = (f, plan) => state.readJson(state.journalFile(f.ctx, plan.approval));

function configure(f, checks) {
  const graph = state.load(f.ctx, "example");
  for (const [id, commands] of Object.entries(checks)) {
    const node = graph.nodes.find((n) => n.id === id);
    node.validations = commands;
    node.validationReason = commands.length ? null : "Documentation-only fixture; no automated check applies.";
    node.validation = { head: node.head, commands: digest(commands), reason: node.validationReason };
  }
  state.save(f.ctx, graph);
  return graph;
}

function productState(f) {
  return {
    refs: git(f.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/remotes/"),
    remote: f.bare ? git(f.root, "ls-remote", "--heads", "upstream") : null,
    head: git(f.root, "rev-parse", "HEAD"), branch: git(f.root, "symbolic-ref", "HEAD"),
    index: fs.readFileSync(path.join(f.root, ".git", "index")).toString("base64"),
    status: git(f.root, "status", "--porcelain", "--untracked-files=all"),
    content: fs.readFileSync(path.join(f.root, "shared.txt"), "utf8"),
  };
}

test("standalone validation pins multi-parent selection, aggregates check failures, and preserves product state", (t) => {
  const f = fixture({ remote: true });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const before = configure(f, {
    a: [command("console.log('first failure'); console.error('diagnostic'); process.exit(2)"), command("console.log('a continued')")],
    c: [command("process.exit(3)"), command("process.exit(4)")],
    f: [command("console.log(require('node:fs').readFileSync('shared.txt', 'utf8'))")],
  });
  const occupied = path.join(f.dir, "occupied-node");
  git(f.root, "worktree", "add", occupied, before.nodes[0].branch);
  fs.appendFileSync(path.join(f.root, "shared.txt"), "staged source\n");
  git(f.root, "add", "shared.txt");
  fs.appendFileSync(path.join(f.root, "shared.txt"), "unstaged source\n");
  fs.writeFileSync(path.join(f.root, "personal.txt"), "untracked source\n");
  const original = productState(f);
  const plan = planValidation(f, "dependents:a");
  assert.deepEqual(plan.validationSelection.nodes, ["a", "c", "f"]);
  assert.deepEqual(plan.validationInputs.map((n) => n.head), ["a", "c", "f"].map((id) => before.nodes.find((n) => n.id === id).head));
  assert.deepEqual(plan.outboundScope, []);
  assert.deepEqual(productState(f), original);
  const result = apply(f, plan);
  assert.equal(result.validation.success, false);
  assert.deepEqual(result.validation.results.map((r) => r.status), ["failed", "failed", "passed"]);
  assert.deepEqual(result.validation.results.map((r) => r.checks.map((c) => c.exitCode)), [[2, 0], [3, 4], [0]]);
  assert.match(result.validation.results[0].checks[0].stderr, /diagnostic/);
  assert.match(result.validation.results[0].checks[1].stdout, /a continued/);
  assert.equal(result.validation.results[2].checks[0].stdout.replace(/\r\n/g, "\n").trim(), f.text(["a", "b", "c", "d", "e", "f"]).trim());
  assert.equal(new Set(result.validation.results.map((r) => r.worktree)).size, 3);
  for (const r of result.validation.results) assert.equal(git(r.worktree, "rev-parse", "HEAD"), r.head);
  assert.equal(result.graph.nodes.find((n) => n.id === "a").validation, null);
  assert.equal(result.graph.nodes.find((n) => n.id === "c").validation, null);
  assert.equal(result.graph.nodes.find((n) => n.id === "f").validation.source, "executed");
  for (const id of ["b", "d", "e"]) assert.deepEqual(result.graph.nodes.find((n) => n.id === id), before.nodes.find((n) => n.id === id));
  assert.deepEqual(result.graph.integration, before.integration);
  assert.equal(result.graph.combined, before.combined);
  assert.deepEqual(productState(f), original);
  assert.equal(fs.readFileSync(path.join(f.root, "personal.txt"), "utf8"), "untracked source\n");
  assert.equal(git(occupied, "status", "--porcelain"), "");
  assert.equal(journal(f, plan).status, "done");
  assert.equal(history(f.ctx, "example", "f").events.at(-1).validation.source, "executed");
});

test("validation plans require exact approval; completed apply reuses receipts while new plans intentionally rerun", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, { a: [command("console.log(process.pid)")] });
  const plan = planValidation(f, "node:a");
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, false), /approval/);
  assert.throws(() => applyPlan(f.ctx, plan, "wrong", true), /approval/);
  const changed = structuredClone(plan);
  changed.validationInputs[0].commands[0].args.push("not approved");
  assert.throws(() => apply(f, changed), /approval/);
  assert.equal(state.readJson(state.journalFile(f.ctx, plan.approval), true), null);
  const first = apply(f, plan);
  assert.equal(first.validation.results[0].checks[0].source, "executed");
  const again = apply(f, plan);
  assert.equal(again.alreadyDone, true);
  assert.equal(again.validation.results[0].checks[0].source, "retained-operation");
  const rerun = planValidation(f, "node:a");
  assert.notEqual(rerun.approval, plan.approval);
  const second = apply(f, rerun);
  assert.equal(second.validation.results[0].checks[0].source, "executed");
  assert.notEqual(second.validation.results[0].checks[0].stdout, first.validation.results[0].checks[0].stdout);
  assert.throws(() => apply(f, plan), /no longer current/);
});

test("persisted finalization resumes without rerunning checks and never resurrects an explicitly aborted journal", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, { a: [command("console.log(process.pid)")] });
  const plan = planValidation(f);
  const first = apply(f, plan);
  const interrupted = journal(f, plan);
  interrupted.status = "running";
  state.atomicJson(state.journalFile(f.ctx, plan.approval), interrupted);
  const resumed = apply(f, plan);
  assert.equal(resumed.alreadyDone, true);
  assert.equal(resumed.validation.results[0].checks[0].stdout, first.validation.results[0].checks[0].stdout);
  assert.equal(journal(f, plan).status, "done");
  state.atomicJson(state.journalFile(f.ctx, plan.approval), interrupted);
  f.apply("abort", { operation: plan.approval });
  assert.throws(() => apply(f, plan), /aborted/);
  assert.equal(journal(f, plan).status, "aborted");
});

test("dirty validation output is retained, skips contaminated checks, and does not contaminate another node", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, {
    a: [command("require('node:fs').writeFileSync('generated.txt', 'retain diagnostic'); console.log('kept output'); process.exit(7)"), command("throw new Error('must not run')")],
    b: [command("if (require('node:fs').existsSync('generated.txt')) process.exit(8); console.log('isolated')")],
  });
  const original = productState(f);
  const plan = planValidation(f);
  const result = apply(f, plan);
  const [a, b] = result.validation.results;
  assert.deepEqual(a.checks.map((c) => c.status), ["dirty", "skipped"]);
  assert.equal(a.checks[0].exitCode, 7);
  assert.match(a.checks[0].stdout, /kept output/);
  assert.match(a.checks[0].dirty, /generated.txt/);
  assert.equal(a.checks[1].source, "not-executed");
  assert.equal(b.status, "passed");
  assert.notEqual(a.worktree, b.worktree);
  assert.equal(fs.readFileSync(path.join(a.worktree, "generated.txt"), "utf8"), "retain diagnostic");
  assert.equal(result.graph.nodes[0].validation, null);
  assert.deepEqual(productState(f), original);
  const status = inspect(f.ctx, "example").operations.find((o) => o.id === plan.approval);
  assert.deepEqual(status.worktrees, [a.worktree, b.worktree]);
  assert.equal(status.validationResults[0].status, "dirty");
  const cleanup = { operation: plan.approval, spec: { branches: [], worktree: true } };
  assert.throws(() => createPlan(f.ctx, "cleanup", cleanup), /output remains dirty/);
  fs.unlinkSync(path.join(a.worktree, "generated.txt"));
  const cleanPlan = createPlan(f.ctx, "cleanup", cleanup);
  fs.writeFileSync(path.join(b.worktree, "late.txt"), "preserve this too");
  assert.throws(() => apply(f, cleanPlan), /changed after approval/);
  assert.ok(fs.existsSync(a.worktree));
  fs.unlinkSync(path.join(b.worktree, "late.txt"));
  apply(f, createPlan(f.ctx, "cleanup", cleanup));
  assert.ok(!fs.existsSync(a.worktree) && !fs.existsSync(b.worktree));
  assert.deepEqual(productState(f), original);
});

test("no-check rationales, stale branches, missing objects and restored configuration are distinct non-executions", (t) => {
  const f = fixture({ names: ["a", "b", "c", "d"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const graph = configure(f, { a: [], b: [], c: [command("process.exit(0)")], d: [] });
  graph.nodes[1].validationReason = null;
  graph.nodes[2].head = "f".repeat(40);
  state.save(f.ctx, graph);
  git(f.root, "update-ref", `refs/heads/${graph.nodes[3].branch}`, f.base);
  const original = productState(f);
  const plan = planValidation(f);
  assert.deepEqual(plan.validationInputs.map((n) => n.input.status), ["current", "unavailable", "unavailable", "stale"]);
  const result = apply(f, plan);
  assert.deepEqual(result.validation.results.map((r) => r.status), ["no-check", "unavailable", "unavailable", "stale"]);
  assert.equal(result.validation.results[0].reason, graph.nodes[0].validationReason);
  assert.equal(result.validation.results[0].source, "explicit-reason");
  assert.equal(result.graph.nodes[0].validation.source, "explicit-reason");
  assert.ok(result.validation.results.every((r) => !r.worktree && !r.checks.length));
  assert.deepEqual(productState(f), original);
});

for (const drift of ["head", "graph", "target", "remote", "policy"]) {
  test(`pinned ${drift} drift blocks validation before any check executes`, (t) => {
    const f = fixture({ remote: true, names: ["a"] });
    t.after(() => f.dispose());
    f.apply("split", { spec: f.spec });
    const before = configure(f, { a: [command("throw new Error('must not execute')")] });
    const plan = planValidation(f);
    if (drift === "head") git(f.root, "update-ref", `refs/heads/${before.nodes[0].branch}`, f.base);
    if (drift === "target") git(f.root, "push", "upstream", `${f.head}:refs/heads/trunk`);
    if (drift === "remote") git(f.root, "remote", "set-url", "upstream", path.join(f.dir, "missing.git"));
    if (drift === "graph") {
      before.nodes[0].validations = [command("process.exit(0)")];
      state.save(f.ctx, before);
    }
    if (drift === "policy") f.apply("publication-policy", { graph: "example", spec: { exclude: ["a"], release: [], reason: "Keep local" } });
    assert.throws(() => apply(f, plan), /changed|fresh plan/i);
    const record = state.readJson(state.journalFile(f.ctx, plan.approval), true);
    assert.ok(!record || record.validationResults.every((r) => !r.worktree && !r.checks.length));
    if (record) f.apply("abort", { operation: plan.approval });
  });
}

test("freshness grace is rechecked without renewing integration or silently syncing", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  let clock = Date.UTC(2026, 10, 18);
  f.ctx.now = () => clock;
  git(f.root, "branch", "main", f.base);
  git(f.root, "push", "upstream", "main");
  f.spec.target = "main";
  f.apply("split", { spec: f.spec });
  const graph = configure(f, { a: [command("process.exit(0)")] });
  const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Forward target");
  git(f.root, "push", "upstream", `${advanced}:refs/heads/main`);
  const plan = planValidation(f);
  assert.equal(plan.freshness.a.integration.status, "grace");
  assert.deepEqual(apply(f, plan).graph.integration, graph.integration);
  const expires = planValidation(f);
  clock += 10800000;
  assert.throws(() => apply(f, expires), /freshness changed/);
  assert.ok(!journal(f, expires).validationResults[0].worktree);
  f.apply("abort", { operation: expires.approval });
  const stale = apply(f, planValidation(f));
  assert.equal(stale.validation.results[0].status, "stale");
  assert.deepEqual(stale.graph.integration, graph.integration);
  assert.equal(git(f.root, "rev-parse", "main"), f.base);
});

test("unsafe command ref changes stop unrelated checks and retain exact command diagnostics", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, {
    a: [command(`require('node:child_process').execFileSync('git', ['update-ref', 'refs/heads/trunk', '${f.head}']); console.log('ref changed')`)],
    b: [command("throw new Error('must not execute')")],
  });
  const before = digest(state.load(f.ctx, "example"));
  const plan = planValidation(f);
  assert.throws(() => apply(f, plan), /observations changed/);
  const record = journal(f, plan);
  assert.equal(record.status, "running");
  assert.match(record.validationResults[0].checks[0].stdout, /ref changed/);
  assert.equal(record.validationResults[1].checks.length, 0);
  assert.ok(record.pendingValidation);
  assert.equal(digest(state.load(f.ctx, "example")), before);
  for (const action of ["resolve", "reconcile"]) assert.throws(() => createPlan(f.ctx, action, { operation: plan.approval }), /no reconstruction or remote effects/);
  f.apply("abort", { operation: plan.approval });
  assert.equal(git(f.root, "rev-parse", "trunk"), f.head);
  assert.throws(() => apply(f, plan), /aborted/);
});

test("uncertain command termination cannot be blindly resumed; explicit abort retains the worktree", { skip: process.platform === "win32" }, (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, { a: [command("console.log('before signal'); process.kill(process.pid, 'SIGTERM')")] });
  const plan = planValidation(f);
  assert.throws(() => apply(f, plan), /terminated by a signal/);
  const record = journal(f, plan);
  assert.match(record.validationResults[0].checks[0].stdout, /before signal/);
  assert.equal(record.validationResults[0].checks[0].status, "uncertain");
  assert.throws(() => apply(f, plan), /uncertain outcome/);
  assert.equal(journal(f, plan).validationResults[0].checks.length, 1);
  const abort = f.apply("abort", { operation: plan.approval });
  assert.ok(fs.existsSync(abort.worktrees[0]));
  assert.equal(journal(f, plan).status, "aborted");
});

test("failed checkout hooks retain the worktree and cannot be bypassed by continuing a clean checkout", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, { a: [command("throw new Error('must not execute')")] });
  const hook = path.join(f.ctx.common, "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\necho checkout-hook-failed >&2\nexit 7\n", { mode: 0o755 });
  const plan = planValidation(f);
  assert.throws(() => apply(f, plan), /checkout-hook-failed/);
  const record = journal(f, plan);
  assert.ok(record.pendingValidationWorktree);
  assert.equal(record.validationResults[0].checks.length, 0);
  assert.equal(git(record.validationResults[0].worktree, "status", "--porcelain"), "");
  assert.throws(() => apply(f, plan), /uncertain outcome or failed hook/);
  assert.equal(journal(f, plan).validationResults[0].checks.length, 0);
  const aborted = f.apply("abort", { operation: plan.approval });
  assert.ok(fs.existsSync(aborted.worktrees[0]));
  assert.equal(fs.readFileSync(hook, "utf8"), "#!/bin/sh\necho checkout-hook-failed >&2\nexit 7\n");
});

test("unavailable executables are reported without abandoning other clean checks", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, { a: [{ command: path.join(f.dir, "missing-executable"), args: [] }, command("console.log('still ran')")] });
  const result = apply(f, planValidation(f));
  assert.deepEqual(result.validation.results[0].checks.map((c) => c.status), ["unavailable", "passed"]);
  assert.equal(result.graph.nodes[0].validation, null);
});

test("safe continuation reuses only durable same-operation checks and never performs hosting writes", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, { a: [command("console.log(process.pid)")], b: [command("console.log('b executed')")] });
  let outage = false;
  let operation;
  f.ctx.providerFactory = () => ({
    kind: "github",
    find() {
      const current = operation && state.readJson(state.journalFile(f.ctx, operation), true);
      if (outage && current?.validationResults[0].status === "passed") throw new Error("Provider temporarily unavailable");
      return null;
    },
    update() { assert.fail("No PR writes are authorized"); },
    create() { assert.fail("No PR creation is authorized"); },
    capabilities() { assert.fail("No hosting mutation capabilities are required"); },
  });
  const plan = planValidation(f);
  operation = plan.approval;
  outage = true;
  assert.throws(() => apply(f, plan), /temporarily unavailable/);
  const interrupted = journal(f, plan);
  assert.equal(interrupted.pendingValidation, null);
  assert.equal(interrupted.validationResults[0].status, "passed");
  assert.equal(interrupted.validationResults[1].checks.length, 0);
  outage = false;
  const result = apply(f, plan);
  assert.equal(result.validation.success, true);
  assert.equal(result.validation.results[0].checks[0].stdout, interrupted.validationResults[0].checks[0].stdout);
  assert.equal(result.validation.results[0].checks[0].source, "retained-operation");
  assert.equal(result.validation.results[1].checks[0].source, "executed");
});

test("live PR drift invalidates an approved validation plan without mutating PRs", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const graph = configure(f, { a: [command("throw new Error('must not run')")] });
  const node = graph.nodes[0];
  const pr = { id: 1, branch: node.branch, head: node.head, base: node.base, baseBranch: graph.target,
    body: "Human description", state: "open", draft: true };
  node.pr = structuredClone(pr);
  state.save(f.ctx, graph);
  f.ctx.providerFactory = () => ({ kind: "github", get: () => structuredClone(pr),
    update() { assert.fail("Validation must not update PRs"); } });
  const plan = planValidation(f, "node:a");
  assert.equal(plan.validationInputs[0].input.status, "current");
  pr.head = f.base;
  assert.throws(() => apply(f, plan), /PR observations changed/);
  assert.equal(journal(f, plan).validationResults[0].checks.length, 0);
  f.apply("abort", { operation: plan.approval });
});

test("a passing command that changes tracked or staged files cannot establish current validation", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, {
    a: [command("require('node:fs').appendFileSync('shared.txt', 'unstaged output')")],
    b: [command("require('node:fs').appendFileSync('shared.txt', 'staged output'); require('node:child_process').execFileSync('git', ['add', 'shared.txt'])")],
  });
  const original = productState(f);
  const result = apply(f, planValidation(f));
  assert.deepEqual(result.validation.results.map((r) => r.status), ["dirty", "dirty"]);
  assert.ok(result.graph.nodes.every((n) => n.validation === null));
  assert.ok(result.validation.results.every((r) => r.checks[0].exitCode === 0));
  assert.deepEqual(productState(f), original);
});

test("validation CLI supports saved selectors and aggregate failure exit codes, not execution through read-only commands", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  configure(f, { a: [command("process.exit(9)")], b: [command("console.log('b passed')")] });
  const file = path.join(f.dir, "validation.json");
  const planned = cli(f.root, "plan", "validate", "--graph", "example", "--select", "unpublished", "--out", file);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.deepEqual(plan.validationSelection.nodes, ["a", "b"]);
  for (const flags of [[], ["--yes"], ["--approve", plan.approval]]) {
    assert.equal(cli(f.root, "apply", "--plan", file, ...flags).status, 1);
  }
  const applied = cli(f.root, "apply", "--plan", file, "--yes", "--approve", plan.approval);
  assert.equal(applied.status, 1, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).validation.results[1].status, "passed");
  assert.match(applied.stderr, /Validation .*: failed/);
  const resumed = cli(f.root, "continue", "--operation", plan.approval, "--yes", "--approve", plan.approval, "--quiet");
  assert.equal(resumed.status, 1);
  assert.equal(JSON.parse(resumed.stdout).alreadyDone, true);
  assert.match(JSON.parse(resumed.stderr).error, /unsuccessful or unavailable/);
  for (const args of [
    ["plan", "validate", "--graph", "example"],
    ["validate", "--graph", "example", "--select", "node:a"],
    ["plan", "validate", "--graph", "example", "--nodes", "a"],
    ["plan", "validate", "--graph", "example", "--select", "node:a", "--node", "a"],
    ["apply", "--plan", file, "--select", "node:a"],
  ]) assert.equal(cli(f.root, ...args).status, 1, args.join(" "));
});
