import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { githubProvider } from "../lib/providers/github.mjs";
import { adoProvider } from "../lib/providers/ado.mjs";
import { resolveProvider } from "../lib/providers/index.mjs";
import { fixture, git, cli } from "./fixtures.mjs";
import { createPlan, applyPlan, inspect } from "../lib/operations.mjs";
import { git as gitResult } from "../lib/git.mjs";
import { setProgressSink } from "../lib/progress.mjs";

test("provider detection handles GitHub, GHES, ADO SSH/HTTPS and local Git", () => {
  assert.equal(resolveProvider("git@github.com:me/repo.git").kind, "github");
  assert.equal(resolveProvider("ssh://git@enterprise.example/me/repo.git", { kind: "github" }).host, "enterprise.example");
  assert.deepEqual(resolveProvider("git@ssh.dev.azure.com:v3/org/project/repo"), {
    kind: "ado", host: "dev.azure.com", organization: "org", project: "project", repo: "repo",
  });
  assert.equal(resolveProvider("https://org.visualstudio.com/project/_git/repo").organization, "org");
  assert.deepEqual(resolveProvider("https://org.visualstudio.com/DefaultCollection/project/_git/repo"),
    resolveProvider("https://org.visualstudio.com/project/_git/repo"));
  assert.throws(() => resolveProvider("https://org.visualstudio.com/OtherCollection/project/_git/repo"),
    /Invalid ADO remote/);
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

for (const host of ["github.com", "enterprise.example"]) {
  test(`GitHub ancestry on ${host} compares exact commits and fails closed on unavailable evidence`, () => {
    const before = "1".repeat(40), after = "2".repeat(40), common = "3".repeat(40);
    const calls = [];
    let result = { merge_base_commit: { sha: before } };
    let status = 0;
    const provider = githubProvider({ host, owner: "o", repo: "r" }, ".",
      (command, args) => {
        calls.push({ command, args });
        return { status, stdout: JSON.stringify(result), stderr: status ? "Resource not found" : "" };
      });
    assert.equal(provider.mergeBase(before, after), before);
    assert.deepEqual(calls[0], {
      command: "gh",
      args: ["api", "--hostname", host, `repos/o/r/compare/${before}...${after}?per_page=1`, "--method", "GET"],
    });
    result = { merge_base_commit: { sha: common } };
    assert.equal(provider.mergeBase(before, after), common);
    for (result of [null, {}, { merge_base_commit: null }, { merge_base_commit: {} },
      { merge_base_commit: { sha: "invalid" } }]) {
      assert.throws(() => provider.mergeBase(before, after), /ancestry is unavailable/);
    }
    const count = calls.length;
    assert.throws(() => provider.mergeBase("main", after), /full commit SHAs/);
    assert.throws(() => provider.mergeBase(before, "short"), /full commit SHAs/);
    assert.equal(calls.length, count);
    status = 1;
    assert.throws(() => provider.mergeBase(before, after), /GitHub request failed.*Resource not found/);
  });
}

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

test("ADO updates do not retarget an unchanged base but still preserve requested body and draft updates", () => {
  const patches = [];
  let description = "Before";
  const runner = (command, args) => {
    if (args[0] === "rest") {
      const body = JSON.parse(args[args.indexOf("--body") + 1]);
      patches.push(body);
      assert.equal(Object.hasOwn(body, "targetRefName"), false);
      description = body.description;
    }
    return { status: 0, stderr: "", stdout: JSON.stringify({
      pullRequestId: 1, sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/trunk", description, isDraft: true, status: "active",
    }) };
  };
  const provider = adoProvider({ host: "dev.azure.com", organization: "o", project: "p", repo: "r" }, ".", runner);
  provider.update(1, { baseBranch: "trunk" });
  assert.equal(patches.length, 0);
  assert.equal(provider.update(1, { baseBranch: "trunk", body: "After", draft: true }).body, "After");
  assert.deepEqual(patches, [{ description: "After", isDraft: true }]);
});

test("ADO active merge previews are not landing receipts", () => {
  let status = "active";
  const provider = adoProvider({ host: "dev.azure.com", organization: "o", project: "p", repo: "r" }, ".",
    () => ({ status: 0, stderr: "", stdout: JSON.stringify({
      pullRequestId: 1, status, sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/trunk",
      lastMergeCommit: { commitId: "preview-or-landing" },
    }) }));
  assert.equal(provider.get(1).landing, null);
  status = "completed";
  assert.equal(provider.get(1).landing, "preview-or-landing");
});

test("ADO ancestry compares exact commits and rejects unavailable or malformed evidence", () => {
  const before = "1".repeat(40), after = "2".repeat(40);
  const calls = [];
  let result = { commonCommit: before };
  let status = 0;
  const provider = adoProvider({ host: "dev.azure.com", organization: "o", project: "p", repo: "r" }, ".",
    (command, args) => {
      calls.push({ command, args });
      return { status, stdout: JSON.stringify(result), stderr: status ? "Access denied" : "" };
    });
  assert.equal(provider.mergeBase(before, after), before);
  const { command, args } = calls[0];
  assert.equal(command, "az");
  assert.equal(args[args.indexOf("--method") + 1], "GET");
  const url = new URL(args[args.indexOf("--url") + 1]);
  assert.equal(url.searchParams.get("baseVersion"), before);
  assert.equal(url.searchParams.get("targetVersion"), after);
  assert.equal(url.searchParams.get("baseVersionType"), "commit");
  assert.equal(url.searchParams.get("targetVersionType"), "commit");
  assert.equal(url.searchParams.get("diffCommonCommit"), "true");
  result = { commonCommit: null };
  assert.equal(provider.mergeBase(before, after), null);
  for (result of [{}, { commonCommit: "invalid" }]) {
    assert.throws(() => provider.mergeBase(before, after), /ancestry is unavailable/);
  }
  assert.throws(() => provider.mergeBase("main", after), /full commit SHAs/);
  status = 1;
  assert.throws(() => provider.mergeBase(before, after), /ADO request failed.*Access denied/);
});

test("ADO own-change paths exclude folder entries, retain rename sources and submodules, and paginate unfiltered entries", () => {
  const pages = [];
  const runner = (command, args) => {
    assert.equal(command, "az");
    let result;
    if (args[0] === "repos") {
      result = { pullRequestId: 1, sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/trunk",
        lastMergeSourceCommit: { commitId: "h" }, lastMergeTargetCommit: { commitId: "b" } };
    } else {
      const url = args[args.indexOf("--url") + 1];
      pages.push(url);
      result = url.includes("$skip=0")
        ? { allChangesIncluded: false, changes: Array.from({ length: 100 }, (_, i) =>
          ({ item: { path: `/folder${i}`, isFolder: true, gitObjectType: "tree" } })) }
        : { allChangesIncluded: true, changes: [
          { item: { path: "/folder", gitObjectType: "tree" } },
          { sourceServerItem: "/old.txt", item: { path: "/new.txt", gitObjectType: "blob" } },
          { originalPath: "/old-link", item: { path: "/link", gitObjectType: "blob" } },
          { item: { path: "/submodule", gitObjectType: "commit" } },
        ] };
    }
    return { status: 0, stdout: JSON.stringify(result), stderr: "" };
  };
  const provider = adoProvider({ host: "dev.azure.com", organization: "o", project: "p", repo: "r" }, ".", runner);
  assert.deepEqual(provider.diffPaths(1), ["link", "new.txt", "old-link", "old.txt", "submodule"]);
  assert.equal(pages.length, 2);
  assert.ok(pages[1].includes("$skip=100"));
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
    mergeBase(before, after) {
      return bare("merge-base", before, after);
    },
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
      const base = bare("merge-base", pr.base, pr.head);
      return bare("diff", "--name-only", "--no-renames", base, pr.head).split("\n").filter(Boolean).sort();
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

test("server ancestry preserves fetch-start grace without fetching remote-only main or preview commits", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  const startedAt = Date.UTC(2026, 9, 21);
  let clock = startedAt + 600000;
  f.ctx.now = () => clock;
  git(f.root, "branch", "main", f.base);
  git(f.root, "push", "-q", "upstream", "main");
  f.spec.target = "main";
  const host = hostedFixture(f);
  const bare = (...args) => git(f.root, `--git-dir=${f.bare}`, ...args);
  const advance = (parent, title) => {
    const sha = bare("commit-tree", `${f.base}^{tree}`, "-p", parent, "-m", title);
    bare("update-ref", "refs/heads/main", sha, parent);
    return sha;
  };
  const present = (sha) =>
    gitResult(f.root, ["cat-file", "-e", sha], undefined, true).status === 0;
  const remoteOnly = advance(f.base, "Remote-only main");
  assert.equal(present(remoteOnly), false);
  const observation = { target: "main", sha: f.base, startedAt };
  const split = createPlan(f.ctx, "split", { spec: f.spec, fetchObservation: observation });
  assert.equal(split.target, f.base);
  assert.equal(split.graph.integration.verifiedAt, startedAt);
  applyPlan(f.ctx, split, split.approval, true);
  const publication = createPlan(f.ctx, "publish", { graph: "example" });
  const latest = advance(remoteOnly, "Remote-only preview");
  const result = applyPlan(f.ctx, publication, publication.approval, true);
  assert.equal(result.graph.targetSha, f.base);
  assert.equal(result.graph.nodes[0].pr.base, latest);
  assert.equal(result.freshness.a.integration.status, "grace");
  assert.equal(result.freshness.a.integration.verifiedAt, startedAt);
  assert.equal(result.freshness.a.integration.expiresAt, startedAt + 5400000);
  assert.equal(present(remoteOnly), false);
  assert.equal(present(latest), false);
  assert.equal(git(f.root, "rev-parse", "main"), f.base);
  const source = result.graph.nodes[0];
  const ready = createPlan(f.ctx, "ready", { graph: "example", node: "a" });
  host.records.get(source.pr.id).body = "Concurrent human edit";
  assert.throws(() => applyPlan(f.ctx, ready, ready.approval, true), /changed; reconcile and replan/);
  host.records.get(source.pr.id).body = source.pr.body;
  f.apply("abort", { operation: ready.approval });
  clock = startedAt + 5400000;
  assert.equal(inspect(f.ctx, "example").freshness.a.integration.status, "stale");
});

for (const hostname of ["github.com", "enterprise.example"]) {
  test(`GitHub ancestry on ${hostname} preserves grace without fetching a remote-only target`, (t) => {
    const f = fixture({ remote: true, names: ["a"] });
    t.after(() => f.dispose());
    const startedAt = Date.UTC(2026, 9, 21);
    f.ctx.now = () => startedAt + 1000;
    git(f.root, "branch", "main", f.base);
    git(f.root, "push", "-q", "upstream", "main");
    f.spec.target = "main";
    const host = hostedFixture(f);
    const bare = (...args) => git(f.root, `--git-dir=${f.bare}`, ...args);
    let comparisons = 0;
    host.p.mergeBase = githubProvider({ host: hostname, owner: "o", repo: "r" }, ".",
      (command, args) => {
        assert.equal(command, "gh");
        assert.equal(args[2], hostname);
        const match = /^repos\/o\/r\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=1$/.exec(args[3]);
        assert.ok(match);
        comparisons++;
        return { status: 0, stdout: JSON.stringify({
          merge_base_commit: { sha: bare("merge-base", match[1], match[2]) },
        }), stderr: "" };
      }).mergeBase;
    const target = bare("commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Remote-only main");
    bare("update-ref", "refs/heads/main", target, f.base);
    const split = f.apply("split", { spec: f.spec,
      fetchObservation: { target: "main", sha: f.base, startedAt } });
    const published = f.apply("publish", { graph: split.graph.id });
    const ready = f.apply("ready", { graph: split.graph.id, node: "a" });
    assert.ok(comparisons > 0);
    assert.equal(published.graph.nodes[0].pr.base, target);
    assert.equal(ready.graph.nodes[0].pr.draft, false);
    assert.equal(ready.freshness.a.integration.status, "grace");
    assert.equal(ready.freshness.a.integration.expiresAt, startedAt + 5400000);
    assert.equal(git(f.root, "rev-parse", "main"), f.base);
    assert.notEqual(gitResult(f.root, ["cat-file", "-e", target], undefined, true).status, 0);
  });
}

for (const movement of ["rewind", "divergence"]) {
  test(`server ancestry rejects remote-only target ${movement} without granting grace`, (t) => {
    const f = fixture({ remote: true, names: ["a"] });
    t.after(() => f.dispose());
    const startedAt = Date.UTC(2026, 9, 21);
    f.ctx.now = () => startedAt + 1000;
    git(f.root, "branch", "main", f.head);
    git(f.root, "push", "-q", "upstream", "main");
    f.spec.target = "main";
    hostedFixture(f);
    const bare = (...args) => git(f.root, `--git-dir=${f.bare}`, ...args);
    const target = movement === "rewind" ? f.base :
      bare("commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Divergent target");
    bare("update-ref", "refs/heads/main", target, f.head);
    assert.throws(() => createPlan(f.ctx, "init", {
      spec: { ...f.spec, source: undefined },
      fetchObservation: { target: "main", sha: f.head, startedAt },
    }), /rewound or rewritten/);
  });
}

for (const target of ["main", "master"]) {
  test(`${target} grace preserves every node's snapshot and permits ready, but not merge`, (t) => {
    const f = fixture({ remote: true, names: ["a", "b", "c"] });
    t.after(() => f.dispose());
    let clock = Date.UTC(2026, 9, 16);
    f.ctx.now = () => clock;
    git(f.root, "branch", target, f.base);
    git(f.root, "push", "-q", "upstream", target);
    f.spec.target = target;
    const host = hostedFixture(f);
    f.apply("split", { spec: f.spec });
    const before = f.apply("publish", { graph: "example" }).graph;
    const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Main advanced");
    git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/${target}`);
    clock += 1800000;
    const description = createPlan(f.ctx, "describe", { graph: "example", node: "a",
      body: "Approved description", fetchObservation: { target, sha: advanced, startedAt: clock } });
    assert.deepEqual(description.graph.integration, before.integration);
    assert.deepEqual(description.graph.nodes.map((n) => n.integration), before.nodes.map((n) => n.integration));
    const result = f.apply("ready", { graph: "example", node: "a" });
    assert.equal(host.p.get(result.graph.nodes[0].pr.id).draft, false);
    assert.equal(result.graph.targetSha, f.base);
    assert.equal(git(f.root, "rev-parse", target), f.base);
    assert.deepEqual(result.graph.nodes.map((n) => n.head), before.nodes.map((n) => n.head));
    for (const node of result.graph.nodes) {
      assert.equal(result.freshness[node.id].integration.status, "grace");
      assert.equal(result.freshness[node.id].integration.verifiedAt, before.integration.verifiedAt);
      assert.equal(result.freshness[node.id].integration.mergeCurrent, false);
      assert.equal(result.freshness[node.id].branch.status, "current");
      assert.equal(result.freshness[node.id].validation, "current");
    }
    const shape = f.apply("deps", { graph: "example", spec: { id: f.spec.id, nodes: f.spec.nodes } });
    assert.equal(shape.graph.integration.verifiedAt, before.integration.verifiedAt);
    assert.deepEqual(shape.graph.nodes.map((n) => n.head), before.nodes.map((n) => n.head));
    const publish = f.apply("publish", { graph: "example" });
    assert.equal(publish.graph.integration.verifiedAt, before.integration.verifiedAt);
    const merge = createPlan(f.ctx, "merge", { graph: "example", node: "a" });
    assert.throws(() => applyPlan(f.ctx, merge, merge.approval, true), /Sync onto the current/);
    f.apply("abort", { operation: merge.approval });
    const ready = createPlan(f.ctx, "ready", { graph: "example", node: "b" });
    clock = before.integration.verifiedAt + 5400000;
    assert.equal(inspect(f.ctx, "example").freshness.b.integration.status, "stale");
    assert.throws(() => createPlan(f.ctx, "deps", { graph: "example",
      spec: { id: f.spec.id, nodes: f.spec.nodes } }), /Integration target moved/);
    assert.throws(() => applyPlan(f.ctx, ready, ready.approval, true), /freshness expired/);
    f.apply("abort", { operation: ready.approval });
    const sync = f.apply("sync", { graph: "example" });
    assert.equal(sync.graph.targetSha, advanced);
    assert.equal(sync.freshness.a.integration.status, "current");
    assert.equal(sync.graph.nodes[0].pr.draft, true);
    f.apply("ready", { graph: "example", node: "a" });
    const merged = f.apply("merge", { graph: "example", node: "a" });
    assert.ok(merged.graph.nodes[0].landing);
    assert.equal(merged.graph.integration.sha, merged.graph.targetSha);
    const latest = git(f.root, "commit-tree", `${merged.graph.targetSha}^{tree}`,
      "-p", merged.graph.targetSha, "-m", "Main advanced after landing");
    git(f.root, "push", "-q", "upstream", `${latest}:refs/heads/${target}`);
    const reshaped = f.apply("deps", { graph: "example", spec: { id: f.spec.id, nodes: f.spec.nodes } });
    assert.equal(reshaped.graph.targetSha, merged.graph.targetSha);
    assert.equal(reshaped.graph.nodes[1].integration.sha, merged.graph.targetSha);
    assert.equal(reshaped.graph.nodes[0].integration.sha, advanced);
    assert.equal(reshaped.freshness.b.integration.status, "grace");
  });
}

test("main grace covers target movement after approval, without accepting changed PR content", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  let clock = Date.UTC(2026, 9, 16);
  f.ctx.now = () => clock;
  git(f.root, "branch", "main", f.base);
  git(f.root, "push", "-q", "upstream", "main");
  f.spec.target = "main";
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const publication = createPlan(f.ctx, "publish", { graph: "example" });
  const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Advance during approval");
  git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/main`);
  clock += 1000;
  const result = applyPlan(f.ctx, publication, publication.approval, true);
  assert.equal(result.graph.targetSha, f.base);
  assert.equal(result.freshness.a.integration.status, "grace");
  const ready = createPlan(f.ctx, "ready", { graph: "example", node: "a" });
  host.p.update(result.graph.nodes[0].pr.id, { body: "Concurrent human text" });
  assert.throws(() => applyPlan(f.ctx, ready, ready.approval, true), /changed; reconcile and replan/);
  assert.equal(host.p.get(result.graph.nodes[0].pr.id).body, "Concurrent human text");
  assert.equal(host.p.get(result.graph.nodes[0].pr.id).draft, true);
});

for (const mutation of ["rewind", "source"]) {
  test(`main grace still rejects a ${mutation} during approval`, (t) => {
    const f = fixture({ remote: true, names: ["a"] });
    t.after(() => f.dispose());
    f.ctx.now = () => Date.UTC(2026, 9, 16);
    git(f.root, "branch", "main", f.base);
    git(f.root, "push", "-q", "upstream", "main");
    f.spec.target = "main";
    const host = hostedFixture(f);
    f.apply("split", { spec: f.spec });
    const graph = f.apply("publish", { graph: "example" }).graph;
    const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Main advanced");
    git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/main`);
    const plan = createPlan(f.ctx, "ready", { graph: graph.id, node: "a" });
    const node = graph.nodes[0];
    if (mutation === "rewind") {
      git(f.root, `--git-dir=${f.bare}`, "update-ref", "refs/heads/main", f.base, advanced);
    } else {
      git(f.root, `--git-dir=${f.bare}`, "update-ref", `refs/heads/${node.branch}`, f.base, node.head);
    }
    assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true),
      mutation === "rewind" ? /rewound or rewritten/ : /Remote ref changed/);
    assert.equal(host.p.get(node.pr.id).draft, true);
  });
}

test("freshness is visible in read-only CLI output without refreshing its recorded timestamp", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  git(f.root, "branch", "main", f.base);
  git(f.root, "push", "-q", "upstream", "main");
  f.spec.target = "main";
  const graph = f.apply("split", { spec: f.spec }).graph;
  const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Main advanced");
  git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/main`);
  const status = cli(f.root, "status", "--graph", graph.id);
  assert.equal(status.status, 0, status.stderr);
  for (const value of Object.values(JSON.parse(status.stdout).freshness)) {
    assert.equal(value.integration.status, "grace");
    assert.equal(value.integration.verifiedAt, graph.integration.verifiedAt);
    assert.equal(value.branch.scope, "unpublished");
  }
  const view = cli(f.root, "view", "--graph", graph.id);
  assert.equal(view.status, 0, view.stderr);
  assert.match(view.stdout, /a .*freshness: grace; branch: current; validation: current/);
  assert.equal(inspect(f.ctx, graph.id).graph.integration.verifiedAt, graph.integration.verifiedAt);
});

test("retarget fully reconstructs and publishes the same ownership on a new integration snapshot", (t) => {
  const f = fixture({ remote: true, names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const before = f.apply("publish", { graph: "example" }).graph;
  for (const node of before.nodes.filter((n) => !n.dependencies.length)) {
    host.p.update(node.pr.id, { draft: false, body: `User text for ${node.id}\n${node.pr.body}` });
  }
  git(f.root, "checkout", "-qb", "new-main", f.base);
  fs.writeFileSync(path.join(f.root, "upstream.txt"), "new integration content\n");
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "New main content");
  const target = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "source");
  git(f.root, "push", "-q", "upstream", "new-main");
  const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.target, "new-main");
  assert.equal(result.graph.targetSha, target);
  assert.equal(git(f.root, "rev-parse", "trunk"), f.base);
  assert.equal(git(f.root, "show", `${result.graph.combined}:upstream.txt`), "new integration content");
  assert.equal(git(f.root, "show", `${result.graph.combined}:shared.txt`), f.text(["a", "b", "c"]).trim());
  for (const node of result.graph.nodes) {
    const old = before.nodes.find((n) => n.id === node.id);
    assert.equal(node.pr.id, old.pr.id);
    assert.equal(node.change.fingerprint, old.change.fingerprint);
    assert.deepEqual(node.dependencies, old.dependencies);
    assert.notEqual(node.head, old.head);
    assert.equal(node.validation.head, node.head);
    assert.equal(node.ready, false);
    assert.equal(node.pr.draft, true);
    assert.equal(node.pr.baseBranch, node.dependencies.length ? old.baseBranch : "new-main");
    if (!node.dependencies.length) assert.ok(node.pr.body.startsWith(`User text for ${node.id}`));
  }
  assert.equal(host.records.size, 3);
});

for (const settles of [true, false]) {
  test(`ADO retarget ${settles ? "waits for" : "rejects persistently stale"} merge-preview target data`, (t) => {
    const f = fixture({ remote: true, names: ["a"] });
    t.after(() => f.dispose());
    const host = hostedFixture(f);
    host.p.kind = "ado";
    f.apply("split", { spec: f.spec });
    f.apply("publish", { graph: "example" });
    git(f.root, "checkout", "-qb", "new-main", f.base);
    fs.writeFileSync(path.join(f.root, "upstream.txt"), "new main content\n");
    git(f.root, "add", ".");
    git(f.root, "commit", "-qm", "New main content");
    git(f.root, "checkout", "source");
    git(f.root, "push", "-q", "upstream", "new-main");
    const get = host.p.get;
    let reads = 0;
    host.p.get = (id) => {
      const current = get(id);
      if (current.baseBranch === "new-main" && (++reads <= 2 || !settles)) {
        return { ...current, base: f.base };
      }
      return current;
    };
    const plan = createPlan(f.ctx, "retarget", {
      graph: "example", spec: { id: "example", target: "new-main" },
    });
    if (settles) {
      const result = applyPlan(f.ctx, plan, plan.approval, true);
      assert.equal(result.graph.nodes[0].pr.base, result.graph.targetSha);
      assert.ok(reads >= 3);
    } else {
      assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true),
        /target no longer preserves the authored own-change base/);
      assert.equal(reads, 5);
    }
  });
}

