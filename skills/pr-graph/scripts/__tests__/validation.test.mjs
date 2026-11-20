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

const workerPolicy = (overrides = {}) => ({ mode: "warm", maxWorkers: 2, maxCacheBytes: 1024 * 1024,
  identity: "fixture-incremental-v1", inputPaths: [], caches: [".build"], reuse: [], ...overrides });
const managedPlan = (f, policy, selector = "unpublished") => createPlan(f.ctx, "validate", {
  graph: "example", selector, validationEnvironment: policy,
});
function managedFixture(t, names = ["a", "b", "c"]) {
  const f = fixture({ names });
  t.after(() => f.dispose());
  fs.appendFileSync(path.join(f.ctx.common, "info", "exclude"), "\n.build/\nunknown/\n");
  f.apply("split", { spec: f.spec });
  return f;
}

test("bounded warm workers reduce incremental build work, retain approved artifacts and always rerun checks", (t) => {
  const f = managedFixture(t);
  const build = command(`
    const fs = require('node:fs'), crypto = require('node:crypto'), cp = require('node:child_process');
    const start = performance.now(); fs.mkdirSync('.build', { recursive: true });
    const setupMs = performance.now() - start, buildStart = performance.now();
    let processes = 1;
    for (const part of fs.readFileSync('shared.txt', 'utf8').split(/(?=^[abc]=)/m)) {
      const key = crypto.createHash('sha256').update(part).digest('hex');
      if (!fs.existsSync('.build/' + key)) {
        const artifact = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))', part]);
        fs.writeFileSync('.build/' + key, artifact); processes++;
      }
    }
    const buildMs = performance.now() - buildStart, checkStart = performance.now();
    for (const file of fs.readdirSync('.build')) if (fs.readFileSync('.build/' + file, 'utf8') !== file) process.exit(7);
    console.log(JSON.stringify({ setupMs, buildMs, checkMs: performance.now() - checkStart, processes, pid: process.pid }));
  `);
  configure(f, { a: [build], b: [build], c: [build] });
  const graph = state.load(f.ctx, "example");
  git(f.root, "worktree", "add", path.join(f.dir, "occupied-warm-node"), graph.nodes[0].branch);
  fs.appendFileSync(path.join(f.root, "shared.txt"), "user staged output\n");
  git(f.root, "add", "shared.txt");
  fs.appendFileSync(path.join(f.root, "shared.txt"), "user unstaged output\n");
  fs.writeFileSync(path.join(f.root, "personal.txt"), "user untracked output\n");
  const original = productState(f);
  const cold = apply(f, managedPlan(f, workerPolicy({ mode: "clean", maxWorkers: 3 })));
  assert.equal(cold.validation.success, true);
  const warmPlan = managedPlan(f, workerPolicy({ maxWorkers: 1 }));
  const warm = apply(f, warmPlan);
  assert.equal(warm.validation.success, true);
  assert.equal(new Set(warm.validation.results.map((r) => r.worktree)).size, 1);
  const metrics = (result) => result.validation.results.map((r) => JSON.parse(r.checks[0].stdout));
  const coldMetrics = metrics(cold), warmMetrics = metrics(warm);
  assert.ok(warmMetrics.reduce((n, m) => n + m.processes, 0) < coldMetrics.reduce((n, m) => n + m.processes, 0));
  for (const m of [...coldMetrics, ...warmMetrics]) for (const key of ["setupMs", "buildMs", "checkMs", "processes"]) assert.ok(m[key] >= 0);
  assert.deepEqual(warm.validation.results.map((r) => r.environment.worktreeReused), [false, true, true]);
  assert.deepEqual(warm.validation.results.map((r) => r.environment.artifactsReused), [false, true, true]);
  assert.ok(warm.validation.results.every((r) => r.environment.cacheBytes > 0 && r.environment.cacheFiles > 0 &&
    !r.environment.setupReplayed && !r.environment.resultsReused && r.checks[0].source === "executed"));
  t.diagnostic(JSON.stringify({ cold: coldMetrics, warm: warmMetrics,
    disk: warm.validation.results.map((r) => ({ bytes: r.environment.cacheBytes, files: r.environment.cacheFiles })) }));
  const source = journal(f, warmPlan);
  const forged = structuredClone(source);
  forged.plan.action = "split";
  state.atomicJson(state.journalFile(f.ctx, warmPlan.approval), forged);
  assert.throws(() => managedPlan(f, workerPolicy({ maxWorkers: 1, reuse: [{ operation: warmPlan.approval, worker: 0 }] })), /unavailable/);
  state.atomicJson(state.journalFile(f.ctx, warmPlan.approval), source);
  const reuse = managedPlan(f, workerPolicy({ maxWorkers: 1, reuse: [{ operation: warmPlan.approval, worker: 0 }] }));
  const rerun = apply(f, reuse);
  assert.equal(rerun.validation.success, true);
  assert.ok(rerun.validation.results.every((r) => r.environment.worktreeReused && r.environment.artifactsReused));
  assert.notEqual(metrics(rerun)[0].pid, warmMetrics[0].pid);
  assert.throws(() => createPlan(f.ctx, "cleanup", { operation: warmPlan.approval,
    spec: { branches: [], worktree: true } }), /latest owner/);
  assert.throws(() => managedPlan(f, workerPolicy({ maxWorkers: 1, reuse: [{ operation: warmPlan.approval, worker: 0 }] })), /transferred/);
  assert.deepEqual(productState(f), original);
  assert.equal(fs.readFileSync(path.join(f.root, "personal.txt"), "utf8"), "user untracked output\n");
});

