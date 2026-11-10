import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import * as gitLib from "../lib/git.mjs";
import * as state from "../lib/state.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";
import { digest } from "../lib/graph.mjs";
import { history, interdiff } from "../lib/history.mjs";
import { historyArchives } from "../lib/history-archive.mjs";

function exportArchive(f, filename = "history.json") {
  const file = path.join(f.dir, filename);
  const plan = createPlan(f.ctx, "export-history", { graph: "example", archive: file });
  applyPlan(f.ctx, plan, plan.approval, true);
  return { file, archive: state.readJson(file), plan };
}

function importArchive(ctx, file) {
  const plan = createPlan(ctx, "import-history", { graph: "example", archive: file });
  return applyPlan(ctx, plan, plan.approval, true);
}

function clone(f) {
  const root = path.join(f.dir, "recipient");
  git(f.dir, "clone", "-q", "--no-local", "--single-branch", "--branch", "source", f.root, root);
  return gitLib.context(root);
}

function executionState(ctx) {
  const graphDir = path.join(ctx.dir, "graphs");
  const operationDir = path.join(ctx.dir, "operations");
  const files = (dir) => fs.existsSync(dir) ? Object.fromEntries(fs.readdirSync(dir).sort()
    .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")])) : {};
  return {
    head: git(ctx.root, "rev-parse", "HEAD"),
    productRefs: git(ctx.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"),
    index: fs.readFileSync(git(ctx.root, "rev-parse", "--path-format=absolute", "--git-path", "index")).toString("base64"),
    status: git(ctx.root, "status", "--porcelain", "--untracked-files=all"),
    worktree: git(ctx.root, "diff", "--binary"),
    registry: git(ctx.root, "worktree", "list", "--porcelain"),
    graphs: files(graphDir), journals: files(operationDir),
  };
}

function rewrite(file, edit) {
  const archive = state.readJson(file);
  edit(archive);
  const { id, ...payload } = archive;
  archive.id = digest(payload);
  state.atomicJson(file, archive);
  return archive;
}

test("portable history retains unreachable versions, lineage and historical baselines offline without importing execution state", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const old = history(f.ctx, "example", "a").current;
  f.apply("publish", { graph: "example" });
  f.apply("fold", { graph: "example", spec: { id: "example", nodes: [{
    id: "a", title: "Combined", dependencies: [], supersedes: ["b"],
    change: { base: f.base, head: f.head }, validationReason: "No build system.",
  }] } });
  f.apply("split-node", { graph: "example", spec: { id: "example", nodes: [
    { id: "c", title: "First replacement", dependencies: [], supersedes: ["a"],
      change: f.changes.a, validationReason: "No build system." },
    { id: "d", title: "Second replacement", dependencies: [], supersedes: ["a"],
      change: f.changes.b, validationReason: "No build system." },
  ] } });
  const local = history(f.ctx, "example", "a");
  const priorHead = local.versions.find((v) => v.id === old).snapshot.node.head;
  // Only current product refs are cloned, not history retention refs.
  const destination = clone(f);
  assert.equal(gitLib.git(destination.root, ["cat-file", "-e", priorHead], undefined, true).status, 1);
  fs.writeFileSync(path.join(destination.root, "staged.txt"), "keep staged\n");
  git(destination.root, "add", "staged.txt");
  fs.appendFileSync(path.join(destination.root, "shared.txt"), "keep unstaged\n");
  fs.writeFileSync(path.join(destination.root, "untracked.txt"), "keep untracked\n");
  const { file, archive, plan } = exportArchive(f);
  assert.equal(archive.completeness.objects, true);
  assert.equal(archive.completeness.evidence, true);
  assert.match(plan.effects.join("\n"), /sensitive material/);
  assert.match(plan.effects.join("\n"), /storage and retention/);
  const text = JSON.stringify(archive);
  assert.equal(text.includes(f.root), false);
  assert.equal(text.includes('"plan"'), false);
  assert.equal(text.includes('"validations"'), false);
  const before = executionState(destination);
  const result = importArchive(destination, file);
  assert.equal(result.imported, archive.id);
  assert.deepEqual(executionState(destination), before);
  assert.equal(importArchive(destination, file).alreadyImported, true);
  assert.deepEqual(executionState(destination), before);
  const replay = createPlan(destination, "import-history", { graph: "example", archive: file });
  fs.unlinkSync(path.join(destination.dir, "history-archives", "example", `${archive.id}.json`));
  assert.equal(applyPlan(destination, replay, replay.approval, true).alreadyImported, false);
  assert.deepEqual(executionState(destination), before);
  assert.equal(historyArchives(destination, "example")[0].origin, archive.origin);
  fs.renameSync(f.root, path.join(f.dir, "source-unavailable"));
  const imported = history(destination, "example", "a", archive.id);
  assert.deepEqual(imported.versions.map((v) => v.id), local.versions.map((v) => v.id));
  assert.deepEqual(imported.lineage, [
    { from: "a", to: "c" }, { from: "a", to: "d" }, { from: "b", to: "a" },
  ]);
  assert.equal(imported.current, null);
  assert.equal(imported.sourceCurrent, local.current);
  assert.deepEqual(imported.baselines, local.baselines);
  assert.equal(imported.baselineOrigins["last-published"].origin, archive.origin);
  assert.ok(imported.events.every((e) => e.source === "imported"));
  assert.ok(imported.versions.every((v) => !v.missingCommits.length));
  assert.equal(interdiff(destination, "example", "a", old, local.current, archive.id).comparison.status, "different");
  assert.equal(interdiff(destination, "example", "a", "last-validated", local.current, archive.id).comparison.status, "equal");
  assert.throws(() => interdiff(destination, "example", "a", old, undefined, archive.id), /Unavailable/);
  assert.throws(() => history(destination, "example", "a"), /Unknown historical node/);
  assert.deepEqual(executionState(destination), before);
  const command = cli(destination.root, "history", "--graph", "example", "--node", "a",
    "--archive", archive.id, "--format", "text", "--quiet");
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /Imported archive:.*origin:/);
  const list = cli(destination.root, "history-archives", "--graph", "example", "--quiet");
  assert.equal(JSON.parse(list.stdout)[0].archive, archive.id);
});

