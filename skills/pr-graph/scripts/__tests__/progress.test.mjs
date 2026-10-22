import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fixture, cli } from "./fixtures.mjs";
import { createPlan } from "../lib/operations.mjs";
import { ProgressReporter, setProgressSink, step } from "../lib/progress.mjs";

function output(isTTY = false) {
  let text = "";
  return {
    stream: { isTTY, columns: 120, write(value) { text += value; } },
    text: () => text,
  };
}

test("heartbeats wait two quiet minutes, repeat, and follow the active nested phase", () => {
  const out = output();
  let now = 0;
  const reporter = new ProgressReporter({ stream: out.stream, now: () => now });
  try {
    reporter.receive({ type: "start", id: 1, label: "Applying split" });
    reporter.receive({ type: "start", id: 2, label: "Validation", node: "api",
      branch: "pr/api", index: 2, total: 5 });
    now = 119_999;
    reporter.tick();
    assert.doesNotMatch(out.text(), /still running/);
    now = 120_000;
    reporter.tick();
    assert.match(out.text(), /\[2\/5\] api \| pr\/api \| Validation: still running \(2m 0s elapsed\)/);
    now = 240_000;
    reporter.tick();
    assert.equal(out.text().match(/still running/g).length, 2);
    reporter.receive({ type: "done", id: 2, label: "Validation", outcome: "passed", elapsed: 240_000 });
    now = 359_999;
    reporter.tick();
    assert.equal(out.text().match(/still running/g).length, 2);
    now = 360_000;
    reporter.tick();
    assert.match(out.text(), /Applying split: still running \(6m 0s elapsed\)/);
    reporter.receive({ type: "done", id: 1, label: "Applying split", elapsed: 360_000 });
    const complete = out.text();
    now = 480_000;
    reporter.tick();
    assert.equal(out.text(), complete);
    assert.doesNotMatch(complete, /\x1b|\r/);
  } finally {
    reporter.close();
  }
});

