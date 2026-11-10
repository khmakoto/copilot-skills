import fs from "node:fs";
import path from "node:path";
import { digest, prerequisites, requireValue, validateGraph } from "./graph.mjs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { importedHistory } from "./history-archive.mjs";

const WARNING = "Historical evidence only: comparisons do not establish semantic equivalence, current freshness, validation, readiness, or merge safety.";

function snapshot(graph, id) {
  const node = graph?.nodes.find((n) => n.id === id);
  if (!node) return null;
  return {
    node, target: graph.target, targetSha: graph.targetSha ?? null,
    integration: node.integration ?? graph.integration ?? null,
    prerequisites: prerequisites(graph, id).map((n) => ({
      id: n.id, change: n.change, head: n.head ?? null, landing: n.landing ?? null,
    })),
  };
}

function differences(before, after) {
  const changed = (a, b) => digest(a ?? null) !== digest(b ?? null);
  return {
    presence: Boolean(before) !== Boolean(after),
    ownChange: changed(before?.node.change, after?.node.change),
    realization: changed([before?.node.base, before?.node.head, before?.node.baseBranch],
      [after?.node.base, after?.node.head, after?.node.baseBranch]),
    dependencies: changed(before?.node.dependencies, after?.node.dependencies),
    prerequisites: changed(before?.prerequisites, after?.prerequisites),
    integration: changed([before?.target, before?.targetSha, before?.integration],
      [after?.target, after?.targetSha, after?.integration]),
    metadata: changed(before && [before.node.title, before.node.description, before.node.branch,
      before.node.retired, before.node.supersedes, before.node.replacedBy],
    after && [after.node.title, after.node.description, after.node.branch,
      after.node.retired, after.node.supersedes, after.node.replacedBy]),
    validation: changed([before?.node.validationCommandsDigest ?? before?.node.validations,
      before?.node.validationReason, before?.node.validation],
    [after?.node.validationCommandsDigest ?? after?.node.validations,
      after?.node.validationReason, after?.node.validation]),
    readiness: changed(before?.node.ready, after?.node.ready),
    publication: changed(before?.node.pr, after?.node.pr),
    landing: changed(before?.node.landing, after?.node.landing),
  };
}

export function history(ctx, graphId, nodeId, archive) {
  if (archive) return importedHistory(ctx, graphId, nodeId, archive);
  return git.withObjectView(ctx, (run) => readHistory(ctx, graphId, nodeId, run));
}

