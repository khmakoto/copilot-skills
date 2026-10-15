import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGraph, eligible, prerequisites, digest, updateFooter, footer } from "../lib/graph.mjs";

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
