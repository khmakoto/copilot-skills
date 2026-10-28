import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  VERSION, digest, requireValue, validateGraph, topological, prerequisites,
  eligible, footer, updateFooter, helperBranch, integrationFreshness, MAIN_FRESHNESS_MS,
} from "./graph.mjs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { normalizeChange, applyChange, realize, verifyComposition } from "./changes.mjs";
import { resolveProvider, identity, providerFor } from "./providers/index.mjs";
import { createAdoptionPlan, applyAdoptionPlan } from "./adoption.mjs";
import { createCheckpointPlan, applyCheckpointPlan } from "./checkpoint.mjs";
import { createRetiredRemovalPlan, applyRetiredRemovalPlan } from "./retirement.mjs";
import { nodeDetails, step } from "./progress.mjs";

const SHAPE = new Set(["init", "split", "add", "deps", "split-node", "fold", "remove"]);
const FORWARD_TARGET = new Set(["retarget", "describe"]);
const ACTIONS = new Set([...SHAPE, "publish", "sync", "retarget", "ready", "merge", "backup",
  "fetch-backup", "restore", "resolve", "abort", "cleanup", "describe", "reconcile", "unlock",
  "record-landing", "adopt", "checkpoint", "remove-retired"]);

const now = (ctx) => ctx.now?.() ?? Date.now();

function mergeBase(ctx, graph, before, after) {
  requireValue([before, after].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)),
    "Ancestry requires full commit SHAs.");
  const available = [before, after].every((sha) =>
    git.git(ctx.root, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], undefined, true).status === 0);
  const provider = graph.repository.remote ? getProvider(ctx, graph) : null;
  if (!available && provider?.mergeBase) return provider.mergeBase(before, after);
  const result = git.git(ctx.root, ["merge-base", before, after], undefined, true);
  requireValue([0, 1].includes(result.status), result.stderr);
  return result.status === 0 ? result.stdout.trim() : null;
}

function ancestor(ctx, graph, before, after) {
  return mergeBase(ctx, graph, before, after) === before;
}

function snapshotFreshness(ctx, graph, target, node) {
  const observedAt = now(ctx);
  const freshness = integrationFreshness(graph, node, target, observedAt);
  if (freshness.status !== "stale" || freshness.target !== graph.target || !freshness.thresholdMs ||
    freshness.ageMs === null || freshness.ageMs >= freshness.thresholdMs) return freshness;
  return integrationFreshness(graph, node, target, observedAt,
    ancestor(ctx, graph, freshness.snapshot, target));
}

function fetchObservation(ctx, graph, input, target, observedAt) {
  if (input === undefined) return null;
  requireValue(input && graph.repository.remote && ["main", "master"].includes(graph.target) &&
    input.target === graph.target && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.sha) &&
    Number.isSafeInteger(input.startedAt) && input.startedAt >= 0 && input.startedAt <= observedAt,
  "Fetch observation requires a remote main/master target, its full SHA, and a non-future startedAt in epoch milliseconds.");
  requireValue(git.commitId(ctx.root, input.sha) === input.sha && ancestor(ctx, graph, input.sha, target),
    "Fetch observation target was rewound or rewritten; fetch and replan.");
  return { target: input.target, sha: input.sha, startedAt: input.startedAt };
}

function permitsForwardTarget(ctx, plan) {
  if (FORWARD_TARGET.has(plan.action)) return true;
  const freshness = integrationFreshness(plan.graph, null, null, now(ctx));
  return plan.action !== "merge" && plan.graph.integration?.sha === plan.target &&
    freshness.ageMs !== null && freshness.ageMs < freshness.thresholdMs;
}

function freshnessReport(ctx, graph, facts) {
  return step("Inspecting integration freshness, branch identity, and validation status", () => {
    const target = graph.repository.remote ? facts.remote[graph.target] : facts.local[graph.target];
    return Object.fromEntries(graph.nodes.map((node) =>
      step("Inspecting node freshness", () => {
        const local = facts.local[node.branch];
        const remote = facts.remote[node.branch];
        return [node.id, {
          integration: { ...snapshotFreshness(ctx, graph, target, node),
            scope: graph.repository.remote ? "remote" : "local-only" },
          branch: {
            status: !node.head ? "unknown" : !local || (node.pr && graph.repository.remote && !remote) ? "missing" :
              local !== node.head ? "changed" :
              graph.repository.remote && remote && remote !== node.head ? "changed" : "current",
            expected: node.head ?? null, local: local ?? null, remote: remote ?? null,
            scope: graph.repository.remote ? remote ? "remote" : "unpublished" : "local-only",
          },
          validation: !node.validation ? "missing" :
            node.validation.head === node.head && node.validation.commands === digest(node.validations) ? "current" : "stale",
        }];
      }, nodeDetails(graph, node))));
  });
}

function getProvider(ctx, graph) {
  return ctx.providerFactory?.(graph.repository.provider) ??
    providerFor(graph.repository.provider, ctx.root);
}

function nodeById(graph, id) {
  const node = graph.nodes.find((n) => n.id === id);
  requireValue(node && !node.retired, `Unknown active node: ${id}`);
  return node;
}

function graphRefs(graph) {
  return [...new Set([
    graph.target,
    ...graph.nodes.flatMap((n) => [n.branch, helperBranch(graph, n.id)]),
    graph.backup?.branch,
  ].filter(Boolean))].sort();
}

function observe(ctx, graph, provider) {
  return step("Observing local refs, remote refs, and PR state", () => {
    const branches = graphRefs(graph);
    const remote = git.remoteRefs(ctx.root, graph.repository.remote);
    const prs = {};
    for (const node of graph.nodes) {
      if (node.pr) prs[node.id] = step("Reading PR state", () => provider.get(node.pr.id), nodeDetails(graph, node));
    }
    return {
      local: Object.fromEntries(branches.map((b) => [b, git.refId(ctx.root, `refs/heads/${b}`)])),
      remote: Object.fromEntries(branches.map((b) => [b, remote[`refs/heads/${b}`] ?? null])),
      prs,
    };
  });
}

function normalizeSpec(ctx, spec, previous) {
  requireValue(spec?.id, "Spec requires a stable graph id.");
  requireValue(!previous || spec.id === previous.id, "A shape operation cannot change graph identity.");
  const remote = git.remoteConfig(ctx.root, previous ? previous.repository.remote : spec.remote);
  const config = resolveProvider(remote.url, previous?.repository.provider ?? spec.provider);
  const target = spec.target ?? previous?.target ?? remote.target;
  requireValue(target, "Cannot determine target branch; specify target explicitly.");
  git.checkBranch(ctx.root, target);
  const graph = {
    version: VERSION, id: spec.id, title: spec.title ?? previous?.title ?? spec.id,
    revision: previous?.revision ?? 0, ...(previous?.source ? { source: previous.source } : {}),
    repository: { identity: identity(remote.url, config, ctx.root), remote: remote.name, url: remote.url, provider: config },
    target, nodes: [], ...(previous?.integration ? { integration: previous.integration } : {}),
    helperBranchPrefix: spec.helperBranchPrefix ?? previous?.helperBranchPrefix ?? `pr-graph/${spec.id}/bases`,
    backup: spec.backup ?? previous?.backup ?? { enabled: false, branch: `pr-graph/${spec.id}/metadata` },
  };
  requireValue(!previous || graph.repository.identity === previous.repository.identity, "Repository identity changed.");
  requireValue(!previous || graph.target === previous.target, "Changing integration targets requires a separate retarget plan.");
  requireValue(typeof graph.backup.enabled === "boolean", "backup.enabled must be boolean.");
  graph.backup.branch ??= `pr-graph/${graph.id}/metadata`;
  git.checkBranch(ctx.root, graph.backup.branch);
  requireValue(!graph.backup.enabled || remote.name, "Backup requires an explicitly selected remote.");
  requireValue(Array.isArray(spec.nodes), "Spec needs a complete node list.");
  for (const input of spec.nodes) {
    const old = previous?.nodes.find((n) => n.id === input.id);
    const change = normalizeChange(ctx.root, input.change ?? old?.change);
    const node = {
      ...old, id: input.id, title: input.title ?? old?.title, description: input.description ?? old?.description ?? "",
      dependencies: input.dependencies ?? old?.dependencies ?? [],
      branch: input.branch ?? old?.branch ?? `pr-graph/${graph.id}/nodes/${input.id}`,
      change,
      validations: input.validations ?? old?.validations ?? [],
      validationReason: input.validationReason ?? old?.validationReason ?? null,
      supersedes: input.supersedes ?? old?.supersedes ?? [],
      retired: false,
    };
    if (input.adoptPr !== undefined) {
      requireValue(!old?.pr, "Node already has a PR.");
      const p = getProvider(ctx, graph);
      requireValue(p.kind !== "local", "PR adoption needs a hosted provider.");
      node.pr = p.get(input.adoptPr);
      requireValue(node.pr.state === "open" && node.pr.branch === node.branch, "Adopted PR does not match the node branch.");
      node.head = node.pr.head;
      node.base = node.pr.base;
      node.baseBranch = node.pr.baseBranch;
    }
    git.checkBranch(ctx.root, node.branch);
    requireValue(!old || old.branch === node.branch, "Branch renaming is not implicit; retain stable published branches.");
    requireValue(!old?.retired, `Retired node ID cannot be reused: ${node.id}`);
    requireValue(!old?.landing || digest(old.change) === digest(change), "Landed changes are immutable.");
    requireValue(typeof node.description === "string", `Description must be text: ${node.id}`);
    requireValue(node.validationReason === null ||
      (typeof node.validationReason === "string" && node.validationReason.trim()),
    `Validation reason must be nonempty text: ${node.id}`);
    requireValue(node.validations.length || node.validationReason, `Supply validations or an explicit validationReason: ${node.id}`);
    requireValue(Array.isArray(node.supersedes) && node.supersedes.every((id) =>
      previous?.nodes.some((n) => n.id === id)), `Invalid supersedes mapping: ${node.id}`);
    graph.nodes.push(node);
  }
  for (const old of previous?.nodes ?? []) {
    if (!graph.nodes.some((n) => n.id === old.id)) graph.nodes.push({
      ...old, retired: true,
      replacedBy: old.retired ? old.replacedBy : graph.nodes.filter((n) => n.supersedes.includes(old.id)).map((n) => n.id),
    });
  }
  validateGraph(graph);
  for (const node of graph.nodes.filter((n) => !n.retired)) {
    requireValue(node.dependencies.every((id) => {
      const dependency = graph.nodes.find((n) => n.id === id);
      return !dependency.retired || dependency.landing;
    }), `Active node ${node.id} depends on a retired unlanded node.`);
  }
  const refs = graphRefs(graph);
  const product = graph.nodes.map((n) => n.branch);
  const helpers = graph.nodes.map((n) => helperBranch(graph, n.id));
  for (const branch of helpers) git.checkBranch(ctx.root, branch);
  requireValue(!product.includes(graph.target) && !product.includes(graph.backup.branch),
    "Product branches cannot collide with the target or metadata branch.");
  requireValue(graph.backup.branch !== graph.target && !helpers.includes(graph.backup.branch) &&
    !helpers.includes(graph.target), "Target, helper, and metadata branches must be distinct.");
  for (const node of graph.nodes) {
    requireValue(!product.includes(helperBranch(graph, node.id)), "Product/helper branch collision.");
  }
  requireValue(refs.length > 0, "Missing refs.");
  return graph;
}

