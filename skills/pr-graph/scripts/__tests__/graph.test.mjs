import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGraph, eligible, prerequisites, digest, updateFooter, footer, integrationFreshness, selectNodes } from "../lib/graph.mjs";

function graph() {
  const edges = { a: [], b: [], c: ["a", "b"], d: ["b"], e: [], f: ["c", "d", "e"] };
  return { version: 1, id: "test", revision: 1, target: "trunk",
    nodes: Object.entries(edges).map(([id, dependencies]) => ({
      id, dependencies, title: id, branch: `nodes/${id}`, change: { base: "abc", patch: "patch" },
    })) };
}

test("A-F review eligibility requires every prerequisite", () => {
  const g = validateGraph(graph());
  const ready = () => g.nodes.filter((n) => eligible(g, n)).map((n) => n.id);
  const land = (id) => { g.nodes.find((n) => n.id === id).landing = { commit: "x" }; };
  assert.deepEqual(ready(), ["a", "b", "e"]);
  land("b");
  assert.deepEqual(ready(), ["a", "d", "e"]);
  land("a");
  assert.deepEqual(ready(), ["c", "d", "e"]);
  land("c"); land("d");
  assert.deepEqual(ready(), ["e"]);
  land("e");
  assert.deepEqual(ready(), ["f"]);
  assert.deepEqual(prerequisites(g, "f").map((n) => n.id), ["a", "b", "c", "d", "e"]);
});

test("selectors include roots and deduplicate descendants in stable dependency order", () => {
  for (const { edges, expected } of [
    { edges: { a: [], b: ["a"], c: ["b"] }, expected: ["a", "b", "c"] },
    { edges: { a: [], b: ["a"], c: ["a"], d: ["b", "c"] }, expected: ["a", "b", "c", "d"] },
    { edges: { a: [], b: [], c: ["a", "b"], d: ["b"], e: [], f: ["c", "d", "e"] },
      expected: ["a", "c", "f"] },
  ]) {
    const g = graph();
    g.nodes = Object.entries(edges).map(([id, dependencies]) =>
      ({ ...g.nodes[0], id, dependencies, branch: `nodes/${id}` }));
    const selected = selectNodes(g, "dependents:a");
    assert.deepEqual(selected.nodes, expected);
    g.nodes.reverse();
    for (const node of g.nodes) node.dependencies.reverse();
    assert.deepEqual(selectNodes(g, "dependents:a"), selected);
    assert.deepEqual(selectNodes(g, "node:a").nodes, ["a"]);
  }
});

test("selectors explain inactive, ineligible, published and outside-scope exclusions", () => {
  const g = graph();
  g.nodes[0].landing = { commit: "landed" };
  g.nodes[1].pr = { id: 1 };
  g.nodes[4].retired = true;
  assert.deepEqual(selectNodes(g, "eligible").nodes, ["b"]);
  assert.deepEqual(selectNodes(g, "unpublished").nodes, ["c", "d", "f"]);
  assert.deepEqual(selectNodes(g, "node:a"), {
    selector: "node:a", nodes: [], excluded: [
      { id: "a", reason: "landed" }, { id: "b", reason: "outside selection" },
      { id: "c", reason: "outside selection" }, { id: "d", reason: "outside selection" },
      { id: "e", reason: "retired" }, { id: "f", reason: "outside selection" },
    ],
  });
  assert.deepEqual(selectNodes(g, "dependents:a").nodes, ["c", "f"]);
  assert.equal(selectNodes(g, "eligible").excluded.find((n) => n.id === "c").reason, "unlanded prerequisites");
  assert.deepEqual(selectNodes(g, "unpublished", { prs: { c: { id: 2 } } }).nodes, ["d", "f"]);
  g.repository = { provider: { kind: "local" } };
  delete g.nodes[1].pr;
  assert.deepEqual(selectNodes(g, "unpublished", { remote: { "nodes/c": "sha" } }).nodes, ["b", "d", "f"]);
  for (const selector of ["node:missing", "dependents:missing"]) {
    assert.throws(() => selectNodes(g, selector), /Unknown node/);
  }
  for (const selector of ["", "all", "node:a|node:b", "node:a;exit", "dependents:", null]) {
    assert.throws(() => selectNodes(g, selector), /selector/);
  }
});

test("rejects cycles, missing nodes, duplicate IDs and malformed footers", () => {
  const g = graph();
  g.nodes[0].dependencies = ["f"];
  assert.throws(() => validateGraph(g), /cycle/);
  g.nodes[0].dependencies = ["missing"];
  assert.throws(() => validateGraph(g), /Missing dependency/);
  g.nodes[0].dependencies = [];
  g.nodes.push(g.nodes[0]);
  assert.throws(() => validateGraph(g), /Duplicate node/);
  assert.throws(() => updateFooter("human\n<!-- pr-graph:begin -->", "new"), /Malformed/);
});

test("footer replacement preserves human text and is idempotent", () => {
  const g = graph();
  const block = footer(g, g.nodes[2]);
  const body = updateFooter("Human template\n\nValidation: done.", block);
  assert.ok(body.startsWith("Human template\n\nValidation: done."));
  assert.equal(updateFooter(body, block), body);
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
});

test("integration freshness uses recorded verification, an exclusive 3-hour window, and forward history", () => {
  const verifiedAt = Date.UTC(2026, 9, 16);
  for (const target of ["main", "master"]) {
    const g = { ...graph(), target, targetSha: "base",
      integration: { target, sha: "base", verifiedAt } };
    const node = { ...g.nodes[0], integration: { ...g.integration } };
    assert.equal(integrationFreshness(g, node, "base", verifiedAt + 14400000).status, "current");
    for (const ageMs of [3600000, 5400000, 7200000]) {
      assert.equal(integrationFreshness(g, node, "advanced", verifiedAt + ageMs, true).status, "grace");
    }
    const grace = integrationFreshness(g, node, "advanced", verifiedAt + 10799999, true);
    assert.equal(grace.status, "grace");
    assert.equal(grace.mergeCurrent, false);
    assert.equal(grace.expiresAt, verifiedAt + 10800000);
    assert.equal(integrationFreshness(g, node, "advanced", verifiedAt + 10800000, true).status, "stale");
    assert.equal(integrationFreshness(g, node, "rewritten", verifiedAt + 1).status, "stale");
    assert.equal(integrationFreshness(g, node, "advanced", verifiedAt - 1, true).status, "stale");
    delete node.integration.verifiedAt;
    assert.equal(integrationFreshness(g, node, "advanced", verifiedAt + 1, true).status, "stale");
    delete node.integration;
    assert.equal(integrationFreshness(g, node, "advanced", verifiedAt + 1, true).status, "unknown");
    node.baseBranch = target;
    node.base = "base";
    assert.equal(integrationFreshness(g, node, "base", verifiedAt + 1).status, "current");
    assert.equal(integrationFreshness(g, node, "advanced", verifiedAt + 1, true).status, "stale");
    assert.equal(integrationFreshness(g, node, null, verifiedAt + 1).status, "unknown");
  }
  const g = { ...graph(), targetSha: "base", integration: { target: "trunk", sha: "base", verifiedAt } };
  assert.equal(integrationFreshness(g, null, "advanced", verifiedAt + 1, true).status, "stale");
});