test("retarget tolerates only forward target movement without silently rebasing its approved snapshot", (t) => {
  const f = fixture({ remote: true, names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  f.apply("publish", { graph: "example" });
  git(f.root, "branch", "new-main", f.base);
  git(f.root, "push", "-q", "upstream", "new-main");
  const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
  git(f.root, "checkout", "-qb", "remote-advance", f.base);
  fs.writeFileSync(path.join(f.root, "later.txt"), "main advanced after approval\n");
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Advance new main");
  const advanced = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "source");
  git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/new-main`);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.targetSha, plan.target);
  assert.equal(plan.target, f.base);
  for (const node of result.graph.nodes.filter((n) => !n.dependencies.length)) {
    assert.equal(node.base, f.base);
    assert.equal(host.p.get(node.pr.id).base, advanced);
  }
  assert.throws(() => f.apply("ready", { graph: "example", node: "a" }), /Sync onto the current/);
});

test("retarget rejects target rewinds and altered ownership specs before any publication", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const before = f.apply("publish", { graph: "example" }).graph;
  git(f.root, "branch", "new-main", f.head);
  git(f.root, "push", "-q", "upstream", "new-main");
  assert.throws(() => createPlan(f.ctx, "retarget", { graph: "example",
    spec: { id: "example", target: "new-main", nodes: [] } }), /containing only/);
  const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
  git(f.root, `--git-dir=${f.bare}`, "update-ref", "refs/heads/new-main", f.base, f.head);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /rewound or rewritten/);
  assert.equal(git(f.root, "rev-parse", before.nodes[0].branch), before.nodes[0].head);
  assert.equal(host.p.get(before.nodes[0].pr.id).baseBranch, "trunk");
});

test("retarget resumes a partial hosting update with the same PRs and candidate commits", (t) => {
  const f = fixture({ remote: true, names: ["a", "b", "c"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const before = f.apply("publish", { graph: "example" }).graph;
  git(f.root, "checkout", "-qb", "new-main", f.base);
  fs.writeFileSync(path.join(f.root, "upstream.txt"), "new integration content\n");
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "New main content");
  git(f.root, "checkout", "source");
  git(f.root, "push", "-q", "upstream", "new-main");
  const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
  const update = host.p.update;
  let lose = true;
  host.p.update = (id, fields) => {
    const result = update(id, fields);
    if (lose && fields.baseBranch === "new-main") {
      lose = false;
      throw new Error("Lost retarget response after successful update");
    }
    return result;
  };
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Lost retarget response/);
  const heads = before.nodes.map((n) => host.p.get(n.pr.id).head);
  const targetBefore = git(f.root, "rev-parse", "new-main");
  const advanced = git(f.root, "commit-tree", `${targetBefore}^{tree}`, "-p", targetBefore, "-m", "Target advanced during recovery");
  git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/new-main`);
  git(f.root, "update-ref", "refs/heads/new-main", advanced, targetBefore);
  const recover = createPlan(f.ctx, "reconcile", { operation: plan.approval });
  const latest = git(f.root, "commit-tree", `${advanced}^{tree}`, "-p", advanced, "-m", "Main and PR preview advanced during approval");
  git(f.root, "push", "-q", "upstream", `${latest}:refs/heads/new-main`);
  applyPlan(f.ctx, recover, recover.approval, true);
  assert.equal(git(f.root, "rev-parse", "new-main"), advanced);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(host.records.size, 3);
  assert.deepEqual(result.graph.nodes.map((n) => n.head), heads);
  assert.ok(result.graph.nodes.every((n) => n.pr.baseBranch === n.baseBranch && n.pr.draft));
});