test("managed workers quarantine failures and tracked, untracked, unknown ignored and oversized output", (t) => {
  for (const script of ["process.exit(7)", "require('node:fs').appendFileSync('shared.txt', 'dirty')",
    "require('node:fs').writeFileSync('untracked.txt', 'keep')",
    "require('node:fs').mkdirSync('unknown'); require('node:fs').writeFileSync('unknown/file', 'keep')",
    "require('node:fs').mkdirSync('.build'); require('node:fs').writeFileSync('.build/file', 'too big')"]) {
    const f = managedFixture(t, ["a", "b"]);
    const check = command(`if (require('node:fs').readFileSync('shared.txt', 'utf8').startsWith('a=1')) { ${script} }`);
    configure(f, { a: [check], b: [check] });
    const original = productState(f);
    const plan = managedPlan(f, workerPolicy({ maxCacheBytes: 2 }));
    const result = apply(f, plan);
    assert.ok(["failed", "dirty"].includes(result.validation.results[0].status));
    assert.equal(result.validation.results[1].status, "passed");
    assert.notEqual(result.validation.results[0].worktree, result.validation.results[1].worktree);
    assert.equal(journal(f, plan).validationWorkers[0].quarantined, true);
    assert.deepEqual(productState(f), original);
  }
});

test("clean mode reruns in fresh workers and bounded exhaustion never cleans or expands execution", (t) => {
  const f = managedFixture(t, ["a", "b"]);
  configure(f, { a: [command("console.log(process.pid)")], b: [command("console.log(process.pid)")] });
  const config = workerPolicy({ mode: "clean", caches: [] });
  const first = apply(f, managedPlan(f, config));
  const second = apply(f, managedPlan(f, config));
  assert.ok(first.validation.success && second.validation.success);
  assert.equal(new Set([...first.validation.results, ...second.validation.results].map((r) => r.worktree)).size, 4);
  const bounded = apply(f, managedPlan(f, { ...config, maxWorkers: 1 }));
  assert.deepEqual(bounded.validation.results.map((r) => r.status), ["passed", "unavailable"]);
  assert.equal(bounded.validation.results[1].checks.length, 0);
  assert.ok(fs.existsSync(bounded.validation.results[0].worktree));
});

test("environment, toolchain, cache policy and retained bytes drift invalidate warm reuse", (t) => {
  const f = managedFixture(t, ["a"]);
  configure(f, { a: [command("require('node:fs').mkdirSync('.build', { recursive: true }); require('node:fs').writeFileSync('.build/file', 'retained')")] });
  const config = workerPolicy();
  const plan = managedPlan(f, config);
  const first = apply(f, plan);
  const reuse = { ...config, reuse: [{ operation: plan.approval, worker: 0 }] };
  for (const changed of [{ identity: "different-toolchain" }, { inputPaths: ["shared.txt"] }, { caches: ["different-cache"] }]) {
    assert.throws(() => managedPlan(f, { ...reuse, ...changed }), /incompatible/);
  }
  const saved = managedPlan(f, reuse);
  const previous = process.env.PR_GRAPH_WORKER_TEST;
  process.env.PR_GRAPH_WORKER_TEST = "changed environment";
  try { assert.throws(() => apply(f, saved), /environment\/toolchain/); }
  finally {
    if (previous === undefined) delete process.env.PR_GRAPH_WORKER_TEST;
    else process.env.PR_GRAPH_WORKER_TEST = previous;
  }
  f.apply("abort", { operation: saved.approval });
  const changedBytes = managedPlan(f, reuse);
  fs.writeFileSync(path.join(first.validation.results[0].worktree, ".build/file"), "changed bytes");
  assert.throws(() => apply(f, changedBytes), /changed after approval/);
  assert.throws(() => apply(f, changedBytes), /changed after approval/);
  assert.equal(journal(f, changedBytes).validationResults[0].checks.length, 0);
  f.apply("abort", { operation: changedBytes.approval });
  assert.throws(() => managedPlan(f, reuse), /output changed/);
});

