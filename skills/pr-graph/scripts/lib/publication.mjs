import fs from "node:fs";
import path from "node:path";
import { digest, requireValue, footer, updateFooter, helperBranch, prerequisites } from "./graph.mjs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";

const ID = /^[a-z0-9][a-z0-9-]*$/;
const HEX = /^[0-9a-f]{64}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const empty = () => ({ version: 1, exclusions: [] });
const file = (ctx, id) => {
  requireValue(ID.test(id), "Invalid publication policy graph ID.");
  return path.join(ctx.dir, "publication-policies", `${id}.json`);
};
const sorted = (values) => [...new Set(values)].sort();

export function validatePolicy(policy) {
  const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
    digest(Object.keys(value).sort()) === digest([...names].sort());
  requireValue(keys(policy, ["version", "exclusions"]) &&
    policy.version === 1 && Array.isArray(policy.exclusions), "Invalid publication policy.");
  const ids = new Set();
  for (const e of policy.exclusions) {
    requireValue(keys(e, ["id", "active", "members", "objects", "markers", "texts", "receipts"]) &&
      typeof e.id === "string" && ID.test(e.id) && !ids.has(e.id) && typeof e.active === "boolean" &&
      [e.members, e.objects, e.markers].every(Array.isArray) &&
      e.members.includes(e.id) && e.members.every((id) => typeof id === "string" && ID.test(id)) &&
      e.objects.every((id) => typeof id === "string" && SHA.test(id)) &&
      e.markers.every((id) => typeof id === "string" && HEX.test(id)) && Array.isArray(e.texts) &&
      e.texts.every((text) => typeof text === "string" && text.trim()) && Array.isArray(e.receipts) &&
      e.receipts.every((r) => keys(r, ["operation", "reason", "action"]) &&
        typeof r.operation === "string" && HEX.test(r.operation) && typeof r.reason === "string" && r.reason.trim() &&
        ["exclude", "release"].includes(r.action)), "Invalid publication exclusion evidence.");
    ids.add(e.id);
  }
  return policy;
}

export function mergePolicies(local = empty(), incoming = empty()) {
  validatePolicy(local);
  validatePolicy(incoming);
  const result = structuredClone(local);
  for (const entry of incoming.exclusions) {
    const old = result.exclusions.find((e) => e.id === entry.id);
    if (!old) result.exclusions.push(structuredClone(entry));
    else {
      old.active ||= entry.active;
      for (const key of ["members", "objects", "markers", "texts"]) old[key] = sorted([...old[key], ...entry[key]]);
      old.receipts = [...new Map([...old.receipts, ...entry.receipts].map((r) => [digest(r), r])).values()];
    }
  }
  result.exclusions.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

export function loadPolicy(ctx, id) {
  return validatePolicy(state.readJson(file(ctx, id), true) ?? empty());
}

export function retainPolicy(ctx, graph, previous) {
  const policy = mergePolicies(loadPolicy(ctx, graph.id),
    mergePolicies(previous?.publicationPolicy ?? empty(), graph.publicationPolicy ?? empty()));
  if (!policy.exclusions.length) return;
  graph.publicationPolicy = collect(ctx, policy, [previous, graph].filter(Boolean));
  state.atomicJson(file(ctx, graph.id), graph.publicationPolicy);
}

export function importPolicy(ctx, id, policy) {
  if (!policy) return;
  state.atomicJson(file(ctx, id), mergePolicies(loadPolicy(ctx, id), policy));
}

function snapshots(ctx, id) {
  const dir = path.join(ctx.dir, "history", id);
  return [
    state.load(ctx, id, true),
    ...(fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
      .flatMap((n) => {
        const record = state.readJson(path.join(dir, n));
        return [record.before, record.after];
      }) : []),
    ...state.journals(ctx).filter((j) => j.plan.graph?.id === id || j.plan.graphId === id)
      .flatMap((j) => [j.plan.graph, j.plan.previous, j.candidate]),
  ].filter(Boolean);
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

function markers(text) {
  return sorted([text, ...text.split(/\r?\n/)].filter((line) => line.trim()).map((line) => digest(line)));
}

function collect(ctx, policy, graphs) {
  const result = structuredClone(policy);
  if (!result.exclusions.some((e) => e.active)) return result;
  return git.withObjectView(ctx, (run) => {
    for (const entry of result.exclusions.filter((e) => e.active)) {
      const members = new Set(entry.members);
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of graphs.flatMap((g) => g.nodes)) {
          if ((node.supersedes ?? []).some((id) => members.has(id)) && !members.has(node.id)) {
            members.add(node.id);
            changed = true;
          }
          if (members.has(node.id)) for (const id of node.replacedBy ?? []) {
            if (!members.has(id)) { members.add(id); changed = true; }
          }
        }
      }
      entry.members = sorted([...members]);
      const objects = new Set(entry.objects);
      const hashes = new Set(entry.markers);
      const texts = new Set(entry.texts);
      const seen = new Set();
      for (const node of graphs.flatMap((g) => g.nodes).filter((n) => members.has(n.id))) {
        const key = digest({ change: node.change, head: node.head, base: node.base,
          title: node.title, description: node.description, validations: node.validations,
          reason: node.validationReason, body: node.pr?.body });
        if (seen.has(key)) continue;
        seen.add(key);
        for (const sha of [node.change.head, node.head].filter(Boolean)) objects.add(sha);
        for (const text of strings({ title: node.title, description: node.description,
          pr: node.pr?.body })) {
          if (text.trim()) texts.add(text);
          for (const hash of markers(text)) hashes.add(hash);
        }
        for (const text of strings({ validations: node.validations, validationReason: node.validationReason })) {
          for (const hash of markers(text)) hashes.add(hash);
        }
        for (const line of node.change.patch.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            for (const hash of markers(line.slice(1))) hashes.add(hash);
          }
        }
        if (node.base && node.head) {
          const diff = run(["diff-tree", "-r", "--raw", "--no-abbrev", "--no-renames",
            node.base, node.head]);
          requireValue(diff.status === 0, `Cannot inventory exclusion ${entry.id}; objects unavailable.`);
          for (const line of diff.stdout.split("\n")) {
            const match = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) /.exec(line);
            if (match && !/^0+$/.test(match[2])) objects.add(match[2]);
          }
        }
      }
      entry.objects = sorted([...objects]);
      entry.markers = sorted([...hashes]);
      entry.texts = sorted([...texts]);
    }
    return result;
  });
}

