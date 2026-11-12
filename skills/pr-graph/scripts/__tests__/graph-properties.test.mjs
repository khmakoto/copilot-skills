import { test } from "node:test";
import assert from "node:assert/strict";
import { dag, generatedCase, reference, seeds } from "./generated.mjs";
import { eligible, prerequisites, selectNodes, topological, validateGraph } from "../lib/graph.mjs";

function compare(graph, facts, queries = { prerequisites, eligible, selectNodes, topological }) {
  validateGraph(graph);
  const expected = reference(graph);
  assert.deepEqual(queries.topological(graph).map((n) => n.id), expected.order);
  for (const node of graph.nodes) {
    assert.deepEqual(queries.prerequisites(graph, node.id).map((n) => n.id), expected.closure(node.id));
    assert.equal(queries.eligible(graph, node), Boolean(expected.eligible(node.id)));
  }
  for (const selector of ["eligible", "unpublished",
    ...graph.nodes.flatMap((n) => [`node:${n.id}`, `dependents:${n.id}`])]) {
    assert.deepEqual(queries.selectNodes(graph, selector, facts), expected.select(selector, facts));
  }
}

test("seeded DAG queries match an independent model through graph edits and landings", () => {
  for (const seed of seeds(64)) {
    const graph = dag(seed);
    const facts = { prs: { n01: { id: 99 } }, remote: { "nodes/n02": "tip" } };
    generatedCase(seed, { graph, facts }, () => {
      compare(graph, facts);
      graph.repository = { provider: { kind: "local" } };
      compare(graph, facts);
      graph.nodes.reverse();
      for (const node of graph.nodes) node.dependencies.reverse();
      compare(graph, facts);
      for (const node of topological(graph)) {
        if (node.retired) continue;
        node.landing = { commit: "receipt" };
        compare(graph, facts);
      }
      // Re-query the same object after dependency/identity edits (cache invalidation).
      graph.nodes = graph.nodes.filter((n) => n.id !== "n03");
      for (const node of graph.nodes) {
        node.dependencies = node.dependencies.filter((id) => id !== "n03");
        delete node.landing;
      }
      compare(graph, facts);
      const renamed = graph.nodes.find((n) => n.id === "n00");
      renamed.id = "renamed";
      for (const node of graph.nodes) {
        node.dependencies = node.dependencies.map((id) => id === "n00" ? renamed.id : id);
      }
      compare(graph, facts);
    });
  }
});

test("the differential oracle detects a deliberately shallow-closure regression with a replayable case", () => {
  const seed = 7;
  const graph = dag(seed, 4);
  assert.throws(() => generatedCase(seed, graph, () => compare(graph, {}, {
    prerequisites: (g, id) => g.nodes.filter((n) => g.nodes.find((n) => n.id === id).dependencies.includes(n.id)),
    eligible, selectNodes, topological,
  })), (error) => {
    assert.match(error.message, /PR_GRAPH_TEST_SEED=7/);
    const reproducer = JSON.parse(error.message.split("Reproducer: ")[1]);
    assert.deepEqual(reproducer, graph);
    assert.ok(reference(reproducer).closure("n03").includes("n00"));
    return true;
  });
});
