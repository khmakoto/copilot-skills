import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, cli } from "./fixtures.mjs";
import { createPlan, applyPlan, inspect } from "../lib/operations.mjs";
import { tree } from "../lib/git.mjs";

test("split reconstructs same-file changes, clean helper bases, and preserves dirty user work", (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  fs.writeFileSync(path.join(f.root, "personal.txt"), "do not touch\n");
  fs.writeFileSync(path.join(f.root, "shared.txt"), `${f.text(["a"])}staged user edit\n`);
  git(f.root, "add", "shared.txt");
  fs.appendFileSync(path.join(f.root, "shared.txt"), "unstaged user edit\n");
  const staged = git(f.root, "diff", "--cached", "--binary");
  const unstaged = git(f.root, "diff", "--binary");
  const before = fs.readFileSync(path.join(f.root, "shared.txt"));
  const result = f.apply("split", { spec: f.spec });
  assert.deepEqual(result.eligible, ["a", "b", "e"]);
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, f.head));
  for (const node of result.graph.nodes) {
    const paths = git(f.root, "diff", "--name-only", node.base, node.head);
    assert.equal(paths, "shared.txt");
    const patch = git(f.root, "diff", node.base, node.head);
    assert.ok(patch.includes(`+${node.id}=1`));
    for (const sibling of result.graph.nodes.filter((n) => n.id !== node.id)) {
      assert.ok(!patch.includes(`+${sibling.id}=1`));
    }
  }
  assert.equal(git(f.root, "branch", "--show-current"), "source");
  assert.deepEqual(fs.readFileSync(path.join(f.root, "shared.txt")), before);
  assert.equal(fs.readFileSync(path.join(f.root, "personal.txt"), "utf8"), "do not touch\n");
  assert.equal(git(f.root, "diff", "--cached", "--binary"), staged);
  assert.equal(git(f.root, "diff", "--binary"), unstaged);
  assert.equal(cli(f.root, "check", "--graph", "example").status, 0);
});

test("exact approved plans reject tampering and occupied branches", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const plan = createPlan(f.ctx, "split", { spec: f.spec });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, false), /approval/);
  const edited = structuredClone(plan);
  edited.graph.nodes[0].title = "unapproved";
  assert.throws(() => applyPlan(f.ctx, edited, plan.approval, true), /approval/);
  applyPlan(f.ctx, plan, plan.approval, true);
  git(f.root, "checkout", "pr-graph/example/nodes/a");
  const sync = createPlan(f.ctx, "sync", { graph: "example" });
  assert.throws(() => applyPlan(f.ctx, sync, sync.approval, true), /checked out/);
});

for (const strategy of ["merge", "squash", "rebase"]) {
  test(`${strategy}: local explicit merge unlocks only the right descendants`, (t) => {
    const f = fixture();
    t.after(() => f.dispose());
    f.apply("split", { spec: f.spec });
    assert.throws(() => f.apply("ready", { graph: "example", node: "c" }), /prerequisites/);
    const blocked = inspect(f.ctx, "example").operations.find((j) => j.status === "running");
    f.apply("abort", { operation: blocked.id });
    f.apply("ready", { graph: "example", node: "b" });
    f.apply("merge", { graph: "example", node: "b", strategy });
    let state = f.apply("sync", { graph: "example" });
    assert.deepEqual(state.eligible, ["a", "d", "e"]);
    f.apply("ready", { graph: "example", node: "a" });
    f.apply("merge", { graph: "example", node: "a", strategy });
    state = f.apply("sync", { graph: "example" });
    assert.deepEqual(state.eligible, ["c", "d", "e"]);
    for (const id of ["c", "d", "e"]) {
      f.apply("ready", { graph: "example", node: id });
      f.apply("merge", { graph: "example", node: id, strategy });
      state = f.apply("sync", { graph: "example" });
    }
    assert.deepEqual(state.eligible, ["f"]);
    assert.equal(state.graph.nodes.find((n) => n.id === "f").ready, false);
    assert.equal(tree(f.root, state.graph.combined), tree(f.root, f.head));
  });
}
