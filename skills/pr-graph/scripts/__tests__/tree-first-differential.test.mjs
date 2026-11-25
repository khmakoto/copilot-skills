import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fixture, git } from "./fixtures.mjs";
import { applyChange, normalizeChange } from "../lib/changes.mjs";
import { checkoutClean, out, tree, withObjectView } from "../lib/git.mjs";

// Research-only: candidate trees are not commits, receipts, or recovery evidence.
function candidates(f, base, changes, inspect = () => {}) {
  return withObjectView(f.ctx, (run) => {
    const execute = (args, input) => {
      const result = run(args, input);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    execute(["read-tree", base]);
    const trees = [];
    for (const change of changes) {
      const result = run(["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], change.patch);
      if (result.status !== 0) {
        return { trees, conflict: run(["ls-files", "--unmerged"]).stdout, error: result.stderr };
      }
      trees.push(execute(["write-tree"]));
    }
    inspect(run, trees);
    return { trees };
  });
}

function measure(f, name, action) {
  const file = path.join(f.dir, `${name}.trace.jsonl`);
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = file;
  const start = performance.now();
  let result;
  try { result = action(); } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
  const elapsedMs = performance.now() - start;
  const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const commands = events.filter((event) => event.event === "start").map((event) => event.argv.slice(1));
  return { result, counters: { subprocesses: commands.length,
    checkouts: commands.filter((args) => args[0] === "checkout").length,
    worktreeAdds: commands.filter((args) => args[0] === "worktree" && args[1] === "add").length,
    commits: commands.filter((args) => args[0] === "commit").length,
    unpackTrees: events.filter((event) => event.event === "region_enter" && event.label === "unpack_trees").length,
    elapsedMs } };
}

function replay(f, base, changes) {
  const cwd = path.join(f.dir, "materialized");
  git(f.root, "worktree", "add", "--detach", cwd, base);
  const trees = [];
  let snapshotBytes = 0;
  for (const [i, change] of changes.entries()) {
    const head = applyChange(cwd, change, `Candidate ${i}\n\nTest-Recipe: tree-first`);
    trees.push(tree(cwd, head));
    for (const file of git(cwd, "ls-files", "-z").split("\0").filter(Boolean)) {
      const stat = fs.lstatSync(path.join(cwd, file));
      if (stat.isFile()) snapshotBytes += stat.size;
    }
  }
  return { trees, snapshotBytes, cwd };
}

for (const objectFormat of ["sha1", "sha256"]) {
  test(`tree-only prototype preserves every intermediate tree without source writes (${objectFormat})`, (t) => {
    const f = fixture({ objectFormat });
    t.after(() => f.dispose());
    const changes = f.spec.nodes.map((node) => normalizeChange(f.root, node.change));
    fs.writeFileSync(path.join(f.root, "user.txt"), "untracked user content\n");
    fs.appendFileSync(path.join(f.root, "shared.txt"), "user edit\n");
    git(f.root, "add", "shared.txt");
    const index = fs.readFileSync(path.join(f.ctx.common, "index"));
    const status = git(f.root, "status", "--porcelain");
    const expected = measure(f, "materialized", () => replay(f, f.base, changes));
    const before = fs.readdirSync(path.join(f.ctx.common, "objects"), { recursive: true }).sort();
    const prototype = measure(f, "tree-only", () => candidates(f, f.base, changes));
    assert.deepEqual(prototype.result.trees, expected.result.trees);
    assert.deepEqual(fs.readdirSync(path.join(f.ctx.common, "objects"), { recursive: true }).sort(), before);
    assert.deepEqual(fs.readFileSync(path.join(f.ctx.common, "index")), index);
    assert.equal(git(f.root, "status", "--porcelain"), status);
    assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
    assert.equal(fs.readFileSync(path.join(f.root, "user.txt"), "utf8"), "untracked user content\n");
    assert.equal(prototype.counters.checkouts, 0);
    assert.equal(prototype.counters.worktreeAdds, 0);
    assert.equal(expected.counters.worktreeAdds, 1);
    assert.equal(prototype.counters.commits, 0);
    assert.equal(expected.counters.commits, changes.length);
    assert.ok(prototype.counters.subprocesses < expected.counters.subprocesses);
    assert.ok(prototype.counters.unpackTrees < expected.counters.unpackTrees);
    assert.equal(git(expected.result.cwd, "log", "--reverse", "--format=%B", `${f.base}..HEAD`),
      changes.map((_, i) => `Candidate ${i}\n\nTest-Recipe: tree-first`).join("\n\n"));
    t.diagnostic(JSON.stringify({ objectFormat, materialized: { ...expected.counters,
      snapshotBytes: expected.result.snapshotBytes }, candidateOnly: prototype.counters }));
  });
}

test("tree-only prototype preserves binary, rename/delete, modes, symlinks and submodule entries", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  git(f.root, "mv", "shared.txt", "moved.txt");
  fs.writeFileSync(path.join(f.root, "binary.bin"), Buffer.from([0, 1, 255, 2, 0, 128]));
  git(f.root, "add", ".");
  git(f.root, "update-index", "--chmod=+x", "moved.txt");
  const link = out(f.root, ["hash-object", "-w", "--stdin"], "moved.txt");
  git(f.root, "update-index", "--add", "--cacheinfo", `120000,${link},link`);
  git(f.root, "update-index", "--add", "--cacheinfo", `160000,${f.base},module`);
  git(f.root, "commit", "-qm", "object kinds");
  const change = normalizeChange(f.root, { base: f.base, head: "HEAD" });
  const expected = replay(f, f.base, [change]);
  const result = candidates(f, f.base, [change], (run, trees) => {
    const entries = run(["ls-tree", trees[0]]).stdout;
    assert.match(entries, /120000 blob .*link/);
    assert.match(entries, /160000 commit .*module/);
    assert.match(entries, /100755 blob .*moved.txt/);
    assert.deepEqual(run(["cat-file", "blob", `${trees[0]}:binary.bin`], undefined, null).stdout,
      Buffer.from([0, 1, 255, 2, 0, 128]));
  });
  assert.deepEqual(result.trees, expected.trees);
});

test("tree-only conflicts remain disposable index evidence, not published commits or recovery", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const original = normalizeChange(f.root, f.changes.a);
  checkoutClean(f.root, f.base);
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text([]).replace("a=0", "a=2"));
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "overlap");
  const overlap = normalizeChange(f.root, { base: f.base, head: "HEAD" });
  const refs = git(f.root, "show-ref");
  const head = git(f.root, "rev-parse", "HEAD");
  const result = candidates(f, f.base, [original, overlap]);
  assert.equal(result.trees.length, 1);
  assert.match(result.conflict, /shared\.txt/);
  assert.throws(() => replay(f, f.base, [original, overlap]), /Change conflict/);
  assert.match(git(path.join(f.dir, "materialized"), "ls-files", "--unmerged"), /shared\.txt/);
  const cwd = path.join(f.dir, "materialized");
  assert.match(fs.readFileSync(path.join(cwd, "shared.txt"), "utf8"), /<<<<<<< /);
  assert.equal(tree(cwd, "HEAD"), result.trees[0]);
  assert.equal(git(f.root, "show-ref"), refs);
  assert.equal(git(f.root, "rev-parse", "HEAD"), head);
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("tree-only prototype refuses missing promisor blobs without fetching", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  git(f.root, "push", "-q", "upstream", "source");
  const change = normalizeChange(f.root, f.changes.a);
  const blob = git(f.root, "rev-parse", `${f.base}:shared.txt`);
  git(f.root, "config", "remote.upstream.promisor", "true");
  git(f.root, "config", "extensions.partialClone", "upstream");
  const file = path.join(f.ctx.common, "objects", blob.slice(0, 2), blob.slice(2));
  fs.unlinkSync(file);
  const result = candidates(f, f.base, [change]);
  assert.ok(result.error);
  assert.equal(result.trees.length, 0);
  assert.equal(fs.existsSync(file), false);
});

