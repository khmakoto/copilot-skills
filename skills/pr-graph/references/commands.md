# Command reference

Run with Node.js 22+ and Git 2.31+. No dependency install is necessary.
`<helper>` below means the absolute installed `scripts/pr-graph.mjs` path.
Use quoted paths, particularly on Windows.

Read the relevant action reference before preparing a plan:

- [Change specifications and shape commands](change-specs.md): complete graph
  specs, splitting, adding, dependencies, folding, and removal.
- [Lifecycle commands](lifecycle-commands.md): publication, sync, retargeting,
  readiness, merging, descriptions, and landing receipts.
- [Backup and recovery commands](recovery-commands.md): checkpoint, adoption,
  backup/restore, interrupted operations, and cleanup.

```text
node "<helper>" help
node "<helper>" analyze --repo "<repo>" --base "<integration-ref>" --head "<source>"
node "<helper>" status --repo "<repo>" --graph feature
node "<helper>" view --repo "<repo>" --graph feature
node "<helper>" check --repo "<repo>" --graph feature
node "<helper>" plan remove-retired --repo "<repo>" --graph feature --node staging --out "<plan.json>"
```

Commands emit JSON except `help` and `view`. Failures emit a JSON error to stderr
and exit nonzero. Errors include the retained operation ID when applicable.
`doctor` is read-only; it does not repair state implicitly.

### Live progress

Repository commands report progress to stderr by default, leaving stdout result
shapes unchanged. Interactive terminals show colors and a spinner with completed
steps retained as lines; redirected output is plain append-only text. `NO_COLOR`
disables colors, and a dumb terminal uses plain output. `help` has no progress.

Per-node phases include node ID, position/total in the active DAG, branch,
PR URL or ID when known, and elapsed completion time. The position identifies
the node, not a completed-node count or percentage; phases may visit it again.
Shared planning, observations, freshness inspection, composition verification,
backup, and recovery also report progress. A quiet step gets a heartbeat every
two minutes, even while a Git, provider, hook, or validation command blocks.
Successful validation output stays captured; commands and pass/fail are shown,
with captured output included only on failure. Reused validation and approved
no-check reasons are labeled separately.

All commands accept `--quiet` to suppress progress, including heartbeats and
spinners, without suppressing errors or final results:

```text
node "<helper>" status --repo "<repo>" --graph feature --quiet
```

With progress enabled, stderr contains human-readable progress as well as the
JSON error on failure; it is not a JSON-only stream. Use `--quiet` when a caller
requires the previous error-only stderr contract. Progress never changes a
plan, approval digest, validation identity, or mutation authorization.

Before invoking any repository inspection or mutation command, complete the
skill's [branch freshness preflight](../SKILL.md#0-mandatory-branch-freshness-preflight).
Check local DAG branches, the actual target, and existing `main`/`master`
branches against freshly fetched tips, and obtain approval for required
fast-forwards. An integration target named exactly `main` or `master` may
remain behind during the documented 90-minute grace outside merging; do not
advance it repeatedly during that window. Block on divergence or unsafe worktree updates. This prerequisite
is a skill workflow; these CLI commands do not automatically fetch or advance
branches. Local ref changes invalidate plans unless explicitly reconciled;
only documented remote-target fast-forwards are tolerated.

### Skill auto mode (not a helper flag)

```text
/pr-graph --auto split [repository, graph, or constraints]
/pr-graph --auto ready [repository, graph, and node]
```

