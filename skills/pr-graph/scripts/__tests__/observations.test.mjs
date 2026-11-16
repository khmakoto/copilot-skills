import { test } from "node:test";
import assert from "node:assert/strict";
import { githubProvider } from "../lib/providers/github.mjs";
import { adoProvider } from "../lib/providers/ado.mjs";
import { readPullRequests } from "../lib/observations.mjs";
import { setProgressSink } from "../lib/progress.mjs";

function measured(action) {
  const events = [];
  setProgressSink((event) => events.push(event));
  try {
    const value = action();
    return { value, metrics: events.findLast((event) => event.label === "Reading live provider evidence").metrics };
  } finally {
    setProgressSink(undefined);
  }
}

function raw(kind, id) {
  const common = { title: `PR ${id}` };
  return kind === "github" ? {
    ...common, number: id, html_url: `https://host.invalid/pull/${id}`, body: `Human ${id}`,
    draft: true, state: "open", merged_at: null, merge_commit_sha: null, updated_at: "2026-01-01",
    head: { ref: `nodes/${id}`, sha: `head-${id}`, repo: { id: 1, full_name: "o/r" } },
    base: { ref: "main", sha: "target", repo: { id: 1 } },
  } : {
    ...common, pullRequestId: id, description: `Human ${id}`, isDraft: true, status: "active",
    sourceRefName: `refs/heads/nodes/${id}`, targetRefName: "refs/heads/main",
    lastMergeSourceCommit: { commitId: `head-${id}` }, lastMergeTargetCommit: { commitId: "target" },
    creationDate: "2026-01-01",
  };
}

function adapter(kind, runner, host = "github.com") {
  return kind === "github" ? githubProvider({ host, owner: "o", repo: "r" }, ".", runner) :
    adoProvider({ host: "dev.azure.com", organization: "o", project: "p", repo: "r" }, ".", runner);
}

const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
const nodesFor = (size) => Array.from({ length: size }, (_, i) =>
  ({ id: `n${i + 1}`, branch: `nodes/${i + 1}`, pr: { id: i + 1 } }));

function hosting(kind, size, host) {
  const records = new Map(Array.from({ length: size }, (_, i) => [i + 1, raw(kind, i + 1)]));
  const calls = [];
  const model = { records, calls };
  const runner = (command, args) => {
    calls.push({ command, args });
    const failure = model.failure?.(calls.length, args);
    if (failure) return failure;
    const url = kind === "github" ? new URL(args[3], "https://host.invalid/") : null;
    const id = kind === "github" ? Number(url.pathname.match(/\/pulls\/(\d+)$/)?.[1]) :
      Number(args[args.indexOf("--id") + 1]);
    if (id) return records.has(id) ? ok(records.get(id)) : { status: 1, stderr: "HTTP 404 PR not found", stdout: "" };
    const branch = kind === "github" ? url.searchParams.get("head")?.replace(/^o:/, "") :
      args.includes("--source-branch") ? args[args.indexOf("--source-branch") + 1] : null;
    const values = [...records.values()].sort((a, b) => kind === "github"
      ? b.number - a.number : b.pullRequestId - a.pullRequestId);
    if (branch) {
      const matches = values.filter((p) => kind === "github" ? p.head.ref === branch && p.state === "open" :
        p.sourceRefName === `refs/heads/${branch}` && p.status === "active");
      return ok(kind === "github" ? [matches] : matches);
    }
    const page = kind === "github" ? Number(url.searchParams.get("page")) - 1 :
      Number(args[args.indexOf("--skip") + 1]) / 100;
    const result = values.slice(page * 100, (page + 1) * 100);
    const listed = model.page ? model.page(result, page) : result;
    if (kind === "github") {
      const more = model.more ? model.more(page) : result.length === 100;
      return { status: 0, stderr: "", stdout: `HTTP/2.0 200 OK\r\n` +
        (more ? `Link: <https://${host ?? "github.com"}/next?page=${page + 2}>; rel="next"\r\n` : "") +
        `\r\n${JSON.stringify(listed)}` };
    }
    return ok(listed);
  };
  model.provider = adapter(kind, runner, host);
  return model;
}

