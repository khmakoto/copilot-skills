import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireValue } from "./graph.mjs";

export function run(command, args, cwd, input) {
  requireValue(typeof command === "string" && Array.isArray(args), "Invalid command.");
  const result = spawnSync(command, args, {
    cwd, input, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
    shell: false, windowsHide: true,
    env: {
      ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
      ...(command === "az" ? { AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no" } : {}),
    },
  });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}. Use an installed executable and explicit argv; shell wrappers are not expanded automatically.`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function git(cwd, args, input, allowFailure = false) {
  const result = run("git", args, cwd, input);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

export const out = (cwd, args, input) => git(cwd, args, input).stdout.trim();

export function commitId(cwd, ref) {
  requireValue(typeof ref === "string" && ref && !ref.startsWith("-"), "Invalid commit reference.");
  return out(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export const tree = (cwd, ref) => out(cwd, ["rev-parse", "--verify", `${ref}^{tree}`]);

export function refId(cwd, ref) {
  const result = git(cwd, ["show-ref", "--verify", "--quiet", ref], undefined, true);
  requireValue([0, 1].includes(result.status), result.stderr);
  return result.status === 0 ? out(cwd, ["rev-parse", "--verify", ref]) : null;
}

export function checkBranch(cwd, name) {
  requireValue(typeof name === "string" && !name.startsWith("-"), "Invalid branch.");
  out(cwd, ["check-ref-format", `refs/heads/${name}`]);
  return name;
}

export function context(cwd = process.cwd()) {
  const root = out(cwd, ["rev-parse", "--show-toplevel"]);
  const common = out(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { root, common, dir: path.join(common, "pr-graph") };
}

export function remoteRefs(cwd, remote) {
  if (!remote) return {};
  const output = out(cwd, ["ls-remote", "--heads", "--", remote]);
  return Object.fromEntries(output.split("\n").filter(Boolean).map((l) => {
    const [sha, ref] = l.split(/\s+/);
    return [ref, sha];
  }));
}

export function remoteConfig(cwd, name) {
  if (name === null) return { name: null, url: null, target: null };
  const remotes = out(cwd, ["remote"]).split("\n").filter(Boolean);
  if (!remotes.length) {
    requireValue(!name, `Remote does not exist: ${name}`);
    return { name: null, url: null, target: null };
  }
  const selected = name ?? (remotes.length === 1 ? remotes[0] : null);
  requireValue(selected && remotes.includes(selected), "Multiple remotes: specify remote explicitly.");
  const url = out(cwd, ["remote", "get-url", selected]);
  if (/^[a-z]+:\/\//i.test(url)) {
    const parsed = new URL(url);
    requireValue(!parsed.password && (!parsed.username || parsed.protocol === "ssh:"),
      "Use a remote without embedded credentials.");
  }
  const sym = out(cwd, ["ls-remote", "--symref", "--", selected, "HEAD"]);
  const target = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(sym)?.[1] ?? null;
  return { name: selected, url, target };
}

export function occupied(cwd, branch) {
  const entries = out(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0\0");
  return entries.some((entry) => entry.split("\0").includes(`branch refs/heads/${branch}`));
}

export function writeBranch(cwd, branch, sha, expected) {
  checkBranch(cwd, branch);
  requireValue(!occupied(cwd, branch), `Branch is checked out in a user worktree: ${branch}`);
  const current = refId(cwd, `refs/heads/${branch}`);
  if (current === sha) return;
  requireValue(current === expected, `Local branch changed: ${branch}`);
  const zero = "0".repeat(sha.length);
  out(cwd, ["update-ref", `refs/heads/${branch}`, sha, expected ?? zero]);
}

export function createWorktree(ctx, operationId, base) {
  const dir = path.join(ctx.dir, "trees", operationId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    out(ctx.root, ["worktree", "add", "--detach", dir, base]);
  }
  requireValue(out(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) === ctx.common,
    "Operation worktree belongs to another repository.");
  return dir;
}

export function operationWorktreeInfo(ctx, dir) {
  requireValue(path.dirname(dir) === path.join(ctx.dir, "trees") &&
    /^[0-9a-f]{64}$/.test(path.basename(dir)) &&
    fs.existsSync(dir) && !fs.lstatSync(dir).isSymbolicLink(),
  "Reuse requires an existing tool-owned operation worktree.");
  requireValue(out(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) === ctx.common,
    "Operation worktree belongs to another repository.");
  requireValue(path.resolve(out(dir, ["rev-parse", "--show-toplevel"])) === dir,
    "Operation worktree root changed.");
  const entry = out(ctx.root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")
    .map((item) => item.split("\0")).find((item) =>
      item[0].startsWith("worktree ") && path.resolve(item[0].slice(9)) === dir);
  requireValue(entry?.includes("detached") &&
    !entry.some((item) => item === "locked" || item.startsWith("locked ")),
  "Reuse requires a registered, detached, unlocked operation worktree.");
  return { path: dir, head: commitId(dir, "HEAD"),
    gitDir: out(dir, ["rev-parse", "--absolute-git-dir"]) };
}

export function checkoutClean(cwd, sha) {
  requireValue(!out(cwd, ["status", "--porcelain", "--untracked-files=all"]), `Operation worktree has changes: ${cwd}`);
  out(cwd, ["checkout", "--detach", sha]);
}

export function commitStaged(cwd, message) {
  requireValue(git(cwd, ["diff", "--cached", "--quiet"], undefined, true).status === 1, "Change produces no delta.");
  const expectedTree = out(cwd, ["write-tree"]);
  out(cwd, ["commit", "-F", "-"], message);
  const sha = commitId(cwd, "HEAD");
  requireValue(tree(cwd, sha) === expectedTree, "Commit hooks changed the approved tree; inspect and replan.");
  requireValue(!out(cwd, ["status", "--porcelain"]), "Commit hooks left worktree changes; inspect before continuing.");
  return sha;
}

export function pin(cwd, operationId, key, sha) {
  out(cwd, ["update-ref", `refs/pr-graph/${operationId}/${key}`, sha]);
}

export function ancestor(cwd, before, after) {
  const result = git(cwd, ["merge-base", "--is-ancestor", before, after], undefined, true);
  requireValue([0, 1].includes(result.status), result.stderr);
  return result.status === 0;
}
