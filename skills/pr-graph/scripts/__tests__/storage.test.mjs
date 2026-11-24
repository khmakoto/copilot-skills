import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fixture, git } from "./fixtures.mjs";
import * as state from "../lib/state.mjs";
import { digest } from "../lib/graph.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import { history } from "../lib/history.mjs";

const largePatch = "diff --git a/example b/example\n+retained content\n".repeat(1024);

function storage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-graph-storage-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir };
}

function journal(i = 0) {
  const graph = { id: "example", revision: i, nodes: Array.from({ length: 16 }, (_, n) => ({
    id: `n${n}`, description: `Node ${n} ${"description ".repeat(60)}`, change: { patch: largePatch },
  })) };
  const content = { action: "sync", graph, previous: { ...graph, revision: i - 1 } };
  const plan = { ...content, approval: digest(content) };
  return { id: plan.approval, plan, candidate: graph, status: "running", commits: {}, remoteStarted: false };
}

const raw = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? files(file) : [file];
});

for (const scenario of [
  {
    name: "namespaced drive paths",
    dir: String.raw`C:\state\created\records`, first: String.raw`\\?\C:\state\created`,
    expected: [String.raw`\\?\C:\state\created\records`, String.raw`\\?\C:\state\created`, String.raw`\\?\C:\state`],
  },
  {
    name: "namespaced UNC paths",
    dir: String.raw`\\server\share\created\records`, first: String.raw`\\?\UNC\server\share\created`,
    expected: [String.raw`\\?\UNC\server\share\created\records`, String.raw`\\?\UNC\server\share\created`,
      String.raw`\\?\UNC\server\share`],
  },
  {
    name: "an unreachable ancestor",
    dir: String.raw`C:\state\created\records`, first: String.raw`\\?\C:\elsewhere\created`, invalid: true,
    expected: [String.raw`\\?\C:\state\created\records`, String.raw`\\?\C:\state\created`,
      String.raw`\\?\C:\state`, "\\\\?\\C:\\"],
  },
]) {
  test(`new directory flush handles ${scenario.name} without an unbounded walk`, (t) => {
    for (const method of ["dirname", "resolve", "toNamespacedPath"]) t.mock.method(path, method, path.win32[method]);
    t.mock.method(fs, "mkdirSync", (dir, options) => {
      assert.equal(dir, scenario.dir);
      assert.deepEqual(options, { recursive: true });
      return scenario.first;
    });
    const synced = [];
    const descriptors = new Map();
    const writeReached = new Error("record write reached");
    t.mock.method(fs, "openSync", (file, flags) => {
      if (flags !== "r") throw writeReached;
      assert.ok(descriptors.size < scenario.expected.length, "directory walk did not terminate");
      const fd = descriptors.size;
      descriptors.set(fd, file);
      return fd;
    });
    t.mock.method(fs, "fsyncSync", (fd) => synced.push(descriptors.get(fd)));
    t.mock.method(fs, "closeSync", () => {});
    assert.throws(() => state.atomicJson(path.win32.join(scenario.dir, "record.json"), {}),
      scenario.invalid ? /not an ancestor/ : (error) => error === writeReached);
    assert.deepEqual(synced, scenario.expected);
  });
}

test("immutable storage shares patches and snapshots without changing full-payload identities or receipts", (t) => {
  const ctx = storage(t);
  const events = [];
  ctx.storageEvent = (e) => events.push(e);
  const value = journal();
  state.saveJournal(ctx, value);
  const file = state.journalFile(ctx, value.id);
  const first = state.readJson(file);
  assert.deepEqual(first, value);
  const { approval, ...content } = first.plan;
  assert.equal(digest(content), approval);
  assert.equal(raw(file).format, "pr-graph-state");
  assert.equal(fs.readFileSync(file, "utf8").includes(largePatch.slice(0, 100)), false);
  const patches = events.filter((e) => e.phase === "after-payload" && e.kind === "text");
  assert.equal(patches.length, 1);
  assert.equal(fs.readFileSync(patches[0].file, "utf8"), largePatch);
  assert.ok(events.some((e) => e.phase === "after-payload" && e.kind === "tree"));
  value.remoteStarted = true;
  value.commits.first = "pinned-commit";
  state.saveJournal(ctx, value);
  assert.equal(events.filter((e) => e.phase === "after-payload" && e.kind === "text").length, 1);
  assert.deepEqual(state.readJson(file), value);
  assert.equal(first.remoteStarted, false);
  value.plan.graph.nodes[0].description = "Changed after an earlier write";
  state.saveJournal(ctx, value);
  assert.equal(state.readJson(file).plan.graph.nodes[0].description, "Changed after an earlier write");
  assert.notEqual(digest(state.readJson(file).plan.graph), digest(first.plan.graph));
});

