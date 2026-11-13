import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { digest, requireValue } from "./graph.mjs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { history } from "./history.mjs";
import { loadPolicy, validatePolicy, importPolicy, effectivePolicy, assertOutbound } from "./publication.mjs";

const HEX = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const WARNING = "Historical evidence only. Origin and version identities are source assertions, not authenticated authorship. Imported evidence never establishes current validation, readiness, freshness, publication, or recovery authority.";
const pick = (value, keys) => value == null ? null :
  Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
const change = (value) => pick(value, ["base", "head", "patch", "fingerprint"]);
const integration = (value) => pick(value, ["target", "sha", "verifiedAt"]);
const landing = (value) => pick(value, ["commit", "source", "target", "strategy"]);
const validation = (value) => pick(value, ["head", "commands", "reason"]);
const pr = (value) => pick(value, ["id", "state", "branch", "head", "base", "baseBranch", "draft", "title", "body"]);
const originFile = (ctx) => path.join(ctx.dir, "history-origin.json");

function archiveFile(ctx, graph, id) {
  requireValue(ID.test(graph) && HEX.test(id), "Invalid history archive identity/path.");
  for (const dir of [path.join(ctx.dir, "history-archives"), path.join(ctx.dir, "history-archives", graph)]) {
    requireValue(!fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink(), "Unsafe archive storage path.");
  }
  return path.join(ctx.dir, "history-archives", graph, `${id}.json`);
}

function portableSnapshot(value) {
  const n = value.node;
  return {
    node: {
      ...pick(n, ["id", "title", "description", "branch", "base", "head", "baseBranch", "dependencies",
        "retired", "supersedes", "replacedBy", "ready", "validationReason"]),
      change: change(n.change), integration: integration(n.integration), landing: landing(n.landing),
      pr: pr(n.pr), validation: validation(n.validation),
      validationCommandsDigest: n.validationCommandsDigest ?? digest(n.validations ?? []),
      automatedChecks: n.automatedChecks ?? Boolean(n.validations?.length),
    },
    target: value.target, targetSha: value.targetSha, integration: integration(value.integration),
    prerequisites: value.prerequisites.map((p) => ({
      id: p.id, change: change(p.change), head: p.head, landing: landing(p.landing),
    })),
  };
}

function portableTimeline(value, graphs) {
  const graphDigests = graphs.map((g) => digest(g));
  return {
    graph: value.graph, node: value.node, sourceCurrent: value.current,
    baselines: value.baselines, lineage: value.lineage, gaps: value.gaps,
    versions: value.versions.map((v) => ({
      ...pick(v, ["id", "node", "revision", "persisted"]),
      graphDigest: graphDigests.find((id) => digest({ graph: id, node: v.node }) === v.id),
      snapshot: portableSnapshot(v.snapshot),
    })),
    events: value.events.map((e) => ({
      ...pick(e, ["id", "node", "operation", "action", "status", "persisted", "source",
        "recordedAt", "before", "after", "changes"]),
      publication: e.publication ? {
        ...pick(e.publication, ["scope", "head", "base", "baseBranch"]),
        pr: pr(e.publication.pr),
      } : null,
      validation: validation(e.validation),
      recoveries: e.recoveries.map((r) => pick(r, ["operation", "action", "recordedAt"])),
      errorDigest: e.error ? digest(e.error) : null,
    })),
  };
}

function localGraphs(ctx, graphId) {
  state.graphFile(ctx, graphId);
  const dir = path.join(ctx.dir, "history", graphId);
  return [
    state.load(ctx, graphId, true),
    ...(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        const r = state.readJson(path.join(dir, f));
        return [r.before, r.after];
      }) : []),
    ...state.journals(ctx).filter((j) => j.plan.graph?.id === graphId || j.plan.graphId === graphId)
      .flatMap((j) => [j.plan.previous, j.candidate]),
  ].filter(Boolean).sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0) ||
    digest(a).localeCompare(digest(b)));
}

function graphIdentity(graphs, graphId) {
  requireValue(graphs.length, "No retained graph snapshots to export.");
  const first = graphs[0];
  return { id: graphId, target: first.target, base: first.source?.base ?? first.targetSha ?? null };
}

