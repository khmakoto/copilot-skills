import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fixture, git } from "./fixtures.mjs";
import { localBranches, refId, out, readObjects, withObjectView } from "../lib/git.mjs";
import { digest, prerequisites, topological } from "../lib/graph.mjs";
import { reference } from "./generated.mjs";
import { history } from "../lib/history.mjs";
import { inspect } from "../lib/operations.mjs";
import * as state from "../lib/state.mjs";

let sequence = 0;
function measure(f, action) {
  const file = path.join(f.dir, `trace-${++sequence}.jsonl`);
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = file;
  const started = performance.now();
  let value;
  try { value = action(); } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
  const elapsed = performance.now() - started;
  const commands = (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").split("\n")
    .filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.event === "start")
    .map((event) => event.argv.slice(1));
  return { value, commands, elapsed };
}

function graphFor(shape, size) {
  const nodes = Array.from({ length: size }, (_, i) => ({
    id: `n${String(i).padStart(3, "0")}`, branch: `nodes/${shape}/${i}`, retired: false,
    dependencies: shape === "chain" && i ? [`n${String(i - 1).padStart(3, "0")}`] :
      shape === "diamond" && i ? i === size - 1
        ? Array.from({ length: size - 2 }, (_, j) => `n${String(j + 1).padStart(3, "0")}`)
        : ["n000"] : [],
  }));
  return { nodes };
}

for (const shape of ["chain", "diamond", "wide"]) {
  test(`large ${shape} read phases reduce subprocess counts and preserve query results`, (t) => {
    const f = fixture({ names: ["a"] });
    t.after(() => f.dispose());
    const graph = graphFor(shape, 128);
    const branches = graph.nodes.map((node) => node.branch);
    out(f.root, ["update-ref", "--stdin"], branches.map((branch) =>
      `create refs/heads/${branch} ${f.head}`).join("\n") + "\n");
    const names = [...branches, "missing"];
    const baseline = measure(f, () => Object.fromEntries(names.map((branch) =>
      [branch, refId(f.root, `refs/heads/${branch}`)])));
    const batched = measure(f, () => localBranches(f.root, names));
    assert.deepEqual(batched.value, baseline.value);
    assert.equal(baseline.commands.length, branches.length * 2 + 1);
    assert.deepEqual(batched.commands.map((args) => args[0]), ["for-each-ref"]);
    const modelStarted = performance.now();
    const model = reference(graph);
    const expected = graph.nodes.map((node) => model.closure(node.id));
    const referenceMs = performance.now() - modelStarted;
    const queryStarted = performance.now();
    for (let pass = 0; pass < 3; pass++) {
      assert.deepEqual(topological(graph).map((node) => node.id), model.order);
      assert.deepEqual(graph.nodes.map((node) => prerequisites(graph, node.id).map((n) => n.id)), expected);
    }
    const queryMs = performance.now() - queryStarted;
    t.diagnostic(`${shape}, ${branches.length} nodes: refs ${baseline.commands.length} -> ${batched.commands.length} Git processes; ` +
      `${baseline.elapsed.toFixed(1)} -> ${batched.elapsed.toFixed(1)} ms. ` +
      `Graph reference ${referenceMs.toFixed(1)} ms; three cached-query passes ${queryMs.toFixed(1)} ms.`);
  });
}

test("history batches retained commit availability and scopes immutable reuse to one read phase", (t) => {
  const f = fixture({ names: ["a"] });
  t.after(() => f.dispose());
  const { graph: initial } = f.apply("split", { spec: f.spec });
  const commits = [f.base, f.head, initial.nodes[0].head];
  const tree = git(f.root, "rev-parse", `${f.head}^{tree}`);
  let graph = initial;
  for (let i = 0; i < 24; i++) {
    const head = git(f.root, "commit-tree", tree, "-p", commits.at(-1), "-m", `version ${i}`);
    commits.push(head);
    const after = structuredClone(graph);
    after.revision++;
    after.nodes[0].head = head;
    const payload = { version: 1, operation: digest(i), action: "sync", before: graph, after };
    const id = digest(payload);
    state.atomicJson(path.join(f.ctx.dir, "history", graph.id, `${id}.json`), {
      ...payload, id, recordedAt: i,
    });
    graph = after;
  }
  state.atomicJson(state.graphFile(f.ctx, graph.id), graph);
  const baseline = measure(f, () => withObjectView(f.ctx, (run) =>
    commits.map((id) => run(["cat-file", "-e", `${id}^{commit}`]).status === 0)));
  const timeline = measure(f, () => history(f.ctx, graph.id, "a"));
  assert.ok(baseline.value.every(Boolean));
  assert.ok(timeline.value.versions.every((v) => !v.missingCommits.length));
  assert.equal(timeline.commands.filter((args) => args[0] === "cat-file").length, 1);
  assert.ok(timeline.commands.some((args) => args[1] === "--batch-check"));
  const immutable = measure(f, () => {
    const objects = readObjects(f.root);
    const trees = objects.trees(commits);
    for (const id of commits) {
      objects.trees([id]);
      objects.ancestor(f.base, id);
      objects.ancestor(f.base, id);
    }
    return trees;
  });
  assert.equal(immutable.commands.filter((args) => args[0] === "cat-file").length, 1);
  assert.equal(immutable.commands.filter((args) => args[0] === "merge-base").length, new Set(commits).size);
  t.diagnostic(`${commits.length} retained commits: availability ${baseline.commands.length} -> ` +
    `${timeline.commands.length} Git processes (including object-view setup); ` +
    `${baseline.elapsed.toFixed(1)} ms baseline availability, ${timeline.elapsed.toFixed(1)} ms full history. ` +
    `Batched trees and repeated ancestry: ${immutable.commands.length} processes, ${immutable.elapsed.toFixed(1)} ms.`);
});

test("freshness inspection reuses full-ID ancestry only within each live observation", (t) => {
  const f = fixture({ names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  git(f.root, "branch", "main", f.base);
  f.spec.target = "main";
  const { graph } = f.apply("split", { spec: f.spec });
  git(f.root, "update-ref", "refs/heads/main", f.head);
  const observed = measure(f, () => inspect(f.ctx, graph.id));
  assert.ok(Object.values(observed.value.freshness).every((f) => f.integration.status === "grace"));
  assert.equal(observed.commands.filter((args) => args[0] === "merge-base").length, 1);
  assert.equal(observed.commands.filter((args) => args[1] === "--batch-check").length, 1);
  git(f.root, "replace", "--graft", f.head);
  const next = measure(f, () => inspect(f.ctx, graph.id));
  assert.ok(Object.values(next.value.freshness).every((f) => f.integration.status === "stale"));
  assert.equal(next.commands.filter((args) => args[0] === "merge-base").length, 1);
});
