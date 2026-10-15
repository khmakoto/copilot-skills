import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git } from "./fixtures.mjs";
import { out, tree } from "../lib/git.mjs";
import { normalizeChange } from "../lib/changes.mjs";

test("individual hunks of a single original mega-diff reconstruct its tree", (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  const diff = out(f.root, ["diff", "--full-index", "--binary", f.base, f.head]);
  const [header, ...hunks] = diff.split(/(?=^@@ )/m);
  assert.equal(hunks.length, 6);
  for (const node of f.spec.nodes) {
    const hunk = hunks.find((h) => h.includes(`+${node.id}=1`));
    node.change = { base: f.base, patch: `${header}${hunk}${hunk.endsWith("\n") ? "" : "\n"}` };
  }
  const result = f.apply("split", { spec: f.spec });
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, f.head));
  assert.ok(result.graph.nodes.every((n) => n.change.head === null));
});

test("preserves binary data, rename/delete, executable bits, symlinks and gitlinks", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  git(f.root, "mv", "shared.txt", "moved.txt");
  fs.writeFileSync(path.join(f.root, "binary.bin"), Buffer.from([0, 1, 255, 2, 0, 128]));
  git(f.root, "add", ".");
  git(f.root, "update-index", "--chmod=+x", "moved.txt");
  const linkBlob = out(f.root, ["hash-object", "-w", "--stdin"], "moved.txt");
  git(f.root, "update-index", "--add", "--cacheinfo", `120000,${linkBlob},link`);
  git(f.root, "update-index", "--add", "--cacheinfo", `160000,${f.base},module`);
  git(f.root, "commit", "-qm", "all Git object kinds");
  const head = git(f.root, "rev-parse", "HEAD");
  f.spec.source.head = head;
  f.spec.nodes[0].change = { base: f.base, head };
  const result = f.apply("split", { spec: f.spec });
  assert.equal(tree(f.root, result.graph.combined), tree(f.root, head));
  const entries = git(f.root, "ls-tree", result.graph.nodes[0].head);
  assert.match(entries, /120000 blob .*link/);
  assert.match(entries, /160000 commit .*module/);
  assert.match(entries, /100755 blob .*moved.txt/);
  assert.throws(() => normalizeChange(f.root, { base: f.base, head, paths: ["../secret"] }), /path selection/);
});