for (const kind of ["github", "ado"]) {
  test(`${kind} live-observation baseline counts provider calls and native subprocesses`, (t) => {
    const size = 32;
    const calls = [];
    const provider = adapter(kind, (command, args) => {
      calls.push({ command, args });
      const id = kind === "github" ? Number(args[3].split("/").at(-1)) : Number(args[args.indexOf("--id") + 1]);
      return ok(raw(kind, id));
    });
    const result = measured(() => readPullRequests({ kind, get: provider.get }, nodesFor(size)));
    assert.equal(Object.keys(result.value).length, size);
    assert.equal(result.metrics.calls, size);
    assert.equal(result.metrics.requests, size);
    assert.equal(result.metrics.subprocesses, calls.length);
    assert.equal(calls.length, size);
    assert.ok(result.metrics.elapsed >= 0);
    t.diagnostic(`${size} PRs: ${calls.length} provider requests/native subprocess invocations; ` +
      `${result.metrics.elapsed.toFixed(1)} ms fixture observation baseline.`);
  });
}

for (const [kind, host] of [["github", "github.com"], ["github", "enterprise.example"], ["ado"]]) {
  test(`${kind} ${host ?? ""} batches identical full observations and refreshes every boundary`, (t) => {
    const model = hosting(kind, 32, host);
    if (kind === "github") {
      Object.assign(model.records.get(1), { merged_at: "2026-01-02", state: "closed", merge_commit_sha: "landed" });
      Object.assign(model.records.get(2), { state: "closed", draft: false });
      model.records.get(3).merge_commit_sha = "open-preview";
    } else {
      Object.assign(model.records.get(1), { status: "completed", closedDate: "2026-01-02", lastMergeCommit: { commitId: "landed" } });
      Object.assign(model.records.get(2), { status: "abandoned", isDraft: false });
      model.records.get(3).lastMergeCommit = { commitId: "open-preview" };
    }
    const nodes = nodesFor(32).reverse();
    const legacy = { kind, get: model.provider.get, find: model.provider.find };
    const before = measured(() => readPullRequests(legacy, nodes));
    const after = measured(() => readPullRequests(model.provider, nodes));
    assert.deepEqual(after.value, before.value);
    assert.deepEqual(Object.keys(after.value), nodes.map((n) => n.id));
    assert.equal(before.metrics.subprocesses, 32);
    assert.equal(after.metrics.subprocesses, 1);
    assert.equal(after.metrics.requests, 1);
    assert.equal(after.metrics.calls, 1);
    assert.equal(kind === "github" ? model.calls.at(-1).args[2] : model.calls.at(-1).command,
      kind === "github" ? host : "az");
    model.records.get(1)[kind === "github" ? "body" : "description"] = "Live edit";
    const next = measured(() => readPullRequests(model.provider, nodes));
    assert.equal(next.value.n1.body, "Live edit");
    assert.equal(next.metrics.requests, 1);
    t.diagnostic(`32 PRs: requests/subprocesses ${before.metrics.requests} -> ${after.metrics.requests}; ` +
      `fixture phase ${before.metrics.elapsed.toFixed(1)} -> ${after.metrics.elapsed.toFixed(1)} ms (not network latency).`);
  });

  test(`${kind} ${host ?? ""} paginates exact identities and discovers unrecorded related PRs`, () => {
    const model = hosting(kind, 105, host);
    const nodes = nodesFor(105);
    delete nodes[0].pr;
    nodes.push({ id: "absent", branch: "absent" });
    const before = readPullRequests({ kind, get: model.provider.get, find: model.provider.find }, nodes, true);
    model.calls.length = 0;
    const after = measured(() => readPullRequests(model.provider, nodes, true));
    assert.deepEqual(after.value, before);
    assert.equal(after.metrics.requests, 2);
    assert.equal(model.calls.length, 2);
    assert.ok(!Object.hasOwn(after.value, "absent"));
    assert.equal(kind === "github" ? new URL(model.calls[1].args[3], "https://host.invalid").searchParams.get("page") :
      model.calls[1].args[model.calls[1].args.indexOf("--skip") + 1], kind === "github" ? "2" : "100");
  });

  test(`${kind} ${host ?? ""} bounds repository scans and falls back without inferring absence`, () => {
    const model = hosting(kind, 410, host);
    const nodes = [nodesFor(1)[0], { id: "discover", branch: "nodes/2" }, { id: "absent", branch: "absent" }];
    const before = readPullRequests({ kind, get: model.provider.get, find: model.provider.find }, nodes, true);
    model.calls.length = 0;
    const after = measured(() => readPullRequests(model.provider, nodes, true));
    assert.deepEqual(after.value, before);
    assert.equal(after.metrics.requests, 5, "two pages, one exact get and two complete branch queries");
    assert.equal(model.calls.length, 5);
  });

  test(`${kind} ${host ?? ""} falls back for missing batch records, not missing live evidence`, () => {
    const model = hosting(kind, 3, host);
    model.page = (values) => values.filter((p) => (kind === "github" ? p.number : p.pullRequestId) !== 1);
    const result = measured(() => readPullRequests(model.provider, nodesFor(3)));
    assert.equal(result.value.n1.id, 1);
    assert.equal(result.metrics.requests, 2);
    model.records.delete(1);
    assert.throws(() => readPullRequests(model.provider, nodesFor(3)), /HTTP 404 PR not found/);
  });

  test(`${kind} ${host ?? ""} hydrates incomplete fields and refuses failed full readback`, () => {
    const model = hosting(kind, 3, host);
    model.page = (values) => values.map((p) => {
      const row = { ...p };
      delete row.title;
      return row;
    });
    const result = measured(() => readPullRequests(model.provider, nodesFor(3)));
    assert.deepEqual(Object.values(result.value).map((p) => p.title), ["PR 1", "PR 2", "PR 3"]);
    assert.equal(result.metrics.requests, 4);
    model.calls.length = 0;
    model.failure = (count) => count === 3 ? { status: 1, stderr: "HTTP 429 hydration limited", stdout: "" } : null;
    assert.throws(() => readPullRequests(model.provider, nodesFor(3)), /hydration limited/);
    assert.equal(model.calls.length, 3, "no partial result, retries, or remaining reads after failure");
  });

  test(`${kind} ${host ?? ""} never infers discovery absence from rows with missing routing fields`, () => {
    const model = hosting(kind, 3, host);
    model.page = (values) => values.map((p) => {
      const row = { ...p };
      if (kind === "github") delete row.head;
      else delete row.sourceRefName;
      return row;
    });
    assert.throws(() => readPullRequests(model.provider, [
      { id: "discovered", branch: "nodes/1" }, { id: "absent", branch: "absent" },
    ], true), /Invalid .* discovery evidence/);
  });

  for (const failure of ["rate limit", "authorization", "malformed page", "overlapping pages"]) {
    test(`${kind} ${host ?? ""} fails closed on ${failure} without retrying partial reads`, () => {
      const model = hosting(kind, 105, host);
      if (failure === "rate limit" || failure === "authorization") {
        model.failure = (count) => count === 2
          ? { status: 1, stderr: failure === "rate limit" ? "HTTP 429 Retry-After: 60" : "HTTP 403 access denied", stdout: "" } : null;
      } else {
        model.page = (values, page) => page === 0 ? values :
          failure === "malformed page" ? { error: "partial result" } : [raw(kind, 105)];
      }
      const events = [];
      setProgressSink((event) => events.push(event));
      try {
        assert.throws(() => readPullRequests(model.provider, nodesFor(105)),
          /HTTP 429|HTTP 403|Invalid provider|repeated PR identity/);
      } finally {
        setProgressSink(undefined);
      }
      assert.equal(model.calls.length, 2);
      assert.equal(events.at(-1).type, "failed");
      assert.equal(events.at(-1).metrics.requests, 2);
      assert.equal(events.at(-1).metrics.subprocesses, 2);
    });
  }

  test(`${kind} ${host ?? ""} rejects duplicate discovery and fork PRs only when relevant`, () => {
    const model = hosting(kind, 3, host);
    const nodes = [{ id: "a", branch: "nodes/1" }, { id: "absent", branch: "absent" }];
    if (kind === "github") model.records.get(2).head.ref = "nodes/1";
    else model.records.get(2).sourceRefName = "refs/heads/nodes/1";
    assert.throws(() => readPullRequests(model.provider, nodes, true), /Multiple PRs/);
    model.records.delete(2);
    if (kind === "github") model.records.get(3).head.repo.id = 2;
    else model.records.get(3).forkSource = {};
    assert.equal(readPullRequests(model.provider, nodes, true).a.id, 1, "unrelated forks are not normalized");
    assert.throws(() => readPullRequests(model.provider, nodesFor(3).filter((n) => n.pr.id !== 2)),
      /Fork-based PRs/);
  });
}