test("retarget recovery rejects concurrent human PR edits even when its preview base advances", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const graph = f.apply("publish", { graph: "example" }).graph;
  git(f.root, "branch", "new-main", f.base);
  git(f.root, "push", "-q", "upstream", "new-main");
  const update = host.p.update;
  host.p.update = (id, fields) => {
    const result = update(id, fields);
    if (fields.baseBranch === "new-main") throw new Error("Lost retarget response");
    return result;
  };
  const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Lost retarget response/);
  const recover = createPlan(f.ctx, "reconcile", { operation: plan.approval });
  const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Main advanced");
  git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/new-main`);
  const pr = host.records.get(graph.nodes[0].pr.id);
  pr.body = "Concurrent human edit\n" + pr.body;
  assert.throws(() => applyPlan(f.ctx, recover, recover.approval, true),
    /Observed state changed after reconciliation approval/);
  assert.ok(pr.body.startsWith("Concurrent human edit\n"));
});

test("retarget still rejects a changed source ref even when its integration branch advances", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const before = f.apply("publish", { graph: "example" }).graph;
  git(f.root, "branch", "new-main", f.base);
  git(f.root, "push", "-q", "upstream", "new-main");
  const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
  const node = before.nodes[0];
  git(f.root, `--git-dir=${f.bare}`, "update-ref", `refs/heads/${node.branch}`, f.base, node.head);
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /Remote ref changed/);
  assert.equal(git(f.root, "rev-parse", node.branch), node.head);
  assert.equal(host.p.get(node.pr.id).baseBranch, "trunk");
});

test("retarget abort never rolls back a separately observed native integration fast-forward", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  hostedFixture(f);
  f.apply("split", { spec: f.spec });
  f.apply("publish", { graph: "example" });
  git(f.root, "checkout", "-qb", "new-main", f.base);
  fs.writeFileSync(path.join(f.root, "upstream.txt"), "main content\n");
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "New main content");
  const target = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "source");
  git(f.root, "push", "-q", "upstream", "new-main");
  const hook = path.join(f.root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /git commit failed/);
  const advanced = git(f.root, "commit-tree", `${target}^{tree}`, "-p", target, "-m", "Native target fast-forward");
  git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/new-main`);
  git(f.root, "update-ref", "refs/heads/new-main", advanced, target);
  f.apply("reconcile", { operation: plan.approval });
  f.apply("abort", { operation: plan.approval });
  assert.equal(git(f.root, "rev-parse", "new-main"), advanced);
});

