import { test } from "node:test";
import assert from "node:assert/strict";
import { githubProvider } from "../lib/providers/github.mjs";
import { adoProvider } from "../lib/providers/ado.mjs";
import { resolveProvider } from "../lib/providers/index.mjs";
import { fixture, git } from "./fixtures.mjs";
import { createPlan, applyPlan, inspect } from "../lib/operations.mjs";

test("provider detection handles GitHub, GHES, ADO SSH/HTTPS and local Git", () => {
  assert.equal(resolveProvider("git@github.com:me/repo.git").kind, "github");
  assert.equal(resolveProvider("ssh://git@enterprise.example/me/repo.git", { kind: "github" }).host, "enterprise.example");
  assert.deepEqual(resolveProvider("git@ssh.dev.azure.com:v3/org/project/repo"), {
    kind: "ado", host: "dev.azure.com", organization: "org", project: "project", repo: "repo",
  });
  assert.equal(resolveProvider("https://org.visualstudio.com/project/_git/repo").organization, "org");
  assert.equal(resolveProvider("/tmp/remote.git").kind, "local");
  assert.throws(() => resolveProvider("https://unknown.example/a/b"), /Unknown hosting/);
});

test("GitHub native adapter paginates, uses host-specific APIs and fails closed on policies", () => {
  const calls = [];
  let draft = true;
  const raw = () => ({
    number: 3, node_id: "PR_node", html_url: "https://enterprise.example/o/r/pull/3",
    title: "Feature", body: "Human", draft, state: "open",
    head: { ref: "feature", sha: "h", repo: { id: 1, full_name: "o/r" } },
    base: { ref: "trunk", sha: "b", repo: { id: 1 } },
  });
  let clean = false;
  const runner = (cmd, args, cwd, input) => {
    calls.push({ cmd, args, input });
    const endpoint = args[3];
    let result;
    if (cmd === "gh" && args[0] === "pr") result = {
      mergeStateStatus: clean ? "CLEAN" : "UNKNOWN", reviewDecision: "", statusCheckRollup: [],
    };
    else if (endpoint === "graphql") { draft = false; result = { data: {} }; }
    else if (endpoint.includes("/files?")) result = [[{ filename: "x", previous_filename: "y" }]];
    else if (endpoint.includes("?state=")) result = [[raw()]];
    else if (endpoint.endsWith("/pulls/3")) result = raw();
    else result = { permissions: { push: true }, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true };
    return { status: 0, stdout: JSON.stringify(result), stderr: "" };
  };
  const provider = githubProvider({ host: "enterprise.example", owner: "o", repo: "r" }, ".", runner);
  assert.equal(provider.capabilities().strategies.length, 3);
  assert.equal(provider.find("feature").id, 3);
  assert.deepEqual(provider.diffPaths(3), ["x", "y"]);
  assert.equal(provider.policies(3).ok, false);
  clean = true;
  assert.equal(provider.policies(3).ok, true);
  assert.equal(provider.update(3, { draft: false }).draft, false);
  assert.ok(calls.filter((c) => c.args[0] === "api").every((c) => c.args.includes("enterprise.example")));
  assert.ok(calls.some((c) => c.args.includes("--paginate") && c.args.includes("--slurp")));
});

test("ADO retarget readback refuses ignored updates and never exports credentials", () => {
  const calls = [];
  let target = "refs/heads/helper";
  let accept = false;
  const raw = () => ({
    pullRequestId: 2, title: "Title", description: "Human", isDraft: true, status: "active",
    sourceRefName: "refs/heads/feature", targetRefName: target,
    lastMergeSourceCommit: { commitId: "h" }, lastMergeTargetCommit: { commitId: "b" },
  });
  const runner = (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "rest" && accept) {
      const body = JSON.parse(args[args.indexOf("--body") + 1]);
      target = body.targetRefName;
    }
    return { status: 0, stdout: JSON.stringify(raw()), stderr: "" };
  };
  const provider = adoProvider({ host: "dev.azure.com", organization: "o", project: "p", repo: "r" }, ".", runner);
  assert.throws(() => provider.update(2, { baseBranch: "trunk" }), /retargeting unavailable/);
  accept = true;
  assert.equal(provider.update(2, { baseBranch: "trunk" }).baseBranch, "trunk");
  assert.ok(calls.every((c) => c.cmd === "az"));
  assert.ok(!calls.some((c) => c.args.includes("get-access-token")));
  assert.throws(() => provider.create({ title: "x" }, "x".repeat(4001)), /4000/);
});