function rootsOf(graphs) {
  return [...new Set(graphs.flatMap((g) => [
    g.targetSha, g.combined, g.source?.base, g.source?.head, g.integration?.sha,
    ...g.nodes.flatMap((n) => [n.change.base, n.change.head, n.head, n.base,
      n.integration?.sha, n.validation?.head, n.pr?.head, n.pr?.base, n.landing?.commit]),
  ]).filter(Boolean))].sort();
}

function closure(run, roots, sha) {
  const available = git.objectReader(run).commits(roots.filter((id) => sha.test(id)));
  const missing = roots.filter((id) => !available.get(id));
  const present = roots.filter((id) => !missing.includes(id));
  const result = present.length ? run(["rev-list", "--objects", "--no-object-names",
    "--missing=print", "--stdin"], `${present.join("\n")}\n`) : { status: 0, stdout: "" };
  requireValue(result.status === 0, `Cannot enumerate historical objects: ${result.stderr}`);
  const objects = [];
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    if (line.startsWith("?")) missing.push(line.slice(1));
    else {
      requireValue(sha.test(line), "Invalid historical object identity.");
      objects.push(line);
    }
  }
  return { objects: [...new Set(objects)].sort(), missing: [...new Set(missing)].sort() };
}

function outside(ctx, file) {
  requireValue(typeof file === "string" && file, "History transfer requires --archive <file>.");
  const resolved = path.resolve(file);
  const parent = fs.realpathSync.native(path.dirname(resolved));
  const target = path.join(parent, path.basename(resolved));
  const relative = path.relative(fs.realpathSync.native(ctx.root), target);
  requireValue(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    "Keep history archives outside the product working tree.");
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  requireValue(!stat?.isSymbolicLink(), "Unsafe archive path: symbolic link.");
  requireValue(!stat || stat.isFile(), "Unsafe archive path: select a regular file.");
  return target;
}

function seal(plan) {
  return { ...plan, approval: digest(plan) };
}

export function createHistoryTransferPlan(ctx, action, options) {
  requireValue(options.fetchObservation === undefined, "History transfer does not accept freshness observations.");
  state.graphFile(ctx, options.graph);
  const file = outside(ctx, options.archive);
  const base = { version: 1, action, repository: ctx.root, common: ctx.common,
    graphId: options.graph, archivePath: file };
  if (action === "import-history") {
    const archive = state.readJson(file);
    validateArchive(ctx, archive, options.graph);
    checkConflicts(ctx, archive);
    return seal({ ...base, archive, effects: [
      `Import evidence from origin ${archive.origin} into private archive ${archive.id}.`,
      `Retain ${archive.objects.length} objects under refs/pr-graph/archives/${options.graph}/${archive.id}/.`,
      "Do not change graphs, product refs, files, index, worktrees, approvals or operation journals. Never run imported commands.",
      WARNING,
    ] });
  }
  requireValue(!fs.existsSync(file), "Archive output exists; choose a new path.");
  const graphs = localGraphs(ctx, options.graph);
  const nodes = [...new Set(graphs.flatMap((g) => g.nodes.map((n) => n.id)))].sort();
  const timelines = nodes.map((node) => portableTimeline(history(ctx, options.graph, node), graphs));
  const previousOrigin = state.readJson(originFile(ctx), true);
  requireValue(!previousOrigin || (typeof previousOrigin.id === "string" && HEX.test(previousOrigin.id)), "Invalid local history origin.");
  const format = git.out(ctx.root, ["rev-parse", "--show-object-format"]);
  requireValue(["sha1", "sha256"].includes(format), "Unsupported Git object format.");
  const sha = new RegExp(`^[0-9a-f]{${format === "sha1" ? 40 : 64}}$`);
  const roots = rootsOf(graphs);
  const payload = git.withObjectView(ctx, (run) => {
    const inventory = closure(run, roots, sha);
    const packed = inventory.missing.length ? null : run(["pack-objects", "--stdout"],
      `${inventory.objects.join("\n")}\n`, null);
    requireValue(!packed || packed.status === 0, `Cannot pack history: ${packed?.stderr}`);
    return { ...inventory, pack: packed ? packed.stdout.toString("base64") : null };
  });
  const gaps = [...new Set(timelines.flatMap((t) => t.gaps))].sort();
  const content = {
    format: "pr-graph-history", version: 1, graph: options.graph,
    identity: graphIdentity(graphs, options.graph),
    origin: previousOrigin?.id ?? randomBytes(32).toString("hex"),
    createdAt: ctx.now?.() ?? Date.now(), objectFormat: format,
    graphs: [...new Set(graphs.map((g) => digest(g)))].sort(),
    roots, objects: payload.objects, pack: payload.pack, timelines,
    ...(loadPolicy(ctx, options.graph).exclusions.length
      ? { publicationPolicy: loadPolicy(ctx, options.graph) } : {}),
    completeness: { objects: !payload.missing.length, evidence: !gaps.length,
      missingObjects: payload.missing, gaps },
  };
  const archive = { ...content, id: digest(content) };
  return seal({ ...base, previousOrigin, archive,
    sourceDigest: digest({ graphs, timelines }), effects: [
      `Write ${file} with ${archive.objects.length} objects and ${nodes.length} node timelines from origin ${archive.origin}.`,
      "Includes obsolete/discarded source, commit ancestry, old descriptions, historical receipts and validation-command digests.",
      "Inspect the complete plan payload before approving: retained source and metadata may contain sensitive material.",
      "Full history increases storage and retention costs. No upload or remote push is included.",
      ...(!payload.missing.length ? [] : [`Export blocked: missing objects ${payload.missing.join(", ")}.`]),
    ] });
}