function reconcile(ctx, graph, facts, target, previous) {
  for (const node of topological(graph)) {
    if (node.landing) {
      requireValue(node.landing.target === graph.target && git.ancestor(ctx.root, node.landing.commit, target),
        `Recorded landing left the integration branch: ${node.id}; reconcile explicitly.`);
    }
    const current = facts.prs[node.id];
    if (!current) {
      if (node.head && git.ancestor(ctx.root, node.head, target) && !node.landing) {
        requireValue(eligible(graph, node), `Out-of-order external landing: ${node.id}`);
        node.landing = { commit: node.head, strategy: "external-ancestry", source: node.head, target: graph.target };
      }
      continue;
    }
    requireValue(current.branch === node.branch, `PR branch changed: ${node.id}`);
    if (current.state === "merged" && !node.landing) {
      requireValue(eligible(graph, node) && current.baseBranch === graph.target,
        `Out-of-order or helper-target merge: ${node.id}; reconcile explicitly.`);
      requireValue(current.head === node.head && current.head === node.pr.head,
        `Merged PR has an unexpected or unpublished source change: ${node.id}.`);
      requireValue(current.landing && git.ancestor(ctx.root, current.landing, target),
        `PR ${node.id} did not land in the integration branch.`);
      node.landing = { commit: current.landing, source: current.head, target: graph.target, strategy: "provider" };
    } else if (current.state === "open") {
      requireValue(current.head === node.pr.head, `External PR content change: ${node.id}; adopt explicitly.`);
      requireValue(current.baseBranch === node.pr.baseBranch, `External PR retarget: ${node.id}; reconcile explicitly.`);
      const intentionallyInvalidated = previous?.nodes.some((n) =>
        n.id === node.id && eligible(previous, n));
      requireValue(current.draft || eligible(graph, node) || intentionallyInvalidated,
        `Blocked node made ready externally: ${node.id}`);
    } else {
      requireValue(node.landing || node.retired, `PR ${node.id} is closed, not merged.`);
    }
    node.pr = current;
  }
}

function warnings(ctx, graph) {
  const items = [];
  if (git.out(ctx.root, ["status", "--porcelain", "--untracked-files=all"])) {
    items.push("Current worktree has uncommitted work. It is not modified or backed up.");
  }
  if (!graph.backup.enabled) items.push("Remote snapshot backup is disabled; unpublished committed work is clone-local.");
  if (graph.backup.enabled) items.push(`Backup publishes committed code and its reachable history to ${graph.repository.url}, branch ${graph.backup.branch}.`);
  if (graph.repository.provider.kind === "ado") items.push("ADO retargeting is conditional and verified after every update. Multi-ref pushes are non-atomic.");
  return items;
}

function worktreePath(ctx, journal) {
  const dir = journal.plan.reuseWorktree?.path ?? path.join(ctx.dir, "trees", journal.id);
  requireValue(path.dirname(dir) === path.join(ctx.dir, "trees") &&
    /^[0-9a-f]{64}$/.test(path.basename(dir)), "Invalid operation worktree path.");
  return dir;
}

function reusableOperation(ctx, operation, graphId) {
  const source = state.readJson(state.journalFile(ctx, operation));
  requireValue(source.id === operation && source.plan.common === ctx.common &&
    source.plan.graph?.id === graphId, "Reuse source belongs to another repository or graph.");
  requireValue(["done", "aborted"].includes(source.status) && !source.pendingChange,
    "Reuse requires a completed or explicitly aborted operation without a pending change.");
  requireValue(!source.worktreeReusedBy,
    `Operation worktree was transferred to ${source.worktreeReusedBy}; select its latest owner.`);
  return source;
}

function planWorktreeReuse(ctx, operation, graphId) {
  const source = reusableOperation(ctx, operation, graphId);
  const info = git.operationWorktreeInfo(ctx, worktreePath(ctx, source));
  requireValue(!git.out(info.path, ["status", "--porcelain", "--untracked-files=all"]),
    "Retained operation worktree has changes; preserve and handle them explicitly.");
  return { operation, journalDigest: digest(source), ...info };
}

function requireWorktreeOwner(ctx, journal) {
  requireValue(!journal.worktreeReusedBy,
    `Operation worktree was transferred to ${journal.worktreeReusedBy}; recover or clean its latest owner instead.`);
  const reuse = journal.plan.reuseWorktree;
  if (!reuse) return;
  const source = state.readJson(state.journalFile(ctx, reuse.operation));
  requireValue(journal.worktreeReuseClaimed && source.worktreeReusedBy === journal.id,
    "Operation has not claimed this retained worktree; recover or clean its actual owner instead.");
  requireValue(git.operationWorktreeInfo(ctx, worktreePath(ctx, journal)).gitDir === reuse.gitDir,
    "Reuse worktree identity changed after approval.");
}

function prepareWorktree(ctx, journal, target) {
  const reuse = journal.plan.reuseWorktree;
  if (!reuse) return git.createWorktree(ctx, journal.id, target);
  return step("Claiming approved retained operation worktree", () => {
    const source = state.readJson(state.journalFile(ctx, reuse.operation));
    // A crash may leave the transfer recorded before this journal acknowledges it.
    const original = { ...source };
    if (original.worktreeReusedBy === journal.id) delete original.worktreeReusedBy;
    requireValue(digest(original) === reuse.journalDigest,
      "Reuse source operation changed after approval.");
    requireValue(!source.worktreeReusedBy || source.worktreeReusedBy === journal.id,
      "Retained operation worktree belongs to another operation.");
    requireValue(!journal.worktreeReuseClaimed || source.worktreeReusedBy === journal.id,
      "Retained operation worktree ownership changed.");
    requireValue(worktreePath(ctx, source) === reuse.path, "Reuse worktree path changed.");
    const info = git.operationWorktreeInfo(ctx, reuse.path);
    requireValue(info.gitDir === reuse.gitDir, "Reuse worktree identity changed after approval.");
    requireValue(journal.worktreeReuseClaimed || info.head === reuse.head,
      "Reuse worktree HEAD changed after approval.");
    requireValue(!git.out(reuse.path, ["status", "--porcelain", "--untracked-files=all"]),
      "Retained operation worktree has changes; preserve and handle them explicitly.");
    if (!journal.worktreeReuseClaimed) {
      source.worktreeReusedBy = journal.id;
      saveJournal(ctx, source);
      journal.worktreeReuseClaimed = true;
      saveJournal(ctx, journal);
    }
    return reuse.path;
  });
}