export function effectivePolicy(ctx, id, graph) {
  const policy = mergePolicies(loadPolicy(ctx, id), graph?.publicationPolicy ?? empty());
  return policy.exclusions.some((e) => e.active)
    ? collect(ctx, policy, [...snapshots(ctx, id), ...(graph ? [graph] : [])]) : policy;
}

export function createPolicyPlan(ctx, options) {
  const graph = state.load(ctx, options.graph);
  const spec = options.spec;
  requireValue(spec && Object.keys(spec).every((key) => ["exclude", "release", "reason"].includes(key)) &&
    typeof spec.reason === "string" && spec.reason.trim() &&
    [spec.exclude, spec.release].every((ids) => Array.isArray(ids) &&
      ids.every((id) => typeof id === "string" && ID.test(id)) && new Set(ids).size === ids.length) &&
    spec.exclude.length + spec.release.length > 0 &&
    spec.exclude.every((id) => !spec.release.includes(id)), "Invalid publication-policy spec.");
  const before = effectivePolicy(ctx, graph.id, graph);
  const after = structuredClone(before);
  for (const id of spec.exclude) {
    requireValue(graph.nodes.some((n) => n.id === id), `Unknown exclusion node: ${id}`);
    const old = after.exclusions.find((e) => e.id === id);
    requireValue(!old?.active, `Exclusion already active: ${id}`);
    if (old) old.active = true;
    else after.exclusions.push({ id, active: true, members: [id], objects: [], markers: [], texts: [], receipts: [] });
  }
  for (const id of spec.release) {
    const old = after.exclusions.find((e) => e.id === id);
    requireValue(old?.active, `Unknown active exclusion: ${id}`);
    old.active = false;
  }
  return { version: 1, action: "publication-policy", repository: ctx.root, common: ctx.common,
    graph, previousDigest: digest(graph), spec, policyBefore: loadPolicy(ctx, graph.id),
    policyAfter: collect(ctx, after, snapshots(ctx, graph.id)),
    effects: ["Change only local publication policy; retain evidence and exact approval receipts.",
      ...spec.exclude.map((id) => `Exclude ${id} and its retained/future lineage from outbound transfer.`),
      ...spec.release.map((id) => `RELEASE exclusion ${id}; this permits future disclosure, not retraction.`)] };
}

export function applyPolicyPlan(ctx, plan) {
  const graph = state.load(ctx, plan.graph.id);
  requireValue(digest(graph) === plan.previousDigest &&
    digest(loadPolicy(ctx, graph.id)) === digest(plan.policyBefore), "Publication policy or graph changed; replan.");
  const policy = structuredClone(plan.policyAfter);
  for (const action of ["exclude", "release"]) for (const id of plan.spec[action]) {
    policy.exclusions.find((e) => e.id === id).receipts.push({
      operation: plan.approval, action, reason: plan.spec.reason,
    });
  }
  // Explicit local release is the only path allowed to replace active restrictions.
  state.atomicJson(file(ctx, graph.id), policy);
  graph.publicationPolicy = policy;
  state.atomicJson(state.graphFile(ctx, graph.id), graph);
  return { graph, operation: plan.approval, policy };
}