function exact(value, keys, message) {
  requireValue(value && typeof value === "object" && !Array.isArray(value) &&
    digest(Object.keys(value).sort()) === digest([...keys].sort()), message);
}

function validateSnapshot(value, sha) {
  requireValue(digest(portableSnapshot(value)) === digest(value),
    "Unsafe or unsupported historical snapshot fields.");
  const { node, prerequisites } = value;
  const text = (v) => typeof v === "string";
  const optionalText = (v) => v == null || text(v);
  const commit = (v) => text(v) && sha.test(v);
  const optionalCommit = (v) => v == null || commit(v);
  const checkValidation = (v) => v === null || (commit(v.head) && HEX.test(v.commands) && optionalText(v.reason));
  const checkPr = (v) => v === null || (
    (v.id === undefined || text(v.id) || Number.isSafeInteger(v.id)) &&
    ["state", "branch", "baseBranch", "title", "body"].every((key) => optionalText(v[key])) &&
    ["head", "base"].every((key) => optionalCommit(v[key])) &&
    (v.draft === undefined || typeof v.draft === "boolean"));
  const checkIntegration = (v) => v === null || (text(v.target) && commit(v.sha) &&
    (v.verifiedAt === undefined || (Number.isSafeInteger(v.verifiedAt) && v.verifiedAt >= 0)));
  const checkLanding = (v) => v === null || (commit(v.commit) &&
    ["source", "target", "strategy"].every((key) => optionalText(v[key])));
  requireValue(text(node.title) && text(node.branch) && text(value.target) &&
    ["description", "baseBranch", "validationReason"].every((key) => optionalText(node[key])) &&
    ["ready", "retired"].every((key) => node[key] === undefined || typeof node[key] === "boolean") &&
    ["dependencies", "supersedes", "replacedBy"].every((key) =>
      (key !== "dependencies" && node[key] === undefined) ||
      (Array.isArray(node[key]) && node[key].every((id) => text(id) && ID.test(id)))) &&
    HEX.test(node.validationCommandsDigest) && typeof node.automatedChecks === "boolean" &&
    optionalCommit(node.base) && optionalCommit(value.targetSha) &&
    checkValidation(node.validation) && checkPr(node.pr) &&
    checkIntegration(node.integration) && checkIntegration(value.integration) &&
    checkLanding(node.landing) && Array.isArray(prerequisites), "Invalid historical node snapshot.");
  for (const s of [node, ...prerequisites]) {
    requireValue(text(s.id) && ID.test(s.id) && commit(s.change?.base) &&
      optionalCommit(s.change.head) && text(s.change.patch) && HEX.test(s.change.fingerprint) &&
      s.change.fingerprint === digest({ base: s.change.base, patch: s.change.patch }) &&
      optionalCommit(s.head) && checkLanding(s.landing), "Invalid historical commit identity.");
  }
}