export function createPlan(ctx, action, options = {}) {
  requireValue(ACTIONS.has(action), `Unknown action: ${action}`);
  requireValue(options.reuseWorktree === undefined || ["sync", "publish", "retarget"].includes(action),
    "Worktree reuse is supported only for sync, publish, and retarget.");
  if (options.commitTrailers !== undefined) {
    requireValue((SHAPE.has(action) || ["sync", "publish", "retarget", "record-landing"].includes(action)) &&
      Array.isArray(options.commitTrailers) && options.commitTrailers.length > 0 &&
      options.commitTrailers.every((line) => typeof line === "string" &&
        /^[A-Za-z0-9-]+: [^\r\n\0]+$/.test(line)),
    "Commit trailers require reconstruction and a nonempty array of single-line Key: value strings.");
  }
  if (action === "adopt" || action === "checkpoint") {
    requireValue(options.fetchObservation === undefined,
      "Adoption and checkpoint recovery do not accept fetch-start observations.");
    return action === "adopt" ? createAdoptionPlan(ctx, options) : createCheckpointPlan(ctx, options);
  }
  if (action === "remove-retired") {
    requireValue(options.fetchObservation === undefined,
      "Metadata-only retired-node removal does not accept fetch-start observations.");
    return createRetiredRemovalPlan(ctx, options);
  }
  if (action === "unlock") {
    const owner = state.readJson(path.join(ctx.dir, "mutation.lock"));
    assertDeadOwner(owner);
    return seal({ version: VERSION, action, repository: ctx.root, common: ctx.common, owner,
      effects: ["Remove this exact lock only after rechecking its same-host owner is dead. No graph/ref/worktree cleanup."] });
  }
  if (["resolve", "abort", "cleanup", "reconcile"].includes(action)) return recoveryPlan(ctx, action, options);
  if (action === "fetch-backup") {
    const remote = git.remoteConfig(ctx.root, options.remote);
    requireValue(remote.name, "Fetch-backup requires a remote.");
    requireValue(/^[a-z0-9][a-z0-9-]*$/.test(options.graph), "Specify graph ID.");
    const branch = options.backupBranch ?? `pr-graph/${options.graph}/metadata`;
    git.checkBranch(ctx.root, branch);
    const sha = git.remoteRefs(ctx.root, remote.name)[`refs/heads/${branch}`];
    requireValue(sha, "No backup exists on the selected remote.");
    return seal({ version: VERSION, action, repository: ctx.root, common: ctx.common,
      remote, graphId: options.graph, branch, sha,
      effects: [`Fetch only ${branch}@${sha} into a private local backup ref; do not restore branches or execute validations.`] });
  }
  const previous = options.graph ? state.load(ctx, options.graph, action === "restore") : options.spec?.id ? state.load(ctx, options.spec.id, true) : null;
  let graph;
  if (action === "restore") {
    requireValue(!previous, "Graph already exists; restore never overwrites local state.");
    const sha = git.commitId(ctx.root, options.backupRef);
    graph = JSON.parse(git.out(ctx.root, ["show", `${sha}:graph.json`]));
    validateGraph(graph);
    const remote = git.remoteConfig(ctx.root, options.remote);
    const provider = resolveProvider(remote.url, graph.repository.provider);
    requireValue(identity(remote.url, provider, ctx.root) === graph.repository.identity, "Backup repository identity mismatch.");
    requireValue(!options.graph || options.graph === graph.id, "Backup graph ID mismatch.");
    graph.repository = { ...graph.repository, remote: remote.name, url: remote.url, provider };
    if (graph.integration) delete graph.integration.verifiedAt;
    for (const n of graph.nodes) {
      if (n.integration) delete n.integration.verifiedAt;
      n.validations = [];
      n.validationReason = null;
      n.validation = null;
      n.ready = false;
      n.requiresDraft = true;
    }
    return seal({ version: VERSION, action, repository: ctx.root, common: ctx.common,
      graph: { ...graph, backup: { ...graph.backup, head: sha } }, previous: null, backupRef: sha,
      expectedLocal: Object.fromEntries(graph.nodes.map((n) => [n.branch, git.refId(ctx.root, `refs/heads/${n.branch}`)])),
      effects: ["Restore verified committed snapshots and local graph state; do not push, mutate PRs, or execute stored validation commands."],
      warnings: warnings(ctx, graph) });
  }
  if (SHAPE.has(action)) {
    requireValue(options.spec, "Shape changes require --spec.");
    requireValue(["init", "split"].includes(action) ? !previous : previous, "Graph existence does not match this operation.");
    graph = normalizeSpec(ctx, options.spec, previous);
    const retired = graph.nodes.filter((n) => n.retired && !previous?.nodes.find((p) => p.id === n.id)?.retired);
    requireValue(!retired.length || ["split-node", "fold", "remove"].includes(action),
      "Node removal requires a split-node, fold, or separately approved remove plan.");
    requireValue(!retired.some((n) => n.landing), "Cannot remove a landed node's dependency receipt.");
    if (["split-node", "fold"].includes(action)) {
      requireValue(retired.every((n) => n.replacedBy.length),
        "Split/fold must declare new-node supersedes mappings for every retired node.");
    }
    if (action === "deps" || action === "add") {
      for (const old of previous.nodes.filter((n) => !n.retired)) {
        requireValue(digest(old.change) === digest(nodeById(graph, old.id).change), "Use split-node/fold to change existing own-change ownership.");
      }
    }
  } else if (action === "retarget") {
    requireValue(previous, "Select an existing graph with --graph.");
    requireValue(options.spec?.id === previous.id && typeof options.spec.target === "string" &&
      Object.keys(options.spec).every((key) => ["id", "target"].includes(key)),
    "Retarget requires a spec containing only this graph's id and the new target.");
    requireValue(options.spec.target !== previous.target, "Integration target is unchanged; use sync.");
    requireValue(previous.combined && previous.nodes.every((n) => !n.landing),
      "Retarget requires a fully realized graph without landing receipts; landed work needs a separate graph.");
    graph = structuredClone(previous);
    graph.target = git.checkBranch(ctx.root, options.spec.target);
    requireValue(graph.target !== graph.backup.branch && graph.nodes.every((n) =>
      n.branch !== graph.target && helperBranch(graph, n.id) !== graph.target),
    "Integration target collides with a graph-owned branch.");
  } else {
    requireValue(previous, "Select an existing graph with --graph.");
    graph = structuredClone(previous);
  }
  const provider = getProvider(ctx, graph);
  const facts = observe(ctx, graph, provider);
  if (options.spec?.helperBranchPrefix !== undefined &&
    (!previous || helperBranch(graph, "prefix-probe") !== helperBranch(previous, "prefix-probe"))) {
    for (const node of graph.nodes.filter((n) => !n.retired && !n.landing)) {
      const branch = helperBranch(graph, node.id);
      requireValue(!facts.local[branch] && !facts.remote[branch],
        `New helper namespace already contains ${branch}; existing refs are not implicitly adopted.`);
    }
  }
  if (graph.backup.enabled) {
    requireValue((facts.remote[graph.backup.branch] ?? null) === (previous?.backup?.head ?? null),
      "Remote graph metadata advanced or belongs to another graph; restore/reconcile before writing.");
  }
  const observedTarget = graph.repository.remote ? facts.remote[graph.target] : facts.local[graph.target];
  requireValue(observedTarget, `Integration branch does not exist: ${graph.target}`);
  const observedAt = now(ctx);
  const fetched = fetchObservation(ctx, graph, options.fetchObservation, observedTarget, observedAt);
  requireValue(action !== "merge" || !fetched || fetched.sha === observedTarget,
    "Merge requires the current integration target; fetch and replan.");
  const retained = graph.integration;
  const fetchedIntegration = fetched ? { target: graph.target, sha: fetched.sha,
    verifiedAt: observedTarget !== fetched.sha && retained?.target === graph.target &&
      retained.sha === fetched.sha && retained.verifiedAt !== undefined
      ? Math.min(retained.verifiedAt, fetched.startedAt) : fetched.startedAt } : retained;
  const snapshot = previous
    ? { ...previous, integration: fetchedIntegration?.target === previous.target &&
      fetchedIntegration.sha === previous.targetSha ? fetchedIntegration : previous.integration }
    : { ...graph, targetSha: fetched?.sha, integration: fetchedIntegration };
  const withinGrace = snapshot.integration?.sha === snapshot.targetSha && action !== "retarget" &&
    snapshotFreshness(ctx, snapshot, observedTarget).status === "grace";
  const target = withinGrace && (SHAPE.has(action) || ["publish", "ready"].includes(action))
    ? snapshot.targetSha : fetched?.sha ?? observedTarget;
  const integration = target === snapshot.targetSha ? snapshot.integration : fetchedIntegration;
  requireValue(!fetched || target !== fetched.sha || target === observedTarget ||
    snapshotFreshness(ctx, { ...graph, integration }, observedTarget).status === "grace",
  "Fetch observation freshness expired; fetch the latest target and replan.");
  if (action === "retarget") {
    requireValue(git.ancestor(ctx.root, previous.targetSha, target),
      "New integration target must contain the previous integration snapshot.");
  }
  if (SHAPE.has(action) && previous) {
    requireValue(previous.targetSha === target, "Integration target moved; sync before reshaping the graph.");
  }
  if ((target === observedTarget || target === fetched?.sha) && (SHAPE.has(action) || ["sync", "publish", "retarget"].includes(action) ||
    graph.targetSha === target)) {
    graph.integration = integration?.target === graph.target && integration.sha === target
      ? integration : { target: graph.target, sha: target, verifiedAt: observedAt };
    for (const node of graph.nodes) {
      if (node.integration?.target === graph.target && node.integration.sha === target) {
        node.integration = { ...graph.integration };
      }
    }
  }
  const source = options.spec?.source ? {
    base: git.commitId(ctx.root, options.spec.source.base),
    head: git.commitId(ctx.root, options.spec.source.head),
  } : null;
  requireValue(action !== "split" || source, "Split needs source.base and source.head for exact reconstruction.");
  if (source) requireValue(source.base === target, "Source base must equal the pinned integration target; rebase or explicitly prepare the source first.");
  if (source) graph.source = source;
  const descriptions = action === "describe" && options.spec ? options.spec.descriptions : null;
  if (action === "describe" && options.spec) {
    requireValue(options.spec.id === graph.id && !options.node && options.body === undefined &&
      Object.keys(options.spec).every((key) => ["id", "descriptions"].includes(key)) &&
      descriptions && typeof descriptions === "object" && !Array.isArray(descriptions) &&
      Object.keys(descriptions).length > 0,
    "Batch describe requires only this graph's id and a nonempty descriptions map; do not combine with --node/--body-file.");
    for (const [id, body] of Object.entries(descriptions)) {
      const node = nodeById(graph, id);
      requireValue(typeof body === "string" && node.pr && provider.kind !== "local",
        `Description requires text and a hosted PR: ${id}`);
      requireValue(provider.kind !== "ado" || updateFooter(body, footer(graph, node)).length <= 4000,
        `ADO description exceeds 4000 characters: ${id}`);
    }
  }
  if (["ready", "merge", "record-landing"].includes(action) || (action === "describe" && !descriptions)) {
    nodeById(graph, options.node);
  }
  const landing = action === "record-landing" ? git.commitId(ctx.root, options.landing) : null;
  if (landing) {
    requireValue(provider.kind === "local" && eligible(graph, nodeById(graph, options.node)),
      "Explicit local landing mappings require a locally managed eligible node.");
    requireValue(git.ancestor(ctx.root, landing, target), "Recorded commit is not in the intended integration branch.");
  }
  const strategy = options.strategy ?? "merge";
  requireValue(["merge", "squash", "rebase"].includes(strategy), "Invalid merge strategy.");
  const remoteAction = ["publish", "sync", "retarget", "ready", "merge", "describe"].includes(action);
  const capabilities = remoteAction || provider.kind === "local" ? provider.capabilities() : null;
  if (action === "merge") requireValue(capabilities.strategies.includes(strategy), "Merge strategy is unsupported.");
  if (action === "backup") requireValue(graph.backup.enabled && graph.repository.remote, "Enable remote backup explicitly in a graph spec first.");
  const plans = graph.nodes.filter((n) => !n.landing && !n.retired).map((n) => ({
    id: n.id, branch: n.branch, dependencies: n.dependencies, title: n.title,
    ownChange: n.change.fingerprint, description: n.description,
    base: n.dependencies.length ? `${helperBranch(graph, n.id)} until all prerequisites land` : graph.target,
    validations: n.validations, validationReason: n.validationReason,
  }));
  const reuseWorktree = options.reuseWorktree === undefined ? null :
    planWorktreeReuse(ctx, options.reuseWorktree, graph.id);
  const plan = {
    version: VERSION, action, repository: ctx.root, common: ctx.common,
    graph, previousDigest: previous ? digest(previous) : null, landing,
    ...(options.commitTrailers ? { commitTrailers: [...options.commitTrailers] } : {}),
    ...(reuseWorktree ? { reuseWorktree } : {}),
    facts, target, source, node: options.node ?? null, strategy,
    ...(fetched ? { fetchObservation: fetched } : {}),
    freshness: freshnessReport(ctx, graph, facts),
    description: action === "describe" ? options.body : null,
    ...(descriptions ? { descriptions } : {}),
    capabilities, allowNonAtomic: options.allowNonAtomic === true || provider.kind === "ado",
    references: Object.fromEntries([
      ...(options.spec?.source ? [options.spec.source.base, options.spec.source.head] : []),
      ...(options.spec?.nodes ?? []).flatMap((n) => [n.change?.base, n.change?.head]),
    ].filter((r) => typeof r === "string" && !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(r))
      .map((r) => [r, git.commitId(ctx.root, r)])),
    effects: [
      ...(graph.repository.remote ? [action === "retarget"
        ? `Fetch configured remote ${graph.repository.remote} and verify its integration branch still contains the approved snapshot before writes.`
        : `Fetch configured remote ${graph.repository.remote} and recheck pinned refs before writes; integration fast-forwards are allowed only under the recorded freshness policy.`] : []),
      ...(!FORWARD_TARGET.has(action) && permitsForwardTarget(ctx, { action, graph, target })
        ? [`Permit forward-only movement of ${graph.target} until ${new Date(graph.integration.verifiedAt + MAIN_FRESHNESS_MS).toISOString()}; retain the approved authored snapshot and local target ref. Merge never uses this grace.`] : []),
      ...(options.commitTrailers ? [`Append these exact trailers to reconstruction commit messages, not PR titles:\n${options.commitTrailers.join("\n")}`] : []),
      ...(reuseWorktree ? [
        `Transfer ownership of clean detached worktree ${reuseWorktree.path} at ${reuseWorktree.head} from stopped operation ${reuseWorktree.operation}; retain its path and hook tooling without creating a new worktree.`,
        "Record the transfer in both operation journals. The previous owner can no longer reuse or clean this worktree; all freshness, hooks, cleanliness checks, and validation remain required.",
      ] : []),
      ...(["merge", "ready", "describe", "backup"].includes(action) ? [] :
        ["Build/validate candidate own changes and integration bases in an isolated worktree; update only unoccupied graph branches."]),
      ...plans,
      ...(action === "retarget" ? [
        `Reconstruct every active node and prerequisite base on ${graph.target}@${target}; preserve own-change ownership and existing PR identities.`,
        "Permit only fast-forward advancement of the new remote integration branch during this operation; keep the approved reconstruction snapshot fixed. Ready/merge still require a subsequent current-target check.",
        "Preserve each eligible PR's observed draft/non-draft state through reconstruction and retargeting. No promotions or merges.",
        "Preserve the previous integration branch and original source snapshots; verify the combined tree against the unchanged own changes composed on the new snapshot.",
      ] : []),
      ...(["publish", "sync", "retarget"].includes(action) ? [
        action === "publish" ? "Push all active nodes; create missing PRs as drafts." : "Push already-published nodes; never promote drafts.",
        "Push tool-owned integration bases; preserve human PR bodies except the managed graph footer.",
        "Preserve observed draft/non-draft state for eligible existing PRs, including manual changes; blocked PRs must remain draft. Readiness does not waive freshness, validation, or merge checks.",
      ] : []),
      ...(action === "ready" ? [`Promote only ${options.node}, after dependency, target, diff, and validation checks.`] : []),
      ...(["publish", "sync", "retarget", "ready", "merge"].includes(action) ? ["Refresh managed graph footers, including landed nodes; preserve human text."] : []),
      ...(action === "merge" ? [`Merge only ${options.node} using ${strategy}; no source-branch deletion, auto-merge, or policy bypass.`] : []),
      ...(landing ? [{ recordLanding: landing, node: options.node,
        observedDelta: git.git(ctx.root, ["diff", "--binary", "--full-index", `${landing}^1`, landing]).stdout,
        effect: "Verify the node's own change replays to exactly this landing tree before recording it; then reconstruct the graph." }] : []),
      ...(action === "describe" ? Object.entries(descriptions ?? { [options.node]: options.body })
        .map(([node, replaceBody]) => ({ node, replaceBody })) : []),
      ...(graph.backup.enabled && ["publish", "sync", "retarget", "backup", "merge", "ready", "describe"].includes(action)
        ? [`Publish graph manifest and reachable committed snapshots to ${graph.backup.branch}.`] : []),
      ...graph.nodes.filter((n) => n.retired && n.pr && n.pr.state === "open")
        .map((n) => `Mark superseded PR ${n.pr.url} as draft; retain all branches and snapshots.`),
      ...(SHAPE.has(action) ? ["Preserve observed draft/non-draft state for eligible existing PRs; mark blocked or superseded PRs draft."] : []),
    ],
    warnings: warnings(ctx, graph),
  };
  requireValue(action !== "describe" || descriptions || typeof options.body === "string", "Describe requires an approved body.");
  return seal(plan);
}