export function outboundScope(plan, graph = plan.graph) {
  if (!graph || plan.localOnly) return [];
  const scopes = [];
  const publication = ["publish", "sync", "retarget"].includes(plan.action);
  const nodes = graph.nodes.filter((n) => !plan.publishNodes || plan.publishNodes.includes(n.id));
  if (publication) for (const n of nodes.filter((n) => !n.retired && !n.landing &&
    (plan.action === "publish" || n.pr))) {
    scopes.push({ route: `product:${n.id}`, nodes: [n.id, ...prerequisites(graph, n.id).map((p) => p.id)],
      roots: [n.head ?? n.change.head, n.base ?? n.change.base].filter(Boolean),
      metadata: [n.title, updateFooter(n.pr?.body ?? n.description, footer(graph, n))] });
    if (n.dependencies.length) scopes.push({ route: `helper:${n.id}`, nodes: prerequisites(graph, n.id).map((p) => p.id),
      roots: [n.base].filter(Boolean), metadata: [helperBranch(graph, n.id)] });
  }
  if (["ready", "merge", "describe"].includes(plan.action)) {
    for (const n of nodes.filter((n) => plan.descriptions ? Object.hasOwn(plan.descriptions, n.id) : n.id === plan.node)) {
      scopes.push({ route: `${plan.action}:${n.id}`, nodes: [n.id],
        roots: [n.head, n.base].filter(Boolean), metadata: [n.title,
          updateFooter(plan.descriptions?.[n.id] ?? plan.description ?? n.pr?.body ?? n.description, footer(graph, n))] });
    }
  }
  const shape = ["init", "split", "add", "deps", "split-node", "fold", "remove"].includes(plan.action);
  const refresh = ["publish", "sync", "retarget", "ready", "merge"].includes(plan.action);
  for (const n of nodes.filter((n) => n.pr && ((shape && (n.retired || n.requiresDraft)) || refresh))) {
    scopes.push({ route: `metadata:${n.id}`, nodes: [n.id, ...n.dependencies, ...(n.replacedBy ?? [])],
      roots: [], metadata: [updateFooter(n.pr.body, footer(graph, n))] });
  }
  if (graph.backup.enabled && ["publish", "sync", "retarget", "backup", "merge", "ready", "describe"].includes(plan.action)) {
    scopes.push({ route: "backup", nodes: graph.nodes.map((n) => n.id),
      policyEvidence: true,
      roots: sorted([graph.backup.head, graph.targetSha, graph.combined, graph.source?.base, graph.source?.head,
        ...graph.nodes.flatMap((n) => [n.change.base, n.change.head, n.head, n.base, n.landing?.commit])].filter(Boolean)),
      metadata: [graph] });
  }
  return scopes;
}

export function assertOutbound(ctx, policy, scopes) {
  const active = policy.exclusions.filter((e) => e.active);
  if (!active.length || !scopes.length) return;
  const blocked = (entry, scope, kind) => {
    throw new Error(`Publication excluded: ${entry.id} via ${scope.route} (${kind}). No further outbound writes permitted; prior effects, if any, require readback.`);
  };
  git.withObjectView(ctx, (run) => {
    for (const scope of scopes) {
      for (const e of active) {
        if (scope.policyEvidence || scope.nodes?.some((id) => e.members.includes(id))) blocked(e, scope, "node/metadata scope");
      }
      const textHashes = new Set(strings(scope.metadata).flatMap(markers));
      for (const e of active) if (e.markers.some((h) => textHashes.has(h)) ||
        strings(scope.metadata).some((text) => e.texts.some((privateText) => text.includes(privateText)))) {
        blocked(e, scope, "metadata fingerprint");
      }
      if (!scope.roots?.length) continue;
      requireValue(scope.roots.every((sha) => SHA.test(sha)), "Cannot prove outbound scope: invalid object ID.");
      const listed = run(["rev-list", "--objects", "--no-object-names", "--missing=print", "--stdin"],
        `${scope.roots.join("\n")}\n`);
      requireValue(listed.status === 0 && !listed.stdout.includes("?"),
        `Cannot prove outbound scope via ${scope.route}; missing/unverifiable objects.`);
      for (const sha of sorted(listed.stdout.trim().split("\n").filter(Boolean))) {
        for (const e of active) if (e.objects.includes(sha)) blocked(e, scope, `object ${sha}`);
        const type = run(["cat-file", "-t", sha]);
        requireValue(type.status === 0, `Cannot inspect outbound object via ${scope.route}.`);
        if (!["blob", "commit", "tag"].includes(type.stdout.trim())) continue;
        const content = run(["cat-file", type.stdout.trim(), sha]);
        requireValue(content.status === 0, `Cannot inspect outbound content via ${scope.route}.`);
        const hashes = new Set(markers(content.stdout));
        for (const e of active) if (e.markers.some((h) => hashes.has(h)) ||
          e.texts.some((text) => content.stdout.includes(text))) blocked(e, scope, `content fingerprint ${sha}`);
      }
    }
  });
}

export function checkOutbound(ctx, plan, graph = plan.graph) {
  requireValue(plan.publicationPolicyDigest === digest(loadPolicy(ctx, graph.id)),
    "Publication policy changed; stop outbound writes and replan. Prior effects require readback.");
  const policy = effectivePolicy(ctx, graph.id, graph);
  assertOutbound(ctx, policy, outboundScope(plan, graph));
  return policy;
}