test("managed worker cleanup pins current ownership and preserves dirty or ignored artifacts", (t) => {
  const f = managedFixture(t, ["a", "b"]);
  configure(f, { a: [command("console.log('checked')")], b: [command("console.log('checked')")] });
  const plan = managedPlan(f, workerPolicy({ maxWorkers: 1 }));
  const result = apply(f, plan);
  const options = { operation: plan.approval, spec: { branches: [], worktree: true } };
  const cleanup = createPlan(f.ctx, "cleanup", options);
  assert.equal(cleanup.worktrees.length, 1);
  const dir = result.validation.results[0].worktree;
  fs.mkdirSync(path.join(dir, ".build"));
  fs.writeFileSync(path.join(dir, ".build/file"), "preserve");
  assert.throws(() => apply(f, cleanup), /changed after approval/);
  assert.throws(() => createPlan(f.ctx, "cleanup", options), /output remains dirty/);
  fs.unlinkSync(path.join(dir, ".build/file"));
  fs.rmdirSync(path.join(dir, ".build"));
  apply(f, createPlan(f.ctx, "cleanup", options));
  assert.ok(!fs.existsSync(dir));
});

test("managed validation cancellation retains an uncertain worker without command retry or reuse", { skip: process.platform === "win32" }, (t) => {
  const f = managedFixture(t, ["a"]);
  configure(f, { a: [command("console.log('retained'); process.kill(process.pid, 'SIGTERM')")] });
  const plan = managedPlan(f, workerPolicy());
  assert.throws(() => apply(f, plan), /terminated by a signal/);
  assert.throws(() => apply(f, plan), /uncertain outcome/);
  f.apply("abort", { operation: plan.approval });
  assert.throws(() => managedPlan(f, workerPolicy({ reuse: [{ operation: plan.approval, worker: 0 }] })), /uncertain/);
  assert.match(journal(f, plan).validationResults[0].checks[0].stdout, /retained/);
  assert.ok(fs.existsSync(journal(f, plan).validationWorkers[0].path));
});

test("managed cache configuration differences consume separate slots rather than carrying incompatible artifacts", (t) => {
  const f = managedFixture(t, ["a", "b"]);
  const check = command("console.log('fresh check')");
  configure(f, { a: [check], b: [check] });
  const plan = managedPlan(f, workerPolicy({ maxWorkers: 1, inputPaths: ["shared.txt"] }));
  assert.notEqual(plan.validationEnvironment.keys.a, plan.validationEnvironment.keys.b);
  const result = apply(f, plan);
  assert.deepEqual(result.validation.results.map((r) => r.status), ["passed", "unavailable"]);
  assert.equal(result.validation.results[1].checks.length, 0);
});

test("changed executable bytes and ignored-input configuration block managed execution before checks", (t) => {
  const f = managedFixture(t, ["a"]);
  const executable = path.join(f.dir, "fixture-executable");
  fs.writeFileSync(executable, "original executable bytes");
  configure(f, { a: [{ command: executable, args: [] }] });
  const plan = managedPlan(f, workerPolicy());
  fs.appendFileSync(executable, "changed toolchain bytes");
  assert.throws(() => apply(f, plan), /environment\/toolchain/);
  assert.equal(journal(f, plan).validationResults[0].checks.length, 0);
  f.apply("abort", { operation: plan.approval });
  configure(f, { a: [command("console.log('must not run')")] });
  const ignore = managedPlan(f, workerPolicy());
  fs.appendFileSync(path.join(f.ctx.common, "info", "exclude"), "new-ignore-rule\n");
  assert.throws(() => apply(f, ignore), /environment\/toolchain/);
  assert.equal(journal(f, ignore).validationResults[0].checks.length, 0);
});

