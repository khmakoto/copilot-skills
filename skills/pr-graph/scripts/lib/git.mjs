import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./graph.mjs";

export function run(command, args, cwd, input, env = {}, encoding = "utf8") {
  requireValue(typeof command === "string" && Array.isArray(args), "Invalid command.");
  const result = spawnSync(command, args, {
    cwd, input, encoding, maxBuffer: 128 * 1024 * 1024,
    shell: false, windowsHide: true,
    env: {
      ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
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

export function withObjectView(ctx, fn, { isolated = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-graph-objects-"));
  try {
    const repository = path.join(temp, "repo.git");
    const config = path.join(temp, "empty-config");
    fs.writeFileSync(config, "");
    const env = {
      GIT_DIR: repository, GIT_WORK_TREE: undefined,
      GIT_COMMON_DIR: undefined, GIT_NAMESPACE: undefined, GIT_SHALLOW_FILE: undefined,
      GIT_INDEX_FILE: path.join(temp, "index"), GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: isolated ? undefined : JSON.stringify(out(ctx.root,
        ["rev-parse", "--path-format=absolute", "--git-path", "objects"])),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG: undefined, GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
    };
    const format = out(ctx.root, ["rev-parse", "--show-object-format"]);
    const initialized = run("git", ["init", "--bare", "--template=", `--object-format=${format}`, repository], temp, undefined, env);
    requireValue(initialized.status === 0, initialized.stderr);
    // No remotes or source configuration: missing promisor objects cannot trigger
    // network access even on Git versions without GIT_NO_LAZY_FETCH support.
    const execute = (args, input, encoding) => run("git", args, temp, input, env, encoding);
    return fn(execute, objectReader(execute));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

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

export function refIds(cwd, refs) {
  requireValue(refs.every((ref) => typeof ref === "string" && ref.startsWith("refs/") &&
    !/[\x00-\x20\x7f~^:?*\\[]/.test(ref) && !ref.includes("..") &&
    !ref.includes("@{") && ref.split("/").every((part) =>
      part && !part.startsWith(".") && !part.endsWith(".lock")) && !ref.endsWith(".")),
  "Invalid full ref name.");
  if (!refs.length) return {};
  const namespaces = [...new Set(refs.map((ref) => ref.split("/").slice(0, 2).join("/")))];
  const result = run("git", ["for-each-ref", "--format=%(refname) %(objectname)", ...namespaces],
    cwd, undefined, { LC_ALL: "C" });
  requireValue(result.status === 0, `git for-each-ref failed (${result.status}): ${result.stderr.trim()}`);
  requireValue(!/warning: ignoring broken ref /.test(result.stderr),
    `Cannot observe local refs: ${result.stderr.trim()}`);
  const found = new Map(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const match = /^(refs\/[^ ]+) ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/.exec(line);
    requireValue(match, "Invalid local ref observation.");
    return [match[1], match[2]];
  }));
  return Object.fromEntries(refs.map((ref) => [ref, found.get(ref) ?? null]));
}

export function localBranches(cwd, branches) {
  const refs = refIds(cwd, branches.map((branch) => `refs/heads/${branch}`));
  return Object.fromEntries(branches.map((branch) => [branch, refs[`refs/heads/${branch}`]]));
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_QUERY = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\^\{(?:commit|tree)\})?$/;

export function readObjects(cwd) {
  return objectReader((args, input, encoding) => run("git", args, cwd, input, {}, encoding));
}

// Each reader belongs to one fixed repository/object view and one read boundary.
// Never carry it across mutations, fetches, or required revalidation.
export function objectReader(execute) {
  const metadata = new Map();
  const ancestry = new Map();
  const inspect = (ids) => {
    requireValue(ids.every((id) => typeof id === "string" && OBJECT_QUERY.test(id)),
      "Object reads require full immutable IDs.");
    const pending = [...new Set(ids)].filter((id) => !metadata.has(id));
    const found = new Map();
    for (let offset = 0; offset < pending.length; offset += 1024) {
      const queries = pending.slice(offset, offset + 1024);
      const result = execute(["cat-file", "--batch-check"], `${queries.join("\n")}\n`);
      requireValue(result.status === 0, `Cannot inspect Git objects: ${result.stderr}`);
      const lines = result.stdout.split("\n");
      requireValue(lines.pop() === "" && lines.length === queries.length, "Invalid Git object batch response.");
      lines.forEach((line, i) => {
        const query = queries[i];
        if (line === `${query} missing`) {
          found.set(query, null);
          return;
        }
        const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|tree|commit|tag) (\d+)$/.exec(line);
        requireValue(match && Number.isSafeInteger(Number(match[3])) &&
          (query.endsWith("^{commit}") ? match[2] === "commit" :
            query.endsWith("^{tree}") ? match[2] === "tree" : match[1] === query),
        "Invalid Git object batch metadata.");
        metadata.set(query, Object.freeze({ id: match[1], type: match[2], size: Number(match[3]) }));
      });
    }
    return new Map(ids.map((id) => [id, metadata.get(id) ?? found.get(id) ?? null]));
  };
  return {
    inspect,
    commits(ids) {
      const valid = [...new Set(ids)].filter((id) => typeof id === "string" && OID.test(id));
      const info = inspect(valid.map((id) => `${id}^{commit}`));
      return new Map(ids.map((id) => [id, Boolean(info.get(`${id}^{commit}`))]));
    },
    trees(ids) {
      requireValue(ids.every((id) => typeof id === "string" && OID.test(id)), "Trees require full commit IDs.");
      const trees = inspect(ids.map((id) => `${id}^{tree}`));
      return new Map(ids.map((id) => {
        const info = trees.get(`${id}^{tree}`);
        requireValue(info, `Missing/invalid commit tree: ${id}`);
        return [id, info.id];
      }));
    },
    ancestor(before, after) {
      requireValue([before, after].every((id) => typeof id === "string" && OID.test(id)),
        "Ancestry requires full commit IDs.");
      const key = `${before} ${after}`;
      if (!ancestry.has(key)) {
        const result = execute(["merge-base", "--is-ancestor", before, after]);
        requireValue([0, 1].includes(result.status), result.stderr);
        ancestry.set(key, result.status === 0);
      }
      return ancestry.get(key);
    },
  };
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
