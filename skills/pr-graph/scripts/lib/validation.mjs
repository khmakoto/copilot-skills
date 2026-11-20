import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VERSION, digest, requireValue, selectNodes } from "./graph.mjs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { loadPolicy } from "./publication.mjs";
import { nodeDetails, step } from "./progress.mjs";
import { planWorkers, fingerprint, prepareWorker, inspectWorker } from "./validation-workers.mjs";

const now = (ctx) => ctx.now?.() ?? Date.now();
const save = (ctx, journal) => state.atomicJson(state.journalFile(ctx, journal.id), journal);
const worktreeId = (operation, node) => digest({ operation, validationNode: node });
const retainedWorktrees = (journal) => journal.validationWorkers ?
  journal.validationWorkers.map((worker, index) => ({ worker: index, worktree: worker.path })) :
  journal.validationResults.filter((result) => result.worktree);

function noPending(ctx, operation) {
  const pending = state.journals(ctx, ({ id, status }) => ({ id, status }))
    .find((j) => j.status === "running" && j.id !== operation);
  requireValue(!pending, `Interrupted operation ${pending?.id} must be continued or explicitly aborted first.`);
}

function inputState(ctx, node, facts, freshness) {
  if (!node.head || !Array.isArray(node.validations) ||
    (!node.validations.length && !(typeof node.validationReason === "string" && node.validationReason.trim()))) {
    return { status: "unavailable", reason: "A realized head and locally approved checks or explicit no-check reason are required." };
  }
  const available = git.withObjectView(ctx, (run, objects) => {
    if (!objects.commits([node.head]).get(node.head)) return false;
    const result = run(["rev-list", "--objects", "--no-walk", "--missing=print", node.head]);
    return result.status === 0 && !result.stdout.includes("?");
  });
  if (!available) return { status: "unavailable", reason: "The pinned realized commit or its tree objects are unavailable locally; no implicit fetch." };
  if (facts.local[node.branch] !== node.head) return { status: "stale", reason: "The local node branch differs from its recorded realized head." };
  if (node.pr && digest(facts.prs[node.id] ?? null) !== digest(node.pr)) {
    return { status: "stale", reason: "The recorded PR observation changed; reconcile separately." };
  }
  if (!["current", "grace"].includes(freshness[node.id].integration.status)) {
    return { status: "stale", reason: "The integration snapshot is stale or unknown; sync separately." };
  }
  return { status: "current" };
}

function inputs(ctx, graph, selection, facts, freshness) {
  return selection.nodes.map((id) => {
    const node = graph.nodes.find((n) => n.id === id);
    requireValue(!node.validations || node.validations.every((check) => check &&
      Object.keys(check).every((key) => ["command", "args"].includes(key)) &&
      typeof check.command === "string" && check.command.trim() && !check.command.includes("\0") &&
      Array.isArray(check.args) && check.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))),
    `Validation requires explicit executable-plus-argv checks: ${id}`);
    return { id, head: node.head ?? null, commands: structuredClone(node.validations ?? []),
      validationReason: node.validationReason ?? null, input: inputState(ctx, node, facts, freshness) };
  });
}

export function createValidationPlan(ctx, options, io) {
  requireValue(options.selector !== undefined && options.spec === undefined && options.node === undefined,
    "Validation requires --select and existing configured checks; configure checks separately.");
  requireValue(options.fetchObservation === undefined, "Validation never refreshes integration observations.");
  noPending(ctx);
  const graph = state.load(ctx, options.graph);
  const facts = io.observe(graph);
  const selection = selectNodes(graph, options.selector, facts);
  requireValue(selection.nodes.length, "Selector resolved to no active nodes; preview exclusions and choose a new selection.");
  const freshness = io.freshness(graph, facts);
  const validationInputs = inputs(ctx, graph, selection, facts, freshness);
  const validationEnvironment = options.validationEnvironment === undefined ? undefined :
    planWorkers(ctx, options.validationEnvironment, validationInputs, graph);
  return {
    version: VERSION, action: "validate", repository: ctx.root, common: ctx.common,
    graph, previousDigest: digest(graph), run: randomUUID(), facts, freshness,
    validationSelection: selection, validationInputs,
    ...(validationEnvironment ? { validationEnvironment } : {}),
    effects: [
      "Rerun the exact configured commands serially at each selected pinned realized head, even if prior validation succeeded; do not reconstruct nodes.",
      validationEnvironment ? "Use only the exact approved managed worker/cache policy and ownership transfers. Execute serially within worker and cache-byte budgets; quarantine contamination and retain output. Never reuse test success or replay setup. Clean mode never reuses workers or artifacts."
        : "Create one owned detached operation worktree per node with checks. Retain all worktrees, outputs and command receipts; cleanup requires a separate approved plan.",
      "Aggregate clean command failures. Dirty output skips remaining checks for that node, not unrelated nodes. Unsafe identity changes or uncertain execution stop for explicit recovery without retrying commands.",
      "Update only local validation evidence after rechecking pinned graph, refs, PRs, policy, objects and integration freshness. Clear selected unsuccessful validation receipts; preserve readiness intent.",
      "The helper does not change source checkout/index, product/helper refs, PRs or integration snapshots, install dependencies, replay setup, publish, upload backups, promote readiness or merge. Repository commands are not sandboxed; review their effects explicitly.",
    ],
  };
}

