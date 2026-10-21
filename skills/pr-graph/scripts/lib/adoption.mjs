import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { digest, requireValue, topological, eligible, helperBranch, validateGraph } from "./graph.mjs";
import { normalizeChange } from "./changes.mjs";
import { providerFor } from "./providers/index.mjs";

const provider = (ctx, graph) => ctx.providerFactory?.(graph.repository.provider) ??
  providerFor(graph.repository.provider, ctx.root);

function commit(ctx, value) {
  requireValue(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? ""),
    "Adoption requires immutable full commit IDs.");
  requireValue(git.commitId(ctx.root, value) === value, "Commit identity mismatch.");
  return value;
}

function observations(ctx, graph, previous = graph) {
  const configured = git.remoteConfig(ctx.root, graph.repository.remote);
  requireValue(configured.url === graph.repository.url, "Graph remote URL changed.");
  const remote = git.remoteRefs(ctx.root, configured.name);
  const p = provider(ctx, graph);
  requireValue(p.kind !== "local", "Adoption requires authoritative hosted PR receipts.");
  const branches = [...new Set([graph.target, ...[graph, previous].flatMap((g) =>
    g.nodes.flatMap((n) => [n.branch, n.baseBranch, helperBranch(g, n.id)]))
  ].filter(Boolean))].sort();
  return {
    local: Object.fromEntries(branches.map((b) => [b, git.refId(ctx.root, `refs/heads/${b}`)])),
    remote: Object.fromEntries(branches.map((b) => [b, remote[`refs/heads/${b}`] ?? null])),
    prs: Object.fromEntries(graph.nodes.filter((n) => n.pr).map((n) => [n.id, p.get(n.pr.id)])),
  };
}

function noPending(ctx, operation) {
  const pending = state.journals(ctx).find((j) => j.status === "running" && j.id !== operation);
  requireValue(!pending, `Interrupted operation ${pending?.id} must be recovered first.`);
}

function stablePr(pr, target) {
  // A moving target changes preview base metadata, not the approved authored delta.
  if (pr.baseBranch !== target) return pr;
  const { base, ...stable } = pr;
  return stable;
}