test("retarget recovery keeps an approved local fast-forward fixed while remote main advances", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  hostedFixture(f);
  f.apply("split", { spec: f.spec });
  f.apply("publish", { graph: "example" });
  git(f.root, "branch", "new-main", f.base);
  git(f.root, "push", "-q", "upstream", "new-main");
  fs.writeFileSync(path.join(f.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /git commit failed/);
  const local = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Approved native fast-forward");
  git(f.root, "push", "-q", "upstream", `${local}:refs/heads/new-main`);
  git(f.root, "update-ref", "refs/heads/new-main", local, f.base);
  const remote = git(f.root, "commit-tree", `${local}^{tree}`, "-p", local, "-m", "Remote advanced before planning");
  git(f.root, "push", "-q", "upstream", `${remote}:refs/heads/new-main`);
  const recover = createPlan(f.ctx, "reconcile", { operation: plan.approval });
  assert.equal(recover.forwardTarget, "new-main");
  const latest = git(f.root, "commit-tree", `${remote}^{tree}`, "-p", remote, "-m", "Remote advanced during approval");
  git(f.root, "push", "-q", "upstream", `${latest}:refs/heads/new-main`);
  applyPlan(f.ctx, recover, recover.approval, true);
  assert.equal(git(f.root, "rev-parse", "new-main"), local);
  f.apply("abort", { operation: plan.approval });
  assert.equal(git(f.root, "rev-parse", "new-main"), local);
});