test("candidate and interrupted legacy evidence round-trips with exact IDs and explicit gaps", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const split = f.apply("split", { spec: f.spec });
  const journal = state.readJson(state.journalFile(f.ctx, split.operation));
  delete journal.historyVersion;
  journal.status = "running";
  journal.error = `private machine path: ${f.root}`;
  journal.pendingChange = { command: "do not export" };
  journal.recoveries = [{ operation: digest("recovery"), action: "resolve", recordedAt: 123,
    worktree: f.root, instructions: "do not export" }];
  state.atomicJson(state.journalFile(f.ctx, split.operation), journal);
  const dir = path.join(f.ctx.dir, "history", "example");
  for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
  fs.unlinkSync(state.graphFile(f.ctx, "example"));
  const local = history(f.ctx, "example", "a");
  const destination = clone(f);
  const { file, archive } = exportArchive(f);
  assert.equal(archive.completeness.evidence, false);
  assert.ok(archive.completeness.gaps.some((g) => g.includes("Legacy")));
  assert.equal(JSON.stringify(archive).includes(f.root), false);
  importArchive(destination, file);
  const imported = history(destination, "example", "a", archive.id);
  assert.deepEqual(imported.versions.map((v) => v.id), local.versions.map((v) => v.id));
  assert.ok(imported.versions.every((v) => !v.persisted));
  assert.equal(imported.events[0].status, "running");
  assert.equal(imported.events[0].originalSource, "legacy-journal");
  assert.deepEqual(imported.events[0].recoveries[0], {
    operation: digest("recovery"), action: "resolve", recordedAt: 123,
  });
  const version = imported.events[0].after;
  assert.equal(interdiff(destination, "example", "a", version, version, archive.id).comparison.status, "equal");
  assert.equal(state.journals(destination).length, 0);
  assert.equal(state.load(destination, "example", true), null);
});

