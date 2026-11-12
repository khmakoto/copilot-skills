import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, git } from "./fixtures.mjs";
import { generatedCase, random, seeds } from "./generated.mjs";
import { ancestor, refId, tree, withObjectView } from "../lib/git.mjs";
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
        const missing = "f".repeat(f.head.length);
        assert.throws(() => tree(f.root, missing), /rev-parse failed/);
        assert.throws(() => ancestor(f.root, missing, f.head), /not a valid commit/i);
        withObjectView(f.ctx, (run) => {
          assert.equal(run(["cat-file", "-t", f.head]).stdout.trim(), "commit");
          assert.equal(run(["cat-file", "-e", missing]).status !== 0, true);
        });
        withObjectView(f.ctx, (run) => {
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
