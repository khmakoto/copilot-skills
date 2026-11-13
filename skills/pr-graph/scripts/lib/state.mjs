import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { digest, requireValue, validateGraph } from "./graph.mjs";
import * as git from "./git.mjs";
import { retainPolicy } from "./publication.mjs";

export function readJson(file, optional = false) {
  if (optional && !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}; preserve it and repair explicitly.`);
  }
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

export const graphFile = (ctx, id) => {
  requireValue(/^[a-z0-9][a-z0-9-]*$/.test(id), "Invalid graph ID.");
  return path.join(ctx.dir, "graphs", `${id}.json`);
};

export function load(ctx, id, optional = false) {
  const value = readJson(graphFile(ctx, id), optional);
  requireValue(!value || value.id === id, "Graph file identity mismatch; preserve and repair explicitly.");
  return value && validateGraph(value);
}

export function save(ctx, graph, plan) {
  validateGraph(graph);
  retainPolicy(ctx, graph, load(ctx, graph.id, true));
  validateGraph(graph);
  if (plan) {
    const before = load(ctx, graph.id, true);
    if (digest(before) !== digest(graph)) {
      const payload = { version: 1, operation: plan.approval, action: plan.action, before, after: graph };
      const id = digest(payload);
      const file = path.join(ctx.dir, "history", graph.id, `${id}.json`);
      if (!fs.existsSync(file)) {
        const snapshots = plan.action === "remove-retired" ? [] : [before, graph];
        const commits = new Set(snapshots.filter(Boolean).flatMap((g) => [
          g.targetSha, g.combined, g.source?.base, g.source?.head,
          ...g.nodes.flatMap((n) => [n.change.base, n.change.head, n.base, n.head,
            n.validation?.head, n.pr?.head, n.pr?.base, n.landing?.commit]),
        ]).filter(Boolean));
        const prefix = `refs/pr-graph/history/${graph.id}/`;
        const retained = new Map(git.out(ctx.root,
          ["for-each-ref", "--format=%(refname) %(objectname)", prefix])
          .split("\n").filter(Boolean).map((line) => line.split(" ")));
        git.withObjectView(ctx, (run, objects) => {
          const available = objects.commits([...commits]);
          for (const sha of commits) {
            if (available.get(sha)) {
              const existing = retained.get(`${prefix}${sha}`);
              requireValue(!existing || existing === sha, "Historical retention ref changed; inspect explicitly.");
              if (!existing) git.out(ctx.root, ["update-ref", `${prefix}${sha}`, sha, "0".repeat(sha.length)]);
            }
          }
        });
        atomicJson(file, { ...payload, id, recordedAt: ctx.now?.() ?? Date.now() });
      }
    }
  }
  atomicJson(graphFile(ctx, graph.id), graph);
}

export function lock(ctx, fn) {
  fs.mkdirSync(ctx.dir, { recursive: true });
  const file = path.join(ctx.dir, "mutation.lock");
  const token = digest({ pid: process.pid, host: os.hostname(), started: Date.now() });
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = readJson(file);
    throw new Error(`Repository locked: ${JSON.stringify(owner)}. Inspect the owner; explicit repair is required even for a stale lock.`);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: os.hostname() }));
    fs.fsyncSync(fd);
    return fn();
  } finally {
    fs.closeSync(fd);
    if (readJson(file).token === token) fs.unlinkSync(file);
  }
}

export function journalFile(ctx, id) {
  requireValue(/^[0-9a-f]{64}$/.test(id), "Invalid operation ID.");
  return path.join(ctx.dir, "operations", `${id}.json`);
}

export function journals(ctx, project = (journal) => journal) {
  const dir = path.join(ctx.dir, "operations");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
    .map((n) => project(readJson(path.join(dir, n))));
}
