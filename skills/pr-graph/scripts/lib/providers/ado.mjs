import { requireValue } from "../graph.mjs";
import { run } from "../git.mjs";

export function adoProvider(config, cwd, runner = run) {
  const org = `https://${config.host}/${config.organization}`;
  const resource = "499b84ac-1321-427f-aa17-267ca6975798";
  function az(args) {
    const result = runner("az", [...args, "--only-show-errors", "-o", "json"], cwd);
    requireValue(result.status === 0, `ADO request failed: ${result.stderr}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }
  function rest(endpoint, method = "GET", body) {
    return az(["rest", "--method", method, "--resource", resource, "--url", endpoint,
      ...(body ? ["--body", JSON.stringify(body), "--headers", "Content-Type=application/json"] : [])]);
  }
  const root = `${org}/${encodeURIComponent(config.project)}/_apis/git/repositories/${encodeURIComponent(config.repo)}`;
  const uri = (id) => `${root}/pullrequests/${id}?api-version=7.1`;
  function normalize(p) {
    requireValue(!p.forkSource, "Fork-based PRs are outside this version's scope.");
    return {
      id: p.pullRequestId,
      url: `${org}/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(config.repo)}/pullrequest/${p.pullRequestId}`,
      title: p.title, body: p.description ?? "", draft: Boolean(p.isDraft),
      state: p.status === "completed" ? "merged" : p.status === "abandoned" ? "closed" : "open",
      branch: p.sourceRefName.replace(/^refs\/heads\//, ""),
      head: p.lastMergeSourceCommit?.commitId ?? null,
      baseBranch: p.targetRefName.replace(/^refs\/heads\//, ""),
      base: p.lastMergeTargetCommit?.commitId ?? null,
      landing: p.status === "completed" ? p.lastMergeCommit?.commitId ?? null : null,
      updated: p.closedDate ?? p.creationDate,
    };
  }
  const get = (id) => normalize(az(["repos", "pr", "show", "--id", String(id), "--org", org, "--detect", "false"]));
  return {
    kind: "ado",
    capabilities() {
      az(["repos", "show", "--org", org, "--project", config.project, "--repository", config.repo]);
      return { drafts: true, retarget: "conditional; verified after write", atomicPush: false,
        strategies: ["merge", "squash", "rebase"] };
    },
    get,
    mergeBase(before, after) {
      requireValue([before, after].every((sha) => /^[a-f0-9]{40}$/.test(sha)),
        "ADO ancestry requires full commit SHAs.");
      const result = rest(`${root}/diffs/commits?baseVersion=${before}&baseVersionType=commit&targetVersion=${after}&targetVersionType=commit&diffCommonCommit=true&$top=1&api-version=7.1`);
      requireValue(result && (result.commonCommit === null || /^[a-f0-9]{40}$/.test(result.commonCommit)),
        "ADO ancestry is unavailable.");
      return result.commonCommit;
    },
    find(branch) {
      const all = [];
      for (let skip = 0; ; skip += 100) {
        const page = az(["repos", "pr", "list", "--org", org, "--project", config.project,
          "--repository", config.repo, "--source-branch", branch, "--status", "active",
          "--skip", String(skip), "--top", "100", "--detect", "false"]);
        requireValue(Array.isArray(page), "Invalid ADO PR list.");
        all.push(...page);
        if (page.length < 100) break;
      }
      requireValue(all.length <= 1, `Multiple ADO PRs for ${branch}.`);
      return all.length ? normalize(all[0]) : null;
    },
    create(node, body) {
      requireValue(body.length <= 4000, "ADO description exceeds 4000 characters; shorten explicitly.");
      return normalize(az(["repos", "pr", "create", "--org", org, "--project", config.project,
        "--repository", config.repo, "--source-branch", node.branch, "--target-branch", node.baseBranch,
        "--title", node.title, "--description", body, "--draft", "true", "--detect", "false"]));
    },
    update(id, fields) {
      requireValue(fields.body === undefined || fields.body.length <= 4000, "ADO description exceeds 4000 characters.");
      const body = {};
      const before = fields.baseBranch === undefined ? null : get(id);
      if (fields.body !== undefined) body.description = fields.body;
      if (fields.baseBranch !== undefined && before.baseBranch !== fields.baseBranch) {
        body.targetRefName = `refs/heads/${fields.baseBranch}`;
      }
      if (fields.draft !== undefined) body.isDraft = fields.draft;
      if (fields.state !== undefined) body.status = fields.state === "closed" ? "abandoned" : "active";
      if (Object.keys(body).length) rest(uri(id), "PATCH", body);
      const current = get(id);
      requireValue(fields.baseBranch === undefined || current.baseBranch === fields.baseBranch,
        "ADO retargeting unavailable or ignored. Stop; enable retargeting before continuing.");
      requireValue(fields.draft === undefined || current.draft === fields.draft, "ADO draft update was not applied.");
      requireValue(fields.body === undefined || current.body === fields.body, "ADO description update was not applied.");
      return current;
    },
    diffPaths(id) {
      const p = get(id);
      const paths = [];
      let skip = 0;
      for (;;) {
        const result = rest(`${root}/diffs/commits?baseVersion=${p.base}&baseVersionType=commit&targetVersion=${p.head}&targetVersionType=commit&diffCommonCommit=true&$top=100&$skip=${skip}&api-version=7.1`);
        requireValue(Array.isArray(result.changes), "ADO diff is unavailable.");
        paths.push(...result.changes
          .filter((c) => c.item?.isFolder !== true && c.item?.gitObjectType !== "tree")
          .flatMap((c) => [c.originalPath, c.sourceServerItem, c.item?.path]
            .filter(Boolean).map((s) => s.replace(/^\//, ""))));
        if (result.allChangesIncluded === true || result.changes.length < 100) break;
        skip += 100;
      }
      return [...new Set(paths)].sort();
    },
    policies(id) {
      const all = [];
      for (let skip = 0; ; skip += 100) {
        const page = az(["repos", "pr", "policy", "list", "--id", String(id), "--org", org,
          "--skip", String(skip), "--top", "100", "--detect", "false"]);
        requireValue(Array.isArray(page), "ADO policy status is unavailable.");
        all.push(...page);
        if (page.length < 100) break;
      }
      const raw = az(["repos", "pr", "show", "--id", String(id), "--org", org, "--detect", "false"]);
      const ok = raw.mergeStatus === "succeeded" && !raw.isDraft &&
        (raw.reviewers ?? []).every((r) => r.vote >= 0 && (!r.isRequired || r.vote >= 10)) &&
        all.every((p) => p.configuration?.isEnabled === false || p.configuration?.isBlocking === false ||
          ["approved", "notApplicable"].includes(p.status));
      return { ok, facts: { policies: all, mergeStatus: raw.mergeStatus, reviewers: raw.reviewers } };
    },
    merge(id, expected, strategy) {
      rest(uri(id), "PATCH", {
        status: "completed", lastMergeSourceCommit: { commitId: expected },
        completionOptions: {
          mergeStrategy: { merge: "noFastForward", squash: "squash", rebase: "rebase" }[strategy],
          deleteSourceBranch: false, bypassPolicy: false,
        },
      });
      const current = get(id);
      requireValue(current.state === "merged", "ADO merge is pending; resume after checking its completed state.");
      return current;
    },
  };
}
