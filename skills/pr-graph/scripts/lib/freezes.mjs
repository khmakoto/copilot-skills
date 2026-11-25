import { digest, requireValue, prerequisites, helperBranch } from "./graph.mjs";
import * as state from "./state.mjs";

const ID = /^[a-z0-9][a-z0-9-]*$/;
const HEX = /^[0-9a-f]{64}$/;
const MODES = ["authored-content", "exact-review-snapshot"];
const empty = () => ({ version: 1, records: [] });
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  digest(Object.keys(value).sort()) === digest([...names].sort());
function humanBody(body) {
  if (typeof body !== "string") return body;
  const begin = "<!-- pr-graph:begin -->";
  const end = "<!-- pr-graph:end -->";
  const starts = body.split(begin).length - 1;
  const ends = body.split(end).length - 1;
  if (starts !== ends || starts > 1 || (starts && body.indexOf(begin) > body.indexOf(end))) {
    return { malformed: body };
  }
  return body.replace(/<!-- pr-graph:begin -->[\s\S]*?<!-- pr-graph:end -->/, "").replace(/[\r\n]+$/, "");
}
const releaseReceipt = (receipt) => keys(receipt, ["operation", "reason"]) &&
  typeof receipt.operation === "string" && HEX.test(receipt.operation) &&
  typeof receipt.reason === "string" && receipt.reason.trim();
const identity = ({ observedReleases, ...record }) => record;

function fields(graph, node, mode) {
  if (!node) return {};
  const values = {
    identity: [node.id, node.branch], ownChange: node.change,
    retirement: Boolean(node.retired),
    lineage: [node.supersedes ?? [], node.replacedBy ?? []],
  };
  if (mode === "exact-review-snapshot") Object.assign(values, {
    target: [graph.target, helperBranch(graph, node.id)],
    dependencies: node.dependencies,
    realization: [node.base, node.head, node.baseBranch],
    metadata: [node.title, node.description ?? ""],
    checks: [node.validations ?? [], node.validationReason ?? null],
    pr: node.pr ? [node.pr.id, node.pr.branch, node.pr.head, node.pr.base,
      node.pr.baseBranch, node.pr.draft, node.pr.title, humanBody(node.pr.body)] : null,
  });
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, digest(value ?? null)]));
}

const fieldNames = (mode) => Object.keys(fields({ target: "", nodes: [] },
  { id: "a", dependencies: [] }, mode));

export function validateFreezes(policy) {
  requireValue(keys(policy, ["version", "records"]) && policy.version === 1 &&
    Array.isArray(policy.records), "Invalid review freeze policy.");
  const seen = new Set();
  for (const record of policy.records) {
    requireValue(keys(record, ["node", "mode", "baseline", "operation", "reason", "release", "observedReleases"]) &&
      typeof record.node === "string" && ID.test(record.node) && MODES.includes(record.mode) &&
      typeof record.operation === "string" && HEX.test(record.operation) &&
      typeof record.reason === "string" && record.reason.trim() &&
      keys(record.baseline, fieldNames(record.mode)) && Object.values(record.baseline).every((v) =>
        typeof v === "string" && HEX.test(v)) &&
      (record.release === null || releaseReceipt(record.release)) &&
      Array.isArray(record.observedReleases) && record.observedReleases.every(releaseReceipt) &&
      new Set(record.observedReleases.map(digest)).size === record.observedReleases.length,
    "Invalid review freeze record.");
    const key = `${record.operation}/${record.node}`;
    requireValue(!seen.has(key), "Duplicate review freeze record.");
    seen.add(key);
  }
  return policy;
}

export function mergeFreezes(local = empty(), incoming = empty()) {
  validateFreezes(local);
  validateFreezes(incoming);
  const result = structuredClone(local);
  for (const record of incoming.records) {
    const old = result.records.find((r) => r.operation === record.operation && r.node === record.node);
    if (!old) result.records.push(structuredClone(record));
    else {
      requireValue(digest({ ...identity(old), release: null }) === digest({ ...identity(record), release: null }),
        "Conflicting review freeze evidence; reconcile explicitly.");
      // Imported release receipts are evidence, not permission to release a local freeze.
      old.observedReleases = [...new Map([...old.observedReleases, ...record.observedReleases,
        ...(record.release ? [record.release] : [])].map((r) => [digest(r), r])).values()];
    }
  }
  return result;
}