function hostedFixture(f) {
  const records = new Map();
  let next = 1;
  let loseResponse = false;
  const bare = (...args) => git(f.root, `--git-dir=${f.bare}`, ...args);
  const get = (id) => {
    const stored = records.get(id);
    assert.ok(stored);
    const branches = Object.fromEntries(bare("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")
      .split("\n").filter(Boolean).map((line) => line.split(" ")));
    stored.head = branches[`refs/heads/${stored.branch}`] ?? stored.head;
    stored.base = branches[`refs/heads/${stored.baseBranch}`] ?? stored.base;
    return { ...stored };
  };
  const p = {
    kind: "github",
    capabilities: () => ({ drafts: true, retarget: true, strategies: ["merge", "squash", "rebase"] }),
    get,
    find: (branch) => {
      const item = [...records.values()].find((n) => n.branch === branch && n.state === "open");
      return item ? get(item.id) : null;
    },
    create(node, body) {
      const id = next++;
      records.set(id, {
        id, url: `https://host.invalid/pull/${id}`, title: node.title,
        body, branch: node.branch, baseBranch: node.baseBranch, draft: true, state: "open",
      });
      if (loseResponse) { loseResponse = false; throw new Error("Created PR but response was lost"); }
      return get(id);
    },
    update(id, fields) {
      Object.assign(records.get(id), fields);
      return get(id);
    },
    diffPaths(id) {
      const pr = get(id);
      return bare("diff", "--name-only", "--no-renames", pr.base, pr.head).split("\n").filter(Boolean).sort();
    },
    policies: () => ({ ok: true }),
    merge(id, expected, strategy) {
      const pr = get(id);
      assert.equal(pr.head, expected);
      const tree = bare("rev-parse", `${pr.head}^{tree}`);
      const parents = strategy === "merge" ? ["-p", pr.base, "-p", pr.head] : ["-p", pr.base];
      const sha = bare("commit-tree", tree, ...parents, "-m", "Hosted merge");
      bare("update-ref", `refs/heads/${pr.baseBranch}`, sha, pr.base);
      Object.assign(records.get(id), { state: "merged", landing: sha });
      return get(id);
    },
  };
  f.ctx.providerFactory = () => p;
  return { p, records, loseResponse: () => { loseResponse = true; } };
}

test("hosted lifecycle publishes all drafts, preserves human text, and gates ready/merge", (t) => {
  const f = fixture({ remote: true });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  let graph = f.apply("publish", { graph: "example" }).graph;
  assert.equal(host.records.size, 6);
  assert.ok([...host.records.values()].every((p) => p.draft));
  const b = graph.nodes.find((n) => n.id === "b");
  host.records.get(b.pr.id).body = `Human addition\n\n${host.records.get(b.pr.id).body}`;
  f.apply("sync", { graph: "example" });
  assert.ok(host.p.get(b.pr.id).body.startsWith("Human addition"));
  f.apply("ready", { graph: "example", node: "b" });
  f.apply("merge", { graph: "example", node: "b", strategy: "squash" });
  const result = f.apply("sync", { graph: "example" });
  assert.deepEqual(result.eligible, ["a", "d", "e"]);
  const d = result.graph.nodes.find((n) => n.id === "d");
  assert.equal(d.pr.baseBranch, "trunk");
  assert.equal(d.pr.draft, true);
  assert.ok(result.graph.nodes.find((n) => n.id === "c").pr.baseBranch.includes("/bases/"));
});

test("ambiguous PR creation resumes through an approved reconciliation without duplicates", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const plan = createPlan(f.ctx, "publish", { graph: "example" });
  host.loseResponse();
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /response was lost/);
  const recover = createPlan(f.ctx, "reconcile", { operation: plan.approval });
  applyPlan(f.ctx, recover, recover.approval, true);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(host.records.size, 1);
  assert.ok(result.graph.nodes[0].pr);
  assert.equal(inspect(f.ctx, "example").operations.find((j) => j.id === plan.approval).status, "done");
});

test("published folds preserve old PRs as superseded drafts until separately approved cleanup", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  f.apply("publish", { graph: "example" });
  f.apply("ready", { graph: "example", node: "a" });
  const folded = f.apply("fold", { graph: "example", spec: {
    id: "example", nodes: [{
      id: "ab", title: "Combined change", dependencies: [], supersedes: ["a", "b"],
      change: { base: f.base, head: f.head }, validationReason: "Fixture.",
    }],
  } });
  const retired = folded.graph.nodes.filter((n) => n.retired);
  assert.ok(retired.every((n) => host.p.get(n.pr.id).draft));
  const published = f.apply("publish", { graph: "example" });
  assert.equal(host.records.size, 3);
  const cleanup = f.apply("cleanup", { operation: published.operation,
    spec: { branches: [], remoteBranches: retired.map((n) => n.branch), closeRetired: retired.map((n) => n.id), worktree: true } });
  assert.ok(cleanup.cleaned.length > 0);
  assert.ok(retired.every((n) => host.p.get(n.pr.id).state === "closed"));
});
