import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fixture, git } from "./fixtures.mjs";
import { tree } from "../lib/git.mjs";
import { readJson, journalFile } from "../lib/state.mjs";
import { setProgressSink } from "../lib/progress.mjs";

function measured(t, action) {
  const counts = { subprocesses: 0, checkouts: 0, journalWrites: 0, journalBytes: 0,
    phasesMs: {} };
  const spawn = childProcess.spawnSync;
  const write = fs.writeFileSync;
  const spawnMock = t.mock.method(childProcess, "spawnSync", function(command, args, ...rest) {
    counts.subprocesses++;
    if (command === "git" && args[0] === "checkout") counts.checkouts++;
    return spawn.call(this, command, args, ...rest);
  });
  const writeMock = t.mock.method(fs, "writeFileSync", function(file, data, ...rest) {
    if (typeof data === "string" && data.startsWith("{\n") && data.includes('"plan":')) {
      const value = JSON.parse(data);
      if (value.id && value.id === value.plan?.approval) {
        counts.journalWrites++;
        counts.journalBytes += Buffer.byteLength(data);
      }
    }
    return write.call(this, file, data, ...rest);
  });
  syncBuiltinESMExports();
  setProgressSink((event) => {
    if (event.type === "done") {
      const phase = event.label.startsWith("Reconstructing branch") ? "reconstruction"
        : event.label === "Verifying whole-graph composition" ? "composition"
          : event.label.startsWith("Reusing verified composition prefix") ? "prefixVerification" : null;
      if (phase) counts.phasesMs[phase] = (counts.phasesMs[phase] ?? 0) + event.elapsed;
    }
  });
  try {
    const result = action();
    return { result, counts };
  } finally {
    setProgressSink(undefined);
    spawnMock.mock.restore();
    writeMock.mock.restore();
    syncBuiltinESMExports();
  }
}

for (const shape of ["chain", "diamond", "wide"]) {
  test(`composition prefix differential work counters: ${shape}`, (t) => {
    const baseline = fixture();
    const optimized = fixture();
    t.after(() => baseline.dispose());
    t.after(() => optimized.dispose());
    baseline.ctx.compositionPrefixes = false;
    const diamond = { a: [], b: ["a"], c: ["a"], d: ["b", "c"], e: ["b", "c"], f: ["d", "e"] };
    for (const f of [baseline, optimized]) {
      for (const [i, node] of f.spec.nodes.entries()) {
        node.dependencies = shape === "chain" && i ? [f.spec.nodes[i - 1].id]
          : shape === "wide" ? [] : shape === "diamond" ? diamond[node.id] : [];
      }
    }
    const old = measured(t, () => baseline.apply("split", { spec: baseline.spec }));
    const next = measured(t, () => optimized.apply("split", { spec: optimized.spec }));
    const before = readJson(journalFile(baseline.ctx, old.result.operation)).reconstruction;
    const after = readJson(journalFile(optimized.ctx, next.result.operation)).reconstruction;
    assert.equal(tree(baseline.root, old.result.graph.combined),
      tree(optimized.root, next.result.graph.combined));
    for (const node of next.result.graph.nodes) {
      const expected = old.result.graph.nodes.find((n) => n.id === node.id);
      assert.equal(tree(optimized.root, node.base), tree(baseline.root, expected.base));
      assert.equal(tree(optimized.root, node.head), tree(baseline.root, expected.head));
      assert.equal(git(optimized.root, "log", "--reverse", "--format=%B",
        `${next.result.graph.targetSha}..${node.head}`),
      git(baseline.root, "log", "--reverse", "--format=%B",
        `${old.result.graph.targetSha}..${expected.head}`));
      assert.equal(node.validation.head, node.head);
      assert.equal(Boolean(node.ready), false);
      assert.deepEqual(node.dependencies, expected.dependencies);
    }
    assert.equal(after.applied, before.applied);
    assert.ok(after.visits < before.visits);
    assert.equal(after.prefixAvoided, before.visits - after.visits);
    if (shape !== "wide") assert.ok(next.counts.subprocesses < old.counts.subprocesses);
    assert.ok(next.counts.checkouts < old.counts.checkouts);
    assert.ok(next.counts.journalWrites < old.counts.journalWrites);
    if (shape === "diamond") {
      assert.equal(next.result.graph.nodes.find((n) => n.id === "d").base,
        next.result.graph.nodes.find((n) => n.id === "e").base);
    }
    t.diagnostic(JSON.stringify({ shape,
      baseline: { ...old.counts, visits: before.visits },
      optimized: { ...next.counts, visits: after.visits, avoided: after.prefixAvoided } }));
  });
}