export function freezeReport(graph, facts) {
  return (graph.reviewFreezes?.records ?? []).filter((r) => !r.release).map((record) => {
    const node = graph.nodes.find((n) => n.id === record.node);
    const actual = fields(graph, node, record.mode);
    const drift = Object.keys(record.baseline).filter((key) => actual[key] !== record.baseline[key]);
    if (node && facts) {
      if (facts.local[node.branch] !== node.head) drift.push("local branch");
      if (facts.remote[node.branch] && facts.remote[node.branch] !== node.head) drift.push("remote branch");
      if (graph.repository.remote && node.pr && !facts.remote[node.branch]) drift.push("missing remote branch");
      if (node.baseBranch && node.baseBranch !== graph.target &&
        (facts.local[node.baseBranch] !== node.base ||
          (facts.remote[node.baseBranch] && facts.remote[node.baseBranch] !== node.base))) drift.push("helper base");
      if (node.pr) {
        const observed = facts.prs[node.id];
        if (!observed || observed.id !== node.pr.id || observed.head !== node.head ||
          observed.branch !== node.branch || observed.baseBranch !== node.baseBranch) drift.push("external PR identity/content");
        if (record.mode === "exact-review-snapshot" &&
          fields(graph, { ...node, pr: observed }, record.mode).pr !== record.baseline.pr) drift.push("external PR review configuration");
      } else if (facts.prs[node.id]) drift.push("untracked PR");
    }
    return { node: record.node, mode: record.mode, operation: record.operation, drift,
      status: drift.length ? "drifted" : "frozen" };
  });
}

export function assertFreezes(previous, graph) {
  for (const record of previous?.reviewFreezes?.records ?? []) {
    const retained = graph.reviewFreezes?.records.find((r) =>
      r.node === record.node && r.operation === record.operation);
    requireValue(retained && digest(identity(retained)) === digest(identity(record)) &&
      record.observedReleases.every((r) => retained.observedReleases.some((other) => digest(r) === digest(other))),
      `Review freeze history changed: ${record.node}; use an explicit review-freeze plan.`);
    if (record.release) continue;
    const actual = fields(graph, graph.nodes.find((n) => n.id === record.node), record.mode);
    const changed = Object.keys(record.baseline).filter((key) => actual[key] !== record.baseline[key]);
    requireValue(!changed.length,
      `Review freeze blocks ${record.node} (${record.mode}): ${changed.join(", ")}; explicitly unfreeze before changing the review baseline.`);
  }
}

export function assertFrozenObservations(graph, facts) {
  const drift = freezeReport(graph, facts).filter((r) => r.drift.length);
  requireValue(!drift.length, `Review freeze drift: ${drift.map((r) =>
    `${r.node} (${r.drift.join(", ")})`).join("; ")}; inspect and explicitly unfreeze or recover; no automatic adoption.`);
}

export function checkFreezePlan(previous, plan) {
  if (!previous || !plan.graph || plan.action === "review-freeze") return [];
  assertFreezes(previous, plan.graph);
  const reconstruct = ["init", "split", "add", "deps", "split-node", "fold", "remove", "absorb",
    "sync", "publish", "retarget"].includes(plan.action);
  const reports = [];
  for (const record of previous.reviewFreezes?.records ?? []) {
    if (record.release) continue;
    const node = plan.graph.nodes.find((n) => n.id === record.node);
    const deps = prerequisites(plan.graph, node.id);
    const old = previous.nodes.find((n) => n.id === node.id);
    const affected = reconstruct && !node.landing && !node.retired && (old.signature !== digest({
      target: plan.target, own: node.change,
      deps: deps.filter((n) => !n.landing).map((n) => [n.id, n.change]),
    }) || node.baseBranch !== (deps.some((n) => !n.landing) ? helperBranch(plan.graph, node.id) : plan.graph.target));
    requireValue(!(affected && record.mode === "exact-review-snapshot"),
      `Review freeze blocks ${node.id} (exact-review-snapshot): direct or indirect prerequisite reconstruction; explicitly unfreeze before syncing.`);
    if (record.mode === "exact-review-snapshot") {
      requireValue(!(plan.action === "ready" && plan.node === node.id && node.pr?.draft),
        `Review freeze blocks ${node.id}: draft promotion; explicitly unfreeze first.`);
      requireValue(!(plan.action === "describe" && (plan.node === node.id ||
        Object.hasOwn(plan.descriptions ?? {}, node.id))),
      `Review freeze blocks ${node.id}: description replacement; explicitly unfreeze first.`);
      requireValue(!(plan.action === "publish" && !node.pr && plan.graph.repository.provider.kind !== "local" &&
        (!plan.publishNodes || plan.publishNodes.includes(node.id))),
      `Review freeze blocks ${node.id}: PR creation; explicitly unfreeze first.`);
    }
    reports.push({ node: node.id, mode: record.mode, reconstruction: affected ? "permitted; authored content unchanged" : "unchanged" });
  }
  return reports;
}