test("attribute conversion is a materialization boundary even when candidate trees agree", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  checkoutClean(f.root, f.base);
  fs.writeFileSync(path.join(f.root, ".gitattributes"), "shared.txt text eol=crlf\n");
  git(f.root, "add", ".gitattributes");
  git(f.root, "commit", "-qm", "attributes");
  const base = git(f.root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text(["a"]));
  git(f.root, "add", "shared.txt");
  git(f.root, "commit", "-qm", "attributed change");
  const change = normalizeChange(f.root, { base, head: "HEAD" });
  const expected = replay(f, base, [change]);
  const result = candidates(f, base, [change]);
  assert.deepEqual(result.trees, expected.trees);
  assert.match(fs.readFileSync(path.join(expected.cwd, "shared.txt"), "utf8"), /\r\n/);
  assert.doesNotMatch(git(f.root, "show", `${expected.trees[0]}:shared.txt`), /\r\n/);
});

test("candidate tree success cannot bypass required filters or commit signing failures", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const change = normalizeChange(f.root, f.changes.a);
  git(f.root, "config", "commit.gpgsign", "true");
  git(f.root, "config", "gpg.program", "pr-graph-nonexistent-test-signer");
  assert.equal(candidates(f, f.base, [change]).trees.length, 1);
  assert.throws(() => replay(f, f.base, [change]), /git commit failed/);
  git(f.root, "config", "commit.gpgsign", "false");
  checkoutClean(f.root, f.base);
  fs.writeFileSync(path.join(f.root, ".gitattributes"), "shared.txt filter=required\n");
  git(f.root, "add", ".gitattributes");
  git(f.root, "commit", "-qm", "required filter");
  const base = git(f.root, "rev-parse", "HEAD");
  git(f.root, "config", "filter.required.required", "true");
  git(f.root, "config", "filter.required.smudge", "pr-graph-nonexistent-test-filter");
  assert.equal(candidates(f, base, [change]).trees.length, 1);
  assert.throws(() => git(f.root, "worktree", "add", "--detach", path.join(f.dir, "filtered"), base), /smudge filter/);
});