test("receipt-before-save candidates and operations without an after snapshot remain incomplete historical evidence", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const before = state.load(f.ctx, "example");
  const candidate = structuredClone(before);
  candidate.nodes[0].title = "Not saved";
  candidate.revision++;
  state.save(f.ctx, candidate, { approval: digest(candidate), action: "describe" });
  state.atomicJson(state.graphFile(f.ctx, "example"), before);
  const operation = digest("interrupted without candidate");
  state.atomicJson(state.journalFile(f.ctx, operation), {
    id: operation, historyVersion: 1, status: "running",
    plan: { graphId: "example", previous: before, action: "sync" },
  });
  const destination = clone(f);
  const { file, archive } = exportArchive(f);
  importArchive(destination, file);
  const imported = history(destination, "example", "a", archive.id);
  const event = imported.events.find((e) => e.action === "describe");
  assert.equal(event.persisted, false);
  assert.equal(imported.versions.find((v) => v.id === event.after).persisted, false);
  assert.equal(imported.events.find((e) => e.operation === operation).after, null);
  assert.equal(archive.completeness.evidence, false);
  assert.ok(imported.gaps.some((g) => g.includes("no retained after snapshot")));
});

test("import does not change current approvals, recovery, validation, readiness or freshness and never executes imported commands", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const split = f.apply("split", { spec: f.spec });
  const graph = state.load(f.ctx, "example");
  const marker = path.join(f.dir, "executed");
  graph.nodes[0].validations = [{ command: process.execPath, args: ["-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`] }];
  graph.nodes[0].validation = { head: graph.nodes[0].head, commands: digest(graph.nodes[0].validations),
    reason: "Historical result only" };
  graph.nodes[0].ready = true;
  graph.revision++;
  const plan = { approval: digest(graph), action: "describe" };
  state.save(f.ctx, graph, plan);
  const journal = state.readJson(state.journalFile(f.ctx, split.operation));
  journal.status = "running";
  journal.plan.privateSentinel = "keep current approval";
  state.atomicJson(state.journalFile(f.ctx, split.operation), journal);
  const before = executionState(f.ctx);
  const { file, archive } = exportArchive(f);
  assert.equal(JSON.stringify(archive).includes(marker), false);
  importArchive(f.ctx, file);
  assert.deepEqual(executionState(f.ctx), before);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(history(f.ctx, "example", "a").current, history(f.ctx, "example", "a", archive.id).sourceCurrent);
  assert.equal(history(f.ctx, "example", "a", archive.id).current, null);
  assert.equal(fs.existsSync(marker), false);
  const destination = clone(f);
  const current = structuredClone(graph);
  current.nodes[0].validations = [];
  current.nodes[0].validation = null;
  current.nodes[0].ready = false;
  if (current.integration) delete current.integration.verifiedAt;
  if (current.nodes[0].integration) delete current.nodes[0].integration.verifiedAt;
  state.atomicJson(state.graphFile(destination, "example"), current);
  const localBefore = executionState(destination);
  importArchive(destination, file);
  assert.deepEqual(executionState(destination), localBefore);
  assert.equal(state.load(destination, "example").nodes[0].validation, null);
  assert.equal(state.load(destination, "example").nodes[0].ready, false);
  assert.equal(state.load(destination, "example").integration?.verifiedAt, undefined);
  assert.equal(fs.existsSync(marker), false);
});

test("archives reject corrupt packs, unsupported schemas, missing inventory, unsafe fields and graph identities before destination changes", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const { file, archive } = exportArchive(f);
  const destination = clone(f);
  const invalid = path.join(f.dir, "invalid.json");
  const before = executionState(destination);
  const mutations = [
    [(a) => { a.version = 2; }, /Unsupported/],
    [(a) => { a.objectFormat = "sha512"; }, /object format/],
    [(a) => { a.objectFormat = "sha256"; }, /base|roots|identity|format/],
    [(a) => { a.graph = "other"; }, /graph\/origin/],
    [(a) => { a.origin = "../escape"; }, /graph\/origin/],
    [(a) => { a.files = [{ path: "../../escape" }]; }, /schema/],
    [(a) => { a.pack = Buffer.from("not a pack").toString("base64"); }, /object pack/],
    [(a) => { a.objects.pop(); }, /unavailable object|inventory/],
    [(a) => { a.completeness.missingObjects = [f.base]; }, /missing objects/],
    [(a) => { a.timelines[0].versions[0].snapshot.node.pendingChange = { command: "bad" }; }, /snapshot fields/],
    [(a) => { a.timelines[0].graph = "other"; }, /timeline/],
    [(a) => { a.timelines[0].versions[0].id = "f".repeat(64); }, /version identity/],
    [(a) => { a.timelines[0].baselines["last-published"] = a.timelines[0].sourceCurrent; }, /baseline.*receipt/],
    [(a) => { a.timelines[0].events[0].validation.commands = "f".repeat(64); }, /validation receipt/],
  ];
  for (const [edit, pattern] of mutations) {
    state.atomicJson(invalid, archive);
    rewrite(invalid, edit);
    assert.throws(() => createPlan(destination, "import-history", { graph: "example", archive: invalid }), pattern);
    assert.deepEqual(executionState(destination), before);
    assert.deepEqual(historyArchives(destination, "example"), []);
    assert.equal(git(destination.root, "for-each-ref", "refs/pr-graph/archives"), "");
  }
  state.atomicJson(invalid, archive);
  const corrupt = state.readJson(invalid);
  corrupt.timelines[0].versions[0].snapshot.node.title = "tampered";
  state.atomicJson(invalid, corrupt);
  assert.throws(() => importArchive(destination, invalid), /integrity/);
  assert.deepEqual(executionState(destination), before);
});

test("retained version conflicts and graph identity conflicts never overwrite imported evidence", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const { file, archive } = exportArchive(f);
  const destination = clone(f);
  importArchive(destination, file);
  const existing = fs.readFileSync(path.join(destination.dir, "history-archives", "example", `${archive.id}.json`), "utf8");
  const conflict = path.join(f.dir, "conflict.json");
  state.atomicJson(conflict, archive);
  rewrite(conflict, (a) => { a.timelines[0].versions[0].snapshot.node.title = "different content under same ID"; });
  assert.throws(() => importArchive(destination, conflict), /Conflicting archived version/);
  state.atomicJson(conflict, archive);
  rewrite(conflict, (a) => { a.identity.target = "different"; });
  assert.throws(() => importArchive(destination, conflict), /graph\/origin identity/);
  assert.equal(fs.readFileSync(path.join(destination.dir, "history-archives", "example", `${archive.id}.json`), "utf8"), existing);
  const other = fixture({ names: ["different"] });
  t.after(() => other.dispose());
  other.apply("split", { spec: other.spec });
  assert.throws(() => importArchive(other.ctx, file), /local graph identity/);
});