test("legacy records migrate only on writes and tagged user data and unusual strings round-trip exactly", (t) => {
  const ctx = storage(t);
  const value = journal();
  value.extra = { format: "pr-graph-state", version: 1, value: ["ref", "tree", "a".repeat(64)],
    "$ref": "literal", unicode: "\u00e9\ud83c\udf31".repeat(2000), loneSurrogate: "\ud800".repeat(5000) };
  const file = state.journalFile(ctx, value.id);
  state.atomicJson(file, value);
  const bytes = fs.readFileSync(file);
  assert.deepEqual(state.journals(ctx), [value]);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(path.join(ctx.dir, "payloads")), false);
  state.saveJournal(ctx, value);
  assert.deepEqual(state.readJson(file), value);
  const legacy = { ...value, id: digest("legacy") };
  state.atomicJson(state.journalFile(ctx, legacy.id), legacy);
  assert.deepEqual(new Set(state.journals(ctx).map((j) => j.id)), new Set([value.id, legacy.id]));
});

for (const kind of ["text", "tree"]) {
  test(`missing and corrupt ${kind} blocks fail closed on reads and writes without implicit repair`, (t) => {
    const ctx = storage(t);
    const events = [];
    ctx.storageEvent = (e) => events.push(e);
    const value = journal();
    state.saveJournal(ctx, value);
    const file = state.journalFile(ctx, value.id);
    const target = events.find((e) => e.phase === "after-payload" && e.kind === kind).file;
    const original = fs.readFileSync(target);
    const record = fs.readFileSync(file);
    fs.writeFileSync(target, "corrupted bytes");
    assert.throws(() => state.readJson(file), /Corrupt retained payload/);
    assert.throws(() => state.saveJournal(ctx, value), /Corrupt retained payload/);
    assert.deepEqual(fs.readFileSync(file), record);
    fs.writeFileSync(target, original);
    assert.deepEqual(state.readJson(file), value);
    fs.unlinkSync(target);
    assert.throws(() => state.journals(ctx, ({ status }) => status), /Cannot read retained payload/);
    assert.throws(() => state.saveJournal(ctx, value), /Cannot read retained payload/);
    assert.equal(fs.existsSync(target), false);
  });
}

test("unsupported envelopes, references, encodings and symlinked payload paths are rejected", (t) => {
  const ctx = storage(t);
  const value = journal();
  const file = state.journalFile(ctx, value.id);
  state.saveJournal(ctx, value);
  const envelope = raw(file);
  for (const edit of [
    (e) => { e.version = 2; },
    (e) => { e.format = "pr-graph-state-unknown"; },
    (e) => { e.value = ["ref", "text", "../outside"]; },
    (e) => { e.value = ["ref", "unknown", "a".repeat(64)]; },
    (e) => { e.value = ["object", [["same", ["value", 1]], ["same", ["value", 2]]]]; },
    (e) => { e.value = ["value", {}]; },
    (e) => { e.value = ["object-parts", [["object", [["a", ["value", 1]]]], ["object", [["a", ["value", 2]]]]]]; },
    (e) => { e.value = ["array-parts", [["value", 1]]]; },
  ]) {
    const bad = structuredClone(envelope);
    edit(bad);
    state.atomicJson(file, bad);
    assert.throws(() => state.readJson(file), /Unsupported|Invalid|Duplicate/);
  }
  state.atomicJson(file, envelope);
  if (process.platform !== "win32") {
    const payloads = path.join(ctx.dir, "payloads");
    fs.renameSync(payloads, `${payloads}-original`);
    fs.symlinkSync(`${payloads}-original`, payloads, "dir");
    assert.throws(() => state.readJson(file), /Unsafe retained payload path/);
    assert.throws(() => state.saveJournal(ctx, value), /Unsafe retained payload path/);
  }
});

