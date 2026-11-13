# Command reference

Run with Node.js 22+ and Git 2.31+. No dependency install is necessary.
`<helper>` below means the absolute installed `scripts/pr-graph.mjs` path.
Use quoted paths, particularly on Windows.

Read the relevant action reference before preparing a plan:

- [Auto authorization](auto-mode.md): invocation-only routine and conditional
  approvals, retained human gates, freshness and recovery.
- [YOLO authorization](yolo-mode.md): explicit invocation-only delegation of all
  in-scope human gates, including disclosure bounds; no helper flag or check bypass.
- [Change specifications and shape commands](change-specs.md): complete graph
  specs, splitting, adding, dependencies, folding, removal, and follow-up allocation.
- [Lifecycle commands](lifecycle-commands.md): publication, sync, retargeting,
  readiness, merging, descriptions, and landing receipts.
- [Backup and recovery commands](recovery-commands.md): checkpoint, adoption, local graph import,
  backup/restore, interrupted operations, and cleanup.
- [Approved setup replay](setup-replay.md): agent-side approval receipts and
  unchanged-input checks; no helper installer or new setup authorization.
- [Portable history archives](history-archives.md): separately approved offline
  evidence export/import, provenance, completeness and retention.
- [Publication exclusions](publication-exclusions.md): persistent local-only
  node/lineage restrictions, exact outbound scope, release approval and limits.

```text
node "<helper>" help
node "<helper>" analyze --repo "<repo>" --base "<integration-ref>" --head "<source>"
node "<helper>" status --repo "<repo>" --graph feature
node "<helper>" view --repo "<repo>" --graph feature
node "<helper>" check --repo "<repo>" --graph feature
node "<helper>" select --repo "<repo>" --graph feature --select "dependents:model"
node "<helper>" absorb --repo "<repo>" --graph feature --base "<old-combined>" --head "<follow-up>"
node "<helper>" plan absorb --repo "<repo>" --graph feature --spec "<spec.json>" --out "<new-plan.json>"
node "<helper>" plan remove-retired --repo "<repo>" --graph feature --node staging --out "<plan.json>"
node "<helper>" plan adopt --repo "<repo>" --graph feature --landings-only --spec "<landings.json>" --out "<plan.json>"
node "<helper>" plan publication-policy --repo "<repo>" --graph feature --spec "<policy.json>" --out "<new-plan.json>"
```

Commands emit JSON except `help` and `view`. Failures emit a JSON error to stderr
and exit nonzero. Errors include the retained operation ID when applicable.
`doctor` is read-only; it does not repair state implicitly.
`history` and `interdiff` also accept `--format text`; their default is JSON.