function seal(plan) {
  return { ...plan, approval: digest(plan) };
}

function verifyApproval(plan, approval, yes) {
  const { approval: expected, ...payload } = plan;
  requireValue(yes && approval === expected && digest(payload) === expected,
    "Missing or mismatched approval. Review this exact plan, then pass --yes --approve <digest>.");
}

function saveJournal(ctx, journal) {
  state.atomicJson(state.journalFile(ctx, journal.id), journal);
}

function fetchRemote(ctx, graph, journal) {
  if (!graph.repository.remote) return;
  return step("Fetching pinned remote snapshots", () => {
    const remote = git.remoteRefs(ctx.root, graph.repository.remote);
    const unique = new Map();
    for (const branch of graphRefs(graph)) {
      if (branch === graph.target && getProvider(ctx, graph).mergeBase &&
        permitsForwardTarget(ctx, journal.plan) &&
        git.git(ctx.root, ["rev-parse", "--verify", "--quiet", `${journal.plan.target}^{commit}`],
          undefined, true).status === 0) continue;
      const sha = remote[`refs/heads/${branch}`];
      if (sha) unique.set(sha, branch);
    }
    const refspecs = [...unique].map(([sha, branch]) =>
      `${sha}:refs/pr-graph/${journal.id}/fetched/${sha}`);
    if (refspecs.length) {
      const startedAt = now(ctx);
      git.out(ctx.root, ["fetch", "--refmap=", "--no-tags", "--no-write-fetch-head", "--",
        graph.repository.remote, ...refspecs]);
      return startedAt;
    }
  });
}

function localCurrent(ctx, plan) {
  const previous = state.load(ctx, plan.graph.id, true);
  return previous ? digest(previous) : null;
}

function forwardTarget(ctx, graph, journal, before, actual) {
  requireValue(before && actual, "Integration branch disappeared during observation.");
  if (!getProvider(ctx, graph).mergeBase) fetchRemote(ctx, graph, journal);
  requireValue(ancestor(ctx, graph, before, actual),
    "Integration history was rewound or rewritten during observation; stop and replan.");
}

function samePrFacts(ctx, graph, journal, before, actual, target) {
  if (digest(actual) === digest(before)) return true;
  if (!permitsForwardTarget(ctx, journal.plan) || before?.baseBranch !== graph.target ||
    actual?.baseBranch !== graph.target ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(before.base ?? "") ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(actual.base ?? "") ||
    digest({ ...actual, base: before.base }) !== digest(before)) return false;
  const node = graph.nodes.find((n) => n.pr?.id === actual.id);
  if (!node) return false;
  forwardTarget(ctx, graph, journal, before.base, actual.base);
  return ancestor(ctx, graph, node.base, actual.base) &&
    ancestor(ctx, graph, actual.base, target) &&
    mergeBase(ctx, graph, node.head, actual.base) === node.base;
}

function verifyIntegration(ctx, plan, journal, target) {
  const graph = plan.graph;
  const expected = graph.repository.remote
    ? journal.remote[graph.target] ?? plan.facts.remote[graph.target]
    : journal.local[graph.target] ?? journal.observedLocal?.[graph.target] ?? plan.facts.local[graph.target];
  if (target !== expected) {
    requireValue(graph.repository.remote && permitsForwardTarget(ctx, plan), `Remote ref changed: ${graph.target}`);
    forwardTarget(ctx, graph, journal, expected, target);
  }
  if (!FORWARD_TARGET.has(plan.action) && plan.action !== "merge" && plan.target !== target) {
    requireValue(permitsForwardTarget(ctx, plan), "Integration freshness expired; sync and approve a new plan.");
    forwardTarget(ctx, graph, journal, plan.target, target);
  }
}

function verifyFacts(ctx, plan, provider, journal) {
  for (const [ref, sha] of Object.entries(plan.references ?? {})) {
    requireValue(git.commitId(ctx.root, ref) === sha, `Source reference changed: ${ref}`);
  }
  requireValue(localCurrent(ctx, plan) === plan.previousDigest, "Graph state changed; create a fresh plan.");
  const current = observe(ctx, journal.candidate ?? plan.graph, provider);
  for (const [branch, before] of Object.entries(plan.facts.local)) {
    requireValue(current.local[branch] === (journal.local?.[branch] ?? journal.observedLocal?.[branch] ?? before),
      `Local ref changed: ${branch}`);
  }
  for (const [branch, before] of Object.entries(plan.facts.remote)) {
    const expected = journal.remote?.[branch] ?? before;
    if (branch !== plan.graph.target) {
      requireValue(current.remote[branch] === expected, `Remote ref changed: ${branch}`);
    }
  }
  const target = plan.graph.repository.remote ? current.remote[plan.graph.target] : current.local[plan.graph.target];
  verifyIntegration(ctx, plan, journal, target);
  for (const id of new Set([...Object.keys(plan.facts.prs), ...Object.keys(journal.prs)])) {
    const expected = journal.prs?.[id] ?? plan.facts.prs[id];
    requireValue(samePrFacts(ctx, journal.candidate ?? plan.graph, journal,
      expected, current.prs[id], current.remote[plan.graph.target]),
    `PR ${id} changed; reconcile and replan.`);
  }
  return current;
}

function applyOwned(ctx, journal, cwd, change, title) {
  const before = git.commitId(cwd, "HEAD");
  const message = journal.plan.commitTrailers?.length
    ? `${title}\n\n${journal.plan.commitTrailers.join("\n")}` : title;
  const key = digest({ before, patch: change.patch,
    ...(journal.plan.commitTrailers?.length ? { message } : {}) });
  const cached = journal.commits[key];
  if (cached) {
    git.checkoutClean(cwd, cached);
    return cached;
  }
  journal.pendingChange = { key, before, title: message, worktree: cwd };
  saveJournal(ctx, journal);
  const sha = applyChange(cwd, change, message);
  git.pin(ctx.root, journal.id, `commits/${key}`, sha);
  journal.commits[key] = sha;
  journal.pendingChange = null;
  saveJournal(ctx, journal);
  return sha;
}

function validateNodes(ctx, graph, journal, cwd) {
  for (const node of graph.nodes.filter((n) => !n.landing && !n.retired)) {
    requireValue(node.validations.length || node.validationReason,
      `Validation configuration required for restored node ${node.id}; approve repository-specific checks first.`);
    const details = nodeDetails(graph, node);
    if (node.validation?.head === node.head && node.validation.commands === digest(node.validations)) {
      step("Reusing current validation (checks not rerun)", () => {}, details);
      continue;
    }
    step(node.validations.length ? "Validating node" : `No automated validation: ${node.validationReason}`, () => {
      git.checkoutClean(cwd, node.head);
      for (const check of node.validations) {
        step(`Validation ${JSON.stringify([check.command, ...check.args])}`, () => {
          const result = git.run(check.command, check.args, cwd);
          requireValue(result.status === 0, `Validation failed for ${node.id}: ${result.stderr}\n${result.stdout}`);
          requireValue(!git.out(cwd, ["status", "--porcelain"]), `Validation changed ${cwd}; inspect generated files and replan.`);
        }, { ...details, success: "passed" });
      }
      node.validation = { head: node.head, commands: digest(node.validations), reason: node.validationReason };
      journal.validated ??= {};
      journal.validated[node.id] = node.validation;
      saveJournal(ctx, journal);
    }, details);
  }
}

function writeLocal(ctx, graph, plan, journal) {
  const values = new Map();
  for (const node of graph.nodes.filter((n) => !n.landing && !n.retired)) {
    values.set(node.branch, node.head);
    if (node.baseBranch !== graph.target) values.set(node.baseBranch, node.base);
  }
  for (const [branch, sha] of values) {
    const node = graph.nodes.find((n) => n.branch === branch || n.baseBranch === branch);
    step(`Updating local branch ${branch}`, () => {
      git.writeBranch(ctx.root, branch, sha, journal.local[branch] ?? plan.facts.local[branch] ?? null);
      journal.local[branch] = sha;
      saveJournal(ctx, journal);
    }, node ? nodeDetails(graph, node) : {});
  }
}

function push(ctx, graph, entries, plan, journal) {
  if (!entries.length) return;
  requireValue(graph.repository.remote, "Publishing requires a remote.");
  const pending = entries.filter(([branch, sha]) => (journal.remote[branch] ?? plan.facts.remote[branch] ?? null) !== sha);
  if (!pending.length) return;
  const nodes = graph.nodes.filter((n) => pending.some(([b]) => b === n.branch || b === n.baseBranch));
  return step(`Pushing ${pending.length} branch ref(s) and verifying remote readback`, () => {
    const leases = pending.map(([b]) => `--force-with-lease=refs/heads/${b}:${journal.remote[b] ?? plan.facts.remote[b] ?? ""}`);
    const refs = pending.map(([b, sha]) => `${sha}:refs/heads/${b}`);
    journal.remoteStarted = true;
    saveJournal(ctx, journal);
    const result = git.git(ctx.root, ["push", "--atomic", ...leases, "--", graph.repository.remote, ...refs], undefined, true);
    if (result.status !== 0) {
      requireValue(/does not support.*atomic|does not support --atomic/i.test(result.stderr) && plan.allowNonAtomic,
        `Push failed; no success is assumed: ${result.stderr}`);
      for (let i = 0; i < pending.length; i++) {
        git.out(ctx.root, ["push", leases[i], "--", graph.repository.remote, refs[i]]);
        journal.remote[pending[i][0]] = pending[i][1];
        saveJournal(ctx, journal);
      }
    } else {
      for (const [branch, sha] of pending) journal.remote[branch] = sha;
      saveJournal(ctx, journal);
    }
    const actual = git.remoteRefs(ctx.root, graph.repository.remote);
    requireValue(entries.every(([b, sha]) => actual[`refs/heads/${b}`] === sha), "Push readback mismatch.");
  }, nodes.length ? nodes.map((n) => nodeDetails(graph, n)) : {});
}

