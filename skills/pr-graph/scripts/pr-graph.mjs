#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import * as git from "./lib/git.mjs";
import * as state from "./lib/state.mjs";
import { requireValue, render, validateGraph } from "./lib/graph.mjs";
import { createPlan, applyPlan, inspect, previewSelection } from "./lib/operations.mjs";
import { ProgressReporter, setProgressSink, step } from "./lib/progress.mjs";
import { history, interdiff, renderHistory, renderInterdiff } from "./lib/history.mjs";
import { historyArchives } from "./lib/history-archive.mjs";
import { inspectAbsorb } from "./lib/absorb.mjs";

const HELP = `pr-graph (Node.js 22+, Git 2.31+)

Read-only:
  analyze --base <ref> --head <ref>
  absorb --graph <id> --base <ref> --head <ref>  Inventory pinned follow-up hunks; no mutations
  status|view|check|doctor --graph <id>
  select --graph <id> --select <selector>
  history --graph <id> --node <id> [--format json|text]
  history-archives --graph <id>
  history|interdiff ... --archive <imported-archive-digest>  Explicit imported evidence only
  interdiff --graph <id> --node <id> --from <version|last-published|last-validated|current>
            [--to <version|current>] [--format json|text]

Prepare a concrete mutation plan:
  plan <action> --graph <id> [--spec <json>] --out <file>
  Actions: init, split, add, deps, split-node, fold, remove, absorb,
           publish, sync, retarget, ready, merge, describe, backup,
           fetch-backup, restore, resolve, reconcile, abort, cleanup, unlock,
           record-landing, adopt, checkpoint, remove-retired, import-graph,
           export-history, import-history, publication-policy
  publication-policy --spec <json>  Approved local exclude/release lists and reason; preserves lineage evidence
  export-history|import-history --archive <file>  Separately approved evidence-only local transfer
  import-graph --source-repo <path>  Recover changed DAG shape from another verified local clone
  adopt --spec <json>         Local-only adoption of verified external PR rewrites
  --landings-only             Adopt only new provider-confirmed landings; preserve source identities and refs
  absorb --spec <json>        Local-only exact allocation of pinned follow-up edits; preserves identities/edges
  checkpoint --spec <json>    Preserve staged source on a new local branch and release its occupied graph branch
  remove-retired --node <id>  Remove retired unpublished node metadata, preserving all Git refs and files
  --node <id>                 Select ready/merge/describe node
  --nodes <id,id>             Publish only selected nodes and their required helper bases
  --select <selector>         Preview or plan publish: node:<id>, dependents:<id>, eligible, unpublished
  --strategy merge|squash|rebase
  --landing <sha>             Verified external local landing to record
  --remote <name>             Backup download/restore remote
  --backup-ref <sha>          Downloaded snapshot to restore
  --operation <digest>        Resolve/abort/cleanup operation
  --retain-published-refs     Abort push-only publication without deleting its verified candidate refs
  --body-file <file>          Explicit describe replacement
  --fetch-observation <json>  Main/master live-tip SHA and fetch-start time
  --commit-trailers-file <json>  Exact trailer lines for reconstruction commits
  --reuse-worktree <digest>   Reuse a clean completed/aborted operation worktree (add/fold/sync/publish/retarget)
  --local-only               Sync locally without pushes, PR changes, or backup uploads
  --allow-non-atomic          Approve fallback when atomic push is unsupported

After user approval of the exact plan:
  apply --plan <file> --yes --approve <digest>
  continue --operation <digest> --yes --approve <original-digest>

All commands accept --repo <working-tree-path>. No command auto-installs tools.
Live progress goes to stderr by default; --quiet suppresses progress, not errors.
Interactive terminals use colors/spinners; redirected output uses plain lines.
Quiet steps report a heartbeat every 2 minutes. Stdout results are unchanged.
Node freshness is reported separately from branch identity and validation.
Only main/master snapshots have a 3-hour grace from the recorded fetch start; merge is strict.
Plans contain code/payloads; keep them outside the product working tree.
`;

