import { digest, eligible, prerequisites, topological, validateGraph } from "./graph.mjs";
import * as state from "./state.mjs";

function alternatePath(byId, prerequisite, node) {
  const queue = [[node.id]];
  const visited = new Set([node.id]);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    for (const id of [...byId.get(path.at(-1)).dependencies].sort()) {
      if (path.length === 1 && id === prerequisite) continue;
      if (id === prerequisite) return [...path, id].reverse();
      if (!visited.has(id)) {
        visited.add(id);
        queue.push([...path, id]);
      }
    }
  }
  return null;
}

function removalEffects(graph, ordered, node, prerequisite) {
  const dependencies = node.dependencies.filter((id) => id !== prerequisite);
  const hypothetical = { ...graph, nodes: graph.nodes.map((n) =>
    n.id === node.id ? { ...n, dependencies } : n) };
  const afterById = new Map(hypothetical.nodes.map((n) => [n.id, n]));
  const affected = ordered.filter((n) => !n.retired && !n.landing &&
    (n.id === node.id || prerequisites(graph, n.id).some((p) => p.id === node.id)));
  const snapshot = (g, n) => ({
    prerequisites: prerequisites(g, n.id).map((p) => p.id).sort(),
    unlandedPrerequisites: prerequisites(g, n.id).filter((p) => !p.landing).map((p) => p.id).sort(),
    eligible: eligible(g, n),
  });
  return {
    dependenciesBefore: [...node.dependencies].sort(), dependenciesAfter: [...dependencies].sort(),
    affected: affected.map((n) => {
      const before = snapshot(graph, n);
      const after = snapshot(hypothetical, afterById.get(n.id));
      return { id: n.id, before, after,
        removedPrerequisites: before.prerequisites.filter((id) => !after.prerequisites.includes(id)) };
    }),
  };
}

export function analyzeDependencies(graph) {
  validateGraph(graph);
  const ordered = topological(graph);
  const byId = new Map(ordered.map((n) => [n.id, n]));
  const redundantEdges = [];
  const sequencingCandidates = [];
  const excludedEdges = [];
  for (const node of ordered) {
    for (const prerequisite of [...node.dependencies].sort()) {
      const parent = byId.get(prerequisite);
      const edge = { prerequisite, node: node.id };
      if (node.retired || node.landing || parent.retired || parent.landing) {
        excludedEdges.push({ ...edge, reason: "One or both endpoints are retired or landed." });
        continue;
      }
      const path = alternatePath(byId, prerequisite, node);
      const finding = { ...edge, removal: removalEffects(graph, ordered, node, prerequisite) };
      if (path) {
        redundantEdges.push({ ...finding, alternatePath: path,
          assessment: "Reachability is preserved, but the explicit edge may document intent; retain unless approved." });
      } else {
        sequencingCandidates.push({ ...finding, assessment: "unassessed",
          missingEvidence: [
            "Semantic review of owned patches, prerequisite intent, consumers, tests and repository contracts.",
            "Separately authorized isolated reconstruction and appropriate validation of the proposed graph.",
          ] });
      }
    }
  }
  return {
    graph: graph.id, graphDigest: digest(graph), target: graph.target,
    redundantEdges, sequencingCandidates, excludedEdges,
    evidence: ordered.map((node) => ({
      id: node.id, title: node.title, description: node.description ?? "",
      branch: node.branch, dependencies: [...node.dependencies].sort(),
      consumers: ordered.filter((n) => n.dependencies.includes(node.id)).map((n) => n.id),
      state: node.retired ? "retired" : node.landing ? "landed" : "active",
      change: node.change,
      realization: { base: node.base ?? null, head: node.head ?? null },
      integration: node.integration ?? null, landing: node.landing ?? null,
      validations: node.validations ?? [], validationReason: node.validationReason ?? null,
      recordedValidation: node.validation ?? null, recordedReady: node.ready ?? false,
    })),
    warning: "Each removal is hypothetical and independent, not a recommended sibling spec or mutation plan. " +
      "Affected IDs are the active consumer and its transitive dependents, not a reconstruction selection. " +
      "Eligibility uses recorded landing receipts only; it is not validation, readiness or live freshness. " +
      "Patches and receipts are retained evidence; object availability and semantic independence are unverified. " +
      "No reconstruction, checks, fetches, ref/state changes or hosting writes. Disjoint paths, clean application " +
      "and passing checks alone do not prove independence. Apply accepted advice only through exact-approved deps plans.",
  };
}

export function inspectDependencies(ctx, graphId) {
  return analyzeDependencies(state.load(ctx, graphId));
}