function verifyPr(ctx, graph, node, provider) {
  let p = provider.get(node.pr.id);
  for (let attempt = 0; attempt < 4; attempt++) {
    const stalePreview = provider.kind === "ado" && p.state === "open" &&
      p.branch === node.branch && p.head === node.head &&
      p.baseBranch === node.baseBranch && node.baseBranch === graph.target &&
      typeof p.base === "string" && p.base !== node.base &&
      ancestor(ctx, graph, p.base, node.base);
    if (!stalePreview) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    p = provider.get(node.pr.id);
  }
  requireValue(p.state === "open" && p.branch === node.branch && p.head === node.head &&
    p.baseBranch === node.baseBranch, `PR head/base not yet consistent: ${node.id}`);
  if (p.base !== node.base && node.baseBranch === graph.target && graph.repository.remote) {
    requireValue(typeof p.base === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p.base),
      `Invalid PR target snapshot: ${node.id}`);
    if (!provider.mergeBase) {
      git.out(ctx.root, ["fetch", "--refmap=", "--no-tags", "--no-write-fetch-head", "--",
        graph.repository.remote,
        `${p.base}:refs/pr-graph/review-targets/${graph.id}/${p.base}`]);
    }
    requireValue(ancestor(ctx, graph, node.base, p.base) &&
      mergeBase(ctx, graph, node.head, p.base) === node.base,
    `PR target no longer preserves the authored own-change base: ${node.id}`);
  } else {
    requireValue(p.base === node.base, `PR head/base not yet consistent: ${node.id}`);
  }
  const expectedPaths = git.git(ctx.root, ["diff", "--name-only", "--no-renames", "-z", node.base, node.head]).stdout
    .split("\0").filter(Boolean).sort();
  requireValue(digest([...new Set(provider.diffPaths(p.id))]) === digest(expectedPaths),
    `Provider diff paths differ from the own change: ${node.id}`);
  requireValue(p.draft || eligible(graph, node), `Blocked PR is not draft: ${node.id}`);
  return p;
}

function publish(ctx, graph, provider, plan, journal) {
  const active = topological(graph).filter((n) => !n.landing && !n.retired && (plan.action === "publish" || n.pr));
  for (const node of active) {
    if (node.pr && node.requiresDraft && !node.pr.draft) {
      step("Returning blocked PR to draft", () => {
        verifyFacts(ctx, plan, provider, journal);
        journal.providerStarted = true;
        journal.remoteStarted = true;
        saveJournal(ctx, journal);
        node.pr = provider.update(node.pr.id, { draft: true });
        requireValue(node.pr.draft, "Cannot publish blocked content until the PR is draft.");
        journal.prs[node.id] = node.pr;
        saveJournal(ctx, journal);
      }, nodeDetails(graph, node));
    }
  }
  verifyFacts(ctx, plan, provider, journal);
  push(ctx, graph, active.flatMap((n) => [
    ...(n.baseBranch !== graph.target ? [[n.baseBranch, n.base]] : []),
    [n.branch, n.head],
  ]), plan, journal);
  if (provider.kind === "local") return;
  for (const node of active) {
    step(node.pr ? "Updating and verifying PR" : "Creating or locating draft PR and verifying it", () => {
      verifyIntegration(ctx, plan, journal,
        git.remoteRefs(ctx.root, graph.repository.remote)[`refs/heads/${graph.target}`]);
      const body = updateFooter(node.pr?.body ?? node.description, footer(graph, node));
      const found = node.pr ?? provider.find(node.branch);
      if (found && !node.pr) {
        requireValue(found.body.includes(`Graph: \`${graph.id}\` / node: \`${node.id}\``),
          `Existing PR was not created by this graph: ${found.url}; adopt explicitly.`);
      }
      journal.remoteStarted = true;
      journal.providerStarted = true;
      saveJournal(ctx, journal);
      node.pr = found
        ? provider.update(found.id, { baseBranch: node.baseBranch, body, ...(node.requiresDraft ? { draft: true } : {}) })
        : provider.create(node, body);
      journal.prs[node.id] = node.pr;
      saveJournal(ctx, journal);
      node.pr = verifyPr(ctx, graph, node, provider);
      requireValue(node.pr.body === body, `PR description readback mismatch: ${node.id}`);
      requireValue(node.pr.draft === (node.requiresDraft ? true : found?.draft ?? true),
        `PR draft state readback mismatch: ${node.id}`);
      node.requiresDraft = false;
      journal.prs[node.id] = node.pr;
      saveJournal(ctx, journal);
    }, nodeDetails(graph, node));
  }
}

function backup(ctx, graph, plan, journal) {
  return step("Saving and publishing approved graph backup", () => {
    requireValue(graph.backup.enabled, "Backup is not enabled.");
    let sha = journal.backupCommit;
    if (!sha) {
      const parents = [...new Set([
        journal.remote[graph.backup.branch] ?? plan.facts.remote[graph.backup.branch],
        graph.targetSha,
        ...graph.nodes.flatMap((n) => [n.change.base, n.change.head, n.head, n.base, n.landing?.commit]),
        graph.combined,
        graph.source?.base, graph.source?.head,
      ].filter(Boolean))];
      const blob = git.out(ctx.root, ["hash-object", "-w", "--stdin"], `${JSON.stringify(graph)}\n`);
      const tree = git.out(ctx.root, ["mktree"], `100644 blob ${blob}\tgraph.json\n`);
      sha = git.out(ctx.root, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])],
        `pr-graph ${graph.id} snapshot revision ${graph.revision}\n`);
      git.pin(ctx.root, journal.id, "metadata", sha);
      journal.backupCommit = sha;
      saveJournal(ctx, journal);
    }
    push(ctx, graph, [[graph.backup.branch, sha]], plan, journal);
    graph.backup.head = sha;
  });
}

function readyChecks(ctx, graph, node, provider, target, action = "merge") {
  requireValue(eligible(graph, node), "All prerequisites must land before review/merge.");
  const freshness = snapshotFreshness(ctx, graph, target, node);
  requireValue((freshness.status === "current" || (action === "ready" && freshness.status === "grace")) &&
    (action !== "merge" || graph.targetSha === target) &&
    node.base === graph.targetSha && node.baseBranch === graph.target,
    "Sync onto the current integration branch before ready/merge.");
  requireValue(node.validation?.head === node.head && node.validation.commands === digest(node.validations),
    "Current node validation is missing or stale.");
  requireValue(node.validations.length || node.validationReason, "Approve validation configuration first.");
  if (provider.kind !== "local") {
    requireValue(node.pr, "Publish the node draft first.");
    node.pr = verifyPr(ctx, graph, node, provider);
  }
}

function mergeNode(ctx, graph, node, provider, plan, journal, cwd) {
  let verifiedAt;
  if (journal.mergeReceipt) {
    const receipt = journal.mergeReceipt;
    requireValue(receipt.source === node.head && receipt.target === graph.target, "Merge receipt differs from the approved node.");
    if (provider.kind === "local") {
      git.writeBranch(ctx.root, graph.target, receipt.commit, journal.local[graph.target] ?? plan.facts.local[graph.target]);
      journal.local[graph.target] = receipt.commit;
      saveJournal(ctx, journal);
      if (graph.repository.remote) push(ctx, graph, [[graph.target, receipt.commit]], plan, journal);
    } else {
      const current = provider.get(node.pr.id);
      requireValue(current.state === "merged" && current.landing === receipt.commit, "Merge receipt is not confirmed by the provider.");
      node.pr = current;
      journal.prs[node.id] = current;
      verifiedAt = fetchRemote(ctx, graph, journal);
      const actual = git.remoteRefs(ctx.root, graph.repository.remote)[`refs/heads/${graph.target}`];
      requireValue(git.ancestor(ctx.root, receipt.commit, actual), "Landing left the integration branch.");
      journal.remote[graph.target] = actual;
    }
    node.landing = receipt;
    graph.targetSha = journal.remote[graph.target] ?? journal.local[graph.target];
    graph.integration = { target: graph.target, sha: graph.targetSha, verifiedAt: verifiedAt ?? now(ctx) };
    saveJournal(ctx, journal);
    return;
  }
  readyChecks(ctx, graph, node, provider, plan.target);
  requireValue(provider.kind === "local" ? node.ready : !node.pr.draft, "Explicit ready is required before merge.");
  journal.remoteStarted = provider.kind !== "local";
  saveJournal(ctx, journal);
  let landing;
  if (provider.kind === "local") {
    requireValue(!git.occupied(ctx.root, graph.target), "Integration branch is checked out in another worktree.");
    git.checkoutClean(cwd, plan.target);
    if (plan.strategy === "merge") {
      git.out(cwd, ["merge", "--no-ff", "--no-edit", node.head]);
    } else if (plan.strategy === "squash") {
      git.out(cwd, ["merge", "--squash", node.head]);
      git.commitStaged(cwd, node.title);
    } else {
      git.out(cwd, ["checkout", "--detach", node.head]);
      git.out(cwd, ["rebase", "--onto", plan.target, node.base]);
    }
    landing = git.commitId(cwd, "HEAD");
    requireValue(git.tree(cwd, landing) === git.tree(cwd, node.head), "Local merge result differs from the validated node tree.");
    journal.mergeReceipt = { commit: landing, source: node.head, target: graph.target, strategy: plan.strategy };
    saveJournal(ctx, journal);
    git.writeBranch(ctx.root, graph.target, landing, plan.facts.local[graph.target]);
    journal.local[graph.target] = landing;
    saveJournal(ctx, journal);
    if (graph.repository.remote) push(ctx, graph, [[graph.target, landing]], plan, journal);
  } else {
    requireValue(provider.policies(node.pr.id).ok, "Provider policies/reviews/checks are not all satisfied.");
    const remote = git.remoteRefs(ctx.root, graph.repository.remote);
    requireValue(remote[`refs/heads/${graph.target}`] === plan.target, "Integration target changed before merge; replan.");
    journal.providerStarted = true;
    saveJournal(ctx, journal);
    const merged = provider.merge(node.pr.id, node.head, plan.strategy);
    requireValue(merged.state === "merged" && merged.baseBranch === graph.target, "Provider has not completed the intended merge.");
    node.pr = merged;
    journal.prs[node.id] = merged;
    landing = merged.landing;
    requireValue(landing, "Provider did not return a landing commit.");
    journal.mergeReceipt = { commit: landing, source: node.head, target: graph.target, strategy: plan.strategy };
    saveJournal(ctx, journal);
    verifiedAt = fetchRemote(ctx, graph, journal);
    const actual = git.remoteRefs(ctx.root, graph.repository.remote)[`refs/heads/${graph.target}`];
    requireValue(git.ancestor(ctx.root, landing, actual), "Landing is not in the integration branch.");
    journal.remote[graph.target] = actual;
  }
  node.landing = { commit: landing, source: node.head, target: graph.target, strategy: plan.strategy };
  graph.targetSha = journal.remote[graph.target] ?? journal.local[graph.target];
  graph.integration = { target: graph.target, sha: graph.targetSha, verifiedAt: verifiedAt ?? now(ctx) };
  saveJournal(ctx, journal);
}

