import { requireValue } from "../graph.mjs";
import { run } from "../git.mjs";

export function githubProvider(config, cwd, runner = run) {
  const repo = `${config.owner}/${config.repo}`;
  const qualified = `${config.host}/${repo}`;
  function api(endpoint, method = "GET", body, paginate = false) {
    const args = ["api", "--hostname", config.host, endpoint, "--method", method];
    if (paginate) args.push("--paginate", "--slurp");
    if (body) args.push("--input", "-");
    const result = runner("gh", args, cwd, body ? JSON.stringify(body) : undefined);
    requireValue(result.status === 0, `GitHub request failed: ${result.stderr}`);
    const value = JSON.parse(result.stdout);
    return paginate ? value.flat() : value;
  }
  function normalize(p) {
    requireValue(!p.head.repo || !p.base.repo || p.head.repo.id === p.base.repo.id,
      "Fork-based PRs are outside this version's scope.");
    return {
      id: p.number, url: p.html_url, title: p.title, body: p.body ?? "",
      draft: Boolean(p.draft), state: p.merged_at ? "merged" : p.state,
      branch: p.head.ref, head: p.head.sha, baseBranch: p.base.ref, base: p.base.sha,
      landing: p.merge_commit_sha, updated: p.updated_at,
    };
  }
  const get = (id) => normalize(api(`repos/${repo}/pulls/${id}`));
  function update(id, fields) {
    if (fields.draft !== undefined) {
      const query = api(`repos/${repo}/pulls/${id}`);
      if (query.draft !== fields.draft) {
        const mutation = fields.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
        api("graphql", "POST", {
          query: `mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{id}}}`,
          variables: { id: query.node_id },
        });
      }
    }
    const body = {};
    if (fields.body !== undefined) body.body = fields.body;
    if (fields.baseBranch !== undefined) body.base = fields.baseBranch;
    if (fields.state !== undefined) body.state = fields.state;
    if (Object.keys(body).length) api(`repos/${repo}/pulls/${id}`, "PATCH", body);
    const current = get(id);
    for (const key of ["draft", "baseBranch", "body", "state"]) {
      requireValue(fields[key] === undefined || current[key] === fields[key], `GitHub ${key} update was not applied.`);
    }
    return current;
  }
  return {
    kind: "github",
    capabilities() {
      const info = api(`repos/${repo}`);
      requireValue(info.permissions?.push, "GitHub repository write permission is required.");
      return {
        drafts: true, retarget: true,
        strategies: [
          info.allow_merge_commit && "merge",
          info.allow_squash_merge && "squash",
          info.allow_rebase_merge && "rebase",
        ].filter(Boolean),
      };
    },
    get,
    find(branch) {
      const prs = api(`repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${config.owner}:${branch}`)}&per_page=100`, "GET", undefined, true);
      const matches = prs.filter((p) => p.head.ref === branch && p.head.repo?.full_name === repo && p.state === "open");
      requireValue(matches.length <= 1, `Multiple PRs for ${branch}; reconcile explicitly.`);
      return matches.length ? normalize(matches[0]) : null;
    },
    create(node, body) {
      return normalize(api(`repos/${repo}/pulls`, "POST", {
        title: node.title, body, head: node.branch, base: node.baseBranch, draft: true,
      }));
    },
    update,
    diffPaths(id) {
      return api(`repos/${repo}/pulls/${id}/files?per_page=100`, "GET", undefined, true)
        .flatMap((f) => f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]).sort();
    },
    policies(id) {
      const result = runner("gh", ["pr", "view", String(id), "-R", qualified,
        "--json", "mergeStateStatus,reviewDecision,statusCheckRollup"], cwd);
      requireValue(result.status === 0, `Cannot inspect GitHub policies: ${result.stderr}`);
      const value = JSON.parse(result.stdout);
      const checks = value.statusCheckRollup;
      const checksPass = Array.isArray(checks) && checks.every((c) =>
        c.__typename === "StatusContext" ? c.state === "SUCCESS" :
          c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion));
      return {
        ok: value.mergeStateStatus === "CLEAN" && checksPass &&
          !["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(value.reviewDecision),
        facts: value,
      };
    },
    merge(id, expected, strategy) {
      const response = api(`repos/${repo}/pulls/${id}/merge`, "PUT", { sha: expected, merge_method: strategy });
      requireValue(response.merged === true, `Merge not completed: ${response.message}`);
      return get(id);
    },
  };
}