test("journal scans share verified blocks only within one read boundary", (t) => {
  const ctx = storage(t);
  for (let i = 0; i < 8; i++) state.saveJournal(ctx, journal(i));
  const original = fs.readFileSync;
  const reads = new Map();
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (path.basename(path.dirname(String(file))) === "payloads") reads.set(String(file), (reads.get(String(file)) ?? 0) + 1);
    return original.call(this, file, ...args);
  });
  assert.equal(state.journals(ctx).length, 8);
  assert.ok(reads.size > 0);
  assert.ok([...reads.values()].every((n) => n === 1));
  const target = [...reads.keys()][0];
  fs.writeFileSync(target, "corrupt after read boundary");
  assert.throws(() => state.journals(ctx), /Corrupt retained payload/);
});

test("sharing a read boundary cannot supply missing payloads from another state directory", (t) => {
  const source = storage(t);
  const destination = storage(t);
  const value = journal();
  state.saveJournal(source, value);
  const file = state.journalFile(source, value.id);
  const other = state.journalFile(destination, value.id);
  state.atomicJson(other, raw(file));
  const cache = new Map();
  assert.deepEqual(state.readJson(file, false, cache), value);
  assert.throws(() => state.readJson(other, false, cache), /Cannot read retained payload/);
});

test("failed file fsync preserves the previous record and unsupported directory sync never skips file flushes", (t) => {
  const ctx = storage(t);
  const value = journal();
  state.saveJournal(ctx, value);
  const file = state.journalFile(ctx, value.id);
  const before = fs.readFileSync(file);
  const fsync = fs.fsyncSync;
  let fileFlushes = 0;
  let fail = true;
  t.mock.method(fs, "fsyncSync", function (fd) {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("unsupported directory fsync"), { code: "EINVAL" });
    fileFlushes++;
    if (fail) throw Object.assign(new Error("file flush failed"), { code: "EIO" });
    return fsync.call(this, fd);
  });
  value.remoteStarted = true;
  assert.throws(() => state.saveJournal(ctx, value), /file flush failed/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(state.readJson(file).remoteStarted, false);
  fail = false;
  state.saveJournal(ctx, value);
  assert.ok(fileFlushes >= 2);
  assert.deepEqual(state.readJson(file), value);
});

test("growing execution maps and arrays share unchanged pages instead of retaining a new complete copy", (t) => {
  const ctx = storage(t);
  const value = journal();
  const keys = Array.from({ length: 512 }, (_, i) => digest(i));
  value.commits = Object.fromEntries(keys.map((key) => [key, digest({ key })]));
  value.recoveries = keys.map((operation) => ({ operation, action: "reconcile", recordedAt: 1 }));
  state.saveJournal(ctx, value);
  const initialPayloads = new Set(files(path.join(ctx.dir, "payloads")));
  let written = 0;
  ctx.storageEvent = (e) => { if (e.phase === "file-synced") written += e.bytes; };
  for (let i = 0; i < 12; i++) {
    value.commits[keys[i]] = digest({ changed: i });
    value.commits[digest({ inserted: i })] = digest({ newReceipt: i });
    value.recoveries.push({ operation: digest({ recovery: i }), action: "resolve", recordedAt: 2 });
    state.saveJournal(ctx, value);
  }
  const unshared = 12 * Buffer.byteLength(JSON.stringify({ commits: value.commits, recoveries: value.recoveries }));
  assert.ok(written < unshared / 4, `${written} bytes written for ${unshared} bytes of unshared evidence`);
  assert.ok([...initialPayloads].every((file) => fs.existsSync(file)));
  assert.deepEqual(state.readJson(state.journalFile(ctx, value.id)), value);
  value.commits = Object.fromEntries(Object.entries(value.commits).slice(0, 8));
  value.recoveries.splice(0, 500);
  state.saveJournal(ctx, value);
  assert.deepEqual(state.readJson(state.journalFile(ctx, value.id)), value);
  t.diagnostic(`Growing evidence: ${unshared} unshared bytes versus ${written} written bytes.`);
});