function noPending(ctx) {
  requireValue(!state.journals(ctx, (j) => j.status).includes("running"),
    "Recover interrupted operations before changing review freezes.");
}

export function createFreezePlan(ctx, options, io) {
  noPending(ctx);
  const graph = state.load(ctx, options.graph);
  const spec = options.spec;
  requireValue(keys(spec, ["freeze", "unfreeze", "reason"]) &&
    typeof spec.reason === "string" && spec.reason.trim() &&
    Array.isArray(spec.freeze) && Array.isArray(spec.unfreeze) &&
    spec.freeze.every((r) => keys(r, ["node", "mode"]) && typeof r.node === "string" &&
      ID.test(r.node) && MODES.includes(r.mode)) &&
    spec.unfreeze.every((id) => typeof id === "string" && ID.test(id)) &&
    new Set([...spec.freeze.map((r) => r.node), ...spec.unfreeze]).size === spec.freeze.length + spec.unfreeze.length &&
    spec.freeze.length + spec.unfreeze.length > 0, "Invalid review-freeze spec.");
  const active = (graph.reviewFreezes?.records ?? []).filter((r) => !r.release);
  const facts = io.observe(graph);
  const baselines = spec.freeze.map(({ node: id, mode }) => {
    const node = graph.nodes.find((n) => n.id === id);
    requireValue(node && !node.retired && !node.landing && node.base && node.head && node.baseBranch,
      `Freeze requires a realized active unlanded node: ${id}`);
    requireValue(!active.some((r) => r.node === id), `Node already frozen: ${id}; explicitly unfreeze before changing mode.`);
    const baseline = fields(graph, node, mode);
    assertFrozenObservations({ ...graph, reviewFreezes: { version: 1,
      records: [{ node: id, mode, baseline, release: null }] } }, facts);
    return { node: id, mode, baseline };
  });
  for (const id of spec.unfreeze) requireValue(active.some((r) => r.node === id), `Node is not frozen: ${id}`);
  return { version: 1, action: "review-freeze", repository: ctx.root, common: ctx.common,
    graph, previousDigest: digest(graph), spec, baselines, facts,
    effects: ["Change only explicit local review-freeze policy and retain exact approval/history receipts; no source, product/helper refs, validation, freshness or hosting changes.",
      ...baselines.map((r) => ({ freeze: r.node, mode: r.mode, protectedFields: r.baseline })),
      ...spec.unfreeze.map((id) => `UNFREEZE ${id}; later changes still require separate exact plans.`)] };
}

export function applyFreezePlan(ctx, plan, io) {
  const graph = state.load(ctx, plan.graph.id);
  if (graph.lastOperation === plan.approval) return { graph, operation: plan.approval, alreadyDone: true };
  noPending(ctx);
  requireValue(digest(graph) === plan.previousDigest, "Graph or review freeze policy changed; replan.");
  requireValue(digest(io.observe(graph)) === digest(plan.facts), "Review freeze observations changed; replan.");
  const policy = structuredClone(graph.reviewFreezes ?? empty());
  for (const id of plan.spec.unfreeze) for (const record of policy.records.filter((r) => r.node === id && !r.release)) {
    record.release = { operation: plan.approval, reason: plan.spec.reason };
  }
  for (const baseline of plan.baselines) policy.records.push({ ...baseline, operation: plan.approval,
    reason: plan.spec.reason, release: null, observedReleases: [] });
  graph.reviewFreezes = validateFreezes(policy);
  graph.revision++;
  graph.lastOperation = plan.approval;
  state.save(ctx, graph, plan);
  return { graph, operation: plan.approval, freezes: freezeReport(graph) };
}