function validateMetadata(archive, graph) {
  exact(archive, ["format", "version", "graph", "identity", "origin", "createdAt", "objectFormat",
    "graphs", "roots", "objects", "pack", "timelines", "completeness", "id",
    ...(archive.publicationPolicy === undefined ? [] : ["publicationPolicy"])], "Unsupported archive schema.");
  if (archive.publicationPolicy !== undefined) validatePolicy(archive.publicationPolicy);
  const { id, ...payload } = archive;
  requireValue(archive.format === "pr-graph-history" && archive.version === 1,
    "Unsupported history archive format/version.");
  requireValue(HEX.test(id) && digest(payload) === id, "History archive integrity mismatch.");
  requireValue(ID.test(graph) && archive.graph === graph &&
    typeof archive.origin === "string" && HEX.test(archive.origin),
    "History archive graph/origin identity mismatch.");
  exact(archive.identity, ["id", "target", "base"], "Invalid archive graph identity.");
  requireValue(archive.identity.id === graph && typeof archive.identity.target === "string" &&
    Number.isSafeInteger(archive.createdAt) && archive.createdAt >= 0 &&
    ["sha1", "sha256"].includes(archive.objectFormat), "Invalid archive identity/object format.");
  const sha = new RegExp(`^[0-9a-f]{${archive.objectFormat === "sha1" ? 40 : 64}}$`);
  requireValue(archive.identity.base === null || sha.test(archive.identity.base), "Invalid archive graph base.");
  for (const [field, pattern] of [["graphs", HEX], ["roots", sha], ["objects", sha]]) {
    requireValue(Array.isArray(archive[field]) && archive[field].length &&
      archive[field].every((v) => typeof v === "string" && pattern.test(v)) &&
      digest(archive[field]) === digest([...new Set(archive[field])].sort()), `Invalid archive ${field}.`);
  }
  exact(archive.completeness, ["objects", "evidence", "missingObjects", "gaps"], "Invalid archive completeness.");
  requireValue(archive.completeness.objects === true &&
    Array.isArray(archive.completeness.missingObjects) && !archive.completeness.missingObjects.length &&
    Array.isArray(archive.completeness.gaps) && archive.completeness.gaps.every((g) => typeof g === "string") &&
    archive.completeness.evidence === !archive.completeness.gaps.length, "Archive contains missing objects or invalid completeness claims.");
  requireValue(typeof archive.pack === "string" && archive.pack.length > 0 &&
    Buffer.from(archive.pack, "base64").toString("base64") === archive.pack, "Invalid archive object pack.");
  requireValue(Array.isArray(archive.timelines) && archive.timelines.length &&
    new Set(archive.timelines.map((t) => t.node)).size === archive.timelines.length, "Invalid archive timelines.");
  const seen = new Map();
  for (const timeline of archive.timelines) {
    exact(timeline, ["graph", "node", "sourceCurrent", "baselines", "lineage", "gaps", "versions", "events"],
      "Invalid archive timeline schema.");
    requireValue(timeline.graph === graph && ID.test(timeline.node) &&
      Array.isArray(timeline.versions) && Array.isArray(timeline.events) &&
      Array.isArray(timeline.lineage) && Array.isArray(timeline.gaps) &&
      timeline.gaps.every((g) => typeof g === "string"), "Invalid archive timeline.");
    exact(timeline.baselines, ["last-published", "last-validated"], "Invalid historical baselines.");
    for (const version of timeline.versions) {
      exact(version, ["id", "graphDigest", "node", "revision", "persisted", "snapshot"], "Invalid archive version schema.");
      requireValue(HEX.test(version.graphDigest) && archive.graphs.includes(version.graphDigest) &&
        ID.test(version.node) && version.id === digest({ graph: version.graphDigest, node: version.node }) &&
        Number.isSafeInteger(version.revision) && version.revision >= 0 &&
        typeof version.persisted === "boolean" && version.snapshot?.node?.id === version.node,
      "Invalid historical version identity.");
      validateSnapshot(version.snapshot, sha);
      const { node, prerequisites } = version.snapshot;
      for (const root of [version.snapshot.targetSha, version.snapshot.integration?.sha,
        node.base, node.head, node.change.base, node.change.head, node.integration?.sha,
        node.validation?.head, node.pr?.head, node.pr?.base, node.landing?.commit,
        ...prerequisites.flatMap((p) => [p.head, p.change.base, p.change.head, p.landing?.commit])].filter(Boolean)) {
        requireValue(sha.test(root) && archive.roots.includes(root), "Historical snapshot references an unavailable object.");
      }
      requireValue(!seen.has(version.id) || seen.get(version.id) === digest(version.snapshot),
        "Conflicting historical version identity.");
      seen.set(version.id, digest(version.snapshot));
    }
    const versions = new Map(timeline.versions.map((v) => [v.id, v]));
    for (const selector of [timeline.sourceCurrent, ...Object.values(timeline.baselines)]) {
      requireValue(selector === null || versions.get(selector)?.node === timeline.node, "Unavailable historical baseline.");
    }
    for (const link of timeline.lineage) {
      exact(link, ["from", "to"], "Unsafe lineage fields.");
      requireValue(ID.test(link.from) && ID.test(link.to), "Invalid historical lineage.");
    }
    for (const event of timeline.events) {
      exact(event, ["id", "node", "operation", "action", "status", "persisted", "source",
        "recordedAt", "before", "after", "changes", "publication", "validation", "recoveries", "errorDigest"],
      "Unsafe archive event fields.");
      requireValue(HEX.test(event.id) && HEX.test(event.operation) && ID.test(event.node) &&
        typeof event.action === "string" && typeof event.status === "string" &&
        typeof event.persisted === "boolean" && typeof event.source === "string" &&
        (event.recordedAt === null || (Number.isSafeInteger(event.recordedAt) && event.recordedAt >= 0)) &&
        [event.before, event.after].every((v) => v === null || versions.get(v)?.node === event.node) &&
        (event.errorDigest === null || HEX.test(event.errorDigest)) &&
        Array.isArray(event.recoveries), "Invalid historical event.");
      exact(event.changes, ["presence", "ownChange", "realization", "dependencies", "prerequisites",
        "integration", "metadata", "validation", "readiness", "publication", "landing"], "Invalid historical differences.");
      requireValue(Object.values(event.changes).every((v) => typeof v === "boolean") &&
        digest(validation(event.validation)) === digest(event.validation) &&
        digest(event.publication && {
          ...pick(event.publication, ["scope", "head", "base", "baseBranch"]), pr: pr(event.publication.pr),
        }) === digest(event.publication) &&
        event.recoveries.every((r) => digest(pick(r, ["operation", "action", "recordedAt"])) === digest(r)),
      "Unsafe historical receipt fields.");
      const after = versions.get(event.after)?.snapshot.node;
      if (event.validation) {
        requireValue(after && event.validation.head === after.head &&
          event.validation.commands === after.validationCommandsDigest &&
          (event.validation.reason == null || typeof event.validation.reason === "string"),
        "Historical validation receipt does not match its version.");
      }
      if (event.publication) {
        const p = event.publication;
        requireValue(after && p.head === after.head && p.base === after.base && p.baseBranch === after.baseBranch &&
          (p.scope === "remote-refs" || (p.scope === "hosted-pr" &&
            p.pr?.head === after.head && p.pr?.baseBranch === after.baseBranch)),
        "Historical publication receipt does not match its version.");
      }
      requireValue(event.recoveries.every((r) => HEX.test(r.operation) && typeof r.action === "string" &&
        Number.isSafeInteger(r.recordedAt) && r.recordedAt >= 0), "Invalid historical recovery receipt.");
    }
    for (const [selector, field] of [["last-published", "publication"], ["last-validated", "validation"]]) {
      const expected = timeline.events.filter((e) => e.node === timeline.node && e.after && e[field]).at(-1)?.after ?? null;
      requireValue(timeline.baselines[selector] === expected, "Historical baseline does not match its receipt.");
    }
  }
  const gaps = [...new Set(archive.timelines.flatMap((t) => t.gaps))].sort();
  requireValue(digest(gaps) === digest(archive.completeness.gaps), "Conflicting evidence completeness claims.");
}