`absorb` is read-only hunk/whole-file inventory with retained own-patch and
dependency provenance, not automatic ownership selection or staging. `plan
absorb` requires a complete replacement spec, pinned follow-up/expected source,
and explicit evidence-backed assignments for every unit. It preserves identities
and edges and applies only after exact approval. Read the
[allocation contract](change-specs.md#allocate-follow-up-edits-with-absorb)
before preparing amendments. Publication/readiness remain separate.

`publication-policy` requires an existing graph and a spec containing `exclude`
and `release` arrays of stable exclusion IDs plus a nonempty `reason`. Review
and apply the exact digest normally. This local operation retains evidence and
approval receipts, never uploads or reconstructs source, and cannot be silently
substituted by shape specs. Policy and outbound payload scope are part of plans;
apply/continue reject drift. Exclusion release requires human approval unless
the skill's explicit YOLO authorization covers the reviewed release and disclosure.

### Graph-relative node selection

`select --graph <id> --select <selector>` is a read-only JSON preview. It returns
`nodes` as exact IDs in stable dependency-first graph order, deduplicating shared
descendants, and `excluded` with an ID and reason for every omitted node.
It also returns the graph digest and live local/remote ref and PR observations
as `evidence`. It does not fetch, move refs, run checks, renew freshness, or
authorize mutations.

| Selector          | Meaning                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:<id>`       | Exactly this node, if active.                                                                                                                                         |
| `dependents:<id>` | This node **including the root**, plus all transitive dependents. Multi-parent descendants appear once; their other prerequisites are not selected implicitly.        |
| `eligible`        | Active nodes whose complete prerequisite closure has landing receipts in the intended target.                                                                         |
| `unpublished`     | Active nodes without a hosted PR, including live branch-based PR discovery. For local Git, nodes without a remote product branch; without a remote, all active nodes. |

Active means neither retired nor landed. These exclusions apply even to an
exact selector or the root of `dependents`; traversal still reaches active
descendants through excluded nodes. Missing root IDs and invalid syntax are
errors. An inactive exact root or no matches returns a successful empty preview
with reasons; a mutation plan rejects an empty selection. Published but stale
content is not `unpublished`; use an exact selector for republication.
Eligibility is dependency eligibility only, not passing validation, readiness,
current integration/branch identity, or provider-policy success. Preview uses
recorded landing receipts, not an implicit reconciliation of external merges.

Only `plan publish --select <selector>` currently accepts selectors for mutation.
All other actions reject them, including sync, ready, merge, shape changes, and
recovery. Do not combine `--select` with `--nodes`, `--node`, or `--spec`.
This is a fixed vocabulary, not an expression language: no unions, shell
evaluation, stored executable expressions, or implicit batch merge.
See [selective publication](lifecycle-commands.md) for effects and approval.

### Node history and interdiff

```text
node "<helper>" history --repo "<repo>" --graph feature --node model
node "<helper>" history --repo "<repo>" --graph feature --node model --format text
node "<helper>" interdiff --repo "<repo>" --graph feature --node model --from last-published
node "<helper>" interdiff --repo "<repo>" --graph feature --node model --from last-validated --format text
node "<helper>" interdiff --repo "<repo>" --graph feature --node model --from "<version-id>" --to "<version-id>"
```

Both commands require explicit graph and node IDs and perform local historical
inspection, not live provider observation. The skill's normal freshness preflight
still applies; neither command fetches, repairs state, moves refs, executes
validation commands, publishes, or renews freshness/readiness evidence.

`history` returns:

- `current`, `versions`, and `baselines`: exact retained version IDs and their
  snapshots. IDs are full 64-character digests of the graph snapshot and node
  identity, not Git commit SHAs or mutable branch names. Even unrelated graph
  metadata changes can produce another exact version ID.
- `events`: operation digest, action, recorded time, journal status, before/after
  version IDs, changed-aspect flags, publication/validation evidence, recovery
  receipts, and any recorded error. `persisted` is independent of operation
  status: a crash can leave a persisted graph with a still-running journal.
- `lineage`: explicit `from`/`to` split/fold edges. Related versions keep their
  own node IDs; many-to-many replacement is not flattened into one change.
- `gaps`: incomplete legacy evidence, missing commits, or import/restore history
  boundaries. Old journals without complete snapshots are labeled, not repaired
  or silently upgraded. Events are ordered by graph revision, recorded time,
  and receipt ID; an interrupted candidate follows its preceding revision,
  and legacy timestamps can be unknown.

An interrupted first operation is inspectable even before a graph file exists.
Its `current` selector is unavailable; retained candidate version IDs remain
explicitly distinguishable from persisted snapshots.

`interdiff --from` is required. `--to` defaults to `current`. Either endpoint can
be a retained version ID returned by history (including explicitly linked lineage
nodes), `current`, `last-published`, or `last-validated`. Named baselines apply
only to the selected node, not automatically to predecessors or replacements.
Missing or unknown selectors are errors; no fallback is guessed.

`last-published` requires an explicit matching readback receipt: remote product
and helper refs for local-provider publication, or verified PR head/base branch,
paths, body, and draft state for hosted publication. An attempted push or
uncertain provider response is insufficient. A successful per-node publication
can be recorded even if a later step leaves its operation interrupted.
`last-validated` identifies the latest matching recorded validation result,
including an explicit no-automated-check rationale. Reused validation is not a
new run, and a no-check rationale is never reported as passing tests.

Interdiff exposes separate changed-aspect flags and authored `ownChange`
base/patch/fingerprint changes. Its `comparison` is scoped to
`realized-own-change`: it derives each version's complete binary/full-index
base-to-head diff and transports both onto the `to` version's realized base
using three-way cached application. Comparing the resulting complete trees
avoids presenting unrelated base movement as a node edit and includes realized
conflict-resolution changes even when authored patches are unchanged.

The comparison uses a temporary bare repository, index, and object directory
with local objects as alternates and no source/global configuration or remotes.
It cannot hydrate missing objects from a promisor remote, including on older
supported Git versions. It removes its scratch directory afterward.
It preserves the user's working tree, index, refs, and operation worktrees.
`equal`/`different` describe the transported trees only. `inconclusive` reports
an application conflict/failure with no invented patch; `unavailable` reports
missing base/head snapshots or other unavailable local objects. Result tree IDs
identify scratch results, not retained versions; only history version IDs are selectors.
An empty interdiff or matching fingerprint is not proof of semantic equivalence,
current validation, dependency eligibility, readiness, or merge safety.

For offline inspection in another clone, use separately authorized
`plan export-history|import-history --graph <id> --archive <file>` and normal
`apply --yes --approve <digest>`. `history-archives --graph <id>` lists imported
archives. `history` and `interdiff` accept `--archive <archive-digest>` to select
one imported timeline explicitly; local baselines remain unchanged.
Imported `current` is unavailable: use a retained ID with `--to`.
Read the [archive contract](history-archives.md) before transfer, including
sensitive-source preview, incomplete evidence, origin trust, and deletion limits.

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
remain behind during the documented 3-hour grace outside merging; do not
advance it repeatedly during that window. Block on unexplained divergence or
unsafe worktree updates. Recognize journal-verified pending publication only
under the skill's narrow preflight exception; do not repair or push it here. This prerequisite
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
Follow the [auto-mode policy](auto-mode.md):
review and save exact routine in-scope plans, then use the normal digest-based
apply commands without repeated human prompts. Preflight fetches, safe
fast-forwards, expired-grace sync/replanning and validation, and routine diagram
updates are included. No freshness or helper safety check is bypassed.

The [conditional auto approvals](auto-mode.md#conditional-auto-approvals) also
cover verified dead-owner unlock, exact-effect reconciliation, no-remote-effect
local abort for replanning, unambiguous requested absorb, requested retired
metadata removal, previously approved unchanged backup uploads, and requested
private-ref backup downloads. Verify every condition; an enabled backup flag
alone is not user approval. History transfers need their separate
[invocation-scoped opt-in](history-archives.md#invocation-scoped-transfer-authorization).
Merging, source removal, branch/worktree cleanup, PR closure, restore, adoption,
graph import, checkpoint, new conflict resolutions and setup/fixes for failed
checks retain human approval. Unresolved uncertainty pauses the workflow; after
approved recovery and rechecks, auto mode resumes for the original task.
Without an explicit flag or unambiguous direct user instruction, all existing
interactive approvals apply.

`import-graph --source-repo <path>` is separately approved local recovery for
changed DAG shape in another clone. See [recovery commands](recovery-commands.md).
It never uploads or executes imported validation commands and is not included
in auto-mode routine authorization.

### Skill YOLO mode (not a helper flag)

```text
/pr-graph --yolo merge [repository, graph, node, target and strategy]
/pr-graph --yolo export-history [repository, graph and exact archive path]
```

Only explicit direct user opt-in enables the
[YOLO policy](../SKILL.md#invocation-scoped-yolo-mode). The agent consumes
`--yolo`; never forward it to the helper or persist it in state. It delegates
all pr-graph human gates necessary for this task/invocation, including merge,
deletion/closure, recovery, new setup/fixes, policy release and history transfer.
Establish exact task/disclosure bounds under the
[authorization matrix](yolo-mode.md) before approving effects. Missing intent
or destinations, unresolved remote outcomes and correctness failures still
block. Save and review each complete plan and use the unchanged digest contract;
YOLO does not override leases, freshness, validation, hooks, provider policies,
other skills or environment permissions. Ordinary auto behavior above is unchanged.

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

Only `main`/`master` integration snapshots have a 3-hour grace, measured from
the start of the last successful fetch for the latest tip, supplied through
`--fetch-observation`. Fetch completion, planning, and applying do not restart it.
Without this input, direct helper callers retain the last recorded exact-target
observation as a compatibility fallback; that is not remote fetch evidence.
Later target observations must be verified fast-forwards; they never extend
the clock while the authored snapshot is behind. At exactly 3 hours grace
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
{
  "target": "main",
  "sha": "<full-live-target-SHA-at-fetch-start>",
  "startedAt": 1792605600000
}
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
snapshot may still be used for less than 3 hours from `startedAt`. The time
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
`remove`, `absorb`, `sync`, `publish`, `retarget`, and `record-landing`; other actions reject
the option. Without it, reconstruction messages retain their existing behavior.

### Reusing a retained operation worktree

`plan sync --local-only` refreshes local reconstruction without pushes, PR
changes, or backup uploads. The approved plan pins this mode; continuation does
not reread a CLI flag. It is valid only for sync and retains every normal
freshness, lease, hook, validation, and worktree check.

For `add`, `fold`, `sync`, `publish`, and `retarget`,
`--reuse-worktree <operation-digest>` can reuse the worktree of a completed or
explicitly aborted operation for the same
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

New operation journals record versioned reconstruction receipts. An approved
transfer carries verified, privately pinned receipts from a compatible source
journal. Cache keys include the exact parent commit, patch digest, complete
requested commit message (including trailers), and an opaque execution
fingerprint. The helper verifies the result commit's sole parent, tree, and
actual message before using it. Exact hits reuse the committed result without
another patch application or commit-hook run; required validation and composition
checks still run. The plan discloses the maximum receipt count to carry.

The fingerprint covers selected hook/authoring configuration, regular hook-file
contents and modes, author/committer overrides, helper implementation, and
Node/Git versions. It is not a fingerprint of arbitrary external tooling.
Unknown hook layouts or unreadable context disable inherited reuse. Changed
parents, messages, patches or fingerprints miss the cache. Legacy journals
retain their existing operation-local caching but do not export unverified
entries. No global cache or persisted auto-mode authorization is introduced.

The helper also retains linked, digest-checked composition prefixes in the
operation journal. Identity includes the pinned target, exact ordered node IDs
and complete own-change inputs, full requested messages/trailers, and the known
execution fingerprint. It chooses the longest exact prefix and checks its
complete parent/receipt chain, operation pins, commit trees/messages, and
reachable object availability before a single clean checkout. Matching complete
prerequisite bases can be shared. Missing prefix entries fall back to individual
applications; inconsistent evidence fails explicitly. Unknown context disables
prefix reuse, even within an operation; individual-commit caching remains the
fallback. Approved retained-worktree transfers carry only verified prefixes
backed by the transferred commit receipts. Prefix records carry no validation,
readiness, authorization, or freshness. Final full-tree checks remain mandatory.

`inspect` reports each operation's `reconstruction` counts: `applied` counts
patch-application attempts (including failures), `cached` counts cache uses,
and `inheritedCached` counts uses of transferred receipts, including applications
skipped by a prefix. `visits` counts calls into the individual application layer;
`prefixHits`/`prefixMisses` count nonempty composition lookups, and `prefixAvoided`
counts individual application visits skipped. Absent counters in older journals
are not measurements. Progress reports each verified prefix hit on stderr;
normal stdout result shapes are unchanged. These are work counts, not unique
commits or elapsed-time savings. Successful conflict recovery
also records the exact approved resolve plan, captured conflict inputs, and
before/result trees; inspect exposes its `resolutionReceipts` count.

`composition-differential.test.mjs` measures application visits, subprocesses,
checkouts, journal writes/bytes, and reconstruction/composition phase durations
against the individual-commit-cache baseline on chains, shared-ancestor graphs,
and wide graphs. It compares exact trees and ordered messages, without
wall-clock assertions. Gains are topology-dependent: additional prefix metadata
can increase journal bytes for wide graphs. The uncached replay matrix separately
checks invalidation and refusal/recovery decisions.

```text
node "<helper>" plan split --repo "<repo>" --spec "<spec.json>" --out "<plan.json>"
node "<helper>" apply --repo "<repo>" --plan "<plan.json>" --yes --approve "<digest>"
```

For example, save the required trailer lines outside the product worktree:

```json
[
  "Co-authored-by: Contributor <contributor@example.invalid>",
  "Session: example"
]
```

Then include them in the reconstruction plan:

```text
node "<helper>" plan split --repo "<repo>" --spec "<spec.json>" --commit-trailers-file "<trailers.json>" --out "<plan.json>"
```

The plan's `approval` field is a digest of the full payload. The agent must
obtain human approval before using it, except for reviewed in-scope plans
authorized by explicit skill auto mode under its routine/conditional policy
or, for history transfer, auto mode plus the separate invocation-scoped opt-in,
or by explicit skill YOLO mode under its task and disclosure bounds.
The helper always
requires `--yes --approve <digest>`. This is an integrity check and workflow
contract, not cryptographic evidence that a human clicked Approve.

Plans contain code and descriptions. Keep them outside the product working
tree and use a new filename per revision. Without `--out`, the plan is printed
as JSON; persist it unchanged before applying.
