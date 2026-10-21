#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as git from "./lib/git.mjs";
import * as state from "./lib/state.mjs";
import { requireValue, render, validateGraph } from "./lib/graph.mjs";
import { createPlan, applyPlan, inspect } from "./lib/operations.mjs";

const HELP = `pr-graph (Node.js 22+, Git 2.31+)

Read-only:
  analyze --base <ref> --head <ref>
  status|view|check|doctor --graph <id>

Prepare a concrete mutation plan:
  plan <action> --graph <id> [--spec <json>] --out <file>
  Actions: init, split, add, deps, split-node, fold, remove,
           publish, sync, retarget, ready, merge, describe, backup,
           fetch-backup, restore, resolve, reconcile, abort, cleanup, unlock,
           record-landing, adopt, checkpoint
  adopt --spec <json>         Local-only adoption of verified external PR rewrites
  checkpoint --spec <json>    Preserve staged source on a new local branch and release its occupied graph branch
  --node <id>                 Select ready/merge/describe node
  --strategy merge|squash|rebase
  --landing <sha>             Verified external local landing to record
  --remote <name>             Backup download/restore remote
  --backup-ref <sha>          Downloaded snapshot to restore
  --operation <digest>        Resolve/abort/cleanup operation
  --retain-published-refs     Abort push-only publication without deleting its verified candidate refs
  --body-file <file>          Explicit describe replacement
  --fetch-observation <json>  Main/master live-tip SHA and fetch-start time
  --allow-non-atomic          Approve fallback when atomic push is unsupported

After user approval of the exact plan:
  apply --plan <file> --yes --approve <digest>
  continue --operation <digest> --yes --approve <original-digest>

All commands accept --repo <working-tree-path>. No command auto-installs tools.
Node freshness is reported separately from branch identity and validation.
Only main/master snapshots have a 90-minute grace from the recorded fetch start; merge is strict.
Plans contain code/payloads; keep them outside the product working tree.
`;

function args(argv) {
  const flags = {};
  const positional = [];
  const boolean = new Set(["yes", "allow-non-atomic", "retain-published-refs"]);
  const known = new Set(["repo", "graph", "spec", "out", "node", "strategy", "remote",
    "backup-ref", "backup-branch", "operation", "body-file", "plan", "approve", "base", "head", "landing",
    "fetch-observation"]);
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
  const ctx = git.context(flags.repo ?? process.cwd());
  let result;
  if (command === "analyze") {
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
      landing: flags.landing,
      remote: flags.remote, backupRef: flags["backup-ref"], backupBranch: flags["backup-branch"],
      operation: flags.operation, allowNonAtomic: flags["allow-non-atomic"],
      retainPublishedRefs: flags["retain-published-refs"],
      fetchObservation: flags["fetch-observation"] ? state.readJson(path.resolve(flags["fetch-observation"])) : undefined,
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
    result = applyPlan(ctx, plan, flags.approve, flags.yes);
  } else {
    throw new Error(`Unknown command: ${command}. Run help.`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  }
}