function supersede(ctx, graph, provider, journal) {
  if (provider.kind === "local") return;
  for (const node of graph.nodes.filter((n) => n.pr?.state === "open" &&
    (n.retired || (n.requiresDraft && !n.pr.draft)))) {
    step("Updating superseded or blocked draft PR", () => {
      journal.remoteStarted = true;
      journal.providerStarted = true;
      saveJournal(ctx, journal);
      const current = provider.get(node.pr.id);
      node.pr = provider.update(node.pr.id, {
        draft: true, body: updateFooter(current.body, footer(graph, { ...node, baseBranch: current.baseBranch })),
      });
      journal.prs[node.id] = node.pr;
      saveJournal(ctx, journal);
    }, nodeDetails(graph, node));
  }
}

function refreshFooters(ctx, graph, provider, journal) {
  if (provider.kind === "local") return;
  for (const node of graph.nodes.filter((n) => n.pr)) {
    step("Refreshing and verifying managed PR footer", () => {
      const current = provider.get(node.pr.id);
      requireValue(current.branch === node.branch && current.head === node.pr.head &&
        current.baseBranch === node.pr.baseBranch && current.state === node.pr.state,
      `PR changed during footer refresh: ${node.id}`);
      const body = updateFooter(current.body, footer(graph, { ...node, baseBranch: current.baseBranch }));
      if (body !== current.body) {
        journal.remoteStarted = true;
        journal.providerStarted = true;
        saveJournal(ctx, journal);
        node.pr = provider.update(current.id, { body });
        requireValue(node.pr.body === body, `Footer readback mismatch: ${node.id}`);
      } else node.pr = current;
      journal.prs[node.id] = node.pr;
      saveJournal(ctx, journal);
    }, nodeDetails(graph, node));
  }
}

function graphPins(ctx, graph) {
  const commits = [...new Set([graph.targetSha, graph.combined, graph.source?.base, graph.source?.head,
    ...graph.nodes.flatMap((n) => [n.change.base, n.change.head, n.head, n.base, n.landing?.commit]),
  ].filter(Boolean))];
  for (const sha of commits) git.pin(ctx.root, "graphs", `${graph.id}/${sha}`, sha);
}

export function applyPlan(ctx, plan, approval, yes) {
  verifyApproval(plan, approval, yes);
  requireValue(plan.repository === ctx.root && plan.common === ctx.common, "Plan belongs to another checkout.");
  if (plan.action === "unlock") {
    const file = path.join(ctx.dir, "mutation.lock");
    const owner = state.readJson(file);
    requireValue(digest(owner) === digest(plan.owner), "Lock owner changed.");
    assertDeadOwner(owner);
    fs.unlinkSync(file);
    return { unlocked: owner };
  }
  return state.lock(ctx, () => {
    if (plan.action === "adopt") return step("Recovering approved external graph identities", () => applyAdoptionPlan(ctx, plan));
    if (plan.action === "checkpoint") return step("Preserving approved staged work on checkpoint branch", () => applyCheckpointPlan(ctx, plan));
    if (plan.action === "remove-retired") return step("Removing approved retired-node metadata", () => applyRetiredRemovalPlan(ctx, plan));
    if (["resolve", "abort", "cleanup", "reconcile"].includes(plan.action)) {
      return step(`Recovering operation: ${plan.action}`, () => applyRecovery(ctx, plan));
    }
    if (plan.action === "fetch-backup") {
      const remote = git.remoteConfig(ctx.root, plan.remote.name);
      requireValue(remote.url === plan.remote.url, "Backup remote changed.");
      requireValue(git.remoteRefs(ctx.root, remote.name)[`refs/heads/${plan.branch}`] === plan.sha, "Backup advanced; replan.");
      const ref = `refs/pr-graph/downloads/${plan.graphId}`;
      git.out(ctx.root, ["fetch", "--no-tags", "--no-write-fetch-head", "--", remote.name, `${plan.sha}:${ref}`]);
      return { downloaded: plan.sha, ref, next: "Inspect and plan restore --backup-ref <sha>." };
    }
    const file = state.journalFile(ctx, plan.approval);
    let journal = state.readJson(file, true);
    requireValue(!journal || journal.id === plan.approval, "Operation journal identity mismatch.");
    if (journal?.finalizing && state.load(ctx, plan.graph.id, true)?.lastOperation === journal.id) {
      requireValue(digest(state.load(ctx, plan.graph.id)) === digest(journal.candidate),
        "Final state differs from the journal; reconcile explicitly.");
      journal.status = "done";
      saveJournal(ctx, journal);
    }
    if (journal?.status === "done") {
      requireValue(state.load(ctx, plan.graph.id).lastOperation === journal.id, "Completed operation is no longer current.");
      const graph = state.load(ctx, plan.graph.id);
      return { graph, operation: journal.id, alreadyDone: true,
        freshness: freshnessReport(ctx, graph, observe(ctx, graph, getProvider(ctx, graph))) };
    }
    requireValue(!journal || !["aborted", "superseded"].includes(journal.status), "Operation was aborted or superseded.");
    const other = state.journals(ctx).filter((j) => j.id !== plan.approval && j.status === "running");
    requireValue(!other.length, `Interrupted operation ${other[0]?.id} must be continued or explicitly aborted first.`);
    journal ??= {
      id: plan.approval, plan, status: "running", local: {}, remote: {}, prs: {},
      commits: {}, pendingChange: null, remoteStarted: false,
    };
    for (const key of ["local", "remote", "prs", "commits"]) Object.setPrototypeOf(journal[key], null);
    saveJournal(ctx, journal);
    try {
      if (plan.action === "restore") return applyRestore(ctx, plan, journal);
      const graph = structuredClone(journal.candidate ?? plan.graph);
      const provider = getProvider(ctx, graph);
      const configured = git.remoteConfig(ctx.root, graph.repository.remote);
      requireValue(configured.url === graph.repository.url, "Remote URL changed after planning.");
      const facts = verifyFacts(ctx, plan, provider, journal);
      requireValue(!journal.pendingChange || journal.commits[journal.pendingChange.key],
        `Operation has a pending change in ${journal.pendingChange?.worktree}; inspect it and approve resolve, or abort.`);
      for (const sha of [...new Set([
        ...Object.values(plan.facts.local), ...graph.nodes.flatMap((n) => [n.change.base, n.change.head]),
      ].filter(Boolean))]) git.pin(ctx.root, journal.id, `original/${sha}`, sha);
      fetchRemote(ctx, graph, journal);
      verifyFacts(ctx, plan, provider, journal);
      const target = git.commitId(ctx.root, plan.target);
      const previous = state.load(ctx, graph.id, true);
      reconcile(ctx, graph, facts, target, SHAPE.has(plan.action) ? previous : null);
      const cwd = prepareWorktree(ctx, journal, target);
      const apply = (dir, change, title) => applyOwned(ctx, journal, dir, change, title);
      if (plan.action === "record-landing") {
        const node = nodeById(graph, plan.node);
        requireValue(!node.landing && eligible(graph, node), "Node is already landed or its prerequisites have not landed.");
        const parent = git.commitId(ctx.root, `${plan.landing}^1`);
        git.checkoutClean(cwd, parent);
        const reproduced = apply(cwd, node.change, node.title);
        requireValue(git.tree(cwd, reproduced) === git.tree(cwd, plan.landing),
          "Recorded landing contains a different change; refuse the mapping.");
        node.landing = { commit: plan.landing, source: node.head, target: graph.target, strategy: `recorded-${plan.strategy}` };
        graph.targetSha = target;
        graph.integration = graph.integration?.sha === target
          ? graph.integration : { target: graph.target, sha: target, verifiedAt: now(ctx) };
        graph.combined = verifyComposition(cwd, graph, target, null, apply);
      }
      if (SHAPE.has(plan.action) || ["sync", "publish", "retarget"].includes(plan.action)) {
        if (["deps", "split-node", "fold", "retarget"].includes(plan.action)) {
          journal.beforeCombined ??= verifyComposition(cwd, previous, target, null, apply);
          saveJournal(ctx, journal);
        }
        realize(cwd, graph, target, previous, (node) => {
          git.pin(ctx.root, journal.id, `nodes/${node.id}`, node.head);
        }, apply);
        graph.combined = verifyComposition(cwd, graph, target,
          plan.source?.head ?? journal.beforeCombined, apply);
        graph.targetSha = target;
        validateNodes(ctx, graph, journal, cwd);
        journal.candidate = graph;
        saveJournal(ctx, journal);
        verifyFacts(ctx, plan, provider, journal);
        writeLocal(ctx, graph, plan, journal);
      }
      if (["sync", "publish", "retarget"].includes(plan.action)) publish(ctx, graph, provider, plan, journal);
      if (plan.action === "ready") {
        const node = nodeById(graph, plan.node);
        step("Checking eligibility and marking ready", () => {
          const current = verifyFacts(ctx, plan, provider, journal);
          readyChecks(ctx, graph, node, provider,
            graph.repository.remote ? current.remote[graph.target] : current.local[graph.target], "ready");
          verifyFacts(ctx, plan, provider, journal);
          if (provider.kind !== "local") {
            journal.remoteStarted = true;
            journal.providerStarted = true;
            saveJournal(ctx, journal);
            node.pr = provider.update(node.pr.id, { draft: false });
            requireValue(!node.pr.draft, "Provider did not promote the draft.");
            journal.prs[node.id] = node.pr;
          }
          node.ready = true;
        }, nodeDetails(graph, node));
      }
      if (plan.action === "merge") {
        const node = nodeById(graph, plan.node);
        step("Merging and verifying landing", () => mergeNode(ctx, graph, node, provider, plan, journal, cwd),
          nodeDetails(graph, node));
      }
      if (plan.action === "describe") {
        for (const [id, description] of Object.entries(plan.descriptions ?? { [plan.node]: plan.description })) {
          const node = nodeById(graph, id);
          step("Updating and verifying PR description", () => {
            requireValue(node.pr && provider.kind !== "local", "Describe requires a hosted PR.");
            const current = provider.get(node.pr.id);
            const expected = journal.prs[id] ?? plan.facts.prs[id];
            requireValue(["body", "head", "branch", "baseBranch", "draft", "state"].every((key) =>
              current[key] === expected[key]), `PR changed before description replacement: ${id}`);
            journal.remoteStarted = true;
            journal.providerStarted = true;
            saveJournal(ctx, journal);
            const body = updateFooter(description, footer(graph, node));
            node.pr = provider.update(node.pr.id, { body });
            requireValue(node.pr.body === body, "Description update mismatch.");
            node.description = description;
            journal.prs[node.id] = node.pr;
            saveJournal(ctx, journal);
          }, nodeDetails(graph, node));
        }
      }
      if (SHAPE.has(plan.action)) supersede(ctx, graph, provider, journal);
      if (["publish", "sync", "retarget", "ready", "merge"].includes(plan.action)) {
        refreshFooters(ctx, graph, provider, journal);
      }
      const freshness = freshnessReport(ctx, graph, observe(ctx, graph, provider));
      graph.revision = plan.graph.revision + 1;
      graph.lastOperation = journal.id;
      journal.candidate = graph;
      saveJournal(ctx, journal);
      graphPins(ctx, graph);
      if (graph.backup.enabled && ["publish", "sync", "retarget", "backup", "merge", "ready", "describe"].includes(plan.action)) {
        backup(ctx, graph, plan, journal);
      }
      journal.candidate = graph;
      journal.finalizing = true;
      saveJournal(ctx, journal);
      step("Persisting graph state and recovery journal", () => {
        state.save(ctx, graph);
        journal.candidate = graph;
        journal.status = "done";
        journal.error = null;
        saveJournal(ctx, journal);
      });
      return { graph, operation: journal.id, freshness,
        eligible: graph.nodes.filter((n) => eligible(graph, n)).map((n) => n.id),
        worktree: cwd, cleanup: "Retained; cleanup requires its own approved plan." };
    } catch (error) {
      journal.error = error.message;
      saveJournal(ctx, journal);
      throw new Error(`${error.message}\nOperation: ${journal.id}. State retained; inspect status before resume/abort.`);
    }
  });
}

