import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git } from "./fixtures.mjs";
import { generatedCase, random, seeds } from "./generated.mjs";
import { ancestor, refId, refIds, localBranches, tree, withObjectView, objectReader, readObjects } from "../lib/git.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";

for (const objectFormat of ["sha1", "sha256"]) {
  test(`seeded Git reads preserve missing objects and observation boundaries (${objectFormat})`, (t) => {
    const f = fixture({ names: ["a"], objectFormat });
    const other = fixture({ names: ["a"], objectFormat });
    t.after(() => f.dispose());
    t.after(() => other.dispose());
    for (const seed of seeds(4)) {
      const pick = random(seed);
      const refs = ["refs/heads/trunk", "refs/heads/source", "refs/heads/missing"];
      const moves = Array.from({ length: 4 }, () => ({
        ref: refs[pick(refs.length)],
        sha: pick(2) ? f.base : f.head,
      }));
      generatedCase(seed, { objectFormat, moves }, () => {
        for (const move of moves) {
          git(f.root, "update-ref", move.ref, move.sha);
          const snapshot = Object.fromEntries(git(f.root, "for-each-ref",
            "--format=%(refname) %(objectname)", "refs/heads").split("\n").map((line) => line.split(" ")));
          assert.deepEqual(refIds(f.root, [...refs, "refs/heads/never-created"]),
            Object.fromEntries([...refs, "refs/heads/never-created"].map((ref) => [ref, snapshot[ref] ?? null])));
          for (const ref of [...refs, "refs/heads/never-created"]) {
            assert.equal(refId(f.root, ref), snapshot[ref] ?? null);
          }
          assert.equal(tree(f.root, move.sha), git(f.root, "show", "-s", "--format=%T", move.sha));
          assert.equal(ancestor(f.root, f.base, move.sha), true);
          assert.equal(ancestor(f.root, f.head, f.base), false);
        }
        // Same ref spelling must not leak a mutable observation across repositories.
        git(other.root, "update-ref", refs[0], other.base);
        git(f.root, "update-ref", refs[0], f.head);
        assert.equal(refId(f.root, refs[0]), f.head);
        assert.equal(refId(other.root, refs[0]), other.base);
        assert.equal(refIds(f.root, refs)[refs[0]], f.head);
        assert.equal(refIds(other.root, refs)[refs[0]], other.base);
        const missing = "f".repeat(f.head.length);
        assert.throws(() => tree(f.root, missing), /rev-parse failed/);
        assert.throws(() => ancestor(f.root, missing, f.head), /not a valid commit/i);
        withObjectView(f.ctx, (run, objects) => {
          const reads = [f.base, f.head, missing, f.base, "invalid\nHEAD"];
          assert.deepEqual([...objects.commits(reads).values()], [true, true, false, false]);
          assert.deepEqual([...objects.trees([f.base, f.head])],
            [f.base, f.head].map((id) => [id, tree(f.root, id)]));
          assert.equal(objects.ancestor(f.base, f.head), ancestor(f.root, f.base, f.head));
          assert.equal(objects.ancestor(f.head, f.base), false);
          assert.equal(run(["cat-file", "-t", f.head]).stdout.trim(), "commit");
          assert.equal(run(["cat-file", "-e", missing]).status !== 0, true);
        });
        withObjectView(f.ctx, (run, objects) => {
          assert.equal(objects.commits([f.head]).get(f.head), false);
          assert.throws(() => objects.trees([f.head]), /Missing\/invalid commit tree/);
          assert.throws(() => objects.ancestor(f.base, f.head), /not a valid commit/i);
          assert.notEqual(run(["cat-file", "-e", f.head]).status, 0);
          assert.equal(run(["remote"]).stdout, "");
        }, { isolated: true });
      });

    }
  });
}

test("a fresh observation cannot hide managed ref drift after plan approval", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const original = f.apply("split", { spec: f.spec });
  const plan = createPlan(f.ctx, "sync", { graph: "example" });
  const node = original.graph.nodes[0];
  assert.equal(plan.facts.local[node.branch], node.head);
  git(f.root, "update-ref", `refs/heads/${node.branch}`, f.base);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Local ref changed/);
  assert.equal(refId(f.root, `refs/heads/${node.branch}`), f.base);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
});

test("batched ref reads preserve exact names, symbolic refs, packing and invalid-ref failures", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  git(f.root, "update-ref", "refs/heads/nested/topic", f.head);
  git(f.root, "update-ref", "refs/heads/unicode/\u00a0", f.head);
  git(f.root, "symbolic-ref", "refs/heads/alias", "refs/heads/source");
  git(f.root, "symbolic-ref", "refs/heads/dangling", "refs/heads/absent");
  git(f.root, "pack-refs", "--all");
  const branches = ["source", "nested", "nested/topic", "unicode/\u00a0", "alias", "dangling", "missing", "source"];
  assert.deepEqual(localBranches(f.root, branches), Object.fromEntries(branches.map((branch) =>
    [branch, refId(f.root, `refs/heads/${branch}`)])));
  assert.deepEqual(refIds(f.root, []), {});
  const trace = process.env.GIT_TRACE;
  try {
    process.env.GIT_TRACE = "1";
    assert.equal(localBranches(f.root, ["source"]).source, f.head);
  } finally {
    if (trace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = trace;
  }
  for (const ref of ["HEAD", "--all", "refs/heads/a*", "refs/heads/a\nb", "refs/heads/a..b",
    "refs/heads/.hidden", "refs/heads/a.lock", "refs/heads/a\\b", "refs/heads/a@{b"]) {
    assert.throws(() => refIds(f.root, [ref]), /Invalid full ref/);
  }
  fs.writeFileSync(path.join(f.ctx.common, "refs", "heads", "broken"), "not-an-object\n");
  assert.throws(() => refIds(f.root, ["refs/heads/broken"]), /Cannot observe local refs/);
});

