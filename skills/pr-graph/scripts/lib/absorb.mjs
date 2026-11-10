import { digest, requireValue, prerequisites, topological } from "./graph.mjs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { normalizeChange } from "./changes.mjs";

const diffOptions = ["--binary", "--full-index", "--no-ext-diff", "--no-textconv",
  "--no-renames", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];

function paths(cwd, base, head) {
  return git.git(cwd, ["diff", "--name-only", "--no-renames", "-z", base, head]).stdout
    .split("\0").filter(Boolean);
}

export function inspectAbsorb(ctx, graphId, base, head) {
  const graph = state.load(ctx, graphId);
  requireValue(graph.combined, "Absorb requires a realized graph.");
  const change = normalizeChange(ctx.root, { base, head });
  requireValue(git.tree(ctx.root, change.base) === git.tree(ctx.root, graph.combined),
    "Follow-up base must equal the current combined tree; explicitly prepare a source first.");
  const patch = git.git(ctx.root, ["diff", ...diffOptions, change.base, change.head]).stdout;
  const files = paths(ctx.root, change.base, change.head);
  const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
  requireValue(files.length === sections.length, "Cannot inventory follow-up file patches.");
  const provenance = graph.nodes.map((node) => ({
    id: node.id, state: node.retired ? "retired" : node.landing ? "landed" : "active",
    dependencies: node.dependencies, base: node.base, head: node.head, change: node.change,
    paths: git.withObjectView(ctx, (run) => {
      const read = run(["read-tree", node.change.base]);
      requireValue(read.status === 0, read.stderr);
      const applied = run(["apply", "--cached", "--whitespace=nowarn", "-"], node.change.patch);
      requireValue(applied.status === 0, applied.stderr);
      const result = run(["diff", "--cached", "--name-only", "--no-renames", "-z", node.change.base]);
      requireValue(result.status === 0, result.stderr);
      return result.stdout.split("\0").filter(Boolean);
    }),
  }));
  const units = sections.flatMap((section, index) => {
    const candidates = provenance.filter((node) => node.paths.includes(files[index])).map((node) => node.id);
    const hunkStart = section.search(/^@@ /m);
    const atomic = hunkStart < 0 ||
      /^(?:new file mode|deleted file mode|old mode|new mode|GIT binary patch|Binary files)/m.test(section);
    const header = atomic ? "" : section.slice(0, hunkStart);
    const bodies = atomic ? [section] : section.slice(hunkStart).split(/(?=^@@ )/m).filter(Boolean);
    return bodies.map((body) => ({
      id: digest({ base: change.base, head: change.head, path: files[index], header, body }),
      path: files[index], kind: atomic ? "whole-file" : "hunk", header, body,
      candidates,
      suggestedOwner: !atomic && candidates.length === 1 &&
        provenance.find((node) => node.id === candidates[0]).state === "active" ? candidates[0] : null,
      owner: null,
      reason: atomic ? "Binary, new/deleted file, mode or other indivisible change needs an explicit decision." :
        candidates.length === 1 ? "Path provenance is evidence only; inspect the retained patch and dependency context." :
          "Shared or unknown path ownership; leave unassigned until a semantic decision.",
    }));
  });
  return {
    graph: graph.id, graphDigest: digest(graph),
    followUp: { base: change.base, head: change.head, patch, fingerprint: digest(patch) },
    expectedTree: git.tree(ctx.root, change.head), provenance, units,
    warning: "Suggestions are not assignments or authorization. No staging, commits, ref changes, or inferred edges.",
  };
}