function applyRestore(ctx, plan, journal) {
  requireValue(!state.load(ctx, plan.graph.id, true), "Graph already exists.");
  const graph = structuredClone(plan.graph);
  const cwd = git.createWorktree(ctx, journal.id, graph.targetSha);
  const apply = (dir, change, title) => applyOwned(ctx, journal, dir, change, title);
  for (const node of graph.nodes) {
    step("Verifying restored own-change snapshot", () => {
      if (node.landing) {
        requireValue(node.landing.target === graph.target &&
          git.ancestor(ctx.root, node.landing.commit, graph.targetSha), "Backup contains an invalid landing receipt.");
      }
      if (node.head && node.base) {
        git.checkoutClean(cwd, node.base);
        const reproduced = apply(cwd, node.change, node.title);
        requireValue(git.tree(cwd, reproduced) === git.tree(cwd, node.head),
          `Backup own-change snapshot mismatch: ${node.id}`);
      }
    }, nodeDetails(graph, node));
  }
  realize(cwd, structuredClone(graph), graph.targetSha, null, (node) => {
    const saved = graph.nodes.find((n) => n.id === node.id);
    if (saved.signature === node.signature) {
      requireValue(git.tree(cwd, saved.base) === git.tree(cwd, node.base) &&
        git.tree(cwd, saved.head) === git.tree(cwd, node.head),
      `Backup prerequisite closure mismatch: ${node.id}`);
    }
  }, apply);
  verifyComposition(cwd, graph, graph.targetSha, graph.combined, apply);
  for (const node of graph.nodes) {
    if (!node.head) continue;
    step("Restoring local branch", () => {
      requireValue(git.refId(ctx.root, `refs/heads/${node.branch}`) === (journal.local[node.branch] ?? plan.expectedLocal[node.branch]), "Restore branch changed.");
      requireValue(!plan.expectedLocal[node.branch] || plan.expectedLocal[node.branch] === node.head,
        `Restore would overwrite ${node.branch}.`);
      git.writeBranch(ctx.root, node.branch, node.head, journal.local[node.branch] ?? plan.expectedLocal[node.branch]);
      journal.local[node.branch] = node.head;
      saveJournal(ctx, journal);
    }, nodeDetails(graph, node));
  }
  graphPins(ctx, graph);
  graph.lastOperation = journal.id;
  journal.candidate = graph;
  journal.finalizing = true;
  saveJournal(ctx, journal);
  state.save(ctx, graph);
  journal.status = "done";
  saveJournal(ctx, journal);
  return { graph, operation: journal.id,
    freshness: freshnessReport(ctx, graph, observe(ctx, graph, getProvider(ctx, graph))),
    warning: "Validation commands cleared. Configure checks, sync, and explicitly ready before review/merge." };
}

function retainedPublication(ctx, journal, graph) {
  requireValue(journal.plan.action === "publish" && journal.status === "running" &&
    !journal.providerStarted && !Object.keys(journal.prs).length && !journal.pendingChange,
  "Retaining published refs requires a push-only interrupted publication with no provider writes or pending patch.");
  requireValue(graph && digest(graph) === journal.plan.previousDigest,
    "Persisted graph changed; cannot retain publication refs.");
  const candidate = journal.candidate ?? journal.plan.graph;
  requireValue(candidate.nodes.every((n) => !n.pr), "Retained-ref recovery is only supported before any PR exists.");
  const provider = getProvider(ctx, candidate);
  const current = observe(ctx, candidate, provider);
  requireValue(digest(current.local) === digest(journal.plan.facts.local),
    "Publication changed local refs; retained-ref abort cannot restore them implicitly.");
  const allowed = new Map(candidate.nodes.flatMap((n) => [
    [n.branch, n.head], ...(n.baseBranch !== candidate.target ? [[n.baseBranch, n.base]] : []),
  ]));
  for (const [branch, actual] of Object.entries(current.remote)) {
    requireValue(actual === journal.plan.facts.remote[branch] ||
      (allowed.has(branch) && actual === allowed.get(branch)),
    `Unexpected remote ref change: ${branch}; cannot retain publication automatically.`);
  }
  for (const node of candidate.nodes) {
    requireValue(!provider.find(node.branch), `A PR exists for ${node.id}; retained-ref abort is unsafe.`);
  }
  return current;
}

function recoveryPlan(ctx, action, options) {
  requireValue(!options.retainPublishedRefs || action === "abort", "--retain-published-refs is only valid for abort.");
  const journal = state.readJson(state.journalFile(ctx, options.operation));
  requireValue(journal.id === options.operation, "Operation journal identity mismatch.");
  requireValue(!journal.worktreeReusedBy,
    `Operation worktree was transferred to ${journal.worktreeReusedBy}; recover or clean its latest owner instead.`);
  const graph = state.load(ctx, journal.plan.graph?.id ?? options.graph, true);
  const cwd = worktreePath(ctx, journal);
  if (action === "reconcile") {
    requireValue(journal.status === "running", "Only running operations can be reconciled.");
    const candidate = journal.candidate ?? journal.plan.graph;
    const provider = getProvider(ctx, candidate);
    const current = observe(ctx, candidate, provider);
    const discovered = {};
    for (const node of candidate.nodes) {
      if (!node.pr && provider.kind !== "local") {
        const found = provider.find(node.branch);
        if (found) discovered[node.id] = found;
      }
    }
    return seal({ version: VERSION, action, repository: ctx.root, common: ctx.common,
      operation: journal.id, journalDigest: digest(journal), current, discovered,
      freshness: freshnessReport(ctx, candidate, current),
      ...(permitsForwardTarget(ctx, journal.plan) ? { forwardTarget: candidate.target } : {}),
      effects: ["Accept only observable effects consistent with the original approved candidate; preserve newly observed human PR text. No content or dependency changes are authorized.",
        ...(permitsForwardTarget(ctx, journal.plan) ? [
          "Allow subsequent remote integration fast-forwards only; keep the approved local observation fixed and require it to remain on the remote integration history.",
          "An integration-target PR's preview base may advance only with that history and preserve its authored merge base; all other PR facts remain exact.",
        ] : []),
        { previous: journal.plan.facts, observed: current, discovered }] });
  }
  if (action === "resolve") {
    requireValue(journal.status === "running" && journal.pendingChange, "No pending change to resolve.");
    requireWorktreeOwner(ctx, journal);
    requireValue(journal.pendingChange.worktree === cwd, "Unexpected operation worktree path.");
    requireValue(!git.out(cwd, ["diff", "--name-only", "--diff-filter=U"]), "Unmerged index entries remain.");
    requireValue(git.git(cwd, ["diff", "--quiet"], undefined, true).status === 0, "Stage the approved resolution; unstaged changes remain.");
    requireValue(!git.out(cwd, ["ls-files", "--others", "--exclude-standard"]), "Untracked operation files require explicit handling.");
    const patch = git.git(cwd, ["diff", "--cached", "--binary", "--full-index"]).stdout;
    requireValue(patch.trim(), "No staged resolution.");
    return seal({ version: VERSION, action, repository: ctx.root, common: ctx.common,
      operation: journal.id, journalDigest: digest(journal),
      head: git.commitId(cwd, "HEAD"), patch,
      effects: [{ commitResolution: patch }, "Record the approved resolution; then resume the original approved operation."] });
  }
  if (action === "abort") {
    requireValue(journal.status === "running", "Operation is not running.");
    if (options.retainPublishedRefs) {
      const retained = retainedPublication(ctx, journal, graph);
      return seal({ version: VERSION, action, repository: ctx.root, common: ctx.common,
        operation: journal.id, journalDigest: digest(journal), retainedPublication: retained,
        effects: [
          "Stop this publication while retaining the exact observed candidate refs, all local branches, snapshots, and worktree. No Git ref writes, deletion, PR changes, or graph-state adoption.",
          { retainedRemoteRefs: Object.fromEntries(Object.entries(retained.remote)
            .filter(([branch, sha]) => sha !== journal.plan.facts.remote[branch])) },
          "A separate approved graph plan and publication are required to resume with different helper names.",
        ] });
    }
    let remoteOriginal = null;
    if (journal.remoteStarted) {
      requireValue(!journal.providerStarted, "Provider effects may exist. Inspect and use a compensating plan; automatic abort is unsafe.");
      const candidate = journal.candidate ?? journal.plan.graph;
      const remote = git.remoteRefs(ctx.root, candidate.repository.remote);
      remoteOriginal = Object.fromEntries(graphRefs(candidate).map((b) => [b, remote[`refs/heads/${b}`] ?? null]));
      requireValue(digest(remoteOriginal) === digest(journal.plan.facts.remote),
        "Remote refs changed. Reconcile or compensate; automatic rollback is unsafe.");
    }
    return seal({ version: VERSION, action, repository: ctx.root, common: ctx.common,
      operation: journal.id, journalDigest: digest(journal),
      remoteOriginal,
      effects: ["Restore changed pre-existing local refs if still unoccupied and unchanged; retain new refs, snapshots, and worktree for separate cleanup."] });
  }
  requireValue(["done", "aborted"].includes(journal.status), "Cannot clean an unfinished operation.");
  requireValue(options.spec && Array.isArray(options.spec.branches), "Cleanup requires spec.branches (possibly empty) and spec.worktree.");
  if (options.spec.worktree) requireWorktreeOwner(ctx, journal);
  const branches = options.spec.branches;
  const remoteBranches = options.spec.remoteBranches ?? [];
  const closeRetired = options.spec.closeRetired ?? [];
  requireValue(Array.isArray(remoteBranches) && Array.isArray(closeRetired), "Invalid cleanup lists.");
  for (const branch of [...branches, ...remoteBranches]) {
    git.checkBranch(ctx.root, branch);
    const retired = graph?.nodes.some((n) => n.retired && n.branch === branch);
    const obsolete = graph?.nodes.some((n) =>
      branch === helperBranch(graph, n.id) && (n.retired || n.baseBranch === graph.target || n.landing));
    requireValue(retired || obsolete, `Not an obsolete tool-owned graph branch: ${branch}`);
    requireValue(!git.occupied(ctx.root, branch), `Branch is occupied: ${branch}`);
  }
  const remote = git.remoteRefs(ctx.root, graph?.repository.remote);
  const provider = graph ? getProvider(ctx, graph) : null;
  const prs = {};
  for (const id of closeRetired) {
    const node = graph?.nodes.find((n) => n.id === id && n.retired && n.pr);
    requireValue(node && provider.kind !== "local", `Not a superseded hosted node: ${id}`);
    prs[id] = provider.get(node.pr.id);
    requireValue(prs[id].state !== "merged", "Never close a merged PR.");
  }
  return seal({ version: VERSION, action, repository: ctx.root, common: ctx.common,
    operation: journal.id, journalDigest: digest(journal),
    branches: Object.fromEntries(branches.map((b) => [b, git.refId(ctx.root, `refs/heads/${b}`)])),
    remoteBranches: Object.fromEntries(remoteBranches.map((b) => [b, remote[`refs/heads/${b}`] ?? null])),
    closeRetired: prs, graphId: graph?.id ?? null,
    worktree: options.spec.worktree === true && fs.existsSync(cwd),
    effects: [...branches.map((b) => `Delete local obsolete branch ${b}; remote branches/PRs remain untouched.`),
      ...remoteBranches.map((b) => `Delete remote obsolete branch ${graph.repository.remote}/${b}, guarded by its exact observed SHA.`),
      ...Object.values(prs).map((p) => `Close/abandon superseded PR ${p.url}; do not merge it.`),
      ...(options.spec.worktree ? [`Remove clean tool-owned worktree ${cwd}; never force removal.`] : [])] });
}

