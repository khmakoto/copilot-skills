import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { digest, requireValue, helperBranch } from "./graph.mjs";

const staged = (ctx) => git.git(ctx.root, [
  "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv",
]).stdout;

function pending(ctx, operation) {
  const running = state.journals(ctx).find((j) => j.status === "running" && j.id !== operation);
  requireValue(!running, `Interrupted operation ${running?.id} must be recovered first.`);
}

function cleanOutsideIndex(ctx) {
  requireValue(!git.out(ctx.root, ["diff", "--name-only"]),
    "Checkpoint requires all intended changes staged; unstaged work is preserved, not auto-staged.");
  requireValue(!git.out(ctx.root, ["ls-files", "--others", "--exclude-standard"]),
    "Checkpoint has untracked work; select and stage it explicitly first.");
}

export function createCheckpointPlan(ctx, options) {
  pending(ctx);
  const graph = state.load(ctx, options.graph);
  const spec = options.spec;
  requireValue(spec?.id === graph.id && typeof spec.message === "string" && spec.message.trim(),
    "Checkpoint spec needs graph id, new branch and exact commit message.");
  const branch = git.checkBranch(ctx.root, spec.branch);
  requireValue(branch !== graph.target && branch !== graph.backup?.branch &&
    !graph.nodes.some((n) => n.branch === branch || helperBranch(graph, n.id) === branch),
    "Checkpoint cannot reuse a graph-owned branch.");
  requireValue(!git.refId(ctx.root, `refs/heads/${branch}`), "Checkpoint branch already exists.");
  requireValue(!git.remoteRefs(ctx.root, graph.repository.remote)[`refs/heads/${branch}`],
    "Checkpoint branch already exists remotely.");
  const originalBranch = git.out(ctx.root, ["symbolic-ref", "--short", "HEAD"]);
  const head = git.commitId(ctx.root, "HEAD");
  requireValue(graph.nodes.some((n) => n.branch === originalBranch && n.head === head),
    "Checkpoint checkout is not the recorded graph node.");
  cleanOutsideIndex(ctx);
  const patch = staged(ctx);
  requireValue(patch.trim(), "No staged changes to checkpoint.");
  const plan = {
    action: "checkpoint", repository: ctx.root, common: ctx.common, graph,
    previousDigest: digest(graph), branch, originalBranch, head, patch,
    message: spec.message,
    effects: [
      `Create and switch only this checkout to local branch ${branch} at ${head}; do not move ${originalBranch}.`,
      "Commit exactly the approved staged snapshot through normal hooks and signing configuration.",
      "Retain the checkpoint branch and journal. Do not push, rewrite graph metadata or remove any worktree/files.",
      "This is a source preservation checkpoint, not a validated or review-ready product node.",
    ],
  };
  return { ...plan, approval: digest(plan) };
}

export function applyCheckpointPlan(ctx, plan) {
  pending(ctx, plan.approval);
  const file = state.journalFile(ctx, plan.approval);
  let journal = state.readJson(file, true);
  requireValue(digest(state.load(ctx, plan.graph.id)) === plan.previousDigest,
    "Graph changed; replan checkpoint.");
  if (journal?.status === "done") {
    requireValue(git.refId(ctx.root, `refs/heads/${plan.branch}`) === journal.commit,
      "Completed checkpoint changed.");
    return { branch: plan.branch, commit: journal.commit, operation: plan.approval, alreadyDone: true };
  }
  requireValue(!journal || journal.status === "running", "Checkpoint was aborted or superseded.");
  requireValue(git.refId(ctx.root, `refs/heads/${plan.originalBranch}`) === plan.head,
    "Original graph branch changed.");
  const branch = git.out(ctx.root, ["symbolic-ref", "--short", "HEAD"]);
  if (journal?.expectedTree && branch === plan.branch && git.commitId(ctx.root, "HEAD") !== plan.head) {
    const head = git.commitId(ctx.root, "HEAD");
    requireValue(git.out(ctx.root, ["show", "-s", "--format=%P", head]) === plan.head &&
      git.tree(ctx.root, head) === journal.expectedTree &&
      git.out(ctx.root, ["show", "-s", "--format=%B", head]) === plan.message.trim(),
    "Checkpoint has an unexpected commit; inspect it without discarding work.");
    requireValue(!git.out(ctx.root, ["status", "--porcelain"]), "Checkpoint left working-tree changes.");
    journal.commit = head;
    journal.status = "done";
    journal.error = null;
    state.atomicJson(file, journal);
    return { branch: plan.branch, commit: head, operation: plan.approval };
  }
  requireValue(branch === plan.originalBranch || (journal && branch === plan.branch),
    "Current checkout changed.");
  requireValue(git.commitId(ctx.root, "HEAD") === plan.head && staged(ctx) === plan.patch,
    "Checkpoint source or staged content changed; inspect and replan.");
  cleanOutsideIndex(ctx);
  if (branch === plan.originalBranch) {
    requireValue(!git.refId(ctx.root, `refs/heads/${plan.branch}`), "Checkpoint branch appeared.");
  }
  journal ??= { id: plan.approval, plan, status: "running", local: {}, remote: {}, prs: {},
    commits: {}, pendingChange: null, remoteStarted: false };
  journal.expectedTree = git.out(ctx.root, ["write-tree"]);
  state.atomicJson(file, journal);
  try {
    if (branch === plan.originalBranch) git.out(ctx.root, ["switch", "-c", plan.branch]);
    journal.commit = git.commitStaged(ctx.root, plan.message);
    journal.status = "done";
    journal.error = null;
    state.atomicJson(file, journal);
    return { branch: plan.branch, commit: journal.commit, operation: plan.approval,
      warning: "Local preservation checkpoint only; no graph branches or remote refs moved." };
  } catch (error) {
    journal.error = error.message;
    state.atomicJson(file, journal);
    throw new Error(`${error.message}\nCheckpoint operation: ${plan.approval}. Work preserved; do not reset or stash.`);
  }
}