function withVerifiedPack(ctx, archive, fn = () => {}) {
  return git.withObjectView(ctx, (run) => {
    const result = run(["index-pack", "--stdin", "--strict"], Buffer.from(archive.pack, "base64"));
    requireValue(result.status === 0, `Invalid history object pack: ${result.stderr}`);
    const inventory = closure(run, archive.roots,
      new RegExp(`^[0-9a-f]{${archive.objectFormat === "sha1" ? 40 : 64}}$`));
    const all = run(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
    requireValue(!inventory.missing.length && all.status === 0 &&
      digest(inventory.objects) === digest(archive.objects) &&
      digest(all.stdout.trim().split("\n").sort()) === digest(archive.objects),
    "History archive object inventory/availability mismatch.");
    return fn(run);
  }, { isolated: true });
}

function validateArchive(ctx, archive, graph) {
  validateMetadata(archive, graph);
  requireValue(archive.objectFormat === git.out(ctx.root, ["rev-parse", "--show-object-format"]),
    "History archive uses an unsupported or different Git object format.");
  withVerifiedPack(ctx, archive);
}

function storedArchives(ctx, graph) {
  state.graphFile(ctx, graph);
  const dir = path.join(ctx.dir, "history-archives", graph);
  archiveFile(ctx, graph, "0".repeat(64));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    requireValue(HEX.test(f.slice(0, -5)), "Unsafe stored history archive path.");
    const archive = state.readJson(path.join(dir, f));
    validateMetadata(archive, graph);
    requireValue(f === `${archive.id}.json`, "Stored history archive identity mismatch.");
    return archive;
  }) : [];
}

