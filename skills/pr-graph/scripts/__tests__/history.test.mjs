import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import * as state from "../lib/state.mjs";
import { digest } from "../lib/graph.mjs";
import { normalizeChange } from "../lib/changes.mjs";
import { history, interdiff } from "../lib/history.mjs";

function userState(f) {
  return {
    head: git(f.root, "rev-parse", "HEAD"),
    refs: git(f.root, "show-ref"),
    index: git(f.root, "diff", "--cached", "--binary"),
    worktree: git(f.root, "diff", "--binary"),
    status: git(f.root, "status", "--porcelain", "--untracked-files=all"),
    worktrees: git(f.root, "worktree", "list", "--porcelain"),
    graph: state.load(f.ctx, "example"),
    journals: state.journals(f.ctx),
    objects: fs.readdirSync(git(f.root, "rev-parse", "--path-format=absolute", "--git-path", "objects"),
      { recursive: true }).sort(),
  };
}

function saveSnapshot(f, graph, action = "split-node") {
  const plan = { approval: digest({ graph, action }), action };
  graph.revision++;
  graph.lastOperation = plan.approval;
  state.save(f.ctx, graph, plan);
}

test("history and interdiff separate shared-prerequisite reconstruction from owned edits without touching user state", (t) => {
  const f = fixture({ names: ["a", "b", "c", "d", "f"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const original = history(f.ctx, "example", "f").current;
  git(f.root, "checkout", "trunk");
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text([]).replace("a context 4", "new context\na context 4"));
  git(f.root, "commit", "-qam", "advance target");
  git(f.root, "checkout", "source");
  f.apply("sync", { graph: "example", localOnly: true });
  fs.writeFileSync(path.join(f.root, "staged.txt"), "preserve staged work\n");
  git(f.root, "add", "staged.txt");
  fs.appendFileSync(path.join(f.root, "shared.txt"), "dirty work\n");
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "preserve untracked work\n");
  const before = userState(f);
  const result = interdiff(f.ctx, "example", "f", original);
  assert.equal(result.ownChange.patchChanged, false);
  assert.equal(result.changes.realization, true);
  assert.equal(result.changes.prerequisites, true);
  assert.equal(result.changes.integration, true);
  assert.equal(result.comparison.status, "equal");
  assert.equal(result.comparison.patch, "");
  const timeline = history(f.ctx, "example", "f");
  assert.equal(timeline.events.filter((e) => e.action === "sync").length, 1);
  assert.equal(timeline.events.at(-1).status, "done");
  assert.equal(timeline.events.at(-1).persisted, true);
  assert.deepEqual(timeline.gaps, []);
  const json = cli(f.root, "history", "--graph", "example", "--node", "f", "--quiet");
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).current, timeline.current);
  const text = cli(f.root, "interdiff", "--graph", "example", "--node", "f",
    "--from", original, "--format", "text", "--quiet");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Own patch: unchanged; realization: changed/);
  assert.deepEqual(userState(f), before);
});

test("history follows explicit fold lineage and interdiff detects changed ownership", (t) => {
  const f = fixture({ names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const original = history(f.ctx, "example", "a").current;
  const other = history(f.ctx, "example", "b").current;
  f.apply("fold", { graph: "example", spec: { id: "example", nodes: [{
    id: "a", title: "Combined", dependencies: [], supersedes: ["b"],
    change: { base: f.base, head: f.head }, validationReason: "No build system.",
  }] } });
  const timeline = history(f.ctx, "example", "b");
  assert.deepEqual(timeline.lineage, [{ from: "b", to: "a" }]);
  assert.ok(timeline.versions.some((v) => v.node === "b" && v.snapshot.node.retired));
  assert.ok(timeline.versions.some((v) => v.node === "a"));
  const result = interdiff(f.ctx, "example", "a", original);
  assert.equal(result.ownChange.patchChanged, true);
  assert.equal(result.comparison.status, "different");
  assert.match(result.comparison.patch, /\+b=1/);
  assert.equal(interdiff(f.ctx, "example", "a", other).comparison.status, "different");
  assert.equal(timeline.events.filter((e) => e.node === "b" && e.action === "fold").length, 1);
});

test("common-base comparison isolates context movement and reports conflicting edits as inconclusive", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const original = history(f.ctx, "example", "a").current;
  git(f.root, "checkout", "-qb", "new-base", f.base);
  const shifted = f.text([]).replace("a context 4", "header\na context 4");
  fs.writeFileSync(path.join(f.root, "shared.txt"), shifted);
  git(f.root, "commit", "-qam", "shifted base");
  const base = git(f.root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.root, "shared.txt"), shifted.replace("a=0", "a=2"));
  git(f.root, "commit", "-qam", "updated owned edit");
  const graph = state.load(f.ctx, "example");
  graph.nodes[0].change = normalizeChange(f.root, { base, head: git(f.root, "rev-parse", "HEAD") });
  graph.nodes[0].base = base;
  graph.nodes[0].head = graph.nodes[0].change.head;
  saveSnapshot(f, graph);
  const result = interdiff(f.ctx, "example", "a", original);
  assert.equal(result.ownChange.baseChanged, true);
  assert.equal(result.ownChange.patchChanged, true);
  assert.equal(result.comparison.status, "different");
  assert.match(result.comparison.patch, /-a=1\n\+a=2/);
  assert.doesNotMatch(result.comparison.patch, /\+header/);

  const conflictGraph = state.load(f.ctx, "example");
  conflictGraph.nodes[0].change = normalizeChange(f.root, { base: graph.nodes[0].change.head,
    patch: graph.nodes[0].change.patch });
  conflictGraph.nodes[0].base = graph.nodes[0].change.head;
  saveSnapshot(f, conflictGraph);
  const conflict = interdiff(f.ctx, "example", "a", original);
  assert.equal(conflict.comparison.status, "inconclusive");
  assert.equal(conflict.comparison.patch, null);
});

