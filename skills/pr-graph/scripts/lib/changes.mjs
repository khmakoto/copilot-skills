import { digest, requireValue, prerequisites, topological, helperBranch } from "./graph.mjs";
import * as git from "./git.mjs";
import { nodeDetails, step } from "./progress.mjs";

export function normalizeChange(cwd, change) {
  requireValue(change && typeof change === "object", "Missing change.");
  const base = git.commitId(cwd, change.base);
  const head = change.head ? git.commitId(cwd, change.head) : null;
  requireValue(!change.paths || (
    Array.isArray(change.paths) && change.paths.length > 0 &&
    change.paths.every((p) => typeof p === "string" && !p.startsWith("/") &&
      !p.split(/[\\/]/).includes(".."))
  ), "Invalid path selection.");
  requireValue(typeof change.patch === "string" || head, "Change needs head or a full-index Git patch.");
  const patch = change.patch ?? git.git(cwd, [
    "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv",
    "--no-renames", base, head, "--", ...(change.paths ?? []),
  ]).stdout;
  requireValue(patch.trim(), "Empty own-change patch.");
  requireValue(patch.startsWith("diff --git ") && !patch.includes("\0"), "Expected a Git binary/full-index patch.");
  return { base, head, patch, fingerprint: digest({ base, patch }) };
}

export function applyChange(cwd, change, title) {
  const result = git.git(cwd, ["apply", "--3way", "--index", "--whitespace=nowarn", "-"], change.patch, true);
  if (result.status !== 0) {
    throw new Error(`Change conflict in ${cwd}: ${result.stderr.trim()}. Resolve and stage only the approved change; create a resolution approval before continuing.`);
  }
  return git.commitStaged(cwd, title);
}

export function compose(cwd, base, nodes, apply = applyChange) {
  git.checkoutClean(cwd, base);
  for (const node of nodes) {
    if (!node.landing && !node.retired) apply(cwd, node.change, node.title);
  }
  return git.commitId(cwd, "HEAD");
}

export function realize(cwd, graph, target, previous, onNode, apply = applyChange) {
  const results = [];
  for (const node of topological(graph)) {
    if (node.landing || node.retired) continue;
    step("Reconstructing branch (reusing unchanged snapshots where possible)", () => {
      node.integration = graph.integration ? { ...graph.integration } : { target: graph.target, sha: target };
      const deps = prerequisites(graph, node.id);
      const baseBranch = deps.some((n) => !n.landing) ? helperBranch(graph, node.id) : graph.target;
      const signature = digest({
        target, own: node.change, deps: deps.filter((n) => !n.landing).map((n) => [n.id, n.change]),
      });
      const old = previous?.nodes.find((n) => n.id === node.id);
      if (old?.signature === signature && old.head && old.base) {
        node.base = old.base;
        node.head = old.head;
        node.signature = signature;
        node.validation = old.validation;
        node.baseBranch = baseBranch;
        if (baseBranch !== old.baseBranch) {
          node.ready = false;
          node.requiresDraft = true;
        }
        results.push(node);
        onNode(node);
        return;
      }
      const base = compose(cwd, target, deps, apply);
      const head = apply(cwd, node.change, node.title);
      node.base = base;
      node.head = head;
      node.signature = signature;
      node.validation = null;
      node.baseBranch = baseBranch;
      node.ready = false;
      node.requiresDraft = true;
      results.push(node);
      onNode(node);
    }, nodeDetails(graph, node));
  }
  return results;
}

export function verifyComposition(cwd, graph, target, expected, apply = applyChange) {
  return step("Verifying whole-graph composition", () => {
    const combined = compose(cwd, target, topological(graph), apply);
    if (expected) {
      requireValue(git.tree(cwd, combined) === git.tree(cwd, expected),
        `Graph is not lossless: reconstructed tree differs from ${expected}. No product refs may be published.`);
    }
    return combined;
  });
}
