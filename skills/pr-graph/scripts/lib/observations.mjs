import { performance } from "node:perf_hooks";
import { requireValue } from "./graph.mjs";
import { step } from "./progress.mjs";

let activeMetrics;

export function providerRequest(action, paginated = false) {
  if (activeMetrics) {
    activeMetrics.requests++;
    activeMetrics.subprocesses++;
  }
  const result = action();
  if (activeMetrics && paginated && result.status !== 0) activeMetrics.requestsExact = false;
  return result;
}

export function providerPages(count) {
  if (activeMetrics) activeMetrics.requests += Math.max(0, count - 1);
}

export function batchPullRequests({ ids, branches }, transport) {
  const rows = new Map();
  let complete = false;
  // Bound unrelated repository history; sparse/old graphs use exact reads.
  const budget = Math.min(3, ids.length + branches.length - 1);
  for (let page = 0; page < budget; page++) {
    const { values, more } = transport.page(page);
    requireValue(Array.isArray(values) && values.length <= 100 && typeof more === "boolean",
      "Invalid provider PR observation page.");
    for (const value of values) {
      const id = transport.id(value);
      requireValue(Number.isSafeInteger(id) && id > 0 && !rows.has(id),
        "Invalid or repeated PR identity during observation; replan.");
      rows.set(id, value);
    }
    complete = !more;
    if (complete || (!branches.length && ids.every((id) => rows.has(id)))) break;
  }
  const read = (row) => {
    const pr = transport.usable(row) ? transport.normalize(row) : transport.get(transport.id(row));
    requireValue(pr?.id === transport.id(row), `Missing or mismatched PR observation: ${transport.id(row)}`);
    return pr;
  };
  const prs = new Map(ids.map((id) => {
    const pr = rows.has(id) ? read(rows.get(id)) : transport.get(id);
    requireValue(pr?.id === id, `Missing or mismatched PR observation: ${id}`);
    return [id, pr];
  }));
  const found = new Map(branches.map((branch) => {
    if (!complete) return [branch, transport.find(branch)];
    const matches = [...rows.values()].filter((row) => transport.matches(row, branch));
    requireValue(matches.length <= 1, `Multiple PRs for ${branch}; reconcile explicitly.`);
    return [branch, matches.length ? read(matches[0]) : null];
  }));
  return { prs, found };
}

export function readPullRequests(provider, nodes, discover = false) {
  const ids = [...new Set(nodes.filter((n) => n.pr).map((n) => n.pr.id))];
  const branches = discover && provider.kind !== "local"
    ? [...new Set(nodes.filter((n) => !n.pr).map((n) => n.branch))] : [];
  const metrics = { ids: ids.length, branches: branches.length, calls: 0,
    requests: 0, requestsExact: true, subprocesses: 0 };
  return step("Reading live provider evidence", () => {
    const previous = activeMetrics;
    activeMetrics = metrics;
    const started = performance.now();
    try {
      const call = (action) => { metrics.calls++; return action(); };
      const { prs, found } = provider.readMany && ids.length + branches.length > 1
        ? call(() => provider.readMany({ ids, branches }))
        : {
          prs: new Map(ids.map((id) => [id, call(() => provider.get(id))])),
          found: new Map(branches.map((branch) => [branch, call(() => provider.find(branch))])),
        };
      requireValue(ids.every((id) => prs.has(id)) &&
        branches.every((branch) => found.has(branch) && found.get(branch) !== undefined),
        "Incomplete provider observation; replan.");
      return Object.fromEntries(nodes.flatMap((node) => {
        const pr = node.pr ? prs.get(node.pr.id) : found.get(node.branch);
        requireValue(!node.pr || pr?.id === node.pr.id, `Missing or mismatched PR observation: ${node.id}`);
        requireValue(node.pr || !pr || (pr.state === "open" && pr.branch === node.branch),
          `Mismatched PR discovery: ${node.id}`);
        return pr ? [[node.id, pr]] : [];
      }));
    } finally {
      metrics.elapsed = performance.now() - started;
      activeMetrics = previous;
    }
  }, { metrics });
}