function args(argv) {
  const flags = {};
  const positional = [];
  const boolean = new Set(["yes", "allow-non-atomic", "retain-published-refs", "quiet", "local-only", "landings-only"]);
  const known = new Set(["repo", "graph", "spec", "out", "node", "strategy", "remote",
    "backup-ref", "backup-branch", "operation", "body-file", "plan", "approve", "base", "head", "landing",
    "fetch-observation", "commit-trailers-file", "reuse-worktree", "nodes", "source-repo",
    "from", "to", "format", "select", "archive"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const key = a.slice(2);
    requireValue(!Object.hasOwn(flags, key), `Duplicate flag: ${a}`);
    if (boolean.has(key)) flags[key] = true;
    else {
      requireValue(known.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--"), `Unknown or missing flag: ${a}`);
      flags[key] = argv[++i];
    }
  }
  return { flags, positional };
}

export function main(argv) {
  const { flags, positional } = args(argv);
  const [command, action] = positional;
  if (!command || command === "help") return process.stdout.write(HELP);
  return step(command === "plan" ? `Planning ${action}` : command === "apply" || command === "continue"
    ? `${command === "continue" ? "Continuing" : "Applying"} approved operation` : `Inspecting ${command}`,
  () => execute(flags, command, action));
}

function execute(flags, command, action) {
  const historical = ["history", "interdiff"].includes(command);
  requireValue(flags.archive === undefined || historical ||
    (command === "plan" && ["export-history", "import-history"].includes(action)),
  "Use --archive only with history/interdiff or plan export-history/import-history.");
  requireValue(flags.format === undefined || (historical && ["json", "text"].includes(flags.format)),
    "Use --format json|text only with history or interdiff.");
  requireValue((flags.from === undefined && flags.to === undefined) || command === "interdiff",
    "Use --from/--to only with interdiff.");
  requireValue(flags["source-repo"] === undefined || (command === "plan" && action === "import-graph"),
    "Use --source-repo only when planning import-graph.");
  requireValue(flags.nodes === undefined || (command === "plan" && action === "publish"),
    "Use --nodes only when planning publish; apply and continue use the approved selection.");
  requireValue(flags.select === undefined || ((command === "select" ||
    (command === "plan" && action === "publish")) &&
    flags.nodes === undefined && flags.node === undefined && flags.spec === undefined),
  "Use --select only with select or plan publish; do not combine with --nodes, --node, or --spec.");
  requireValue(flags["local-only"] === undefined || (command === "plan" && action === "sync"),
    "Use --local-only only when planning sync; apply and continue use the approved plan's mode.");
  requireValue(flags["landings-only"] === undefined || (command === "plan" && action === "adopt"),
    "Use --landings-only only when planning adopt; apply and continue use the approved plan's mode.");
  const ctx = step("Locating repository", () => git.context(flags.repo ?? process.cwd()));
  let result;
  if (command === "history-archives") {
    requireValue(flags.graph, "Select --graph explicitly.");
    result = historyArchives(ctx, flags.graph);
  } else if (command === "absorb") {
    requireValue(flags.graph && flags.base && flags.head, "Absorb requires --graph, --base and --head.");
    result = inspectAbsorb(ctx, flags.graph, flags.base, flags.head);
  } else if (command === "select") {
    requireValue(flags.graph && flags.select, "Select requires --graph and --select.");
    result = previewSelection(ctx, flags.graph, flags.select);
  } else if (historical) {
    requireValue(flags.graph && flags.node, "Select --graph and --node explicitly.");
    result = command === "history" ? history(ctx, flags.graph, flags.node, flags.archive) :
      interdiff(ctx, flags.graph, flags.node, flags.from, flags.to, flags.archive);
    if (flags.format === "text") return process.stdout.write(
      `${command === "history" ? renderHistory(result) : renderInterdiff(result)}\n`);
  } else if (command === "analyze") {
    requireValue(flags.base && flags.head, "Analyze requires explicit --base and --head.");
    const target = git.commitId(ctx.root, flags.base);
    const head = git.commitId(ctx.root, flags.head);
    const base = git.out(ctx.root, ["merge-base", target, head]);
    result = {
      base, target, head,
      paths: git.git(ctx.root, ["diff", "--name-status", "--no-renames", "-z", base, head]).stdout.split("\0").filter(Boolean),
      statistics: git.git(ctx.root, ["diff", "--numstat", "-z", base, head]).stdout,
      patch: git.git(ctx.root, ["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", base, head]).stdout,
      warning: "Statistics are facts, not a universal size limit. Inspect repository guidance and semantic dependencies.",
    };
  } else if (["status", "view", "check", "doctor"].includes(command)) {
    requireValue(flags.graph, "Select --graph explicitly.");
    result = inspect(ctx, flags.graph);
    if (["check", "doctor"].includes(command)) {
      requireValue(result.graph, "Graph not found.");
      validateGraph(result.graph);
      const problems = [];
      for (const n of result.graph.nodes) {
        if (n.head && git.refId(ctx.root, `refs/heads/${n.branch}`) !== n.head) problems.push(`Missing/changed branch: ${n.branch}`);
        for (const sha of [n.change.base, n.change.head, n.head, n.base].filter(Boolean)) git.commitId(ctx.root, sha);
      }
      result.problems = problems;
      requireValue(!problems.length, problems.join("\n"));
    }
    if (command === "view") {
      requireValue(result.graph, "Graph not found.");
      return process.stdout.write(`${render(result.graph, result.freshness)}\n`);
    }
  } else if (command === "plan") {
    const spec = flags.spec ? state.readJson(path.resolve(flags.spec)) : undefined;
    result = createPlan(ctx, action, {
      graph: flags.graph, spec, node: flags.node, strategy: flags.strategy,
      archive: flags.archive,
      sourceRepo: flags["source-repo"],
      publishNodes: flags.nodes === undefined ? undefined : flags.nodes.split(","),
      selector: flags.select,
      landing: flags.landing,
      remote: flags.remote, backupRef: flags["backup-ref"], backupBranch: flags["backup-branch"],
      operation: flags.operation, allowNonAtomic: flags["allow-non-atomic"],
      retainPublishedRefs: flags["retain-published-refs"],
      reuseWorktree: flags["reuse-worktree"],
      localOnly: flags["local-only"],
      landingsOnly: flags["landings-only"],
      fetchObservation: flags["fetch-observation"] ? state.readJson(path.resolve(flags["fetch-observation"])) : undefined,
      commitTrailers: flags["commit-trailers-file"] ? state.readJson(path.resolve(flags["commit-trailers-file"])) : undefined,
      body: flags["body-file"] ? fs.readFileSync(path.resolve(flags["body-file"]), "utf8") : undefined,
    });
    if (flags.out) {
      const target = path.resolve(flags.out);
      const relative = path.relative(ctx.root, target);
      requireValue(relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative),
        "Write plans outside the product working tree.");
      requireValue(!fs.existsSync(target), "Plan output exists; choose a new path to preserve previous approvals.");
      state.atomicJson(target, result);
    }
  } else if (command === "apply" || command === "continue") {
    const plan = command === "apply"
      ? state.readJson(path.resolve(flags.plan ?? ""))
      : state.readJson(state.journalFile(ctx, flags.operation)).plan;
    result = step(`Executing ${plan.action}`, () => applyPlan(ctx, plan, flags.approve, flags.yes));
  } else {
    throw new Error(`Unknown command: ${command}. Run help.`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function errorOutput(error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}

function runCLI(argv) {
  const { flags, positional } = args(argv);
  if (flags.quiet || !positional[0] || positional[0] === "help") return main(argv);
  const reporter = new ProgressReporter();
  // Keep reporting responsive while the worker runs synchronous Git/provider commands.
  const worker = new Worker(new URL(import.meta.url), { workerData: { prGraph: true, argv } });
  worker.on("message", (message) => {
    if (message.type === "progress") reporter.receive(message.event);
    else if (message.type === "error") {
      reporter.close();
      errorOutput(message);
    }
  });
  worker.on("error", (error) => {
    reporter.close();
    errorOutput(error);
  });
  worker.on("exit", (code) => {
    reporter.close();
    if (code !== 0) process.exitCode = code;
  });
}

if (!isMainThread && workerData?.prGraph) {
  setProgressSink((event) => parentPort.postMessage({ type: "progress", event }));
  try {
    main(workerData.argv);
  } catch (error) {
    parentPort.postMessage({ type: "error", message: error.message });
    process.exitCode = 1;
  }
  parentPort.close();
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    runCLI(process.argv.slice(2));
  } catch (error) {
    errorOutput(error);
  }
}
