import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../lib/graph.mjs";
import { compositionCache, verifyPrefix } from "../lib/composition.mjs";

const target = "a".repeat(40);
const execution = "b".repeat(64);
const nodes = ["a", "b", "c"].map((id) => ({
  id, title: `Implement ${id}`, change: { base: target, patch: `patch ${id}` },
}));

function fixture() {
  const journal = { commitCacheVersion: 2, commits: {}, reconstructionReceipts: {} };
  let context = execution;
  let trailer = "Trailer: exact";
  const verified = [];
  const cache = compositionCache(journal, {
    fingerprint: () => context, message: (title) => `${title}\n\n${trailer}`,
    verifyCommit: (_cwd, key) => verified.push(key),
  });
  const populate = (items = nodes, base = target) => {
    const cursor = cache("", base, items);
    let before = cursor.head;
    for (let i = cursor.length; i < items.length; i++) {
      const recipe = { before, patch: digest(items[i].change.patch),
        message: `${items[i].title}\n\n${trailer}`, execution: context };
      const key = digest(recipe);
      const head = digest({ key }).slice(0, 40);
      journal.commits[key] = head;
      journal.reconstructionReceipts[key] = { recipe, head };
      cursor.record(i, head);
      before = head;
    }
    return before;
  };
  return { journal, cache, populate, verified,
    setContext: (value) => { context = value; }, setTrailer: (value) => { trailer = value; } };
}

test("composition cache finds the longest ordered prefix, including complete shared bases", () => {
  const f = fixture();
  const head = f.populate(nodes.slice(0, 2));
  const hit = f.cache("", target, nodes);
  assert.equal(hit.head, head);
  assert.equal(hit.length, 2);
  assert.equal(f.verified.length, 2);
  assert.equal(f.cache("", target, nodes.slice(0, 2)).head, head);
  assert.equal(f.journal.reconstruction.prefixAvoided, 4);
  assert.equal(Object.keys(f.journal.compositionPrefixes).length, 2);
});

for (const kind of ["target", "order", "patch", "base", "message", "trailer", "context", "unknown-context"]) {
  test(`composition prefixes do not match changed ${kind}`, () => {
    const f = fixture();
    f.populate();
    const changed = structuredClone(nodes);
    let base = target;
    if (kind === "target") base = "c".repeat(40);
    if (kind === "order") changed.reverse();
    if (kind === "patch") changed[0].change.patch += " revised";
    if (kind === "base") changed[0].change.base = "d".repeat(40);
    if (kind === "message") changed[0].title += " revised";
    if (kind === "trailer") f.setTrailer("Trailer: revised");
    if (kind === "context") f.setContext("e".repeat(64));
    if (kind === "unknown-context") f.setContext(null);
    assert.equal(f.cache("", base, changed)?.length ?? 0, 0);
    assert.equal(f.verified.length, 0);
  });
}

for (const kind of ["prefix", "receipt", "parent", "commit", "missing-prefix", "missing-receipt"]) {
  test(`composition prefixes reject inconsistent ${kind} evidence`, () => {
    const f = fixture();
    f.populate();
    const [key, prefix] = Object.entries(f.journal.compositionPrefixes).at(-1);
    const receipt = f.journal.reconstructionReceipts[prefix.commit];
    if (kind === "prefix") prefix.recipe.input.message += " changed";
    if (kind === "receipt") receipt.recipe.patch = digest("changed");
    if (kind === "parent") receipt.recipe.before = target;
    if (kind === "commit") f.journal.commits[prefix.commit] = target;
    if (kind === "missing-prefix") delete f.journal.compositionPrefixes[prefix.recipe.previous];
    if (kind === "missing-receipt") delete f.journal.reconstructionReceipts[prefix.commit];
    assert.throws(() => verifyPrefix(f.journal, key, () => {}), /composition prefix/i);
  });
}

test("unknown or changing execution context cannot record optimistic prefixes", () => {
  const f = fixture();
  const cursor = f.cache("", target, nodes);
  f.setContext("e".repeat(64));
  f.populate();
  const previous = structuredClone(f.journal.compositionPrefixes);
  const first = Object.values(f.journal.reconstructionReceipts)[0];
  cursor.record(0, first.head);
  assert.deepEqual(f.journal.compositionPrefixes, previous);
  f.setContext(null);
  assert.equal(f.cache("", target, nodes), null);
});