function checkConflicts(ctx, archive) {
  const graphs = localGraphs(ctx, archive.graph);
  if (graphs.length) {
    requireValue(digest(graphIdentity(graphs, archive.graph)) === digest(archive.identity),
      "History archive conflicts with local graph identity.");
  }
  const versions = new Map(archive.timelines.flatMap((t) => t.versions)
    .map((v) => [v.id, digest(v.snapshot)]));
  const immutableEvent = (e) => pick(e, ["id", "node", "operation", "action", "before", "after", "changes"]);
  const events = new Map(archive.timelines.flatMap((t) => t.events)
    .map((e) => [`${e.id}/${e.node}`, digest(immutableEvent(e))]));
  if (graphs.length) {
    for (const node of new Set(graphs.flatMap((g) => g.nodes.map((n) => n.id)))) {
      for (const version of portableTimeline(history(ctx, archive.graph, node), graphs).versions) {
        requireValue(!versions.has(version.id) || versions.get(version.id) === digest(version.snapshot),
          "Conflicting local historical version identity.");
      }
    }
  }
  for (const existing of storedArchives(ctx, archive.graph)) {
    requireValue(digest(existing.identity) === digest(archive.identity),
      "Conflicting archive graph/origin identity.");
    for (const version of existing.timelines.flatMap((t) => t.versions)) {
      requireValue(!versions.has(version.id) || versions.get(version.id) === digest(version.snapshot),
        "Conflicting archived version identity; existing evidence will not be overwritten.");
    }
    for (const event of existing.timelines.flatMap((t) => t.events)) {
      const key = `${event.id}/${event.node}`;
      requireValue(!events.has(key) || events.get(key) === digest(immutableEvent(event)),
        "Conflicting archived event identity; existing evidence will not be overwritten.");
    }
  }
}

