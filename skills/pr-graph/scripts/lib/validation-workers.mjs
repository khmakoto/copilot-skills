import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { digest, requireValue } from "./graph.mjs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";

const persist = (ctx, journal) => state.atomicJson(state.journalFile(ctx, journal.id), journal);
const hashFile = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const relative = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
  value.split("/").every((part) => ![".", "..", ".git"].includes(part));

export function fingerprint(ctx, config, input) {
  const executables = input.commands.map(({ command }) => {
    requireValue(path.isAbsolute(command) && fs.statSync(command).isFile(),
      "Managed validation requires absolute installed executable paths; no setup or installation is implied.");
    return [command, fs.statSync(command).mode, hashFile(command)];
  });
  const files = git.withObjectView(ctx, (run) => [...new Set([".gitignore", ...config.inputPaths])].map((file) => {
    const result = run(["ls-tree", "-r", "-z", input.head, "--", file]);
    requireValue(result.status === 0, "Cannot inspect validation cache inputs.");
    requireValue(!result.stdout.split("\0").some((entry) => /^(120000|160000) /.test(entry)),
      "Managed cache configuration inputs cannot contain symlinks or submodules; use fresh default validation.");
    return [file, result.stdout];
  }));
  const hooks = path.resolve(ctx.root, git.git(ctx.root, ["config", "--get", "core.hooksPath"], undefined, true).stdout.trim() ||
    path.join(ctx.common, "hooks"));
  const hookFiles = fs.existsSync(hooks) ? fs.readdirSync(hooks).sort().map((name) => {
    const file = path.join(hooks, name);
    requireValue(fs.statSync(file).isFile(), "Unverifiable validation hook input.");
    return [name, fs.statSync(file).mode, hashFile(file)];
  }) : [];
  const excludes = git.git(ctx.root, ["config", "--get", "core.excludesFile"], undefined, true).stdout.trim();
  const defaultIgnore = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || ctx.root, ".config"), "git", "ignore");
  const ignoreFiles = [path.join(ctx.common, "info", "exclude"), excludes ? path.resolve(ctx.root, excludes) : defaultIgnore]
    .map((file) => [file, fs.existsSync(file) ? hashFile(file) : null]);
  return digest({ environment: process.env, executables, files, hookFiles,
    ignoreFiles,
    config: { ...config, reuse: [] }, commands: input.commands, node: process.version,
    gitConfig: git.out(ctx.root, ["config", "--list", "--null"]) });
}

export function snapshot(ctx, worker, config) {
  const info = git.operationWorktreeInfo(ctx, worker.path);
  requireValue(info.head === worker.head && (!worker.gitDir || info.gitDir === worker.gitDir),
    "Validation worker identity or HEAD changed; inspect before recovery.");
  const configuration = digest(git.out(worker.path, ["config", "--list", "--null"]));
  requireValue(!worker.configuration || worker.configuration === configuration,
    "Validation worker configuration changed; inspect before recovery.");
  const dirty = git.out(worker.path, ["status", "--porcelain", "--untracked-files=all"]);
  const files = git.git(worker.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).stdout
    .split("\0").filter(Boolean).sort();
  const manifest = [];
  let bytes = 0;
  let contamination = dirty;
  for (const file of files) {
    if (!config.caches.some((cache) => file.startsWith(`${cache}/`))) {
      contamination += `\nUnknown ignored output: ${file}`;
      continue;
    }
    let target = worker.path;
    for (const part of file.split("/")) {
      target = path.join(target, part);
      requireValue(!fs.lstatSync(target).isSymbolicLink(), "Validation cache symlinks are not supported; retain and inspect output.");
    }
    const stat = fs.lstatSync(target);
    requireValue(stat.isFile(), "Validation cache must contain regular files only.");
    bytes += stat.size;
    manifest.push([file, stat.size, stat.mode, bytes > config.maxCacheBytes ? "over-budget" :
      hashFile(target)]);
  }
  if (bytes > config.maxCacheBytes) contamination += "\nValidation cache exceeds approved byte budget.";
  return { ...info, configuration, bytes, files: manifest.length, manifest: digest(manifest), dirty: contamination };
}