test("GitHub follows Link pagination even for a short page before concluding discovery", () => {
  const model = hosting("github", 101);
  model.page = (values, page) => page === 0 ? [raw("github", 101)] : values;
  const nodes = [{ id: "discovered", branch: "nodes/1" }, { id: "absent", branch: "absent" }, nodesFor(2)[1]];
  const result = measured(() => readPullRequests(model.provider, nodes, true));
  assert.equal(result.value.discovered.id, 1);
  assert.equal(result.value.n2.id, 2, "missing known ID is hydrated separately");
  assert.equal(result.metrics.requests, 3);
});

test("GitHub hydrates missing source/base repository identities instead of treating them as same-repository evidence", () => {
  const model = hosting("github", 2);
  model.page = (values) => values.map((p) => ({
    ...p, head: { ...p.head, repo: {} }, base: { ...p.base, repo: {} },
  }));
  const result = measured(() => readPullRequests(model.provider, nodesFor(2)));
  assert.equal(result.metrics.requests, 3);
  model.records.get(1).head.repo.id = 2;
  assert.throws(() => readPullRequests(model.provider, nodesFor(2)), /Fork-based PRs/);
});

test("observation metrics count all native discovery pages and remain scoped after a failed boundary", () => {
  const records = Array.from({ length: 101 }, (_, i) => raw("github", i + 1));
  const provider = adapter("github", () => ok([records.slice(0, 100), records.slice(100)]));
  const nodes = [{ id: "absent", branch: "absent" }];
  const result = measured(() => readPullRequests(provider, nodes, true));
  assert.deepEqual(result.value, {});
  assert.equal(result.metrics.requests, 2);
  assert.equal(result.metrics.subprocesses, 1);
  const model = hosting("ado", 2);
  model.failure = () => ({ status: 1, stderr: "Unavailable", stdout: "" });
  assert.throws(() => measured(() => readPullRequests(model.provider, nodesFor(2))), /Unavailable/);
  model.failure = undefined;
  const next = measured(() => readPullRequests(model.provider, nodesFor(2)));
  assert.equal(next.metrics.requests, 1);
  assert.equal(next.metrics.subprocesses, 1);
});