export function applyHistoryTransferPlan(ctx, plan) {
  const { archive } = plan;
  requireValue(outside(ctx, plan.archivePath) === plan.archivePath, "Archive path changed.");
  if (plan.action === "export-history") {
    const graphs = localGraphs(ctx, plan.graphId);
    const nodes = [...new Set(graphs.flatMap((g) => g.nodes.map((n) => n.id)))].sort();
    const timelines = nodes.map((node) => portableTimeline(history(ctx, plan.graphId, node), graphs));
    requireValue(digest({ graphs, timelines }) === plan.sourceDigest, "Historical evidence changed; replan export.");
    requireValue(digest(state.readJson(originFile(ctx), true)) === digest(plan.previousOrigin),
      "History origin changed; replan export.");
    validateArchive(ctx, archive, plan.graphId);
    requireValue(!fs.existsSync(plan.archivePath), "Archive output appeared; do not overwrite it.");
    requireValue(digest(loadPolicy(ctx, plan.graphId)) === plan.publicationPolicyDigest,
      "Publication policy changed; replan history export.");
    assertOutbound(ctx, effectivePolicy(ctx, plan.graphId), plan.outboundScope);
    // Exclusive creation avoids replacing an existing archive even after approval.
    const fd = fs.openSync(plan.archivePath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(archive, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!plan.previousOrigin) state.atomicJson(originFile(ctx), { id: archive.origin });
    requireValue(digest(state.readJson(plan.archivePath)) === digest(archive), "Export readback failed.");
    return { exported: archive.id, origin: archive.origin, archive: plan.archivePath,
      completeness: archive.completeness };
  }
  requireValue(plan.action === "import-history" &&
    digest(state.readJson(plan.archivePath)) === digest(archive), "History archive changed; replan import.");
  validateArchive(ctx, archive, plan.graphId);
  checkConflicts(ctx, archive);
  importPolicy(ctx, plan.graphId, archive.publicationPolicy);
  const file = archiveFile(ctx, archive.graph, archive.id);
  const existing = state.readJson(file, true);
  requireValue(!existing || digest(existing) === digest(archive), "Conflicting existing archive.");
  const prefix = `refs/pr-graph/archives/${archive.graph}/${archive.id}/`;
  for (const root of archive.roots) {
    const retained = git.refId(ctx.root, `${prefix}${root}`);
    requireValue(!retained || retained === root, "Archive retention ref changed; inspect explicitly.");
  }
  git.git(ctx.root, ["index-pack", "--stdin", "--strict"], Buffer.from(archive.pack, "base64"));
  const commands = ["start", ...archive.roots.map((root) => {
    const ref = `${prefix}${root}`;
    return git.refId(ctx.root, ref) ? `verify ${ref} ${root}` : `create ${ref} ${root}`;
  }), "prepare", "commit", ""].join("\n");
  git.out(ctx.root, ["update-ref", "--stdin"], commands);
  if (!existing) state.atomicJson(file, archive);
  requireValue(digest(state.readJson(file)) === digest(archive) &&
    archive.roots.every((root) => git.refId(ctx.root, `${prefix}${root}`) === root), "History import readback failed.");
  return { imported: archive.id, origin: archive.origin, alreadyImported: Boolean(existing),
    completeness: archive.completeness, warning: WARNING };
}

export function historyArchives(ctx, graph) {
  return storedArchives(ctx, graph).map((a) => ({
    archive: a.id, origin: a.origin, graph: a.graph, identity: a.identity,
    createdAt: a.createdAt, completeness: a.completeness, warning: WARNING,
  }));
}

export function importedHistory(ctx, graph, node, id) {
  requireValue(ID.test(node), "Select --node explicitly.");
  const archive = state.readJson(archiveFile(ctx, graph, id));
  validateMetadata(archive, graph);
  requireValue(archive.id === id, "Imported history archive identity mismatch.");
  const timeline = archive.timelines.find((t) => t.node === node);
  requireValue(timeline, `Unknown imported historical node: ${node}`);
  const provenance = { source: "imported", archive: id, origin: archive.origin,
    graphIdentity: archive.identity, authenticated: false };
  return git.withObjectView(ctx, (run, objects) => {
    const commits = (v) => [...new Set([v.snapshot.node.change.base, v.snapshot.node.change.head,
      v.snapshot.node.base, v.snapshot.node.head, v.snapshot.node.validation?.head,
      v.snapshot.node.landing?.commit].filter(Boolean))];
    const available = objects.commits(timeline.versions.flatMap(commits));
    return {
      ...timeline, current: null,
      versions: timeline.versions.map((v) => ({
        ...v, provenance,
        missingCommits: commits(v).filter((sha) => !available.get(sha)),
      })),
      events: timeline.events.map((e) => ({ ...e, source: "imported", originalSource: e.source, provenance })),
      provenance, baselineOrigins: Object.fromEntries(Object.keys(timeline.baselines)
        .map((key) => [key, timeline.baselines[key] ? provenance : null])),
      gaps: [...timeline.gaps], warning: WARNING,
    };
  });
}