test("publication and validation baselines require explicit evidence, not an attempted remote write", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  const split = f.apply("split", { spec: f.spec });
  let timeline = history(f.ctx, "example", "a");
  assert.equal(timeline.baselines["last-published"], null);
  assert.ok(timeline.baselines["last-validated"]);
  const published = f.apply("publish", { graph: "example" });
  timeline = history(f.ctx, "example", "a");
  const event = timeline.events.find((e) => e.operation === published.operation);
  assert.equal(event.publication.scope, "remote-refs");
  assert.equal(timeline.baselines["last-published"], timeline.current);
  assert.equal(interdiff(f.ctx, "example", "a", "last-published").comparison.status, "equal");
  const journal = state.readJson(state.journalFile(f.ctx, published.operation));
  journal.status = "running";
  journal.error = "Interrupted after verified publication";
  state.atomicJson(state.journalFile(f.ctx, journal.id), journal);
  timeline = history(f.ctx, "example", "a");
  assert.equal(timeline.events.find((e) => e.operation === journal.id).status, "running");
  assert.equal(timeline.baselines["last-published"], timeline.current);
  delete journal.published;
  state.atomicJson(state.journalFile(f.ctx, journal.id), journal);
  assert.equal(history(f.ctx, "example", "a").baselines["last-published"], null);
  assert.throws(() => interdiff(f.ctx, "example", "a", "last-published"), /Unavailable node version/);
  assert.ok(history(f.ctx, "example", "a").events.find((e) => e.operation === split.operation).validation);
});

test("legacy journals, missing commits, restore boundaries, and absent snapshots are reported without repair", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const split = f.apply("split", { spec: f.spec });
  const original = history(f.ctx, "example", "a").current;
  const dir = path.join(f.ctx.dir, "history", "example");
  for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
  const legacy = state.readJson(state.journalFile(f.ctx, split.operation));
  delete legacy.historyVersion;
  state.atomicJson(state.journalFile(f.ctx, legacy.id), legacy);
  let timeline = history(f.ctx, "example", "a");
  assert.ok(timeline.gaps.some((g) => g.includes("Legacy")));
  assert.equal(timeline.events[0].source, "legacy-journal");
  const graph = state.load(f.ctx, "example");
  graph.nodes[0].change.base = "0".repeat(40);
  graph.nodes[0].base = graph.nodes[0].change.base;
  saveSnapshot(f, graph, "restore");
  timeline = history(f.ctx, "example", "a");
  assert.ok(timeline.gaps.some((g) => g.includes("history boundary")));
  assert.ok(timeline.gaps.some((g) => g.includes("unavailable")));
  const before = userState(f);
  assert.equal(interdiff(f.ctx, "example", "a", original).comparison.status, "unavailable");
  assert.deepEqual(userState(f), before);
  const journal = state.readJson(state.journalFile(f.ctx, split.operation));
  journal.status = "aborted";
  delete journal.candidate;
  state.atomicJson(state.journalFile(f.ctx, journal.id), journal);
  const event = history(f.ctx, "example", "a").events.find((e) => e.operation === split.operation);
  assert.equal(event.status, "aborted");
  assert.equal(event.after, null);
});

test("history receipts pin versions and reject corrupted evidence; CLI rejects invalid selectors", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const timeline = history(f.ctx, "example", "a");
  const refs = git(f.root, "for-each-ref", "--format=%(objectname)", "refs/pr-graph/history");
  assert.ok(refs.split("\n").includes(timeline.versions[0].snapshot.node.head));
  assert.equal(cli(f.root, "history", "--graph", "example", "--node", "a", "--format", "text").status, 0);
  assert.equal(cli(f.root, "interdiff", "--graph", "example", "--node", "a").status, 1);
  assert.equal(cli(f.root, "history", "--graph", "example", "--node", "a", "--from", "current").status, 1);
  assert.throws(() => interdiff(f.ctx, "example", "a", "unknown"), /Unavailable/);
  const dir = path.join(f.ctx.dir, "history", "example");
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const receipt = state.readJson(file);
  receipt.after.nodes[0].title = "corrupted";
  state.atomicJson(file, receipt);
  assert.throws(() => history(f.ctx, "example", "a"), /Invalid history receipt/);
});