test("successive exports preserve clone origin while keeping imported archive selections independent", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const first = exportArchive(f);
  const graph = state.load(f.ctx, "example");
  graph.revision++;
  graph.nodes[0].title = "Later historical title";
  state.save(f.ctx, graph, { action: "describe", approval: digest(graph) });
  const second = exportArchive(f, "later.json");
  assert.equal(first.archive.origin, second.archive.origin);
  assert.notEqual(first.archive.id, second.archive.id);
  const destination = clone(f);
  importArchive(destination, first.file);
  importArchive(destination, second.file);
  assert.equal(historyArchives(destination, "example").length, 2);
  const old = history(destination, "example", "a", first.archive.id);
  const next = history(destination, "example", "a", second.archive.id);
  assert.notEqual(old.sourceCurrent, next.sourceCurrent);
  assert.equal(old.versions.find((v) => v.id === old.sourceCurrent).snapshot.node.title, "Implement a");
  assert.equal(next.versions.find((v) => v.id === next.sourceCurrent).snapshot.node.title, "Later historical title");
  assert.equal(state.load(destination, "example", true), null);
});

test("history export reports missing objects without lazy fetching or writing a partial archive", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const blob = git(f.root, "rev-parse", `${f.head}:shared.txt`);
  const objectDir = git(f.root, "rev-parse", "--path-format=absolute", "--git-path", "objects");
  const objectFile = path.join(objectDir, blob.slice(0, 2), blob.slice(2));
  fs.unlinkSync(objectFile);
  git(f.root, "config", "remote.upstream.promisor", "true");
  git(f.root, "config", "extensions.partialClone", "upstream");
  const file = path.join(f.dir, "missing.json");
  const plan = createPlan(f.ctx, "export-history", { graph: "example", archive: file });
  assert.equal(plan.archive.completeness.objects, false);
  assert.ok(plan.archive.completeness.missingObjects.includes(blob));
  assert.match(plan.effects.join("\n"), /Export blocked/);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /missing objects/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(objectFile), false);
});