export function planWorkers(ctx, config, inputs, graph) {
  requireValue(config && Object.keys(config).every((key) =>
    ["mode", "maxWorkers", "maxCacheBytes", "identity", "inputPaths", "caches", "reuse"].includes(key)) &&
    ["warm", "clean"].includes(config.mode) && Number.isInteger(config.maxWorkers) &&
    config.maxWorkers >= 1 && config.maxWorkers <= 4 && Number.isSafeInteger(config.maxCacheBytes) && config.maxCacheBytes >= 0 &&
    typeof config.identity === "string" && config.identity.trim() &&
    Array.isArray(config.inputPaths) && config.inputPaths.every(relative) &&
    Array.isArray(config.caches) && config.caches.every(relative) &&
    Array.isArray(config.reuse) && (config.mode === "warm" || !config.reuse.length),
  "Validation environment requires warm/clean mode, identity, maxWorkers (1..4), maxCacheBytes, inputPaths, caches and reuse lists.");
  requireValue(new Set(config.caches).size === config.caches.length && !config.caches.some((a) =>
    config.caches.some((b) => a !== b && a.startsWith(`${b}/`))), "Cache directories must be unique and non-overlapping.");
  const keys = {};
  for (const input of inputs.filter((item) => item.input.status === "current" && item.commands.length)) {
    git.withObjectView(ctx, (run) => {
      for (const cache of config.caches) {
        const result = run(["ls-tree", "-r", "-z", input.head, "--", cache]);
        requireValue(result.status === 0 && !result.stdout, "Cache directories cannot overlap tracked input.");
      }
    });
    keys[input.id] = fingerprint(ctx, config, input);
  }
  const reused = config.reuse.map(({ operation, worker: index, ...extra }) => {
    requireValue(!Object.keys(extra).length && /^[0-9a-f]{64}$/.test(operation) && Number.isInteger(index), "Invalid validation worker source.");
    const source = state.readJson(state.journalFile(ctx, operation));
    const worker = source.validationWorkers?.[index];
    requireValue(source.id === operation && source.plan.action === "validate" && source.plan.common === ctx.common && source.plan.graph.id === graph.id &&
      ["done", "aborted"].includes(source.status) && !source.pendingValidation && !source.pendingValidationWorktree &&
      worker && !worker.transferredTo && !worker.quarantined && Object.values(keys).includes(worker.key),
    "Validation worker is unavailable, incompatible, uncertain or transferred; use a new worker or its latest owner.");
    const observed = snapshot(ctx, worker, config);
    requireValue(!observed.dirty && digest(observed) === digest(worker.snapshot), "Validation worker output changed after its receipt.");
    return { operation, index, journalDigest: digest(source), worker: structuredClone(worker), observed };
  });
  requireValue(reused.length <= config.maxWorkers && new Set(reused.map((item) => item.worker.path)).size === reused.length,
    "Validation reuse exceeds worker budget or selects a worker twice.");
  return { config: structuredClone(config), keys, reused, concurrency: 1 };
}

export function prepareWorker(ctx, journal, result) {
  const policy = journal.plan.validationEnvironment;
  const { config, keys } = policy;
  journal.validationWorkers ??= [];
  if (!journal.workersClaimed) {
    for (const reuse of policy.reused) {
      const source = state.readJson(state.journalFile(ctx, reuse.operation));
      const original = structuredClone(source);
      for (const item of original.validationWorkers) if (item.transferredTo === journal.id) delete item.transferredTo;
      requireValue(digest(original) === reuse.journalDigest, "Validation worker source changed after approval.");
      const old = source.validationWorkers[reuse.index];
      requireValue(!old.transferredTo || old.transferredTo === journal.id, "Validation worker ownership changed.");
      requireValue(digest(snapshot(ctx, old, config)) === digest(reuse.observed), "Validation worker changed after approval.");
      old.transferredTo = journal.id;
      persist(ctx, source);
      if (!journal.validationWorkers.some((item) => item.path === old.path)) {
        const worker = structuredClone(reuse.worker);
        worker.reusedFrom = { operation: reuse.operation, worker: reuse.index };
        journal.validationWorkers.push(worker);
      }
      persist(ctx, journal);
    }
    journal.workersClaimed = true;
    persist(ctx, journal);
  }
  let worker = result.worker === undefined ? null : journal.validationWorkers[result.worker];
  if (!worker) {
    worker = config.mode === "warm" ? journal.validationWorkers.findLast((item) => item.key === keys[result.id] && !item.quarantined) : null;
    if (!worker) {
      if (journal.validationWorkers.length >= config.maxWorkers) return null;
      worker = { key: keys[result.id], head: result.head,
        path: path.join(ctx.dir, "trees", digest({ operation: journal.id, worker: journal.validationWorkers.length })) };
      journal.validationWorkers.push(worker);
    }
    result.worker = journal.validationWorkers.indexOf(worker);
    result.worktree = worker.path;
    result.environment = { mode: config.mode, worker: result.worker, worktreeReused: !!worker.gitDir,
      artifactsReused: !!worker.snapshot?.files, setupReplayed: false, resultsReused: false };
    persist(ctx, journal);
  }
  requireValue(!worker.transferredTo && !worker.quarantined, "Validation worker no longer belongs to this run.");
  if (worker.gitDir) {
    const observed = snapshot(ctx, worker, config);
    requireValue(!observed.dirty && digest(observed) === digest(worker.snapshot), "Validation worker changed before reuse.");
  } else requireValue(!fs.existsSync(worker.path), "Unexpected existing validation worker; inspect and abort.");
  journal.pendingValidationWorktree = { node: result.id, worktree: worker.path };
  persist(ctx, journal);
  const startedAt = Date.now();
  if (!worker.gitDir) git.createWorktree(ctx, path.basename(worker.path), result.head);
  else if (worker.head !== result.head) git.checkoutClean(worker.path, result.head);
  worker.head = result.head;
  const observed = snapshot(ctx, worker, config);
  requireValue(!observed.dirty, "Validation checkout hook contaminated worker output; inspect and abort.");
  worker.gitDir = observed.gitDir;
  worker.configuration = observed.configuration;
  worker.snapshot = observed;
  result.gitDir = observed.gitDir;
  result.environment.checkoutMs = Date.now() - startedAt;
  journal.pendingValidationWorktree = null;
  persist(ctx, journal);
  return worker;
}

export function inspectWorker(ctx, journal, result, record = false) {
  const worker = journal.validationWorkers[result.worker];
  requireValue(worker && !worker.transferredTo && result.worktree === worker.path, "Validation worker ownership changed.");
  const observed = snapshot(ctx, worker, journal.plan.validationEnvironment.config);
  if (record === true) {
    worker.snapshot = observed;
    if (observed.dirty) worker.quarantined = true;
    result.environment.cacheBytes = observed.bytes;
    result.environment.cacheFiles = observed.files;
  } else if (record !== "cleanup") requireValue(digest(observed) === digest(worker.snapshot), "Validation worker output changed outside an observed check.");
  return { info: observed, dirty: observed.dirty };
}
