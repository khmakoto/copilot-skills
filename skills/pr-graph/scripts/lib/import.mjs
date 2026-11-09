import fs from "node:fs";
import * as git from "./git.mjs";
import * as state from "./state.mjs";
import { digest, requireValue, eligible, helperBranch } from "./graph.mjs";
import { identity, resolveProvider, providerFor } from "./providers/index.mjs";
import { normalizeChange } from "./changes.mjs";
import { step, nodeDetails } from "./progress.mjs";

const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function snapshots(graph) {
  return [graph.targetSha, graph.combined, graph.source?.base, graph.source?.head,
    graph.integration?.sha, ...graph.nodes.flatMap((n) =>
      [n.head, n.base, n.change.base, n.change.head, n.integration?.sha, n.landing?.commit])].filter(Boolean);
}

function noPending(ctx, operation) {
  const pending = state.journals(ctx, ({ id, status }) => ({ id, status }))
    .find((j) => j.status === "running" && j.id !== operation);
  requireValue(!pending, `Interrupted operation ${pending?.id} must be recovered first.`);
}

function repository(ctx, graph) {
  const remote = git.remoteConfig(ctx.root, graph.repository.remote);
  requireValue(remote.url === graph.repository.url, "Graph remote URL changed.");
  const provider = resolveProvider(remote.url, graph.repository.provider);
  const key = identity(remote.url, provider, ctx.root);
  return provider.kind === "ado" ? key.toLowerCase() : key;
}

function provider(ctx, graph) {
  return ctx.providerFactory?.(graph.repository.provider) ??
    providerFor(graph.repository.provider, ctx.root);
}

function branches(graph) {
  return [graph.target, ...graph.nodes.flatMap((n) =>
    [n.branch, n.baseBranch, helperBranch(graph, n.id)])].filter(Boolean);
}

function observe(ctx, graph, previous, p) {
  const names = [...new Set([...branches(graph), ...branches(previous)])].sort();
  for (const name of names) git.checkBranch(ctx.root, name);
  const remote = git.remoteRefs(ctx.root, graph.repository.remote);
  return {
    local: Object.fromEntries(names.map((b) => [b, git.refId(ctx.root, `refs/heads/${b}`)])),
    remote: Object.fromEntries(names.map((b) => [b, remote[`refs/heads/${b}`] ?? null])),
    prs: Object.fromEntries(graph.nodes.filter((n) => n.pr).map((n) =>
      step("Observing imported PR identity", () => [n.id, p.get(n.pr.id)], nodeDetails(graph, n)))),
  };
}

function stablePr(pr, target) {
  if (pr.baseBranch !== target) return pr;
  const { base, ...stable } = pr;
  return stable;
}

function forward(ctx, source, p, before, after) {
  requireValue([before, after].every((sha) => shaPattern.test(sha)), "Invalid target commit identity.");
  for (const root of [ctx.root, source.root]) {
    if ([before, after].every((sha) =>
      git.git(root, ["cat-file", "-e", `${sha}^{commit}`], undefined, true).status === 0)) {
      return git.ancestor(root, before, after);
    }
  }
  requireValue(p.mergeBase, "Target ancestry is unavailable; fetch current target and replan.");
  return p.mergeBase(before, after) === before;
}