test("matching candidate trees do not reproduce clean/smudge filter execution", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const script = path.join(f.dir, "filter.cjs");
  const marker = path.join(f.dir, "filter-ran");
  fs.writeFileSync(script, `const fs = require('node:fs');
const kind = process.argv[2];
fs.appendFileSync(${JSON.stringify(marker)}, kind + '\\n');
const text = fs.readFileSync(0, 'utf8');
process.stdout.write(kind === 'clean' ? text.toUpperCase() : text.toLowerCase());\n`);
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`;
  checkoutClean(f.root, f.base);
  fs.writeFileSync(path.join(f.root, ".gitattributes"), "shared.txt filter=case -text\n");
  git(f.root, "config", "filter.case.clean", `${command} clean`);
  git(f.root, "config", "filter.case.smudge", `${command} smudge`);
  git(f.root, "config", "filter.case.required", "true");
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "filtered base");
  const base = git(f.root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.root, "shared.txt"), f.text(["a"]));
  git(f.root, "add", "shared.txt");
  git(f.root, "commit", "-qm", "filtered change");
  const change = normalizeChange(f.root, { base, head: "HEAD" });
  fs.writeFileSync(marker, "");
  const result = candidates(f, base, [change]);
  assert.equal(fs.readFileSync(marker, "utf8"), "");
  const expected = replay(f, base, [change]);
  assert.deepEqual(result.trees, expected.trees);
  assert.match(fs.readFileSync(marker, "utf8"), /clean\n/);
  assert.match(fs.readFileSync(marker, "utf8"), /smudge\n/);
  assert.equal(fs.readFileSync(path.join(expected.cwd, "shared.txt"), "utf8"), f.text(["a"]));
  assert.equal(git(f.root, "show", `${expected.trees[0]}:shared.txt`), f.text(["a"]).toUpperCase().trim());
});

test("candidate tree success does not execute or satisfy a rejecting commit hook", { skip: process.platform === "win32" }, (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const marker = path.join(f.dir, "hook-ran");
  fs.writeFileSync(path.join(f.ctx.common, "hooks", "pre-commit"),
    `#!/bin/sh\nprintf 'hook\\n' >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  const change = normalizeChange(f.root, f.changes.a);
  assert.equal(candidates(f, f.base, [change]).trees.length, 1);
  assert.equal(fs.existsSync(marker), false);
  assert.throws(() => replay(f, f.base, [change]), /git commit failed/);
  assert.equal(fs.readFileSync(marker, "utf8"), "hook\n");
});
