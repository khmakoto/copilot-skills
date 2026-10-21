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
export const MAIN_FRESHNESS_MS = 90 * 60 * 1000;

export function integrationFreshness(graph, node, target, now = Date.now(), forward = false) {
  const snapshot = node
    ? node.integration ?? (!node.retired && !node.landing && node.baseBranch === graph.target
      ? { target: graph.target, sha: node.base } : null)
    : graph.integration ?? { target: graph.target, sha: graph.targetSha };
  const thresholdMs = ["main", "master"].includes(graph.target) ? MAIN_FRESHNESS_MS : 0;
  const verifiedAt = Number.isSafeInteger(snapshot?.verifiedAt) && snapshot.verifiedAt >= 0 && snapshot.verifiedAt <= now
    ? snapshot.verifiedAt : null;
  const ageMs = verifiedAt === null ? null : now - verifiedAt;
  const current = Boolean(target && snapshot?.sha === target && snapshot.target === graph.target);
  const grace = !current && snapshot?.target === graph.target && forward &&
    ageMs !== null && ageMs < thresholdMs;
  return {
    status: !snapshot?.sha || !target ? "unknown" : current ? "current" : grace ? "grace" : "stale",
    target: snapshot?.target ?? graph.target, snapshot: snapshot?.sha ?? null, observedTip: target ?? null,
    verifiedAt, ageMs, thresholdMs, observedAt: now,
    expiresAt: verifiedAt === null || !thresholdMs ? null : verifiedAt + thresholdMs,
    mergeCurrent: current,
  };
}

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function helperBranch(graph, nodeId) {
  return `${graph.helperBranchPrefix ?? `pr-graph/${graph.id}/bases`}/${nodeId}`;
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
  requireValue(graph.helperBranchPrefix === undefined ||
    (typeof graph.helperBranchPrefix === "string" && graph.helperBranchPrefix.trim() &&
      !graph.helperBranchPrefix.endsWith("/")), "Invalid helper branch prefix.");
  const validateIntegration = (snapshot) => {
    requireValue(snapshot === undefined || (snapshot && typeof snapshot.target === "string" &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.sha) &&
      (snapshot.verifiedAt === undefined || (Number.isSafeInteger(snapshot.verifiedAt) &&
        snapshot.verifiedAt >= 0 && snapshot.verifiedAt <= 8640000000000000))),
    "Invalid integration freshness evidence.");
  };
  validateIntegration(graph.integration);
  const ids = new Set();
  const branches = new Set();
  for (const node of graph.nodes) {
    validateIntegration(node.integration);
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
  const snapshot = node.integration ?? (!node.retired && !node.landing
    && node.baseBranch === graph.target ? { target: graph.target, sha: node.base } : null);
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
    `Integration snapshot: \`${snapshot?.target ?? graph.target}@${snapshot?.sha ?? "unknown"}\`; last verified: ${snapshot?.verifiedAt === undefined ? "unknown" : new Date(snapshot.verifiedAt).toISOString()}. Freshness is checked live; merge requires the current tip.`,
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

export function render(graph, freshness = {}) {
  return [
    `${graph.id} -> ${graph.target} (revision ${graph.revision})`,
    ...topological(graph).map((n) =>
      `${n.id} <- ${n.dependencies.join(" + ") || graph.target}: ${
        n.retired ? "superseded" : n.landing ? "landed" : eligible(graph, n) ? "eligible" : "BLOCKED"
      }${n.pr ? `; ${n.pr.draft ? "draft" : "ready"} ${n.pr.url}` : "; unpublished"}; freshness: ${
        freshness[n.id]?.integration.status ?? "unknown"
      }; branch: ${freshness[n.id]?.branch.status ?? "unknown"}; validation: ${freshness[n.id]?.validation ?? "unknown"}`),
  ].join("\n");
}