function verifyInputs(ctx, plan, io) {
  requireValue(digest(state.load(ctx, plan.graph.id)) === plan.previousDigest,
    "Graph state changed; create a fresh validation plan.");
  requireValue(digest(loadPolicy(ctx, plan.graph.id)) === plan.publicationPolicyDigest,
    "Publication policy changed; create a fresh validation plan.");
  const remote = plan.graph.repository.remote;
  const url = remote ? git.out(ctx.root, ["remote", "get-url", remote]) : null;
  requireValue(url === plan.graph.repository.url, "Remote URL changed after planning.");
  const facts = io.observe(plan.graph);
  requireValue(digest(facts) === digest(plan.facts), "Validation refs or PR observations changed; create a fresh plan.");
  const freshness = io.freshness(plan.graph, facts);
  requireValue(digest(inputs(ctx, plan.graph, plan.validationSelection, facts, freshness)) === digest(plan.validationInputs),
    "Validation inputs or integration freshness changed; create a fresh plan.");
  if (plan.validationEnvironment) for (const input of plan.validationInputs) {
    const key = plan.validationEnvironment.keys[input.id];
    if (key) requireValue(fingerprint(ctx, plan.validationEnvironment.config, input) === key,
      "Validation environment/toolchain/cache inputs changed; create a fresh plan.");
  }
  return freshness;
}

function inspectWorktree(ctx, journal, result, record = false) {
  if (journal.plan.validationEnvironment) return inspectWorker(ctx, journal, result, record);
  const expected = path.join(ctx.dir, "trees", worktreeId(journal.id, result.id));
  requireValue(result.worktree === expected, "Unexpected validation worktree path.");
  const info = git.operationWorktreeInfo(ctx, expected);
  requireValue(info.head === result.head && (!result.gitDir || result.gitDir === info.gitDir),
    "Validation worktree identity or HEAD changed; stop and inspect before recovery.");
  return { info, dirty: git.out(expected, ["status", "--porcelain", "--untracked-files=all"]) };
}

function report(journal, executed = new Set(), alreadyDone = false) {
  const results = structuredClone(journal.validationResults);
  for (const result of results) for (const check of result.checks) {
    if (check.source === "executed" && !executed.has(`${result.id}:${check.index}`)) check.source = "retained-operation";
  }
  return { graph: journal.candidate, operation: journal.id, ...(alreadyDone ? { alreadyDone: true } : {}),
    validation: { success: results.every((r) => ["passed", "no-check"].includes(r.status)), results,
      ...(journal.validationWorkers ? { workers: structuredClone(journal.validationWorkers), concurrency: 1 } : {}) },
    cleanup: "Worktrees and output retained; cleanup requires its own approved plan." };
}