export function createImportPlan(ctx, options) {
  noPending(ctx);
  requireValue(options.sourceRepo, "Import requires an explicit --source-repo.");
  const source = git.context(fs.realpathSync(options.sourceRepo));
  requireValue(source.common !== ctx.common, "Import requires a different local clone.");
  noPending(source);
  requireValue(!fs.existsSync(`${source.dir}/mutation.lock`), "Source graph is locked.");
  const previous = state.load(ctx, options.graph);
  const incoming = state.load(source, options.graph);
  requireValue(previous.target === incoming.target, "Import cannot change the integration target.");
  requireValue(repository(ctx, previous) === repository(source, incoming),
    "Source and destination repository identities differ.");
  for (const sha of snapshots(previous)) git.commitId(ctx.root, sha);
  const pins = [...new Set(snapshots(incoming))].sort();
  for (const sha of pins) {
    requireValue(shaPattern.test(sha) && git.commitId(source.root, sha) === sha,
      "Imported snapshots require immutable full commit IDs.");
  }
  requireValue(git.ancestor(source.root, previous.targetSha, incoming.targetSha),
    "Imported integration snapshot does not descend from the previous snapshot.");
  const graph = structuredClone(incoming);
  graph.repository = structuredClone(previous.repository);
  graph.backup = structuredClone(previous.backup);
  requireValue(previous.nodes.filter((n) => !graph.nodes.some((other) => other.id === n.id))
    .every((n) => n.landing || (n.retired && !n.pr)),
  "Import cannot omit an unlanded or hosted retired node; recover its identity explicitly.");
  const p = provider(ctx, graph);
  requireValue(p.kind !== "local", "Graph import requires authoritative hosted PR receipts.");
  const facts = observe(ctx, graph, previous, p);
  requireValue(facts.remote[graph.target] &&
    forward(ctx, source, p, graph.targetSha, facts.remote[graph.target]),
  "Imported integration snapshot is not on the live target history.");
  const updates = new Map();
  for (const node of graph.nodes) {
    requireValue(node.branch !== graph.target, "Imported node collides with integration target.");
    requireValue(git.refId(source.root, `refs/heads/${node.branch}`) === node.head,
      `Source node branch differs from its manifest: ${node.id}`);
    requireValue(digest(normalizeChange(source.root, node.change)) === digest(node.change),
      `Imported own-change fingerprint differs: ${node.id}`);
    const old = previous.nodes.find((n) => n.id === node.id);
    requireValue(!old || (old.branch === node.branch &&
      (!old.pr || old.pr.id === node.pr?.id)),
    `Existing branch or hosted PR identity changed: ${node.id}`);
    requireValue(!old?.landing || digest(old.landing) === digest(node.landing),
      `Existing landing changed: ${node.id}`);
    if (!node.retired) {
      const pr = facts.prs[node.id];
      requireValue(pr && pr.id === node.pr?.id && pr.branch === node.branch &&
        pr.head === node.head && pr.baseBranch === node.baseBranch,
      `Live PR differs from imported node: ${node.id}`);
      if (node.landing) {
        requireValue(pr.state === "merged" && pr.landing === node.landing.commit &&
          pr.baseBranch === graph.target &&
          git.ancestor(source.root, pr.landing, graph.targetSha),
        `Imported landing is unproven: ${node.id}`);
      } else {
        requireValue(pr.state === "open" && facts.remote[node.branch] === node.head,
          `Imported product head is not live: ${node.id}`);
        const base = node.baseBranch === graph.target ? graph.targetSha : facts.remote[node.baseBranch];
        requireValue(base && git.out(source.root, ["merge-base", node.head, base]) === node.base,
          `Imported own-change base differs: ${node.id}`);
        requireValue(node.baseBranch === (eligible(graph, node) ? graph.target : helperBranch(graph, node.id)),
          `Imported dependency target differs: ${node.id}`);
        if (node.baseBranch !== graph.target) updates.set(node.baseBranch, node.base);
      }
      node.pr = pr;
    } else {
      requireValue(!node.pr, "Import does not retire or close hosted PRs.");
    }
    updates.set(node.branch, node.head);
    node.validations = [];
    node.validationReason = null;
    node.validation = null;
    node.ready = false;
    delete node.signature;
    if (node.integration) delete node.integration.verifiedAt;
  }
  for (const node of graph.nodes) {
    requireValue(!updates.has(graph.target) &&
      (!updates.has(helperBranch(graph, node.id)) ||
        !graph.nodes.some((n) => n.branch === helperBranch(graph, node.id))),
    "Imported helper and product branches collide.");
  }
  const changes = [...updates].filter(([branch, head]) => facts.local[branch] !== head)
    .map(([branch, head]) => {
      requireValue(!git.occupied(ctx.root, branch), `Branch is checked out: ${branch}`);
      return { branch, expected: facts.local[branch], head };
    });
  if (graph.integration) delete graph.integration.verifiedAt;
  delete graph.source;
  delete graph.combined;
  delete graph.adoption;
  graph.import = { source: source.root, digest: digest(incoming), composition: "unverified" };
  const plan = {
    action: "import-graph", repository: ctx.root, common: ctx.common,
    previous, previousDigest: digest(previous), graph, source,
    sourceDigest: digest(incoming), pins, facts, updates: changes,
    omittedNodes: previous.nodes.filter((n) => !graph.nodes.some((other) => other.id === n.id)).map((n) => n.id),
    effects: [
      `Import the exact graph manifest from ${source.root}; replace DAG shape without reconstructing source.`,
      "Fetch only pinned local-clone snapshots into private refs; preserve old manifest and all previous snapshots.",
      "Atomically update only listed unoccupied branches using expected-old-SHA checks; preserve omitted branches.",
      "Leave integration branches, worktrees, indexes, remotes, PR bodies and draft states unchanged.",
      "Clear imported validation commands/results, readiness, signatures, freshness timestamps and composition claims.",
      "Preserve destination backup settings; do not upload, delete, or run imported commands.",
    ],
    warnings: ["Local recovery only. Integration freshness and dependency composition remain unverified."],
  };
  requireValue(digest(state.load(ctx, graph.id)) === plan.previousDigest &&
    digest(state.load(source, graph.id)) === plan.sourceDigest, "Graph changed during import planning.");
  return { ...plan, approval: digest(plan) };
}

