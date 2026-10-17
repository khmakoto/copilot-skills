import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { out, context, run } from "../lib/git.mjs";
import { createPlan, applyPlan } from "../lib/operations.mjs";

export const git = (cwd, ...args) => out(cwd, args);

export function fixture({ remote = false, names = ["a", "b", "c", "d", "e", "f"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-graph-test-"));
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "trunk");
  git(root, "config", "user.name", "Graph Test");
  git(root, "config", "user.email", "graph@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  const text = (selected) => names.map((n) =>
    [`${n}=${selected.includes(n) ? 1 : 0}`, ...Array.from({ length: 8 }, (_, i) => `${n} context ${i}`)].join("\n")
  ).join("\n") + "\n";
  fs.writeFileSync(path.join(root, "shared.txt"), text([]));
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  const base = git(root, "rev-parse", "HEAD");
  const changes = {};
  for (const name of names) {
    git(root, "checkout", "-qb", `input-${name}`, base);
    fs.writeFileSync(path.join(root, "shared.txt"), text([name]));
    git(root, "add", ".");
    git(root, "commit", "-qm", `change ${name}`);
    changes[name] = { base, head: git(root, "rev-parse", "HEAD") };
  }
  git(root, "checkout", "-qb", "source", base);
  fs.writeFileSync(path.join(root, "shared.txt"), text(names));
  git(root, "add", ".");
  git(root, "commit", "-qm", "complete feature");
  const head = git(root, "rev-parse", "HEAD");
  let bare;
  if (remote) {
    bare = path.join(dir, "remote.git");
    fs.mkdirSync(bare);
    git(bare, "init", "--bare", "-q", "-b", "trunk");
    git(bare, "config", "user.name", "Graph Test");
    git(bare, "config", "user.email", "graph@example.invalid");
    git(bare, "config", "commit.gpgsign", "false");
    git(root, "remote", "add", "upstream", bare);
    git(root, "push", "-q", "upstream", "trunk");
  }
  const deps = { a: [], b: [], c: ["a", "b"], d: ["b"], e: [], f: ["c", "d", "e"] };
  const spec = {
    id: "example", target: "trunk", ...(remote ? { remote: "upstream" } : {}),
    source: { base, head },
    nodes: names.map((id) => ({
      id, title: `Implement ${id}`, dependencies: (deps[id] ?? []).filter((n) => names.includes(n)),
      change: changes[id], validations: [], validationReason: "Fixture has no build system.",
    })),
  };
  const ctx = context(root);
  return {
    root, dir, bare, ctx, spec, changes, base, head, text,
    apply(action, options = {}) {
      const plan = createPlan(ctx, action, options);
      return applyPlan(ctx, plan, plan.approval, true);
    },
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function cli(root, ...args) {
  return run(process.execPath, [path.resolve(import.meta.dirname, "../pr-graph.mjs"), "--repo", root, ...args], root);
}