test("managed continuation retains durable command receipts without rerun after an observation outage", (t) => {
  const f = managedFixture(t, ["a", "b"]);
  const check = command("console.log(process.pid)");
  configure(f, { a: [check], b: [check] });
  let outage = false, operation;
  f.ctx.providerFactory = () => ({ kind: "github", find() {
    const current = operation && state.readJson(state.journalFile(f.ctx, operation), true);
    if (outage && current?.validationResults[0].status === "passed") throw new Error("Observation outage");
    return null;
  } });
  const plan = managedPlan(f, workerPolicy({ maxWorkers: 1 }));
  operation = plan.approval;
  outage = true;
  assert.throws(() => apply(f, plan), /Observation outage/);
  const retained = journal(f, plan).validationResults[0].checks[0].stdout;
  assert.equal(journal(f, plan).pendingValidation, null);
  outage = false;
  const result = apply(f, plan);
  assert.equal(result.validation.success, true);
  assert.equal(result.validation.results[0].checks[0].stdout, retained);
  assert.equal(result.validation.results[0].checks[0].source, "retained-operation");
  assert.equal(result.validation.results[1].checks[0].source, "executed");
  assert.equal(result.validation.results[1].environment.worktreeReused, true);
});

test("managed CLI policy is pinned to validate plans, not apply or other actions", (t) => {
  const f = managedFixture(t, ["a"]);
  configure(f, { a: [command("console.log('fresh')")] });
  const policy = path.join(f.dir, "worker-policy.json"), file = path.join(f.dir, "warm-plan.json");
  state.atomicJson(policy, workerPolicy());
  const planned = cli(f.root, "plan", "validate", "--graph", "example", "--select", "node:a",
    "--validation-environment", policy, "--out", file);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  const altered = structuredClone(plan);
  altered.validationEnvironment.config.maxCacheBytes++;
  assert.throws(() => apply(f, altered), /approval/);
  assert.equal(cli(f.root, "apply", "--plan", file, "--yes", "--approve", plan.approval,
    "--validation-environment", policy).status, 1);
  assert.equal(cli(f.root, "plan", "sync", "--graph", "example", "--validation-environment", policy).status, 1);
  const applied = cli(f.root, "apply", "--plan", file, "--yes", "--approve", plan.approval);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).validation.results[0].checks[0].source, "executed");
});

test("worktree-specific configuration changes stop validation without authorizing a blind retry", (t) => {
  const f = managedFixture(t, ["a"]);
  git(f.root, "config", "extensions.worktreeConfig", "true");
  configure(f, { a: [command("require('node:child_process').execFileSync('git', ['config', '--worktree', 'validation.changed', 'true']); console.log('configuration changed')")] });
  const plan = managedPlan(f, workerPolicy());
  assert.throws(() => apply(f, plan), /worker configuration changed/);
  assert.match(journal(f, plan).validationResults[0].checks[0].stdout, /configuration changed/);
  assert.throws(() => apply(f, plan), /uncertain outcome/);
  f.apply("abort", { operation: plan.approval });
  assert.ok(fs.existsSync(journal(f, plan).validationWorkers[0].path));
});

test("managed cache symlinks and tracked cache paths cannot be reused or silently accepted", { skip: process.platform === "win32" }, (t) => {
  const f = managedFixture(t, ["a"]);
  configure(f, { a: [command("require('node:fs').mkdirSync('.build'); require('node:fs').symlinkSync('../shared.txt', '.build/link')")] });
  assert.throws(() => managedPlan(f, workerPolicy({ caches: ["shared.txt"] })), /tracked input/);
  const plan = managedPlan(f, workerPolicy());
  assert.throws(() => apply(f, plan), /cache symlinks/);
  assert.throws(() => apply(f, plan), /uncertain outcome/);
  f.apply("abort", { operation: plan.approval });
  assert.ok(fs.lstatSync(path.join(journal(f, plan).validationWorkers[0].path, ".build/link")).isSymbolicLink());
});

test("cleanup includes claimed workers even when no selected node used their slot", (t) => {
  const f = managedFixture(t, ["a", "b"]);
  const check = command("console.log('fresh')");
  configure(f, { a: [check], b: [check] });
  const policy = workerPolicy();
  const a = managedPlan(f, policy, "node:a");
  const first = apply(f, a);
  const b = managedPlan(f, policy, "node:b");
  const second = apply(f, b);
  const combined = managedPlan(f, { ...policy, reuse: [{ operation: a.approval, worker: 0 },
    { operation: b.approval, worker: 0 }] }, "node:a");
  const result = apply(f, combined);
  assert.equal(result.validation.workers.length, 2);
  assert.equal(result.validation.results.length, 1);
  const cleanup = createPlan(f.ctx, "cleanup", { operation: combined.approval,
    spec: { branches: [], worktree: true } });
  assert.equal(cleanup.worktrees.length, 2);
  apply(f, cleanup);
  assert.ok(!fs.existsSync(first.validation.results[0].worktree));
  assert.ok(!fs.existsSync(second.validation.results[0].worktree));
});