test("TTY progress retains completed lines, sanitizes controls, and clears its spinner", (t) => {
  const term = process.env.TERM;
  const noColor = process.env.NO_COLOR;
  t.after(() => {
    if (term === undefined) delete process.env.TERM; else process.env.TERM = term;
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
  });
  process.env.TERM = "xterm";
  delete process.env.NO_COLOR;
  const out = output(true);
  const reporter = new ProgressReporter({ stream: out.stream, now: () => 0 });
  try {
    reporter.receive({ type: "start", id: 1, label: "Checking\x1b[31m\ninjected" });
    reporter.tick();
    reporter.receive({ type: "done", id: 1, label: "Checking", elapsed: 1_234 });
    assert.match(out.text(), /\x1b\[36m/);
    assert.match(out.text(), /\| Checking/);
    assert.match(out.text(), /Checking: done \(1s\).*\n/);
    assert.doesNotMatch(out.text(), /Checking\x1b\[31m|\ninjected/);
  } finally {
    reporter.close();
  }
  assert.ok(out.text().endsWith("\r\x1b[2K"));

  process.env.NO_COLOR = "";
  const plainColor = output(true);
  const noColorReporter = new ProgressReporter({ stream: plainColor.stream });
  noColorReporter.receive({ type: "start", id: 2, label: "Checking" });
  noColorReporter.close();
  assert.doesNotMatch(plainColor.text(), /\x1b\[\d+m/);

  process.env.TERM = "dumb";
  const dumb = output(true);
  const dumbReporter = new ProgressReporter({ stream: dumb.stream });
  dumbReporter.receive({ type: "start", id: 3, label: "Checking" });
  dumbReporter.tick();
  dumbReporter.close();
  assert.doesNotMatch(dumb.text(), /\x1b|\r/);
});

test("phase events include newly observed PR identity and never report failed work as done", () => {
  const events = [];
  setProgressSink((event) => events.push(event));
  try {
    const node = { id: "api", branch: "pr/api" };
    const value = step("Creating draft PR", () => {
      node.pr = { id: 42, url: "https://example.invalid/pull/42" };
      return "created";
    }, { node, index: 2, total: 5 });
    assert.equal(value, "created");
    assert.equal(events[0].pr, undefined);
    assert.equal(events[1].pr, node.pr.url);
    assert.equal(events[1].index, 2);
    const failure = new Error("provider readback mismatch");
    assert.throws(() => step("Verifying PR", () => { throw failure; }, { node }), (error) => error === failure);
    assert.deepEqual(events.map((event) => event.type), ["start", "done", "start", "failed"]);
    assert.ok(events.every((event) => event.elapsed >= 0));
  } finally {
    setProgressSink(undefined);
  }
});

test("CLI progress arrives while validation is blocked and stdout remains a JSON result", { timeout: 30_000 }, async () => {
  const f = fixture({ names: ["a"] });
  const gate = path.join(f.dir, "release");
  const waiting = path.join(f.dir, "waiting");
  const script = path.join(f.dir, "validate.mjs");
  fs.writeFileSync(script, `
    import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(waiting)}, "");
    const until = Date.now() + 10_000;
    while (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    if (!fs.existsSync(${JSON.stringify(gate)})) process.exit(7);
    console.log("SUCCESS_OUTPUT_MUST_STAY_CAPTURED");
  `);
  f.spec.nodes[0].validations = [{ command: process.execPath, args: [script] }];
  const plan = createPlan(f.ctx, "split", { spec: f.spec });
  const planFile = path.join(f.dir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../pr-graph.mjs"),
    "--repo", f.root, "apply", "--plan", planFile, "--yes", "--approve", plan.approval],
  { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "", stderr = "", stdoutBeforeRelease;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const timer = setInterval(() => {
    if (stdoutBeforeRelease === undefined && /Validation .*: started/.test(stderr) && fs.existsSync(waiting)) {
      stdoutBeforeRelease = stdout;
      fs.writeFileSync(gate, "");
    }
  }, 20);
  try {
    assert.equal(await exited, 0, stderr);
    assert.equal(stdoutBeforeRelease, "");
    assert.equal(JSON.parse(stdout).graph.nodes[0].id, "a");
    assert.match(stderr, /\[1\/1\] a \| pr-graph\/example\/nodes\/a \| Reconstructing branch/);
    assert.match(stderr, /Verifying whole-graph composition: done/);
    assert.match(stderr, /Validation .*validate\.mjs.*: passed \(\d+s\)/);
    assert.doesNotMatch(stderr + stdout, /SUCCESS_OUTPUT_MUST_STAY_CAPTURED/);
    assert.doesNotMatch(stderr, /\x1b|\r/);
    const quiet = cli(f.root, "status", "--graph", "example", "--quiet");
    const normal = cli(f.root, "status", "--graph", "example");
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stderr, "");
    assert.equal(normal.status, 0, normal.stderr);
    assert.deepEqual(JSON.parse(quiet.stdout).graph, JSON.parse(normal.stdout).graph);
    assert.match(normal.stderr, /Inspecting node freshness/);
  } finally {
    clearInterval(timer);
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    f.dispose();
  }
});

test("failed validation retains diagnostics and recovery ID with progress enabled or quiet", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const script = path.join(f.dir, "fail.mjs");
  fs.writeFileSync(script, 'console.log("CHECK_STDOUT"); console.error("CHECK_STDERR"); process.exitCode = 7;\n');
  f.spec.nodes[0].validations = [{ command: process.execPath, args: [script] }];
  const plan = createPlan(f.ctx, "split", { spec: f.spec });
  const planFile = path.join(f.dir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  for (const flags of [[], ["--quiet"]]) {
    const result = cli(f.root, "apply", "--plan", planFile, "--yes", "--approve", plan.approval, ...flags);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr.trim().split("\n").at(-1)).error;
    assert.match(error, /Validation failed for a/);
    assert.match(error, /CHECK_STDOUT/);
    assert.match(error, /CHECK_STDERR/);
    assert.ok(error.includes(`Operation: ${plan.approval}`));
    if (flags.length) {
      assert.equal(JSON.parse(result.stderr).error, error);
    } else {
      assert.match(result.stderr, /Validation .*fail\.mjs.*: failed/);
      assert.doesNotMatch(result.stderr, /Validation .*: passed|Applying approved operation: done/);
    }
  }
});