export function createAdoptionPlan(ctx, options) {
  noPending(ctx);
  const previous = state.load(ctx, options.graph);
  const spec = options.spec;
  requireValue(spec?.id === previous.id && Array.isArray(spec.nodes),
    "Adoption requires this graph's ID and a complete node list.");
  requireValue(spec.nodes.length === previous.nodes.length &&
    new Set(spec.nodes.map((n) => n.id)).size === previous.nodes.length &&
    spec.nodes.every((n) => previous.nodes.some((old) => old.id === n.id)),
  "Adoption cannot add, remove, or duplicate nodes.");
  const graph = structuredClone(previous);
  if (spec.helperBranchPrefix !== undefined) {
    git.checkBranch(ctx.root, `${spec.helperBranchPrefix}/probe`);
    graph.helperBranchPrefix = spec.helperBranchPrefix;
  }
  const target = commit(ctx, spec.targetSnapshot);
  requireValue(git.ancestor(ctx.root, previous.targetSha, target),
    "Adoption target snapshot must descend from the previous snapshot.");
  const facts = observations(ctx, graph, previous);
  requireValue(facts.remote[graph.target], "Integration branch is missing.");
  const updates = [];
  for (const node of topological(graph)) {
    const input = spec.nodes.find((n) => n.id === node.id);
    const pr = facts.prs[node.id];
    requireValue(pr && pr.id === node.pr.id && pr.branch === node.branch,
      `PR identity mismatch: ${node.id}`);
    if (node.retired) {
      requireValue(input.head === node.head && input.base === node.base &&
        input.baseBranch === node.baseBranch, `Retired snapshot is immutable: ${node.id}`);
      continue;
    }
    requireValue(pr.head === input.head && pr.baseBranch === input.baseBranch,
      `Live PR does not match approved adoption inputs: ${node.id}`);
    if (pr.state === "merged") {
      requireValue(input.landing === pr.landing && pr.landing &&
        pr.baseBranch === graph.target && (node.landing || eligible(graph, node)),
      `Unexpected source or landing order: ${node.id}`);
      requireValue(git.ancestor(ctx.root, commit(ctx, pr.landing), target),
      `Landing is not on the pinned integration snapshot: ${node.id}`);
      requireValue(!node.landing || (node.landing.commit === pr.landing &&
        node.head === input.head && node.base === input.base && node.baseBranch === input.baseBranch),
        `Existing landing changed: ${node.id}`);
      if (!node.landing) {
        node.head = commit(ctx, input.head);
        node.base = commit(ctx, input.base);
        node.baseBranch = input.baseBranch;
        requireValue(git.out(ctx.root, ["merge-base", node.head, `${pr.landing}^1`]) === node.base,
          `Merged own-change base differs from the landing's target parent: ${node.id}`);
        node.change = normalizeChange(ctx.root, { base: node.base, head: node.head });
        node.landing = { commit: pr.landing, source: pr.head, target: graph.target, strategy: "provider" };
      }
    } else {
      requireValue(pr.state === "open" && !node.landing && !input.landing,
        `Closed or previously landed PR cannot be adopted as open: ${node.id}`);
      node.head = commit(ctx, input.head);
      node.base = commit(ctx, input.base);
      node.baseBranch = input.baseBranch;
      requireValue(facts.remote[node.branch] === node.head,
        `Remote product branch differs from PR head: ${node.id}`);
      const base = node.baseBranch === graph.target ? target : facts.remote[node.baseBranch];
      requireValue(base && git.out(ctx.root, ["merge-base", node.head, base]) === node.base,
        `Own-change base differs from the live prerequisite base: ${node.id}`);
      requireValue(node.baseBranch === graph.target || node.baseBranch === helperBranch(graph, node.id),
        `PR targets an unapproved helper branch: ${node.id}`);
      requireValue(node.baseBranch !== graph.target || eligible(graph, node),
        `Unlanded prerequisites cannot target integration: ${node.id}`);
      node.change = normalizeChange(ctx.root, { base: node.base, head: node.head });
      if (node.baseBranch !== graph.target && facts.local[node.baseBranch] !== node.base) {
        requireValue(!git.occupied(ctx.root, node.baseBranch), `Branch is checked out: ${node.baseBranch}`);
        updates.push({ branch: node.baseBranch, expected: facts.local[node.baseBranch], head: node.base });
      }
      node.integration = { target: graph.target,
        sha: git.out(ctx.root, ["merge-base", node.base, target]) };
    }
    const expected = facts.local[node.branch];
    if (expected !== node.head) {
      requireValue(!git.occupied(ctx.root, node.branch), `Branch is checked out: ${node.branch}`);
      updates.push({ branch: node.branch, expected, head: node.head });
    }
    node.pr = pr;
    node.validation = null;
    node.ready = false;
    node.requiresDraft = true;
    delete node.signature;
  }
  delete graph.combined;
  delete graph.source;
  graph.targetSha = target;
  graph.integration = { target: graph.target, sha: target };
  graph.adoption = { composition: "unverified", observedAt: Date.now() };
  validateGraph(graph);
  const plan = {
    action: "adopt", repository: ctx.root, common: ctx.common, previous,
    previousDigest: digest(previous), graph, facts, updates,
    effects: [
      "Adopt only the pinned live PR heads, own-change bases, helper namespace and provider landing receipts.",
      "Preserve the full previous manifest in the operation journal and pin previous snapshots before any branch moves.",
      "Atomically update only the listed unoccupied local branches using expected-old-SHA checks.",
      "Do not change main/master, any worktree or index, remote refs, PR descriptions or draft states.",
      "Clear validation, readiness, reconstruction signatures and combined/source snapshots. Dependency composition remains unverified.",
    ],
    warnings: [
      "This is metadata recovery, not sync, validation or publication. Authored integration snapshots may be stale.",
      "Target preview-base fast-forwards may be observed without adopting them; any product/helper/PR content change invalidates the plan.",
    ],
  };
  requireValue(digest(state.load(ctx, previous.id)) === digest(previous),
    "Graph changed during planning.");
  return { ...plan, approval: digest(plan) };
}