test("large retained histories reduce serialized and written bytes with every transition still durable", (t) => {
  const ctx = storage(t);
  const legacy = storage(t);
  const metrics = { serialized: 0, written: 0, fileSyncs: 0, directorySyncs: 0, records: 0 };
  const baseline = { serialized: 0, written: 0, fileSyncs: 0, directorySyncs: 0 };
  let writingLegacy = false;
  const fsync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", function (fd) {
    if (writingLegacy) baseline[fs.fstatSync(fd).isDirectory() ? "directorySyncs" : "fileSyncs"]++;
    return fsync.call(this, fd);
  });
  ctx.storageEvent = (e) => {
    if (e.phase === "serialized") metrics.serialized += e.bytes;
    if (e.phase === "file-synced") { metrics.written += e.bytes; metrics.fileSyncs++; }
    if (e.phase === "directory-synced") metrics.directorySyncs++;
    if (e.phase === "after-record") metrics.records++;
  };
  const expected = [];
  for (let i = 0; i < 16; i++) {
    const value = journal(i);
    for (let transition = 0; transition < 10; transition++) {
      value.commits[`step-${transition}`] = digest({ i, transition });
      value.status = transition === 9 ? "done" : "running";
      baseline.serialized += Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
      writingLegacy = true;
      state.atomicJson(state.journalFile(legacy, value.id), value);
      writingLegacy = false;
      baseline.written += fs.statSync(state.journalFile(legacy, value.id)).size;
      state.saveJournal(ctx, value);
    }
    expected.push(value);
  }
  const retained = files(ctx.dir).reduce((sum, file) => sum + fs.statSync(file).size, 0);
  baseline.retained = files(legacy.dir).reduce((sum, file) => sum + fs.statSync(file).size, 0);
  assert.equal(metrics.records, 160);
  assert.equal(baseline.fileSyncs, metrics.records);
  assert.ok(metrics.fileSyncs >= metrics.records);
  assert.ok(metrics.written < baseline.written / 10);
  assert.ok(metrics.serialized < baseline.serialized / 10);
  assert.ok(retained < baseline.retained / 10);
  assert.deepEqual(state.journals(ctx).sort((a, b) => a.id.localeCompare(b.id)),
    expected.sort((a, b) => a.id.localeCompare(b.id)));
  t.diagnostic(JSON.stringify({ baseline, shared: { ...metrics, retained } }));
});

test("history scans shared and legacy snapshots identically with measured read volume and no secondary index", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const { graph: initial } = f.apply("split", { spec: f.spec });
  const contexts = ["inline", "shared"].map((name) => ({ ...f.ctx, dir: path.join(f.dir, name) }));
  const write = (ctx, file, value) => ctx === contexts[0]
    ? state.atomicJson(file, value) : state.storedJson(ctx, file, value);
  let graph = structuredClone(initial);
  graph.nodes[0].description = largePatch;
  for (let i = 0; i < 20; i++) {
    const before = graph;
    graph = structuredClone(graph);
    graph.revision++;
    graph.nodes[0].title = `Historical version ${i}`;
    const content = { action: "describe", graph: before, previous: before };
    const plan = { ...content, approval: digest(content) };
    graph.lastOperation = plan.approval;
    const value = { id: plan.approval, plan, candidate: graph, status: "done", historyVersion: 1 };
    const receiptPayload = { version: 1, operation: value.id, action: "describe", before, after: graph };
    const id = digest(receiptPayload);
    for (const ctx of contexts) {
      write(ctx, state.journalFile(ctx, value.id), value);
      write(ctx, path.join(ctx.dir, "history", graph.id, `${id}.json`), { ...receiptPayload, id, recordedAt: i });
    }
  }
  for (const ctx of contexts) write(ctx, state.graphFile(ctx, graph.id), graph);
  const readFile = fs.readFileSync;
  const reads = contexts.map(() => ({ bytes: 0, files: 0 }));
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    const result = readFile.call(this, file, ...args);
    const index = contexts.findIndex((ctx) => String(file).startsWith(`${ctx.dir}${path.sep}`));
    if (index >= 0) { reads[index].bytes += Buffer.byteLength(result); reads[index].files++; }
    return result;
  });
  const timelines = contexts.map((ctx) => history(ctx, "example", "a"));
  assert.deepEqual(timelines[1], timelines[0]);
  assert.equal(timelines[1].events.length, 20);
  assert.ok(reads[1].bytes < reads[0].bytes / 4);
  assert.deepEqual(fs.readdirSync(contexts[1].dir).sort(), ["graphs", "history", "operations", "payloads"]);
  t.diagnostic(`Authoritative 20-operation history lookup: ${JSON.stringify({ inline: reads[0], shared: reads[1] })}`);
});

const stages = ["before-payload", "payload-fsynced", "after-payload", "before-intent", "after-intent",
  "before-effect-receipt", "after-effect-receipt", "after-history", "graph-fsynced", "after-graph", "before-done"];

