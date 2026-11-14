import fs from "node:fs";
import path from "node:path";
import { digest, prerequisites, requireValue, validateGraph } from "./graph.mjs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { importedHistory } from "./history-archive.mjs";

const WARNING = "Historical evidence only: comparisons do not establish semantic equivalence, current freshness, validation, readiness, or merge safety.";

const commitIds = (node) => [...new Set([node.change.base, node.change.head, node.base,
  node.head, node.validation?.head, node.landing?.commit].filter(Boolean))];

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

function matchingEvidence(journal, value, id) {
  const p = journal?.published?.[id];
  const v = journal?.validated?.[id];
  const node = value?.node;
  return {
    publication: p && node && p.head === node.head && p.base === node.base &&
      p.baseBranch === node.baseBranch && (p.scope === "remote-refs" ||
        (p.scope === "hosted-pr" && p.pr?.head === node.head && p.pr?.baseBranch === node.baseBranch)) ? p : null,
    validation: v && node && Array.isArray(node.validations) && v.head === node.head &&
      v.commands === digest(node.validations) ? v : null,
  };
}

export function history(ctx, graphId, nodeId, archive) {
  if (archive) return importedHistory(ctx, graphId, nodeId, archive);
  return git.withObjectView(ctx, (run, objects) => readHistory(ctx, graphId, nodeId, objects));
}

function retainedHistory(ctx, graphId) {
  const current = state.load(ctx, graphId, true);
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
  return { current, journals, byOperation, records, graphs, persisted };
}