function applyRecovery(ctx, plan) {
  const journal = state.readJson(state.journalFile(ctx, plan.operation));
  requireValue(digest(journal) === plan.journalDigest, "Operation changed after recovery approval.");
  const cwd = worktreePath(ctx, journal);
  if (plan.action === "reconcile") {
    const candidate = structuredClone(journal.candidate ?? journal.plan.graph);
    const provider = getProvider(ctx, candidate);
    const current = observe(ctx, candidate, provider);
    const comparison = structuredClone(current);
    if (permitsForwardTarget(ctx, journal.plan) && plan.forwardTarget === candidate.target) {
      forwardTarget(ctx, candidate, journal, plan.current.remote[candidate.target], current.remote[candidate.target]);
      comparison.remote[candidate.target] = plan.current.remote[candidate.target];
      for (const [id, before] of Object.entries(plan.current.prs)) {
        if (samePrFacts(ctx, candidate, journal, before, current.prs[id], current.remote[candidate.target])) {
          comparison.prs[id] = before;
        }
      }
    }
    requireValue(digest(comparison) === digest(plan.current), "Observed state changed after reconciliation approval.");
    const observedPrs = { ...current.prs, ...plan.discovered };
    if (journal.plan.action === "merge") {
      const node = nodeById(candidate, journal.plan.node);
      const actual = observedPrs[node.id];
      if (actual?.state === "merged") {
        requireValue(eligible(candidate, node) && actual.branch === node.branch &&
          actual.head === node.head && actual.baseBranch === candidate.target && actual.landing,
        "Unexpected external merge cannot be reconciled.");
        journal.mergeReceipt = { commit: actual.landing, source: node.head, target: candidate.target, strategy: journal.plan.strategy };
      }
    }
    const allowed = new Map(candidate.nodes.flatMap((n) => [
      [n.branch, n.head], ...(n.baseBranch && n.baseBranch !== candidate.target ? [[n.baseBranch, n.base]] : []),
    ]));
    if (journal.mergeReceipt) allowed.set(candidate.target, journal.mergeReceipt.commit);
    if (journal.backupCommit) allowed.set(candidate.backup.branch, journal.backupCommit);
    for (const side of ["local", "remote"]) {
      for (const [branch, actual] of Object.entries(current[side])) {
        const expected = journal[side][branch] ??
          (side === "local" ? journal.observedLocal?.[branch] : null) ?? journal.plan.facts[side][branch] ?? null;
        if (actual === expected) continue;
        if (permitsForwardTarget(ctx, journal.plan) && branch === candidate.target &&
          (side === "remote" || (actual && current.remote[branch] &&
            git.ancestor(ctx.root, actual, current.remote[branch])))) {
          forwardTarget(ctx, candidate, journal, expected, actual);
          if (side === "local") {
            journal.observedLocal ??= {};
            Object.setPrototypeOf(journal.observedLocal, null);
            journal.observedLocal[branch] = actual;
          } else journal.remote[branch] = actual;
          continue;
        }
        requireValue(actual === allowed.get(branch),
          `Unexpected ${side} ref change: ${branch}; cannot adopt content automatically.`);
        journal[side][branch] = actual;
      }
    }
    for (const [id, actual] of Object.entries(observedPrs)) {
      const node = nodeById(candidate, id);
      const baseline = journal.prs[id] ?? journal.plan.facts.prs[id];
      if (journal.plan.action === "describe" && baseline) {
        requireValue(samePrFacts(ctx, candidate, journal, baseline, actual, current.remote[candidate.target]),
          `Description inputs changed for ${id}; abort and replan without discarding human edits.`);
      }
      if (baseline && digest(baseline) === digest(actual)) continue;
      if (journal.plan.action === "merge" && id === journal.plan.node && actual.state === "merged" &&
        actual.landing === journal.mergeReceipt?.commit) {
        node.pr = actual;
        journal.prs[id] = actual;
        continue;
      }
      requireValue(actual.state === "open" && actual.head === node.head && actual.branch === node.branch &&
        [node.baseBranch, baseline?.baseBranch].includes(actual.baseBranch),
      `Unexpected PR content/landing for ${id}; manual compensation required.`);
      if (!baseline) {
        requireValue(actual.body.includes(`Graph: \`${candidate.id}\` / node: \`${node.id}\``),
          "Discovered PR lacks this graph's identity.");
      }
      journal.prs[id] = actual;
      node.pr = actual;
    }
    journal.candidate = candidate;
    journal.error = null;
    saveJournal(ctx, journal);
    return { reconciled: journal.id, next: "Continue the original approved operation." };
  }
  if (plan.action === "resolve") {
    requireWorktreeOwner(ctx, journal);
    requireValue(git.commitId(cwd, "HEAD") === plan.head &&
      git.git(cwd, ["diff", "--cached", "--binary", "--full-index"]).stdout === plan.patch,
    "Resolution changed after approval.");
    const sha = git.commitStaged(cwd, journal.pendingChange.title);
    git.pin(ctx.root, journal.id, `commits/${journal.pendingChange.key}`, sha);
    journal.commits[journal.pendingChange.key] = sha;
    journal.pendingChange = null;
    saveJournal(ctx, journal);
    return { resolved: sha, resume: journal.id };
  }
  if (plan.action === "abort") {
    if (plan.retainedPublication) {
      const graph = state.load(ctx, journal.plan.graph.id);
      requireValue(digest(retainedPublication(ctx, journal, graph)) === digest(plan.retainedPublication),
        "Publication state changed after retained-ref abort approval.");
      journal.status = "aborted";
      journal.retainedPublication = plan.retainedPublication;
      journal.error = null;
      saveJournal(ctx, journal);
      return { aborted: journal.id, retained: cwd, retainedPublication: plan.retainedPublication };
    }
    if (plan.remoteOriginal) {
      const candidate = journal.candidate ?? journal.plan.graph;
      const remote = git.remoteRefs(ctx.root, candidate.repository.remote);
      const actual = Object.fromEntries(graphRefs(candidate).map((b) => [b, remote[`refs/heads/${b}`] ?? null]));
      requireValue(digest(actual) === digest(plan.remoteOriginal), "Remote changed after abort approval.");
    }
    for (const [branch, candidate] of Object.entries(journal.local)) {
      const original = journal.plan.facts.local[branch];
      if (original) git.writeBranch(ctx.root, branch, original, candidate);
    }
    journal.status = "aborted";
    saveJournal(ctx, journal);
    return { aborted: journal.id, retained: cwd };
  }
  if (plan.worktree) requireWorktreeOwner(ctx, journal);
  for (const [branch, expected] of Object.entries(plan.branches)) {
    requireValue(!git.occupied(ctx.root, branch), `Branch became occupied: ${branch}`);
    requireValue(git.refId(ctx.root, `refs/heads/${branch}`) === expected, `Cleanup branch changed: ${branch}`);
    if (expected) git.out(ctx.root, ["update-ref", "-d", `refs/heads/${branch}`, expected]);
  }
  if (Object.keys(plan.remoteBranches).length || Object.keys(plan.closeRetired).length) {
    const graph = state.load(ctx, plan.graphId);
    const provider = getProvider(ctx, graph);
    for (const [id, expected] of Object.entries(plan.closeRetired)) {
      const node = graph.nodes.find((n) => n.id === id && n.retired);
      const current = provider.get(expected.id);
      requireValue(digest(current) === digest(expected), "PR changed before cleanup.");
      node.pr = provider.update(expected.id, { state: "closed" });
      requireValue(node.pr.state === "closed", "PR was not closed.");
    }
    const current = git.remoteRefs(ctx.root, graph.repository.remote);
    for (const [branch, expected] of Object.entries(plan.remoteBranches)) {
      requireValue((current[`refs/heads/${branch}`] ?? null) === expected, "Remote cleanup ref changed.");
      if (expected) {
        git.out(ctx.root, ["push", `--force-with-lease=refs/heads/${branch}:${expected}`, "--",
          graph.repository.remote, `:refs/heads/${branch}`]);
        requireValue(!git.remoteRefs(ctx.root, graph.repository.remote)[`refs/heads/${branch}`], "Remote branch was not deleted.");
      }
    }
    state.save(ctx, graph);
  }
  if (plan.worktree) {
    requireValue(git.out(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) === ctx.common,
      "Cleanup worktree identity mismatch.");
    git.out(ctx.root, ["worktree", "remove", cwd]);
  }
  return { cleaned: plan.effects };
}

export function inspect(ctx, id) {
  const graph = state.load(ctx, id, true);
  return {
    graph,
    freshness: graph ? freshnessReport(ctx, graph, observe(ctx, graph, getProvider(ctx, graph))) : {},
    eligible: graph?.nodes.filter((n) => eligible(graph, n)).map((n) => n.id) ?? [],
    operations: state.journals(ctx).filter((j) => j.plan.graph?.id === id).map((j) => ({
      id: j.id, status: j.status, error: j.error, pending: j.pendingChange,
      worktree: worktreePath(ctx, j),
      ...(j.worktreeReusedBy ? { worktreeReusedBy: j.worktreeReusedBy } : {}),
      ...(j.status === "running" ? {
        freshness: freshnessReport(ctx, j.candidate ?? j.plan.graph,
          observe(ctx, j.candidate ?? j.plan.graph, getProvider(ctx, j.candidate ?? j.plan.graph))),
      } : {}),
    })),
    uncommitted: Boolean(git.out(ctx.root, ["status", "--porcelain", "--untracked-files=all"])),
    backup: graph?.backup ?? null,
  };
}

function assertDeadOwner(owner) {
  requireValue(owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0,
    "Cannot establish owner liveness across hosts; do not break this lock automatically.");
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    requireValue(error.code === "ESRCH", "Lock owner liveness is unknown.");
    return;
  }
  throw new Error("Lock owner is still alive; do not unlock.");
}