function readHistory(ctx, graphId, nodeId, run) {
  const current = state.load(ctx, graphId, true);
  requireValue(typeof nodeId === "string" && /^[a-z0-9][a-z0-9-]*$/.test(nodeId), "Select --node explicitly.");
  const journals = state.journals(ctx).filter((j) => j.plan.graph?.id === graphId || j.plan.graphId === graphId);
  const byOperation = new Map(journals.map((j) => [j.id, j]));
  const dir = path.join(ctx.dir, "history", graphId);
  const records = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((file) => {
    const record = state.readJson(path.join(dir, file));
    const { id, recordedAt, ...payload } = record;
    requireValue(record.version === 1 && digest(payload) === id && file === `${id}.json` &&
      /^[0-9a-f]{64}$/.test(record.operation) && typeof record.action === "string" &&
      Number.isSafeInteger(recordedAt) && recordedAt >= 0,
    "Invalid history receipt; preserve it and inspect explicitly.");
    for (const graph of [record.before, record.after].filter(Boolean)) {
      requireValue(validateGraph(graph).id === graphId, "History graph identity mismatch.");
    }
    return { ...record, source: "receipt" };
  }) : [];
  const graphs = [current, ...records.flatMap((r) => [r.before, r.after]),
    ...journals.flatMap((j) => [j.plan.previous, j.candidate])].filter(Boolean);
  const known = new Map(graphs.map((g) => [digest(g), g]));
  for (const journal of journals) {
    if (records.some((r) => r.operation === journal.id)) continue;
    records.push({
      id: journal.id, operation: journal.id, action: journal.plan.action,
      source: journal.historyVersion === 1 ? "journal" : "legacy-journal",
      before: journal.plan.previous ?? known.get(journal.plan.previousDigest) ?? null,
      after: journal.candidate ?? null, recordedAt: null,
    });
  }
  // A receipt is written before the graph. Trace committed states backwards to
  // distinguish persisted history from an interrupted, not-yet-saved candidate.
  const persisted = new Set(current ? [digest(current)] : []);
  for (const r of records) {
    const j = byOperation.get(r.operation);
    if (j?.status === "done" && r.after && digest(j.candidate ?? null) === digest(r.after)) persisted.add(digest(r.after));
  }
  let grew;
  do {
    grew = false;
    for (const r of records) {
      if (r.before && r.after && persisted.has(digest(r.after)) && !persisted.has(digest(r.before))) {
        persisted.add(digest(r.before));
        grew = true;
      }
    }
  } while (grew);
  const lineage = new Set([nodeId]);
  const links = graphs.flatMap((g) => g.nodes.flatMap((n) => [
    ...(n.supersedes ?? []).map((id) => ({ from: id, to: n.id })),
    ...(n.replacedBy ?? []).map((id) => ({ from: n.id, to: id })),
  ]));
  do {
    grew = false;
    for (const link of links) {
      if ((lineage.has(link.from) || lineage.has(link.to)) &&
        (!lineage.has(link.from) || !lineage.has(link.to))) {
        lineage.add(link.from);
        lineage.add(link.to);
        grew = true;
      }
    }
  } while (grew);
  requireValue(graphs.some((g) => g.nodes.some((n) => n.id === nodeId)) ||
    journals.some((j) => j.plan.graph?.nodes.some((n) => n.id === nodeId)), `Unknown historical node: ${nodeId}`);
  const versions = new Map();
  const available = new Map();
  const addVersion = (graph, id) => {
    const value = snapshot(graph, id);
    if (!value) return null;
    const key = digest({ graph: digest(graph), node: id });
    if (!versions.has(key)) {
      const commits = [...new Set([value.node.change.base, value.node.change.head, value.node.base,
        value.node.head, value.node.validation?.head, value.node.landing?.commit].filter(Boolean))];
      const missing = commits.filter((sha) => {
        if (!available.has(sha)) available.set(sha, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) &&
          run(["cat-file", "-e", `${sha}^{commit}`]).status === 0);
        return !available.get(sha);
      });
      versions.set(key, { id: key, node: id, revision: graph.revision, snapshot: value,
        persisted: persisted.has(digest(graph)), missingCommits: missing });
    }
    return key;
  };
  const gaps = new Set();
  const events = [];
  const revision = (record) => Math.max(record.after?.revision ?? 0,
    (record.before?.revision ?? -1) + 1);
  records.sort((a, b) => revision(a) - revision(b) ||
    (a.recordedAt ?? 0) - (b.recordedAt ?? 0) || a.id.localeCompare(b.id));
  for (const record of records) {
    const journal = byOperation.get(record.operation);
    if (record.source === "legacy-journal") gaps.add("Legacy journals may lack complete before/after snapshots and verified publication receipts.");
    if (!record.after) gaps.add("Some operations have no retained after snapshot; candidate versions or receipts may be incomplete.");
    if (["restore", "import-graph"].includes(record.action)) gaps.add(`${record.action} is a history boundary; upstream clone history is not imported.`);
    for (const id of [...lineage].sort()) {
      const before = addVersion(record.before, id);
      const after = addVersion(record.after, id);
      if (!before && !after && !journal?.plan.graph?.nodes.some((n) => n.id === id)) continue;
      const s = after ? versions.get(after).snapshot : null;
      const p = journal?.published?.[id];
      const v = journal?.validated?.[id];
      const publication = p && s && p.head === s.node.head && p.base === s.node.base &&
        p.baseBranch === s.node.baseBranch && (p.scope === "remote-refs" ||
          (p.scope === "hosted-pr" && p.pr?.head === s.node.head && p.pr?.baseBranch === s.node.baseBranch)) ? p : null;
      const validation = v && s && v.head === s.node.head &&
        v.commands === digest(s.node.validations) ? v : null;
      events.push({
        id: record.id, node: id, operation: record.operation, action: record.action,
        status: journal?.status ?? "unknown", persisted: Boolean(record.after && persisted.has(digest(record.after))),
        source: record.source, recordedAt: record.recordedAt,
        before, after, changes: differences(before ? versions.get(before).snapshot : null, s),
        publication, validation, recoveries: journal?.recoveries ?? [], error: journal?.error ?? null,
      });
    }
  }
  const currentVersion = addVersion(current, nodeId);
  if (!current) gaps.add("No persisted graph exists; retained operation snapshots may be candidates only.");
  else if (!records.some((r) => r.after && digest(r.after) === digest(current))) gaps.add("Current graph has no retained matching history event.");
  if (records.some((r) => r.before?.lastOperation &&
    !records.some((previous) => previous.after && digest(previous.after) === digest(r.before)))) {
    gaps.add("A before snapshot has no retained preceding history event.");
  }
  const ordered = [...versions.values()].sort((a, b) =>
    (a.revision ?? 0) - (b.revision ?? 0) || a.node.localeCompare(b.node) || a.id.localeCompare(b.id));
  if (ordered.some((v) => v.missingCommits.length)) gaps.add("Some historical commits are unavailable locally; affected comparisons may be unavailable.");
  const baseline = (field) => {
    const candidates = events.filter((e) => e.node === nodeId && e.after && e[field]);
    return candidates.at(-1)?.after ?? null;
  };
  return {
    graph: graphId, node: nodeId, current: currentVersion,
    baselines: { "last-published": baseline("publication"), "last-validated": baseline("validation") },
    lineage: [...new Map(links.filter((l) => lineage.has(l.from) && lineage.has(l.to))
      .map((l) => [digest(l), l])).values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    versions: ordered, events, gaps: [...gaps], warning: WARNING,
  };
}