function readHistory(ctx, graphId, nodeId, objects) {
  const { current, journals, byOperation, records, graphs, persisted } = retainedHistory(ctx, graphId);
  requireValue(typeof nodeId === "string" && /^[a-z0-9][a-z0-9-]*$/.test(nodeId), "Select --node explicitly.");
  const lineage = new Set([nodeId]);
  const links = graphs.flatMap((g) => g.nodes.flatMap((n) => [
    ...(n.supersedes ?? []).map((id) => ({ from: id, to: n.id })),
    ...(n.replacedBy ?? []).map((id) => ({ from: n.id, to: id })),
  ]));
  let grew;
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
  const available = objects.commits(graphs.flatMap((graph) =>
    graph.nodes.filter((node) => lineage.has(node.id)).flatMap(commitIds)));
  const addVersion = (graph, id) => {
    const value = snapshot(graph, id);
    if (!value) return null;
    const key = digest({ graph: digest(graph), node: id });
    if (!versions.has(key)) {
      const missing = commitIds(value.node).filter((sha) => !available.get(sha));
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
      const { publication, validation } = matchingEvidence(journal, s, id);
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
  result.comparison = compareVersions(ctx, old, next);
  return result;
}

function compareVersions(ctx, old, next) {
  if ([old, next].some((v) => !v.snapshot.node.base || !v.snapshot.node.head ||
    v.missingCommits.some((sha) => [v.snapshot.node.base, v.snapshot.node.head].includes(sha)))) {
    return { status: "unavailable", scope: "realized-own-change",
      reason: "A realized base/head snapshot is missing locally.", patch: null };
  }
  try {
    return git.withObjectView(ctx, (run) => {
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
    return { status: "unavailable", scope: "realized-own-change", patch: null,
      reason: "Local object comparison could not be completed.", details: error.message };
  }
}

export function operationDiff(ctx, graphId, operation) {
  requireValue(typeof operation === "string" && /^[0-9a-f]{64}$/.test(operation),
    "Operation diff requires an exact --operation <digest>.");
  const evidence = retainedHistory(ctx, graphId);
  const journal = evidence.byOperation.get(operation);
  const records = evidence.records.filter((r) => r.operation === operation);
  requireValue(records.length || journal, `Unknown retained operation for graph ${graphId}: ${operation}`);
  requireValue(!journal || (journal.id === operation && journal.plan.approval === operation),
    "Operation journal identity mismatch; preserve it and inspect explicitly.");
  const gaps = new Set();
  if (!journal) gaps.add("No operation journal remains; execution status and verified effect receipts are unavailable.");
  if (journal?.candidate && !records.some((r) => r.after && digest(r.after) === digest(journal.candidate))) {
    records.push({ id: operation, operation, action: journal.plan.action, source: "journal-candidate",
      before: journal.plan.previous ?? records[0]?.before ?? null, after: journal.candidate, recordedAt: null });
  }
  const descriptor = (graph) => graph ? {
    id: digest(graph), revision: graph.revision, lastOperation: graph.lastOperation ?? null,
    persisted: evidence.persisted.has(digest(graph)),
  } : null;
  const intended = journal?.plan.graph ?? null;
  for (const graph of [...records.flatMap((r) => [r.before, r.after]), intended].filter(Boolean)) {
    requireValue(validateGraph(graph).id === graphId, "Operation graph identity mismatch.");
  }
  if (!evidence.current) gaps.add("No persisted graph exists; retained snapshots may be candidates only.");
  const comparisons = git.withObjectView(ctx, (run, objects) => {
    const available = objects.commits(records.flatMap((r) => [r.before, r.after]).filter(Boolean)
      .flatMap((g) => g.nodes.flatMap(commitIds)));
    return records.map((record) => {
      const beforeGraph = descriptor(record.before);
      const afterGraph = descriptor(record.after);
      const beforeKnown = Boolean(record.before) || (record.source === "receipt" && record.before === null) ||
        journal?.plan.previousDigest === null;
      const afterKnown = Boolean(record.after);
      if (record.source === "legacy-journal") gaps.add("Legacy journals may lack complete snapshots and verified effect receipts.");
      if (!beforeKnown) gaps.add("The before graph snapshot is unavailable; absence is not evidence of added nodes.");
      if (!afterKnown) gaps.add("No retained after snapshot exists; intended changes are not executed results.");
      if (["restore", "import-graph"].includes(record.action)) {
        gaps.add(`${record.action} is a history boundary; upstream clone history is not imported.`);
      }
      const nodeIds = [...new Set([record.before, record.after].filter(Boolean)
        .flatMap((g) => g.nodes.map((n) => n.id)))].sort();
      const nodes = nodeIds.map((id) => {
        const before = snapshot(record.before, id);
        const after = snapshot(record.after, id);
        const known = beforeKnown && afterKnown;
        const changes = known ? differences(before, after) : null;
        const fields = known ? [...new Set([...Object.keys(before?.node ?? {}), ...Object.keys(after?.node ?? {})])]
          .filter((key) => digest(before?.node[key] ?? null) !== digest(after?.node[key] ?? null)).sort() : null;
        const version = (graph, value) => ({
          id: digest({ graph: graph.id, node: id }), snapshot: value,
          missingCommits: commitIds(value.node).filter((sha) => !available.get(sha)),
        });
        const old = before ? version(beforeGraph, before) : null;
        const next = after ? version(afterGraph, after) : null;
        const missingCommits = {
          before: old?.missingCommits ?? [],
          after: next?.missingCommits ?? [],
        };
        if (missingCommits.before.length || missingCommits.after.length) {
          gaps.add(`Node ${id}: some historical commits are unavailable locally.`);
        }
        let comparison = { status: "unavailable", scope: "realized-own-change", patch: null,
          reason: "Both before and after node snapshots are required; inspect presence and lineage separately." };
        if (old && next) {
          comparison = compareVersions(ctx, old, next);
          if (["unavailable", "inconclusive"].includes(comparison.status)) {
            gaps.add(`Node ${id}: ${comparison.reason}`);
          }
        }
        return {
          id, presence: !known ? "unknown" : !before ? "added" : !after ? "removed" : "retained",
          before, after, changes, fields, missingCommits,
          ownChange: before && after ? {
            baseChanged: before.node.change.base !== after.node.change.base,
            patchChanged: before.node.change.patch !== after.node.change.patch,
            fingerprintChanged: before.node.change.fingerprint !== after.node.change.fingerprint,
          } : null,
          comparison, ...matchingEvidence(journal, after, id),
        };
      });
      const links = [record.before, record.after].filter(Boolean).flatMap((g) => g.nodes.flatMap((n) => [
        ...(n.supersedes ?? []).map((id) => ({ from: id, to: n.id })),
        ...(n.replacedBy ?? []).map((id) => ({ from: n.id, to: id })),
      ]));
      const keys = [...new Set([record.before, record.after].filter(Boolean).flatMap(Object.keys))]
        .filter((key) => !["nodes", "revision", "lastOperation"].includes(key)).sort();
      return {
        receipt: record.id, source: record.source, recordedAt: record.recordedAt,
        before: beforeGraph, after: afterGraph, beforeKnown, afterKnown,
        graphChanges: beforeKnown && afterKnown ? keys.filter((key) =>
          digest(record.before?.[key] ?? null) !== digest(record.after?.[key] ?? null)).map((key) => ({
          field: key, before: record.before?.[key] ?? null, after: record.after?.[key] ?? null,
        })) : null,
        lineage: [...new Map(links.map((link) => [digest(link), link])).values()]
          .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
        nodes,
      };
    });
  });
  const published = Object.entries(journal?.published ?? {}).map(([node, receipt]) => ({
    node, receipt, matchesSnapshot: comparisons.some((c) => c.nodes.some((n) =>
      n.id === node && n.publication !== null)),
  }));
  if (published.some((p) => !p.matchesSnapshot)) gaps.add("Some publication receipts do not match any retained after snapshot.");
  if (Object.keys(journal?.validated ?? {}).some((id) => !comparisons.some((c) =>
    c.nodes.some((node) => node.id === id && node.validation !== null)))) {
    gaps.add("Some validation receipts do not match any retained after snapshot or command specification.");
  }
  if (journal?.remoteStarted) {
    gaps.add("Remote attempts and response/ref records are not verified publication; unrecorded effects cannot be inferred or retried from this report.");
  }
  return {
    graph: graphId, operation, action: journal?.plan.action ?? records[0].action,
    status: journal?.status ?? "unknown", current: descriptor(evidence.current),
    intended: journal ? { graph: intended, effects: journal.plan.effects ?? [],
      localOnly: journal.plan.localOnly ?? false, publishNodes: journal.plan.publishNodes ?? null } : null,
    comparisons,
    execution: journal ? {
      remoteStarted: journal.remoteStarted ?? false, providerStarted: journal.providerStarted ?? false,
      localRefs: journal.local ?? {}, remoteRefRecords: journal.remote ?? {}, prResponses: journal.prs ?? {},
      published, validations: journal.validated ?? {}, pendingChange: journal.pendingChange ?? null,
      mergeReceipt: journal.mergeReceipt ?? null, backupCommit: journal.backupCommit ?? null,
      recoveries: journal.recoveries ?? [], error: journal.error ?? null,
    } : null,
    gaps: [...gaps], warning: WARNING,
  };
}

export function renderOperationDiff(value) {
  return [
    `${value.graph} / operation ${value.operation}: ${value.action}, ${value.status}`,
    `Current persisted graph: ${value.current?.id ?? "absent"}`,
    "Intended effects (not execution evidence):",
    ...(value.intended?.effects.map((effect) => `  ${typeof effect === "string" ? effect : JSON.stringify(effect)}`) ??
      ["  unavailable"]),
    ...value.comparisons.flatMap((c) => [
      `${c.source} ${c.receipt}: ${c.before?.id ?? (c.beforeKnown ? "absent" : "unavailable")} -> ` +
        `${c.after?.id ?? "unavailable"} (${c.after?.persisted ? "persisted snapshot" : "candidate, not proven persisted"})`,
      `  Graph fields: ${c.graphChanges?.map((change) => change.field).join(", ") || (c.graphChanges ? "unchanged" : "unknown")}`,
      ...(c.graphChanges ?? []).map((change) =>
        `    ${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`),
      ...c.lineage.map((link) => `  Lineage: ${link.from} -> ${link.to}`),
      ...c.nodes.flatMap((n) => [
        `  ${n.id}: ${n.presence}; fields: ${n.fields?.join(", ") || (n.fields ? "unchanged" : "unknown")}`,
        `    Authored patch: ${n.ownChange ? n.ownChange.patchChanged ? "changed" : "unchanged" : "unavailable"}; ` +
          `realization: ${n.changes ? n.changes.realization ? "changed" : "unchanged" : "unknown"}; ` +
          `common-base realized comparison: ${n.comparison.status}`,
        n.comparison.reason ? `    ${n.comparison.reason}` : "",
        n.comparison.patch ?? "",
        n.publication ? `    Matching verified publication: ${n.publication.scope}` : "    Verified publication: unavailable",
        n.validation ? `    Matching validation: ${n.after.node.validations.length ? "recorded checks" :
          `no automated checks (${n.validation.reason ? "recorded rationale" : "rationale unavailable"})`}` : "",
        ...(n.fields ?? []).filter((key) => key !== "change").map((key) =>
          `    ${key}: ${JSON.stringify(n.before?.node[key] ?? null)} -> ${JSON.stringify(n.after?.node[key] ?? null)}`),
      ]),
    ]),
    `Execution: remote attempt ${value.execution?.remoteStarted ? "recorded" : value.execution ? "not recorded" : "unknown"}; ` +
      `PR responses/ref records are not publication verification.`,
    ...(value.execution ? [
      `Local ref records: ${JSON.stringify(value.execution.localRefs)}`,
      `Remote ref records (not publication verification): ${JSON.stringify(value.execution.remoteRefRecords)}`,
      `PR responses (not publication verification): ${JSON.stringify(value.execution.prResponses)}`,
      ...value.execution.recoveries.map((recovery) => `Recovery receipt: ${JSON.stringify(recovery)}`),
    ] : []),
    ...(value.execution?.pendingChange ? [`Pending change: ${JSON.stringify(value.execution.pendingChange)}`] : []),
    ...(value.execution?.error ? [`Recorded error: ${value.execution.error}`] : []),
    ...value.gaps.map((gap) => `Gap: ${gap}`), value.warning,
  ].filter(Boolean).join("\n");
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