export function planAbsorb(ctx, previous, graph, spec, source) {
  requireValue(spec.followUp?.base && spec.followUp?.head && source,
    "Absorb requires followUp.base/head and an explicit source.base/head.");
  const inventory = inspectAbsorb(ctx, previous.id, spec.followUp.base, spec.followUp.head);
  requireValue(source.head === inventory.followUp.head,
    "Absorb source.head must be the pinned follow-up head.");
  requireValue(graph.nodes.length === previous.nodes.length && graph.nodes.every((node) => {
    const old = previous.nodes.find((n) => n.id === node.id);
    return old && node.retired === old.retired &&
      digest(node.dependencies) === digest(old.dependencies) &&
      digest(node.supersedes) === digest(old.supersedes);
  }), "Absorb preserves identities and dependency edges; use separate add/split/fold/deps plans for reshaping.");
  requireValue(graph.helperBranchPrefix === previous.helperBranchPrefix &&
    digest(graph.backup) === digest(previous.backup),
  "Absorb cannot change helper namespaces or backup configuration.");
  requireValue(Array.isArray(spec.allocations) && spec.allocations.length === inventory.units.length,
    "Assign every follow-up unit exactly once; unassigned edits block application.");
  const assigned = new Set();
  const allocations = spec.allocations.map((allocation) => {
    const unit = inventory.units.find((item) => item.id === allocation.unit);
    const owner = graph.nodes.find((node) => node.id === allocation.node);
    requireValue(unit && !assigned.has(unit.id), "Unknown or duplicate follow-up unit.");
    requireValue(owner && !owner.retired && !owner.landing,
      "Allocation requires an active unlanded owner; landed/retired ownership needs a separate explicit decision.");
    requireValue(typeof allocation.evidence === "string" && allocation.evidence.trim() &&
      typeof allocation.rationale === "string" && allocation.rationale.trim(),
    "Each assignment needs evidence and a semantic rationale, including ambiguous or indivisible edits.");
    assigned.add(unit.id);
    return { ...unit, node: owner.id, evidence: allocation.evidence, rationale: allocation.rationale };
  }).sort((a, b) => inventory.units.findIndex((unit) => unit.id === a.id) -
    inventory.units.findIndex((unit) => unit.id === b.id));
  const owners = [...new Set(allocations.map((unit) => unit.node))];
  for (const old of previous.nodes) {
    if (!owners.includes(old.id)) {
      requireValue(digest(old.change) === digest(graph.nodes.find((node) => node.id === old.id).change),
        `Own change modified without an allocation: ${old.id}`);
    }
  }
  const affected = topological(graph).filter((node) => !node.retired && !node.landing &&
    (owners.includes(node.id) || prerequisites(graph, node.id).some((n) => owners.includes(n.id))))
    .map((node) => node.id);
  return { ...inventory, allocations, owners, affected,
    identities: graph.nodes.map((node) => ({ id: node.id, branch: node.branch, preserved: true })),
    dependencyChanges: [],
    publication: "Local reconstruction only; remote refs, PRs, publication and readiness require separate plans.",
  };
}

export function verifyAbsorb(cwd, graph, previous, allocation, apply) {
  requireValue(git.tree(cwd, previous.combined) === git.tree(cwd, allocation.followUp.base),
    "Follow-up base no longer matches the original combined tree.");
  for (const id of allocation.owners) {
    const old = previous.nodes.find((node) => node.id === id);
    const node = graph.nodes.find((item) => item.id === id);
    requireValue(!node.landing && !node.retired, `Absorb owner became inactive: ${id}`);
    const files = new Map();
    for (const unit of allocation.allocations.filter((item) => item.node === id)) {
      if (!files.has(unit.path)) files.set(unit.path, { header: unit.header, bodies: [] });
      files.get(unit.path).bodies.push(unit.body);
    }
    const patch = [...files.values()].map(({ header, bodies }) => header + bodies.join("")).join("");
    git.checkoutClean(cwd, old.head);
    const expected = apply(cwd, { base: allocation.followUp.base, patch }, `Allocate follow-up to ${id}`);
    git.checkoutClean(cwd, old.base);
    const actual = apply(cwd, node.change, node.title);
    requireValue(git.tree(cwd, actual) === git.tree(cwd, expected),
      `Absorb ownership mismatch for ${id}; replacement own change differs from its assigned edits.`);
  }
}