export function applyAdoptionPlan(ctx, plan) {
  const file = state.journalFile(ctx, plan.approval);
  let journal = state.readJson(file, true);
  noPending(ctx, plan.approval);
  if (journal?.status === "done") {
    requireValue(digest(state.load(ctx, plan.graph.id)) === digest(journal.candidate),
      "Completed adoption is no longer current.");
    return { graph: journal.candidate, operation: plan.approval, alreadyDone: true };
  }
  requireValue(!journal || journal.status === "running", "Adoption was aborted or superseded.");
  const current = state.load(ctx, plan.graph.id);
  if (journal?.candidate && digest(current) === digest(journal.candidate)) {
    journal.status = "done";
    state.atomicJson(file, journal);
    return { graph: current, operation: plan.approval };
  }
  requireValue(digest(current) === plan.previousDigest, "Graph changed; prepare a new adoption plan.");
  const facts = observations(ctx, plan.graph, plan.previous);
  for (const [branch, expected] of Object.entries(plan.facts.remote)) {
    if (branch !== plan.graph.target) {
      requireValue(facts.remote[branch] === expected, `Remote ref changed: ${branch}`);
    }
  }
  requireValue(facts.remote[plan.graph.target], "Integration branch disappeared.");
  for (const [id, pr] of Object.entries(plan.facts.prs)) {
    requireValue(digest(stablePr(pr, plan.graph.target)) ===
      digest(stablePr(facts.prs[id], plan.graph.target)), `PR changed: ${id}`);
  }
  for (const [branch, expected] of Object.entries(plan.facts.local)) {
    const update = plan.updates.find((u) => u.branch === branch);
    requireValue(facts.local[branch] === expected ||
      (journal && update && facts.local[branch] === update.head), `Local ref changed: ${branch}`);
  }
  for (const update of plan.updates) {
    requireValue(!git.occupied(ctx.root, update.branch), `Branch is checked out: ${update.branch}`);
  }
  journal ??= { id: plan.approval, plan, status: "running", local: {}, remote: {}, prs: {},
    commits: {}, pendingChange: null, remoteStarted: false };
  const graph = structuredClone(plan.graph);
  graph.revision++;
  graph.lastOperation = plan.approval;
  graph.adoption.operation = plan.approval;
  journal.candidate = graph;
  state.atomicJson(file, journal);
  const pins = [...new Set([plan.previous.targetSha, plan.previous.combined, graph.targetSha,
    ...plan.previous.nodes.flatMap((n) => [n.head, n.base, n.change.base, n.change.head, n.landing?.commit]),
    ...graph.nodes.flatMap((n) => [n.head, n.base, n.landing?.commit]),
  ].filter(Boolean))];
  const commands = ["start"];
  for (const sha of pins) {
    commit(ctx, sha);
    const ref = `refs/pr-graph/${plan.approval}/adoption/${sha}`;
    const existing = git.refId(ctx.root, ref);
    requireValue(!existing || existing === sha, "Adoption snapshot pin changed.");
    commands.push(existing ? `verify ${ref} ${sha}` : `create ${ref} ${sha}`);
  }
  for (const [branch, expected] of Object.entries(plan.facts.local)) {
    const ref = `refs/heads/${branch}`;
    const update = plan.updates.find((u) => u.branch === branch);
    const actual = facts.local[branch];
    commands.push(update && actual !== update.head
      ? `update ${ref} ${update.head} ${expected ?? "0".repeat(update.head.length)}`
      : `verify ${ref} ${actual ?? "0".repeat(graph.targetSha.length)}`);
  }
  commands.push("prepare", "commit");
  git.out(ctx.root, ["update-ref", "--stdin"], `${commands.join("\n")}\n`);
  for (const update of plan.updates) journal.local[update.branch] = update.head;
  journal.finalizing = true;
  state.atomicJson(file, journal);
  state.save(ctx, graph);
  journal.status = "done";
  journal.error = null;
  state.atomicJson(file, journal);
  return { graph, operation: plan.approval, updates: plan.updates,
    warning: "Adopted locally only; composition and validation are unverified. No PR or remote refs changed." };
}