test("history transfers pin the approved payload and reject changed evidence, unsafe destinations and missing approval", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const file = path.join(f.dir, "history.json");
  const plan = createPlan(f.ctx, "export-history", { graph: "example", archive: file });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, false), /approval|--yes/);
  assert.throws(() => applyPlan(f.ctx, plan, "f".repeat(64), true), /approval|digest/);
  assert.throws(() => createPlan(f.ctx, "export-history", { graph: "example", archive: file,
    reuseWorktree: "f".repeat(64) }), /Worktree reuse/);
  assert.throws(() => createPlan(f.ctx, "export-history", { graph: "example",
    archive: path.join(f.root, "unsafe.json") }), /outside/);
  if (process.platform !== "win32") {
    const link = path.join(f.dir, "symlink.json");
    fs.symlinkSync(path.join(f.dir, "not-created.json"), link);
    assert.throws(() => createPlan(f.ctx, "export-history", { graph: "example", archive: link }), /symbolic link|exists/);
  }
  const graph = state.load(f.ctx, "example");
  graph.nodes[0].title = "changed";
  state.save(f.ctx, graph);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /changed; replan/);
  const exported = exportArchive(f);
  const destination = clone(f);
  const incoming = createPlan(destination, "import-history", { graph: "example", archive: exported.file });
  rewrite(exported.file, (a) => { a.createdAt++; });
  assert.throws(() => applyPlan(destination, incoming, incoming.approval, true), /changed; replan/);
  assert.deepEqual(historyArchives(destination, "example"), []);
});

test("history transfers reject worktree destinations across Windows path aliases", {
  skip: process.platform !== "win32",
}, (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const canonicalRoot = fs.realpathSync.native(f.root);
  const roots = [f.root, canonicalRoot, path.toNamespacedPath(canonicalRoot)];
  for (const root of roots) {
    for (const destination of roots) {
      for (const action of ["export-history", "import-history"]) {
        assert.throws(() => createPlan({ ...f.ctx, root }, action, {
          graph: "example", archive: path.join(destination, "unsafe.json"),
        }), /outside/);
      }
    }
  }
});

test("SHA-256 archives round-trip only into repositories with the matching object format", (t) => {
  const f = fixture({ names: ["a"], objectFormat: "sha256" });
  t.after(() => f.dispose());
  f.apply("split", { spec: f.spec });
  const { file, archive } = exportArchive(f);
  assert.equal(archive.objectFormat, "sha256");
  const destination = clone(f);
  importArchive(destination, file);
  const imported = history(destination, "example", "a", archive.id);
  assert.equal(interdiff(destination, "example", "a",
    imported.sourceCurrent, imported.sourceCurrent, archive.id).comparison.status, "equal");
  const other = fixture({ names: ["a"] });
  t.after(() => other.dispose());
  assert.throws(() => importArchive(other.ctx, file), /different Git object format/);
});
