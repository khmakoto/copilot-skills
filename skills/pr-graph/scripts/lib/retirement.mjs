import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { digest, requireValue, validateGraph } from "./graph.mjs";

function noPending(ctx, operation) {
  const pending = state.journals(ctx).find((j) => j.status === "running" && j.id !== operation);
  requireValue(!pending, `Interrupted operation ${pending?.id} must be recovered first.`);
}

function observations(ctx, graph, node) {
  const remote = git.remoteConfig(ctx.root, graph.repository.remote);
  requireValue(remote.url === graph.repository.url, "Graph remote URL changed.");
  return {
    local: git.refId(ctx.root, `refs/heads/${node.branch}`),
    remote: git.remoteRefs(ctx.root, remote.name)[`refs/heads/${node.branch}`] ?? null,
  };
}

export function createRetiredRemovalPlan(ctx, options) {
  noPending(ctx);
  const previous = state.load(ctx, options.graph);
  const node = previous.nodes.find((n) => n.id === options.node);
  requireValue(node?.retired && !node.pr && !node.landing,
    "Select a retired unpublished node without a PR or landing.");
  requireValue(!previous.nodes.some((n) => n.dependencies.includes(node.id)),
    `Node still has dependents: ${node.id}`);
  const facts = observations(ctx, previous, node);
  requireValue(!facts.remote, `Node has a published remote branch: ${node.id}`);
  const graph = structuredClone(previous);
  graph.nodes = graph.nodes.filter((n) => n.id !== node.id);
  for (const n of graph.nodes) {
    for (const key of ["supersedes", "replacedBy"]) {
      if (n[key]) n[key] = n[key].filter((id) => id !== node.id);
    }
  }
  validateGraph(graph);
  const plan = {
    action: "remove-retired", repository: ctx.root, common: ctx.common,
    previous, previousDigest: digest(previous), graph, node: node.id, facts,
    effects: [
      `Remove only retired unpublished node ${node.id} and historical supersedes/replacedBy references to it.`,
      "Retain the complete previous manifest in the operation journal.",
      "Preserve every Git ref, commit, file, index, worktree, remote ref and PR.",
      "Do not reconstruct source, run validation, change readiness or upload a backup.",
    ],
  };
  return { ...plan, approval: digest(plan) };
}

export function applyRetiredRemovalPlan(ctx, plan) {
  noPending(ctx, plan.approval);
  const file = state.journalFile(ctx, plan.approval);
  let journal = state.readJson(file, true);
  const current = state.load(ctx, plan.graph.id);
  if (journal?.candidate && digest(current) === digest(journal.candidate)) {
    journal.status = "done";
    state.atomicJson(file, journal);
    return { graph: current, operation: plan.approval, alreadyDone: true };
  }
  requireValue(!journal || journal.status === "running", "Operation was aborted or superseded.");
  requireValue(digest(current) === plan.previousDigest, "Graph changed; replan retired-node removal.");
  const node = current.nodes.find((n) => n.id === plan.node);
  requireValue(digest(observations(ctx, current, node)) === digest(plan.facts),
    "Retired node branch changed; replan removal.");
  const graph = structuredClone(plan.graph);
  graph.revision++;
  graph.lastOperation = plan.approval;
  journal ??= { id: plan.approval, plan, status: "running",
    local: {}, remote: {}, prs: {}, commits: {}, pendingChange: null, remoteStarted: false };
  journal.candidate = graph;
  state.atomicJson(file, journal);
  state.save(ctx, graph);
  journal.status = "done";
  state.atomicJson(file, journal);
  return { graph, operation: plan.approval };
}