export function applyImportPlan(ctx, plan) {
  const file = state.journalFile(ctx, plan.approval);
  let journal = state.readJson(file, true);
  noPending(ctx, plan.approval);
  const current = state.load(ctx, plan.graph.id);
  if (journal?.candidate && digest(current) === digest(journal.candidate)) {
    journal.status = "done";
    state.atomicJson(file, journal);
    return { graph: current, operation: plan.approval, alreadyDone: true };
  }
  requireValue(!journal || journal.status === "running", "Import was aborted or superseded.");
  requireValue(digest(current) === plan.previousDigest, "Destination graph changed; replan import.");
  const source = git.context(plan.source.root);
  requireValue(source.common === plan.source.common, "Source repository identity changed.");
  noPending(source);
  requireValue(!fs.existsSync(`${source.dir}/mutation.lock`), "Source graph is locked.");
  requireValue(digest(state.load(source, plan.graph.id)) === plan.sourceDigest,
    "Source graph changed; replan import.");
  for (const node of plan.graph.nodes) {
    requireValue(git.refId(source.root, `refs/heads/${node.branch}`) === node.head,
      `Source node branch changed: ${node.id}`);
  }
  requireValue(repository(ctx, current) === repository(source, state.load(source, plan.graph.id)),
    "Source and destination repository identities differ.");
  const p = provider(ctx, plan.graph);
  const facts = observe(ctx, plan.graph, plan.previous, p);
  requireValue(forward(ctx, source, p, plan.facts.remote[plan.graph.target], facts.remote[plan.graph.target]),
    "Integration target rewound or diverged.");
  for (const [branch, sha] of Object.entries(plan.facts.remote)) {
    requireValue(branch === plan.graph.target || facts.remote[branch] === sha, `Remote ref changed: ${branch}`);
  }
  for (const [id, pr] of Object.entries(plan.facts.prs)) {
    requireValue(digest(stablePr(pr, plan.graph.target)) === digest(stablePr(facts.prs[id], plan.graph.target)),
      `PR changed: ${id}`);
  }
  for (const [branch, sha] of Object.entries(plan.facts.local)) {
    const update = plan.updates.find((u) => u.branch === branch);
    requireValue(facts.local[branch] === sha || (journal && update && facts.local[branch] === update.head),
      `Local ref changed: ${branch}`);
  }
  for (const update of plan.updates) {
    requireValue(!git.occupied(ctx.root, update.branch), `Branch is checked out: ${update.branch}`);
  }
  journal ??= { id: plan.approval, plan, status: "running", local: {}, remote: {}, prs: {},
    commits: {}, pendingChange: null, remoteStarted: false };
  const graph = structuredClone(plan.graph);
  graph.revision = plan.previous.revision + 1;
  graph.lastOperation = plan.approval;
  graph.import.operation = plan.approval;
  journal.candidate = graph;
  state.atomicJson(file, journal);
  step("Fetching pinned snapshots from approved local clone", () => {
    git.out(ctx.root, ["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "--", source.root,
      ...plan.pins.map((sha) => `${sha}:refs/pr-graph/${plan.approval}/imported/${sha}`)]);
  });
  const oldPins = [...new Set([...snapshots(plan.previous), ...Object.values(plan.facts.local)].filter(Boolean))];
  const commands = ["start"];
  for (const sha of oldPins) {
    requireValue(shaPattern.test(sha) && git.commitId(ctx.root, sha) === sha, "Previous snapshot is unavailable.");
    const ref = `refs/pr-graph/${plan.approval}/original/${sha}`;
    const existing = git.refId(ctx.root, ref);
    requireValue(!existing || existing === sha, "Previous snapshot pin changed.");
    commands.push(existing ? `verify ${ref} ${sha}` : `create ${ref} ${sha}`);
  }
  for (const [branch, sha] of Object.entries(plan.facts.local)) {
    const update = plan.updates.find((u) => u.branch === branch);
    const actual = facts.local[branch];
    commands.push(update && actual !== update.head
      ? `update refs/heads/${branch} ${update.head} ${sha ?? "0".repeat(update.head.length)}`
      : `verify refs/heads/${branch} ${actual ?? "0".repeat(graph.targetSha.length)}`);
  }
  commands.push("prepare", "commit");
  step("Updating approved local DAG branches atomically", () =>
    git.out(ctx.root, ["update-ref", "--stdin"], `${commands.join("\n")}\n`));
  for (const update of plan.updates) journal.local[update.branch] = update.head;
  state.atomicJson(file, journal);
  state.save(ctx, graph, plan);
  journal.status = "done";
  state.atomicJson(file, journal);
  return { graph, operation: plan.approval, updates: plan.updates,
    warning: "Imported locally only; validation and composition are unverified. No hosting writes or checkout changes." };
}