export function applyValidationPlan(ctx, plan, io) {
  requireValue(plan.previousDigest === digest(plan.graph) &&
    digest(selectNodes(plan.graph, plan.validationSelection?.selector, plan.facts)) === digest(plan.validationSelection),
  "Invalid pinned validation selection; create a fresh plan.");
  noPending(ctx, plan.approval);
  let journal = state.readJson(state.journalFile(ctx, plan.approval), true);
  requireValue(!journal || (journal.id === plan.approval && digest(journal.plan) === digest(plan)),
    "Validation operation journal identity mismatch.");
  if (journal?.status === "running" && journal.finalizing &&
    digest(state.load(ctx, plan.graph.id)) === digest(journal.candidate)) {
    journal.status = "done";
    save(ctx, journal);
  }
  if (journal?.status === "done") {
    requireValue(digest(state.load(ctx, plan.graph.id)) === digest(journal.candidate),
      "Completed validation is no longer current; prepare a new plan to rerun checks.");
    return report(journal, new Set(), true);
  }
  requireValue(!journal || journal.status === "running", "Validation operation was aborted or superseded.");
  journal ??= { id: plan.approval, plan, status: "running", historyVersion: 1,
    local: {}, remote: {}, prs: {}, commits: {}, pendingChange: null, remoteStarted: false,
    validationResults: plan.validationInputs.map((input) => ({ ...structuredClone(input), status: "pending", checks: [] })) };
  requireValue(digest(journal.validationResults.map(({ id, head, commands, validationReason, input }) =>
    ({ id, head, commands, validationReason, input }))) === digest(plan.validationInputs),
  "Retained validation inputs differ from the approved plan; preserve the journal and inspect explicitly.");
  save(ctx, journal);
  const executed = new Set();
  try {
    verifyInputs(ctx, plan, io);
    requireValue(!journal.pendingValidationWorktree,
      "Validation worktree creation has an uncertain outcome or failed hook. Inspect and explicitly abort before replanning.");
    requireValue(!journal.pendingValidation,
      "A validation command has an uncertain outcome. Inspect retained output and explicitly abort; do not blindly retry.");
    for (const result of journal.validationResults) {
      if (result.status !== "pending") continue;
      verifyInputs(ctx, plan, io);
      if (result.input.status !== "current") {
        result.status = result.input.status;
        result.reason = result.input.reason;
        save(ctx, journal);
        continue;
      }
      if (!result.commands.length) {
        result.status = "no-check";
        result.reason = result.validationReason;
        result.source = "explicit-reason";
        save(ctx, journal);
        continue;
      }
      const node = plan.graph.nodes.find((n) => n.id === result.id);
      const details = nodeDetails(plan.graph, node);
      if (plan.validationEnvironment) {
        if (!prepareWorker(ctx, journal, result)) {
          result.status = "unavailable";
          result.reason = "Approved worker budget exhausted; retain existing output and approve a new bounded run.";
          save(ctx, journal);
          continue;
        }
      } else if (!result.worktree) {
        const id = worktreeId(journal.id, result.id);
        const dir = path.join(ctx.dir, "trees", id);
        requireValue(!fs.existsSync(dir), "Unexpected existing validation worktree; preserve it and inspect explicitly.");
        result.worktree = dir;
        save(ctx, journal);
        git.pin(ctx.root, journal.id, `validation/${node.id}`, result.head);
      }
      if (!result.gitDir) {
        journal.pendingValidationWorktree = { node: result.id, worktree: result.worktree };
        save(ctx, journal);
        git.createWorktree(ctx, worktreeId(journal.id, result.id), result.head);
      }
      const inspected = inspectWorktree(ctx, journal, result);
      requireValue(!inspected.dirty, "Validation worktree has changes; preserve output and abort before replanning.");
      result.gitDir = inspected.info.gitDir;
      journal.pendingValidationWorktree = null;
      save(ctx, journal);
      for (let index = result.checks.length; index < result.commands.length; index++) {
        verifyInputs(ctx, plan, io);
        requireValue(!inspectWorktree(ctx, journal, result).dirty, "Validation worktree changed before the next check.");
        const command = result.commands[index];
        journal.pendingValidation = { node: result.id, index, command, worktree: result.worktree };
        save(ctx, journal);
        const check = { index, ...command, source: "executed", startedAt: now(ctx) };
        result.checks.push(check);
        executed.add(`${result.id}:${index}`);
        try {
          step(`Validation ${JSON.stringify([command.command, ...command.args])}`, () => {
            Object.assign(check, git.run(command.command, command.args, result.worktree));
            requireValue(check.status === 0 && !check.signal, `Validation command failed: ${result.id}, check ${index + 1}`);
          }, { ...details, success: "passed" });
        } catch (error) {
          check.error = error.message;
          if (check.status === undefined && !["ENOENT", "EACCES"].includes(error.cause?.code)) {
            save(ctx, journal);
            throw error;
          }
        }
        check.completedAt = now(ctx);
        check.exitCode = check.status ?? null;
        check.status = check.signal ? "uncertain" : check.exitCode === null ? "unavailable" : check.exitCode === 0 ? "passed" : "failed";
        save(ctx, journal);
        requireValue(!check.signal, "Validation was terminated by a signal; inspect and explicitly abort without retrying.");
        const after = inspectWorktree(ctx, journal, result, true);
        verifyInputs(ctx, plan, io);
        check.dirty = after.dirty;
        if (after.dirty) {
          check.status = "dirty";
          for (let skipped = index + 1; skipped < result.commands.length; skipped++) {
            result.checks.push({ index: skipped, ...result.commands[skipped], status: "skipped",
              source: "not-executed", reason: "Earlier check left dirty output in this node's worktree." });
          }
          result.status = "dirty";
        }
        journal.pendingValidation = null;
        save(ctx, journal);
        if (after.dirty) break;
      }
      if (result.status === "pending") result.status = result.checks.every((c) => c.status === "passed") ? "passed" : "failed";
      if (plan.validationEnvironment && result.status !== "passed") journal.validationWorkers[result.worker].quarantined = true;
      save(ctx, journal);
    }
    const freshness = verifyInputs(ctx, plan, io);
    if (plan.validationEnvironment) for (const result of retainedWorktrees(journal)) inspectWorktree(ctx, journal, result);
    for (const result of journal.validationResults.filter((r) => r.status === "passed")) {
      if (plan.validationEnvironment && journal.validationWorkers[result.worker].snapshot.dirty) {
        result.status = "dirty";
        result.reason = "Shared worker was subsequently contaminated; no current validation receipt retained.";
        continue;
      }
      requireValue(!inspectWorktree(ctx, journal, result).dirty,
        "A previously successful validation worktree changed; preserve evidence and abort before replanning.");
    }
    const graph = structuredClone(plan.graph);
    journal.validated = {};
    for (const result of journal.validationResults) {
      const node = graph.nodes.find((n) => n.id === result.id);
      node.validation = ["passed", "no-check"].includes(result.status) ? {
        head: node.head, commands: digest(node.validations), reason: node.validationReason,
        operation: journal.id, source: result.status === "no-check" ? "explicit-reason" : "executed",
        completedAt: now(ctx),
      } : null;
      if (node.validation) journal.validated[node.id] = node.validation;
    }
    graph.revision++;
    graph.lastOperation = journal.id;
    journal.candidate = graph;
    journal.finalizing = true;
    journal.freshness = freshness;
    save(ctx, journal);
    state.save(ctx, graph, plan);
    journal.status = "done";
    journal.error = null;
    save(ctx, journal);
    return report(journal, executed);
  } catch (error) {
    journal.error = error.message;
    save(ctx, journal);
    throw new Error(`${error.message}\nOperation: ${journal.id}. State and validation output retained; inspect before recovery.`);
  }
}