export function interdiff(ctx, graphId, nodeId, from, to = "current", archive) {
  const timeline = history(ctx, graphId, nodeId, archive);
  const resolve = (selector) => {
    const id = selector === "current" ? timeline.current : timeline.baselines[selector] ?? selector;
    const version = timeline.versions.find((v) => v.id === id);
    requireValue(version, `Unavailable node version/baseline: ${selector}. Inspect history for retained version IDs.`);
    return version;
  };
  requireValue(from, "Interdiff requires --from <version|last-published|last-validated|current>.");
  const old = resolve(from);
  const next = resolve(to);
  const result = {
    graph: graphId, node: nodeId, from: old, to: next,
    changes: differences(old.snapshot, next.snapshot),
    ownChange: {
      baseChanged: old.snapshot.node.change.base !== next.snapshot.node.change.base,
      patchChanged: old.snapshot.node.change.patch !== next.snapshot.node.change.patch,
      fingerprintChanged: old.snapshot.node.change.fingerprint !== next.snapshot.node.change.fingerprint,
    },
    comparison: null, gaps: timeline.gaps, warning: WARNING,
    ...(timeline.provenance ? { provenance: timeline.provenance } : {}),
  };
  if ([old, next].some((v) => !v.snapshot.node.base || !v.snapshot.node.head ||
    v.missingCommits.some((sha) => [v.snapshot.node.base, v.snapshot.node.head].includes(sha)))) {
    result.comparison = { status: "unavailable", scope: "realized-own-change",
      reason: "A realized base/head snapshot is missing locally.", patch: null };
    return result;
  }
  try {
    result.comparison = git.withObjectView(ctx, (run) => {
      const checked = (args, input) => {
        const r = run(args, input);
        requireValue(r.status === 0, r.stderr.trim() || `git ${args[0]} failed.`);
        return r.stdout.trim();
      };
      const base = next.snapshot.node.base;
      const trees = [];
      for (const version of [old, next]) {
        checked(["read-tree", base]);
        const { node } = version.snapshot;
        const patch = run(["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff",
          "--no-textconv", "--no-color", node.base, node.head]);
        requireValue(patch.status === 0, patch.stderr);
        const applied = patch.stdout ? run(["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], patch.stdout) : { status: 0 };
        if (applied.status !== 0) {
          return { status: "inconclusive", scope: "realized-own-change", base, patch: null,
            reason: "A realized own-change patch could not be applied cleanly to the selected common base.",
            details: applied.stderr.trim(), version: version.id };
        }
        trees.push(checked(["write-tree"]));
      }
      const patch = run(["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff",
        "--no-textconv", "--no-color", trees[0], trees[1]]);
      requireValue(patch.status === 0, patch.stderr);
      return { status: trees[0] === trees[1] ? "equal" : "different", scope: "realized-own-change", base,
        beforeTree: trees[0], afterTree: trees[1], patch: patch.stdout };
    });
  } catch (error) {
    result.comparison = { status: "unavailable", scope: "realized-own-change", patch: null,
      reason: "Local object comparison could not be completed.", details: error.message };
  }
  return result;
}

export function renderHistory(value) {
  return [
    `${value.graph} / ${value.node}`,
    ...(value.provenance ? [`Imported archive: ${value.provenance.archive}; origin: ${value.provenance.origin} (untrusted historical evidence)`] : []),
    `Current: ${value.current ?? "absent"}; last-published: ${value.baselines["last-published"] ?? "unavailable"}; last-validated: ${value.baselines["last-validated"] ?? "unavailable"}`,
    ...value.events.map((e) => `${e.action} ${e.node}: ${e.status}${e.persisted ? ", persisted" : ", candidate"} ` +
      `(${e.operation})\n  ${e.before ?? "unavailable"} -> ${e.after ?? "unavailable"}\n  ` +
      Object.entries(e.changes).filter(([, changed]) => changed).map(([name]) => name).join(", ") +
      (e.recoveries.length ? `; recovery: ${e.recoveries.map((r) => r.action).join(", ")}` : "") +
      (e.validation ? `; ${e.validation.reason && !(value.versions.find((v) => v.id === e.after)?.snapshot.node.automatedChecks ??
        value.versions.find((v) => v.id === e.after)?.snapshot.node.validations?.length)
        ? "no automated checks (recorded rationale)" : "checks passed"}` : "")),
    ...value.gaps.map((gap) => `Gap: ${gap}`), value.warning,
  ].join("\n");
}

export function renderInterdiff(value) {
  return [
    `${value.graph} / ${value.node}: ${value.from.id} -> ${value.to.id}`,
    ...(value.provenance ? [`Imported archive: ${value.provenance.archive}; origin: ${value.provenance.origin} (untrusted historical evidence)`] : []),
    `Own patch: ${value.ownChange.patchChanged ? "changed" : "unchanged"}; realization: ${value.changes.realization ? "changed" : "unchanged"}`,
    `Common-base comparison: ${value.comparison.status}`,
    value.comparison.reason ?? "", value.comparison.patch ?? "",
    ...value.gaps.map((gap) => `Gap: ${gap}`), value.warning,
  ].filter(Boolean).join("\n");
}