test("object metadata batches handle binary objects, cache only in their reader, and do not cache absence", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const payload = Buffer.from([0, 10, 255, 13, ...Buffer.from(`${f.head} commit 0\n\n`), 0]);
  withObjectView(f.ctx, (run) => {
    const calls = [];
    const objects = objectReader((...args) => { calls.push(args[0]); return run(...args); });
    const blob = run(["hash-object", "-w", "--stdin"], payload).stdout.trim();
    const tag = run(["mktag"], `object ${f.head}\ntype commit\ntag snapshot\ntagger Test <test@example.invalid> 1 +0000\n\nsnapshot\n`).stdout.trim();
    const ids = [blob, f.head, tag, blob];
    assert.equal(objects.inspect(ids).get(blob).size, payload.length);
    assert.deepEqual(run(["cat-file", "blob", blob], undefined, null).stdout, payload);
    assert.equal(objects.commits([tag, blob]).get(tag), true);
    assert.equal(objects.commits([blob]).get(blob), false);
    assert.equal(objects.trees([tag]).get(tag), tree(f.root, f.head));
    const before = calls.length;
    objects.inspect(ids);
    objects.trees([tag]);
    assert.equal(calls.length, before, "successful immutable reads should be reused");
    const count = calls.length;
    assert.equal(objects.ancestor(f.base, f.head), true);
    assert.equal(objects.ancestor(f.base, f.head), true);
    assert.equal(objects.ancestor(f.head, f.base), false);
    assert.equal(objects.ancestor(f.head, f.base), false);
    assert.equal(calls.length, count + 2);
    const sourceOnly = payload.toString("hex");
    const later = run(["hash-object", "--stdin"], sourceOnly).stdout.trim();
    assert.equal(objects.inspect([later]).get(later), null);
    assert.equal(run(["hash-object", "-w", "--stdin"], sourceOnly).status, 0);
    assert.equal(objects.inspect([later]).get(later).type, "blob");
    assert.notEqual(calls.length, before);
    assert.throws(() => objects.inspect(["HEAD"]), /full immutable IDs/);
    assert.throws(() => objects.ancestor("HEAD", f.head), /full commit IDs/);
  });
  const other = fixture({ names: ["b"] });
  t.after(() => other.dispose());
  assert.equal(readObjects(other.root).commits([f.head]).get(f.head), false);
});

test("batch metadata rejects malformed, truncated and changed responses", () => {
  const id = "a".repeat(40);
  for (const stdout of ["", `${id} blob 1\nextra\n`, `${id} blob -1\n`,
    `${id} blob 9007199254740992\n`, `${"b".repeat(40)} blob 1\n`]) {
    assert.throws(() => objectReader(() => ({ status: 0, stdout })).inspect([id]), /Invalid Git object batch/);
  }
  assert.throws(() => objectReader(() => ({ status: 0, stdout: `${id} blob 1\n` }))
    .trees([id]), /Invalid Git object batch metadata/);
  assert.throws(() => objectReader(() => ({ status: 128, stderr: "corrupt object" }))
    .inspect([id]), /corrupt object/);
  const ids = Array.from({ length: 2050 }, (_, i) => i.toString(16).padStart(40, "0"));
  const batches = [];
  const objects = objectReader((args, input) => {
    const queries = input.trim().split("\n");
    batches.push(queries.length);
    return { status: 0, stdout: queries.map((query) => `${query} missing\n`).join("") };
  });
  assert.ok([...objects.inspect(ids).values()].every((value) => value === null));
  assert.deepEqual(batches, [1024, 1024, 2]);
});

test("batched isolated reads never hydrate missing commits from a promisor remote", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  git(f.root, "push", "-q", "upstream", "source");
  git(f.root, "config", "remote.upstream.promisor", "true");
  git(f.root, "config", "extensions.partialClone", "upstream");
  const objects = git(f.root, "rev-parse", "--path-format=absolute", "--git-path", "objects");
  const file = path.join(objects, f.head.slice(0, 2), f.head.slice(2));
  assert.ok(fs.existsSync(file));
  fs.unlinkSync(file);
  withObjectView(f.ctx, (run, reader) => {
    assert.equal(reader.commits([f.base, f.head]).get(f.head), false);
    assert.throws(() => reader.trees([f.head]), /Missing\/invalid commit tree/);
  });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(path.join(objects, "pack")), []);
});

test("new object readers recheck removed trees and commits instead of reusing earlier evidence", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const expected = tree(f.root, f.head);
  assert.equal(readObjects(f.root).trees([f.head]).get(f.head), expected);
  const objects = git(f.root, "rev-parse", "--path-format=absolute", "--git-path", "objects");
  fs.unlinkSync(path.join(objects, expected.slice(0, 2), expected.slice(2)));
  assert.throws(() => tree(f.root, f.head), /rev-parse failed/);
  assert.throws(() => readObjects(f.root).trees([f.head]), /Missing\/invalid commit tree/);
  fs.unlinkSync(path.join(objects, f.head.slice(0, 2), f.head.slice(2)));
  assert.equal(readObjects(f.root).commits([f.head]).get(f.head), false);
  assert.throws(() => readObjects(f.root).ancestor(f.base, f.head), /not a valid commit/i);
});