export function validationRecoveryPlan(ctx, action, options, journal) {
  requireValue(["abort", "cleanup"].includes(action),
    "Validation has no reconstruction or remote effects to resolve/reconcile. Inspect output, then explicitly abort or clean up.");
  requireValue(!options.retainPublishedRefs, "Validation has no published refs to retain.");
  const plan = { version: VERSION, action, repository: ctx.root, common: ctx.common,
    operation: journal.id, journalDigest: digest(journal), validationRecovery: true };
  if (action === "abort") {
    requireValue(journal.status === "running", "Validation operation is not running.");
    return { ...plan, effects: ["Abort only this validation journal; retain every ref, graph receipt, worktree and output. Never rerun an uncertain command."] };
  }
  requireValue(["done", "aborted"].includes(journal.status), "Cannot clean an unfinished validation operation.");
  requireValue(options.spec?.worktree === true && Array.isArray(options.spec.branches) && !options.spec.branches.length &&
    Object.keys(options.spec).every((key) => ["branches", "worktree"].includes(key)),
  "Validation cleanup requires only branches: [] and worktree: true; no branch or PR cleanup.");
  requireValue(!journal.validationWorkers?.some((worker) => worker.transferredTo),
    "Validation workers transferred to another operation; clean their latest owner instead.");
  const worktrees = retainedWorktrees(journal).filter((r, index, all) => fs.existsSync(r.worktree) &&
    all.findIndex((item) => item.worktree === r.worktree) === index).map((r) => {
    const { info, dirty } = inspectWorktree(ctx, journal, r, "cleanup");
    requireValue(!dirty && !git.out(r.worktree, ["status", "--porcelain", "--untracked-files=all", "--ignored"]),
      `Validation output remains dirty: ${r.worktree}; preserve and handle it explicitly before cleanup.`);
    return info;
  });
  return { ...plan, worktrees, effects: worktrees.map((info) => `Remove only clean owned validation worktree ${info.path}; never force removal.`) };
}

export function applyValidationRecovery(ctx, plan, journal) {
  if (plan.action === "abort") {
    journal.status = "aborted";
    journal.recoveries ??= [];
    journal.recoveries.push({ operation: plan.approval, action: "abort", recordedAt: now(ctx) });
    save(ctx, journal);
    return { aborted: journal.id, worktrees: retainedWorktrees(journal).map((r) => r.worktree) };
  }
  for (const expected of plan.worktrees) {
    const result = retainedWorktrees(journal).find((r) => r.worktree === expected.path);
    requireValue(result, "Unexpected validation cleanup path.");
    const { info, dirty } = inspectWorktree(ctx, journal, result, "cleanup");
    requireValue(digest(info) === digest(expected) && !dirty &&
      !git.out(expected.path, ["status", "--porcelain", "--untracked-files=all", "--ignored"]),
    "Validation cleanup worktree changed after approval.");
  }
  for (const info of plan.worktrees) git.out(ctx.root, ["worktree", "remove", info.path]);
  return { cleaned: plan.effects };
}