test("interdiff preserves binary content and Git mode metadata", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const original = history(f.ctx, "example", "a").current;
  git(f.root, "checkout", "-qb", "binary-change", f.base);
  fs.writeFileSync(path.join(f.root, "image.bin"), Buffer.from([0, 1, 2, 255]));
  git(f.root, "add", "image.bin");
  git(f.root, "update-index", "--chmod=+x", "image.bin");
  git(f.root, "commit", "-qm", "binary and mode");
  const graph = state.load(f.ctx, "example");
  graph.nodes[0].change = normalizeChange(f.root, { base: f.base, head: git(f.root, "rev-parse", "HEAD") });
  graph.nodes[0].base = f.base;
  graph.nodes[0].head = graph.nodes[0].change.head;
  saveSnapshot(f, graph);
  const result = interdiff(f.ctx, "example", "a", original);
  assert.equal(result.comparison.status, "different");
  assert.match(result.comparison.patch, /GIT binary patch/);
  assert.match(result.comparison.patch, /100755/);
});

test("interdiff compares realized review deltas even when authored patches are unchanged", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const original = history(f.ctx, "example", "a").current;
  git(f.root, "checkout", "-qb", "resolved-version", f.base);
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text(["a"]).replace("a=1", "a=2"));
  git(f.root, "commit", "-qam", "different realized resolution");
  const graph = state.load(f.ctx, "example");
  graph.nodes[0].head = git(f.root, "rev-parse", "HEAD");
  saveSnapshot(f, graph, "sync");
  const result = interdiff(f.ctx, "example", "a", original);
  assert.equal(result.ownChange.patchChanged, false);
  assert.equal(result.comparison.scope, "realized-own-change");
  assert.equal(result.comparison.status, "different");
  assert.match(result.comparison.patch, /-a=1\n\+a=2/);
});

test("historical comparison does not hydrate missing blobs from a promisor remote", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  git(f.root, "push", "-q", "upstream", "source");
  const blob = git(f.root, "rev-parse", `${f.head}:shared.txt`);
  const objects = git(f.root, "rev-parse", "--path-format=absolute", "--git-path", "objects");
  const file = path.join(objects, blob.slice(0, 2), blob.slice(2));
  assert.ok(fs.existsSync(file));
  git(f.root, "config", "remote.upstream.promisor", "true");
  git(f.root, "config", "extensions.partialClone", "upstream");
  fs.unlinkSync(file);
  const result = interdiff(f.ctx, "example", "a", "current");
  assert.equal(result.comparison.status, "unavailable");
  assert.equal(result.comparison.patch, null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(path.join(objects, "pack")), []);
});

test("history distinguishes a receipt written before graph persistence from a completed save", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const before = state.load(f.ctx, "example");
  const graph = structuredClone(before);
  graph.nodes[0].title = "Renamed";
  saveSnapshot(f, graph, "describe");
  state.atomicJson(state.graphFile(f.ctx, "example"), before);
  let event = history(f.ctx, "example", "a").events.at(-1);
  assert.equal(event.action, "describe");
  assert.equal(event.persisted, false);
  state.atomicJson(state.graphFile(f.ctx, "example"), graph);
  event = history(f.ctx, "example", "a").events.at(-1);
  assert.equal(event.persisted, true);
  assert.equal(event.status, "unknown");
});

test("history inspects an interrupted first operation without inventing a persisted graph", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const split = f.apply("split", { spec: f.spec });
  const journal = state.readJson(state.journalFile(f.ctx, split.operation));
  journal.status = "running";
  state.atomicJson(state.journalFile(f.ctx, split.operation), journal);
  fs.unlinkSync(state.graphFile(f.ctx, "example"));
  const before = git(f.root, "show-ref");
  const timeline = history(f.ctx, "example", "a");
  assert.equal(timeline.current, null);
  assert.equal(timeline.events[0].status, "running");
  assert.equal(timeline.events[0].persisted, false);
  assert.ok(timeline.versions.every((v) => !v.persisted));
  assert.ok(timeline.gaps.some((g) => g.includes("No persisted graph")));
  const version = timeline.events[0].after;
  assert.equal(interdiff(f.ctx, "example", "a", version, version).comparison.status, "equal");
  assert.throws(() => interdiff(f.ctx, "example", "a", version), /Unavailable node version/);
  assert.equal(git(f.root, "show-ref"), before);
  assert.equal(fs.existsSync(state.graphFile(f.ctx, "example")), false);
});
