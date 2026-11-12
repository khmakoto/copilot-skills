import assert from "node:assert/strict";

export function random(seed) {
  let state = seed >>> 0;
  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * limit);
  };
}

export function seeds(count) {
  const override = process.env.PR_GRAPH_TEST_SEED;
  if (override === undefined) return Array.from({ length: count }, (_, i) => i + 1);
  assert.match(override, /^\d+$/, "PR_GRAPH_TEST_SEED must be a uint32");
  const seed = Number(override);
  assert.ok(Number.isInteger(seed) && seed <= 0xffffffff, "PR_GRAPH_TEST_SEED must be a uint32");
  return [seed];
}

export function generatedCase(seed, input, check) {
  try {
    return check();
  } catch (error) {
    error.message += `\nPR_GRAPH_TEST_SEED=${seed}\nReproducer: ${JSON.stringify(input)}`;
    throw error;
  }
}

export function dag(seed, size = 4 + seed % 6) {
  const pick = random(seed);
  const nodes = Array.from({ length: size }, (_, i) => {
    const id = `n${String(i).padStart(2, "0")}`;
    return {
      id, title: id, branch: `nodes/${id}`,
      dependencies: Array.from({ length: i }, (_, j) => `n${String(j).padStart(2, "0")}`)
        .filter(() => pick(3) === 0),
      change: { base: "base", patch: `patch-${id}` },
      ...(pick(5) === 0 ? { retired: true } : {}),
      ...(pick(4) === 0 ? { landing: { commit: "landed" } } : {}),
      ...(pick(3) === 0 ? { pr: { id: i + 1 } } : {}),
    };
  });
  // Always include a shared ancestor; extra edges and inactive states vary.
  nodes[1].dependencies = [nodes[0].id];
  nodes[2].dependencies = [nodes[0].id];
  nodes[3].dependencies = [nodes[1].id, nodes[2].id];
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
  }
  return { version: 1, id: "generated", target: "trunk", nodes };
}

export function reference(graph) {
  const ids = graph.nodes.map((n) => n.id).sort();
  const node = (id) => graph.nodes.find((n) => n.id === id);
  const reaches = Object.fromEntries(ids.map((id) => [id, new Set(node(id).dependencies)]));
  // Fixed-point transitive closure, independent of production's recursive walk.
  let changed;
  do {
    changed = false;
    for (const id of ids) {
      for (const dep of [...reaches[id]]) {
        for (const ancestor of reaches[dep]) {
          if (!reaches[id].has(ancestor)) {
            reaches[id].add(ancestor);
            changed = true;
          }
        }
      }
    }
  } while (changed);
  // Expand all sorted paths, then keep the first occurrence of each node.
  // Unlike production this deliberately repeats shared ancestor work.
  const expand = (id) => [...[...node(id).dependencies].sort().flatMap(expand), id];
  const order = [...new Set(ids.flatMap(expand))];
  const closure = (id) => order.filter((dep) => reaches[id].has(dep));
  const eligible = (id) => !node(id).retired && !node(id).landing &&
    closure(id).every((dep) => node(dep).landing);
  const select = (selector, facts = {}) => {
    const [kind, root] = selector.split(":");
    const nodes = [], excluded = [];
    for (const id of order) {
      const n = node(id);
      let reason = n.retired ? "retired" : n.landing ? "landed" : null;
      if (!reason) {
        if (kind === "node" || kind === "dependents") {
          if (id !== root && !(kind === "dependents" && reaches[id].has(root))) reason = "outside selection";
        } else if (kind === "eligible") {
          if (!eligible(id)) reason = "unlanded prerequisites";
        } else if (n.pr || facts.prs?.[id] ||
          (graph.repository?.provider?.kind === "local" && facts.remote?.[n.branch])) {
          reason = "already published";
        }
      }
      if (reason) excluded.push({ id, reason });
      else nodes.push(id);
    }
    return { selector, nodes, excluded };
  };
  return { order, closure, eligible, select };
}