for (const stage of stages) {
  test(`process interruption at ${stage} retains complete evidence and safe recovery boundaries`, (t) => {
    const f = fixture({ names: ["a"] });
    t.after(() => f.dispose());
    f.spec.nodes[0].description = largePatch;
    const plan = createPlan(f.ctx, "split", { spec: f.spec });
    const planFile = path.join(f.dir, "plan.json");
    state.atomicJson(planFile, plan);
    const moduleUrl = (name) => pathToFileURL(path.resolve(import.meta.dirname, `../lib/${name}.mjs`)).href;
    const script = `
      import { context } from ${JSON.stringify(moduleUrl("git"))};
      import { applyPlan } from ${JSON.stringify(moduleUrl("operations"))};
      import { readJson } from ${JSON.stringify(moduleUrl("state"))};
      const ctx = context(${JSON.stringify(f.root)});
      const plan = readJson(${JSON.stringify(planFile)});
      const stage = ${JSON.stringify(stage)};
      ctx.storageEvent = (e) => {
        const operation = e.file?.includes("operations");
        const graph = e.file?.includes("graphs");
        const intent = operation && e.value?.pendingChange;
        const receipt = operation && !e.value?.pendingChange && Object.keys(e.value?.commits ?? {}).length > 0;
        if ((stage === "before-payload" && e.phase === "before-payload") ||
            (stage === "payload-fsynced" && e.phase === "file-synced" && e.file.includes("payloads")) ||
            (stage === "after-payload" && e.phase === "after-payload") ||
            (stage === "before-intent" && e.phase === "before-record" && intent) ||
            (stage === "after-intent" && e.phase === "after-record" && intent) ||
            (stage === "before-effect-receipt" && e.phase === "before-record" && receipt) ||
            (stage === "after-effect-receipt" && e.phase === "after-record" && receipt) ||
            (stage === "after-history" && e.phase === "after-record" && e.file.includes("history")) ||
            (stage === "graph-fsynced" && e.phase === "file-synced" && graph) ||
            (stage === "after-graph" && e.phase === "after-record" && graph) ||
            (stage === "before-done" && e.phase === "before-record" && operation && e.value.status === "done")) process.exit(73);
      };
      applyPlan(ctx, plan, plan.approval, true);
    `;
    const before = { head: git(f.root, "rev-parse", "HEAD"), status: git(f.root, "status", "--porcelain"),
      index: git(f.root, "diff", "--cached", "--binary") };
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 60000 });
    assert.equal(result.status, 73, result.stderr);
    assert.equal(git(f.root, "rev-parse", "HEAD"), before.head);
    assert.equal(git(f.root, "status", "--porcelain"), before.status);
    assert.equal(git(f.root, "diff", "--cached", "--binary"), before.index);
    const retained = state.readJson(state.journalFile(f.ctx, plan.approval), true);
    if (["before-payload", "payload-fsynced", "after-payload"].includes(stage)) {
      assert.equal(retained, null);
      assert.equal(state.load(f.ctx, "example", true), null);
      return;
    }
    assert.equal(retained.id, plan.approval);
    assert.deepEqual(retained.plan, plan);
    assert.equal(retained.status, "running");
    assert.equal(Boolean(retained.pendingChange), ["after-intent", "before-effect-receipt"].includes(stage));
    const graph = state.load(f.ctx, "example", true);
    assert.equal(Boolean(graph), ["after-graph", "before-done"].includes(stage));
    if (["after-history", "graph-fsynced", "after-graph", "before-done"].includes(stage)) {
      const timeline = history(f.ctx, "example", "a");
      assert.equal(timeline.events[0].persisted, Boolean(graph));
      assert.ok(timeline.versions.every((v) => v.persisted === Boolean(graph)));
    }
    const commits = git(f.root, "for-each-ref", "--format=%(objectname)", `refs/pr-graph/${plan.approval}/commits`);
    if (["after-intent", "before-intent"].includes(stage)) assert.equal(commits, "");
    if (stage === "before-effect-receipt") {
      assert.notEqual(commits, "");
      assert.deepEqual(retained.commits, {});
    }
    f.apply("unlock");
    if (retained.pendingChange) {
      assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /pending change/);
    } else {
      const resumed = applyPlan(f.ctx, plan, plan.approval, true);
      assert.equal(state.readJson(state.journalFile(f.ctx, plan.approval)).status, "done");
      assert.equal(resumed.graph.lastOperation, plan.approval);
      if (graph) assert.equal(resumed.alreadyDone, true);
    }
  });
}