test("failed native pagination reports a request lower bound without swallowing rate-limit details", () => {
  const events = [];
  const provider = adapter("github", () => ({ status: 1, stderr: "HTTP 429 Retry-After: 60", stdout: "" }));
  setProgressSink((event) => events.push(event));
  try {
    assert.throws(() => readPullRequests(provider, [{ id: "absent", branch: "absent" }], true), /Retry-After: 60/);
  } finally {
    setProgressSink(undefined);
  }
  assert.equal(events.at(-1).metrics.requestsExact, false);
  assert.equal(events.at(-1).metrics.subprocesses, 1);
});

test("ADO hydrates potentially truncated, missing, and long Unicode descriptions before using them", () => {
  const model = hosting("ado", 5);
  const bodies = ["x".repeat(399), "x".repeat(400), "x".repeat(401), "\u{1f600}".repeat(400), "Actual body"];
  for (const [i, body] of bodies.entries()) model.records.get(i + 1).description = body;
  model.page = (values) => values.map((p) => {
    const row = { ...p, description: [...p.description].slice(0, 400).join("") };
    if (p.pullRequestId === 5) delete row.description;
    return row;
  });
  const result = measured(() => readPullRequests(model.provider, nodesFor(5)));
  assert.deepEqual(Object.values(result.value).map((p) => p.body), bodies);
  assert.equal(result.metrics.requests, 5, "one list plus four full descriptions");
  assert.equal(model.calls.filter((c) => c.args.includes("show")).length, 4);
});

test("ADO full-description discovery also survives bounded-scan fallback", () => {
  const model = hosting("ado", 410);
  const body = "Human text".repeat(100);
  model.records.get(1).description = body;
  const result = measured(() => readPullRequests(model.provider, [
    { id: "discovered", branch: "nodes/1" }, { id: "absent", branch: "absent" },
  ], true));
  assert.equal(result.value.discovered.body, body);
  assert.equal(result.metrics.requests, 4, "one bounded page, two branch queries and one full body");
});

test("fallback adapters and singleton reads preserve identity checks and reject incomplete batch answers", () => {
  const nodes = nodesFor(2);
  const get = (id) => ({ id, branch: `nodes/${id}`, state: "open" });
  assert.deepEqual(readPullRequests({ kind: "github", get }, nodes), { n1: get(1), n2: get(2) });
  const provider = { kind: "github", get, readMany: () => { throw new Error("not for a singleton"); } };
  assert.deepEqual(readPullRequests(provider, nodes.slice(0, 1)), { n1: get(1) });
  assert.throws(() => readPullRequests({ kind: "github", get: () => get(99) }, nodes), /mismatched PR observation/);
  provider.readMany = () => ({ prs: new Map([[1, get(1)]]), found: new Map() });
  assert.throws(() => readPullRequests(provider, nodes), /Incomplete provider observation/);
  delete nodes[1].pr;
  provider.readMany = () => ({ prs: new Map([[1, get(1)]]), found: new Map([[nodes[1].branch, undefined]]) });
  assert.throws(() => readPullRequests(provider, nodes, true), /Incomplete provider observation/);
  provider.readMany = () => ({ prs: new Map([[1, get(1)]]), found: new Map([[nodes[1].branch, get(99)]]) });
  assert.throws(() => readPullRequests(provider, nodes, true), /Mismatched PR discovery/);
});