An unambiguous user instruction such as "Split this branch using auto mode"
also enables the same task-scoped behavior when the agent selects pr-graph
automatically. A mention, quotation, or question about auto mode does not.
The agent consumes this authorization for the current invocation/task only;
the helper does not accept `--auto`.
Follow the [auto-mode policy](../SKILL.md#invocation-scoped-auto-mode):
review and save exact routine in-scope plans, then use the normal digest-based
apply commands without repeated human prompts. Preflight fetches, safe
fast-forwards, expired-grace sync/replanning and validation, and routine diagram
updates are included. No freshness or helper safety check is bypassed.

Merging, removal/deletion/cleanup, backup upload/download, restore, and recovery
decisions still require human approval. A routine plan containing an enabled
backup upload also requires approval. Blockers pause the workflow; after an
approved resolution and rechecks, auto mode resumes for the original task.
Without an explicit flag or unambiguous direct user instruction, all existing
interactive approvals apply.

### Freshness reports

`status`, `check`, and `doctor` include a `freshness` map keyed by node ID;
`view` shows each node's integration, branch, and validation status. Plans and
graph operation results also include freshness, and status exposes running
candidate reports separately. These are live read-only observations, not
automatic fetches, branch updates, or renewed verification timestamps.

Each integration report includes `status` (`current`, `grace`, `stale`, or
`unknown`), `snapshot`, `observedTip`, `verifiedAt`, `ageMs`, `thresholdMs`,
`expiresAt`, `observedAt`, `scope`, and `mergeCurrent`. Timestamps are epoch milliseconds.
Branch reports compare recorded/local/remote heads and distinguish unpublished
and local-only scope. Validation is independently `current`, `stale`, or
`missing`; none of these imply dependency eligibility or provider-policy success.

Only `main`/`master` integration snapshots have a 90-minute grace, measured from
the start of the last successful fetch for the latest tip, supplied through
`--fetch-observation`. Fetch completion, planning, and applying do not restart it.
Without this input, direct helper callers retain the last recorded exact-target
observation as a compatibility fallback; that is not remote fetch evidence.
Later target observations must be verified fast-forwards; they never extend
the clock while the authored snapshot is behind. At exactly 90 minutes grace
expires. Legacy/restored snapshots without verification evidence get no grace,
and neither do rewinds, future-dated evidence, or other target branch names.
Unchanged exact-current snapshots remain current regardless of age.

During grace, shape plans and publication preserve the authored snapshot and
`ready` may promote an otherwise eligible, validated node. Grace is rechecked
on apply/continue and does not relax source/helper/PR identity checks. Explicit
`sync` still adopts its approved current snapshot. `merge` always requires the
actual current integration tip; a node readied within grace may need sync and
another ready operation before it can merge. Metadata-only description
updates can report stale integration freshness without rewriting branches.

GitHub/GHES and ADO verify ancestry server-side when target or PR-target commits
are unavailable locally. With the pinned authored snapshot present, they can
observe forward movement during grace without refetching main/master. Live refs
and PR identities remain checked, and server observations never renew the window.

### Recording the fetch start

For a remote integration target named exactly `main` or `master`, capture its
live SHA and epoch-millisecond time immediately before the approved freshness
fetch starts. After the fetch succeeds and the fetched commit is available
locally, save the observation outside the product worktree:

```json
{ "target": "main", "sha": "<full-live-target-SHA-at-fetch-start>", "startedAt": 1792605600000 }
```

Pass the file to planning, not application:

```text
node "<helper>" plan split --repo "<repo>" --spec "<spec.json>" --fetch-observation "<fetch.json>" --out "<plan.json>"
```

The helper validates the target, timestamp, commit, and forward ancestry against
the live target. The normalized observation is included in the full approval
digest; apply/continue use that pinned evidence, never reread the file or restart
the clock. The agent must verify that the recorded SHA was live at fetch start
and that the fetch succeeded; the helper cannot prove a historical fetch from a
timestamp alone. Do not supply failed-fetch evidence or cached tracking tips.

If the target advances during a slow fetch or before the first plan, the fetched
snapshot may still be used for less than 90 minutes from `startedAt`. The time
spent fetching, planning, waiting for approval, and applying all counts.
Exactly-current snapshots remain current regardless of age; otherwise expired
observations, rewinds, divergence, and future timestamps cannot grant grace.
Reusing an observation or fetching an already-ahead target cannot renew an older
snapshot's window. A new fetched tip starts its own window only for work authored
on that tip. Merge always requires the actual current target.

## Plan, approve, apply

For reconstruction actions, `--commit-trailers-file <json>` accepts a nonempty
JSON array of single-line `Key: value` strings. Planning includes those exact
lines in its digest and effects. Apply and conflict recovery append the pinned
trailers to reconstruction commit messages, without changing PR titles or
rereading the file. Supply the option again when planning a new operation; it
does not alter Git configuration or persist a graph-wide commit policy.
Supported actions are `init`, `split`, `add`, `deps`, `split-node`, `fold`,
`remove`, `sync`, `publish`, `retarget`, and `record-landing`; other actions reject
the option. Without it, reconstruction messages retain their existing behavior.

### Reusing a retained operation worktree

For `sync`, `publish`, and `retarget`, `--reuse-worktree <operation-digest>` can
reuse the worktree of a completed or explicitly aborted operation for the same
graph and repository:

```text
node "<helper>" plan sync --repo "<repo>" --graph feature --reuse-worktree "<stopped-operation-digest>" --out "<plan.json>"
```

Planning pins the source journal, exact path, Git administrative-directory
identity, and HEAD. The source must have no pending change; its worktree must be
registered, detached, unlocked, and clean including untracked files. Apply
rechecks those leases under the repository mutation lock before transferring
ownership in both journals. The path and ignored installed tooling are retained;
no new worktree, automatic install, stash, or cleanup is performed.

Use the latest owner operation when reusing the same worktree again. Earlier
owners cannot recover or clean a transferred worktree, and plans approved before
the transfer are invalidated. Recovery and status use the retained path, not a
new directory named after the current operation. Freshness, commit hooks,
cleanliness checks, composition, and validation requirements are unchanged.
Reusing a worktree does not reuse an expired snapshot or renew its fetch clock.

```text
node "<helper>" plan split --repo "<repo>" --spec "<spec.json>" --out "<plan.json>"
node "<helper>" apply --repo "<repo>" --plan "<plan.json>" --yes --approve "<digest>"
```

For example, save the required trailer lines outside the product worktree:

```json
["Co-authored-by: Contributor <contributor@example.invalid>", "Session: example"]
```

Then include them in the reconstruction plan:

```text
node "<helper>" plan split --repo "<repo>" --spec "<spec.json>" --commit-trailers-file "<trailers.json>" --out "<plan.json>"
```

The plan's `approval` field is a digest of the full payload. The agent must
obtain human approval before using it, except for reviewed routine in-scope
plans authorized by the skill's explicit `--auto` mode. The helper always
requires `--yes --approve <digest>`. This is an integrity check and workflow
contract, not cryptographic evidence that a human clicked Approve.

Plans contain code and descriptions. Keep them outside the product working
tree and use a new filename per revision. Without `--out`, the plan is printed
as JSON; persist it unchanged before applying.
