import { createHash } from "node:crypto";

/**
 * @typedef {{base: string, head: string|null, patch: string, fingerprint: string}} OwnChange
 * @typedef {{command: string, args: string[]}} ValidationCommand
 * @typedef {{commit: string, source: string, target: string, strategy: string}} Landing
 *
 * OwnChange records an authored delta, not an accumulated branch. A realized
 * node's base/head include its prerequisite closure; Landing identifies the
 * target receipt even when squash/rebase changed the source commit identity.
 */

export const VERSION = 1;

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function digest(value) {
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
        : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function validateGraph(graph) {
  requireValue(graph?.version === VERSION, "Unsupported graph version.");
  requireValue(typeof graph.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(graph.id), "Invalid graph ID.");
  requireValue(Array.isArray(graph.nodes) && graph.nodes.length > 0, "Graph needs nodes.");
  requireValue(typeof graph.target === "string" && graph.target.length > 0, "Missing target.");
  const ids = new Set();
  const branches = new Set();
  for (const node of graph.nodes) {
    requireValue(typeof node.id === "string", "Invalid node ID.");
    requireValue(/^[a-z0-9][a-z0-9-]*$/.test(node.id), "Invalid node ID.");
    requireValue(!ids.has(node.id), `Duplicate node: ${node.id}`);
    ids.add(node.id);
    requireValue(typeof node.title === "string" && node.title.trim(), `Missing title: ${node.id}`);
    requireValue(Array.isArray(node.dependencies), `Missing dependencies: ${node.id}`);
    requireValue(new Set(node.dependencies).size === node.dependencies.length, `Duplicate dependency: ${node.id}`);
    requireValue(typeof node.branch === "string" && node.branch && !branches.has(node.branch), `Duplicate/missing branch: ${node.id}`);
    branches.add(node.branch);
    requireValue(node.change && typeof node.change.base === "string", `Missing change base: ${node.id}`);
    requireValue(typeof node.change.patch === "string", `Missing pinned patch: ${node.id}`);
    requireValue(node.change.patch.trim(), `Empty change: ${node.id}`);
    requireValue(!node.validations || (
      Array.isArray(node.validations) &&
      node.validations.every((v) => typeof v.command === "string" &&
        Array.isArray(v.args) && v.args.every((a) => typeof a === "string"))
    ), `Invalid validation commands: ${node.id}`);
  }
  for (const node of graph.nodes) {
    for (const dependency of node.dependencies) {
      requireValue(ids.has(dependency), `Missing dependency ${dependency} of ${node.id}`);
    }
  }
  topological(graph);
  return graph;
}

export function topological(graph) {
  const visiting = new Set();
  const visited = new Set();
  const result = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  function visit(node) {
    requireValue(node, "Unknown node.");
    if (visited.has(node.id)) return;
    requireValue(!visiting.has(node.id), `Dependency cycle at ${node.id}`);
    visiting.add(node.id);
    for (const id of [...node.dependencies].sort()) visit(byId.get(id));
    visiting.delete(node.id);
    visited.add(node.id);
    result.push(node);
  }
  for (const node of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) visit(node);
  return result;
}

export function prerequisites(graph, id) {
  const selected = new Set();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  function collect(key) {
    for (const dependency of byId.get(key).dependencies) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        collect(dependency);
      }
    }
  }
  requireValue(byId.has(id), `Unknown node: ${id}`);
  collect(id);
  return topological(graph).filter((n) => selected.has(n.id));
}

export function eligible(graph, node) {
  return !node.retired && !node.landing && prerequisites(graph, node.id).every((n) => n.landing);
}

const BEGIN = "<!-- pr-graph:begin -->";
const END = "<!-- pr-graph:end -->";

export function footer(graph, node) {
  const deps = node.dependencies.map((id) => {
    const dep = graph.nodes.find((n) => n.id === id);
    const label = dep.pr?.url ? `[${id}](${dep.pr.url})` : `\`${id}\``;
    return dep.landing ? `~~${label}~~` : label;
  }).join(", ") || "none";
  return [
    BEGIN,
    `Graph: \`${graph.id}\` / node: \`${node.id}\``,
    `Dependencies: ${deps}`,
    `Review: ${node.retired ? "SUPERSEDED; do not merge" : node.landing ? "landed" : eligible(graph, node) ? "eligible; readiness is explicit" : "BLOCKED until all prerequisites land"}.`,
    ...(node.replacedBy?.length ? [`Replaced by nodes: ${node.replacedBy.map((id) => `\`${id}\``).join(", ")}.`] : []),
    ...(node.baseBranch !== graph.target
      ? ["This draft targets a tool-owned integration base. Do not merge into that base."]
      : []),
    END,
  ].join("\n");
}

export function updateFooter(body, block) {
  const starts = body.split(BEGIN).length - 1;
  const ends = body.split(END).length - 1;
  requireValue(starts === ends && starts <= 1, "Malformed or duplicated graph footer; repair explicitly.");
  if (!starts) return `${body}${body ? "\n\n" : ""}${block}`;
  const start = body.indexOf(BEGIN);
  const end = body.indexOf(END);
  requireValue(start < end, "Reversed graph footer markers.");
  return body.slice(0, start) + block + body.slice(end + END.length);
}

export function render(graph) {
  return [
    `${graph.id} -> ${graph.target} (revision ${graph.revision})`,
    ...topological(graph).map((n) =>
      `${n.id} <- ${n.dependencies.join(" + ") || graph.target}: ${
        n.retired ? "superseded" : n.landing ? "landed" : eligible(graph, n) ? "eligible" : "BLOCKED"
      }${n.pr ? `; ${n.pr.draft ? "draft" : "ready"} ${n.pr.url}` : "; unpublished"}`),
  ].join("\n");
}