test("retarget recovery still rejects rewound targets and changed local or source observations", (t) => {
  for (const mutation of ["rewind", "local", "source"]) {
    const f = fixture({ remote: true, names: ["a"] });
    t.after(() => f.dispose());
    hostedFixture(f);
    f.apply("split", { spec: f.spec });
    const graph = f.apply("publish", { graph: "example" }).graph;
    git(f.root, "branch", "new-main", f.base);
    git(f.root, "push", "-q", "upstream", "new-main");
    fs.writeFileSync(path.join(f.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const plan = createPlan(f.ctx, "retarget", { graph: "example", spec: { id: "example", target: "new-main" } });
    assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /git commit failed/);
    const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Remote main advanced");
    git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/new-main`);
    const recover = createPlan(f.ctx, "reconcile", { operation: plan.approval });
    if (mutation === "rewind") {
      git(f.root, `--git-dir=${f.bare}`, "update-ref", "refs/heads/new-main", f.base, advanced);
    } else if (mutation === "local") {
      git(f.root, "update-ref", "refs/heads/new-main", advanced, f.base);
    } else {
      const node = graph.nodes[0];
      git(f.root, `--git-dir=${f.bare}`, "update-ref", `refs/heads/${node.branch}`, f.base, node.head);
    }
    assert.throws(() => applyPlan(f.ctx, recover, recover.approval, true),
      /rewound or rewritten|Observed state changed after reconciliation approval/);
  }
});

test("description batches tolerate forward integration movement without rebasing or promoting nodes", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const before = f.apply("publish", { graph: "example" }).graph;
  const descriptions = { a: "Approved body A", b: "Approved body B" };
  const plan = createPlan(f.ctx, "describe", { graph: "example", spec: { id: "example", descriptions } });
  const first = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Main advanced before body approval");
  git(f.root, "push", "-q", "upstream", `${first}:refs/heads/trunk`);
  const update = host.p.update;
  let advanced = false;
  host.p.update = (id, fields) => {
    const current = update(id, fields);
    if (!advanced && fields.body !== undefined) {
      advanced = true;
      const latest = git(f.root, "commit-tree", `${first}^{tree}`, "-p", first, "-m", "Main advanced during body batch");
      git(f.root, "push", "-q", "upstream", `${latest}:refs/heads/trunk`);
    }
    return current;
  };
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(result.graph.targetSha, before.targetSha);
  assert.equal(git(f.root, "rev-parse", "trunk"), f.base);
  assert.deepEqual(result.graph.nodes.map((n) => n.head), before.nodes.map((n) => n.head));
  for (const node of result.graph.nodes) {
    const pr = host.p.get(node.pr.id);
    assert.ok(pr.body.startsWith(descriptions[node.id]));
    assert.equal(pr.draft, true);
    assert.equal(pr.baseBranch, node.baseBranch);
    assert.equal(pr.head, node.head);
  }
  assert.throws(() => f.apply("ready", { graph: "example", node: "a" }),
    /Sync onto the current integration branch before ready\/merge/);
});

for (const mutation of ["source", "body"]) {
  test(`description plans reject changed ${mutation} despite forward integration movement`, (t) => {
    const f = fixture({ remote: true, names: ["a"] });
    t.after(() => f.dispose());
    const host = hostedFixture(f);
    f.apply("split", { spec: f.spec });
    const graph = f.apply("publish", { graph: "example" }).graph;
    const node = graph.nodes[0];
    const plan = createPlan(f.ctx, "describe", {
      graph: "example", spec: { id: "example", descriptions: { a: "Approved replacement" } },
    });
    const advanced = git(f.root, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "Main advanced");
    git(f.root, "push", "-q", "upstream", `${advanced}:refs/heads/trunk`);
    if (mutation === "source") {
      git(f.root, `--git-dir=${f.bare}`, "update-ref", `refs/heads/${node.branch}`, f.base, node.head);
    } else {
      host.records.get(node.pr.id).body = "Concurrent human text";
    }
    assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true),
      /Remote ref changed|PR a changed/);
    assert.ok(!host.p.get(node.pr.id).body.startsWith("Approved replacement"));
    if (mutation === "body") {
      const recover = createPlan(f.ctx, "reconcile", { operation: plan.approval });
      assert.throws(() => applyPlan(f.ctx, recover, recover.approval, true),
        /Description inputs changed/);
      assert.equal(host.p.get(node.pr.id).body, "Concurrent human text");
    }
  });
}

test("hosted lifecycle publishes all drafts, preserves human text, and gates ready/merge", (t) => {
  const f = fixture({ remote: true });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  const progress = [];
  setProgressSink((event) => {
    if (event.type === "done" && event.label === "Creating or locating draft PR and verifying it") {
      assert.equal(host.records.get(Number(event.pr.split("/").at(-1))).state, "open");
    }
    progress.push(event);
  });
  t.after(() => setProgressSink(undefined));
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
  const published = progress.filter((event) => event.type === "done" &&
    event.label === "Creating or locating draft PR and verifying it");
  assert.deepEqual(new Set(published.map((event) => event.node)), new Set(["a", "b", "c", "d", "e", "f"]));
  assert.ok(published.every((event) => event.branch && event.pr && event.total === 6 && event.index > 0));
  assert.ok(progress.some((event) => event.type === "done" && event.label.startsWith("Pushing ")));
  assert.ok(progress.some((event) => event.type === "done" && event.label === "Checking eligibility and marking ready" && event.node === "b"));
  assert.ok(progress.some((event) => event.type === "done" && event.label === "Merging and verifying landing" && event.node === "b"));
});

test("batch describe updates approved bodies together without moving refs or draft states", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const before = f.apply("publish", { graph: "example" }).graph;
  host.p.update(before.nodes[0].pr.id, { draft: false });
  const result = f.apply("describe", { graph: "example", spec: {
    id: "example", descriptions: { a: "Approved body A", b: "Approved body B" },
  } });
  assert.equal(result.graph.revision, before.revision + 1);
  for (const node of result.graph.nodes) {
    assert.equal(node.head, before.nodes.find((n) => n.id === node.id).head);
    assert.equal(node.description, `Approved body ${node.id.toUpperCase()}`);
    assert.ok(host.p.get(node.pr.id).body.startsWith(node.description));
    assert.equal(host.p.get(node.pr.id).draft, node.id === "b");
  }
});

test("batch describe rejects invalid requests and concurrent human edits rather than overwriting them", (t) => {
  const f = fixture({ remote: true, names: ["a", "b"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const before = f.apply("publish", { graph: "example" }).graph;
  const bodies = { id: "example", descriptions: { a: "Approved A", b: "Approved B" } };
  assert.throws(() => createPlan(f.ctx, "describe", { graph: "example", spec: bodies, node: "a" }), /Batch describe/);
  assert.throws(() => createPlan(f.ctx, "describe", { graph: "example",
    spec: { id: "example", descriptions: { missing: "No PR" } } }), /Unknown active node/);
  const plan = createPlan(f.ctx, "describe", { graph: "example", spec: bodies });
  const update = host.p.update;
  const b = before.nodes.find((n) => n.id === "b");
  host.p.update = (id, fields) => {
    const result = update(id, fields);
    if (id !== b.pr.id) host.records.get(b.pr.id).body = "Concurrent human body";
    return result;
  };
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /PR changed before description replacement/);
  assert.equal(host.p.get(b.pr.id).body, "Concurrent human body");
});

test("ambiguous PR creation resumes through an approved reconciliation without duplicates", (t) => {
  const f = fixture({ remote: true, names: ["a"] });
  t.after(() => f.dispose());
  const host = hostedFixture(f);
  f.apply("split", { spec: f.spec });
  const plan = createPlan(f.ctx, "publish", { graph: "example" });
  const progress = [];
  setProgressSink((event) => progress.push(event));
  t.after(() => setProgressSink(undefined));
  host.loseResponse();
  assert.throws(() => applyPlan(f.ctx, plan, plan.approval, true), /response was lost/);
  const creation = progress.filter((event) => event.label === "Creating or locating draft PR and verifying it");
  assert.deepEqual(creation.map((event) => event.type), ["start", "failed"]);
  const recover = createPlan(f.ctx, "reconcile", { operation: plan.approval });
  applyPlan(f.ctx, recover, recover.approval, true);
  const result = applyPlan(f.ctx, plan, plan.approval, true);
  assert.equal(host.records.size, 1);
  assert.ok(result.graph.nodes[0].pr);
  assert.equal(inspect(f.ctx, "example").operations.find((j) => j.id === plan.approval).status, "done");
  assert.ok(progress.some((event) => event.type === "done" && event.label === "Recovering operation: reconcile"));
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
