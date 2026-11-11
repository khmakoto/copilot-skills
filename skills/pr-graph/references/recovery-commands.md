# Backup and recovery commands

Read the [command reference](commands.md) for shared invocation, freshness,
and plan/approve/apply requirements before using these commands.

## Backup and recovery actions

Portable node history is a separate, evidence-only transfer:
`plan export-history|import-history --graph <id> --archive <file>`.
Read the [archive contract](history-archives.md) and approve each exact payload
separately, or review it under the invocation's separate transfer opt-in.
Backup/restore and `import-graph` do not silently transfer originating
clone history, and importing an archive does not authorize or resume recovery.

### Importing a newer DAG from another local clone

```text
node "<helper>" plan import-graph --repo "<destination>" --graph feature --source-repo "<source>" --out "<plan>"
```

Use this separately approved recovery when a verified local clone has newer
node ownership or dependencies that `adopt` cannot represent. It can replace
an existing graph's shape, but cannot omit unlanded nodes or hosted retired
nodes, change integration targets, or change existing landing receipts.
Approval is required even in auto mode.

The plan pins both manifests, repository identities, source branches, live
product/helper refs and PR bodies, states and heads. Apply fetches only exact
local-clone snapshots into private refs, preserves the previous manifest and
all previous branch/snapshot commits, then atomically moves only approved
unoccupied branches with expected-old-SHA checks. Omitted branches remain.
An unchanged occupied node and its dirty index/worktree remain untouched.
Source and destination pending operations, source locks, unexpected changes,
target rewinds and occupied rewrites block recovery.

This never pushes, uploads backup, edits PRs, changes integration branches or
worktrees, installs tools, or executes imported commands. Destination remote
and backup settings remain. Imported checks, readiness, reconstruction and
freshness evidence are cleared; configure repository-specific validation
before subsequent source-changing operations. Lossless composition and
current-target freshness remain unverified. Only pinned read-only comparisons
are exempt from integration reconstruction, as for `adopt`.
Continue an interrupted import with its original operation and approval digest;
never edit manifests or journals manually to resume it.

### Other backup and recovery actions

`plan remove-retired --graph <id> --node <id> --out <plan>` removes only a
retired node without a PR, landing, remote product branch, or dependents.
It also removes historical `supersedes`/`replacedBy` references to that ID.
This metadata-only operation retains the previous manifest
in its journal and preserves all Git refs, commits, files, indexes, worktrees,
PRs, and validation/readiness evidence. It does not reconstruct or publish source,
upload a backup, or accept fetch-start observations. Apply with the exact digest;
`continue` resumes the same journal after an interrupted metadata write.
Human approval remains the default. In auto mode, explicitly requested removal
of identified retired metadata may proceed under the
[conditional policy](../SKILL.md#conditional-auto-approvals); do not prune it
opportunistically or expand into source/ref/worktree deletion.

To release an occupied graph node while retaining an exact local source
checkpoint, prepare `plan checkpoint --graph <id> --spec <json> --out <plan>`.
Its spec contains `id`, a new local `branch`, and the exact commit `message`.
Only already-staged content is accepted; unstaged/untracked work is refused.
It switches this checkout to the new branch and commits through hooks, leaving
the original graph branch and all remote refs untouched. This preservation
operation needs separate exact-plan approval and does not establish validation
or integration freshness. See
[checkpoint recovery](safety-and-recovery.md#releasing-an-occupied-node-without-stashing).

For externally rewritten or landed existing hosted PRs, use the separately
approved local-only adoption workflow:

```text
node "<helper>" plan adopt --repo "<repo>" --graph feature --spec "<adoption.json>" --out "<plan>"
```

The spec contains `id`, immutable fetched `targetSnapshot`, optional
`helperBranchPrefix`, and a complete `nodes` list with `id`, `head`, `base`,
`baseBranch`, and `landing` for merged PRs. It preserves node IDs, branches and
dependency edges. The plan captures live refs and PRs, proves authored merge
bases and provider landing reachability, and lists exact expected-SHA local
branch updates. It preserves the previous manifest and snapshots, refuses
occupied branch rewrites, and never changes hosting, worktrees or main/master.
It clears validations/readiness and combined reconstruction caches rather than
claiming source freshness or lossless prerequisite composition. See
[external graph recovery](safety-and-recovery.md#adopting-external-graph-recovery)
for the limited read-only comparison exception and interrupted-apply handling.

General `adopt` and `checkpoint` require human approval even in auto mode.
Requested landing-only adoption may use the conditional policy below. All three
reject `--fetch-observation`; none extends or bypasses freshness for normal
graph operations. Apply the saved plan with the normal `--yes --approve <digest>`
contract. Retry an interrupted preservation/recovery only after inspecting its
journal, using `continue` with the original operation and approval digest.

For a bounded external update, an adoption spec may use `"selective": true`
with a nonempty subset of existing nodes. Keep `targetSnapshot` equal to the
graph's recorded `targetSha` and omit `helperBranchPrefix`. Only selected live
PR identities and branches are adopted. Unselected authored changes, local
branches, landing receipts and retired snapshots remain intact, including
unpublished local reconstructions. Unselected hosted heads and targets must
still match their recorded PR identities; unrelated external changes require
explicit recovery too. Validation/readiness is invalidated for selected nodes
and their active descendants, and combined/source caches are cleared. This
does not reconstruct or publish descendants or claim current integration
freshness. Retired nodes without a PR may be retained in complete adoption;
their snapshots remain immutable.

### Landing-only adoption

```text
node "<helper>" plan adopt --landings-only --repo "<repo>" --graph feature --spec "<landings.json>" --out "<plan.json>"
```

The spec contains `id`, a full fetched `targetSnapshot`, and a nonempty `nodes`
subset of newly merged nodes. Each entry supplies the unchanged recorded `head`,
`base`, `baseBranch`, and the provider-confirmed `landing` commit. Do not combine
this mode with `"selective": false` or a `helperBranchPrefix`. For example:

```json
{
  "id": "feature",
  "targetSnapshot": "<full integration snapshot SHA>",
  "nodes": [
    { "id": "model", "head": "<unchanged head SHA>", "base": "<unchanged base SHA>",
      "baseBranch": "main", "landing": "<provider landing SHA>" }
  ]
}
```

Unlike general or selective adoption, the helper preserves every owned delta
and refuses source identity changes or local branch repair. Selected PRs must
be newly merged into the graph's intended target in prerequisite order.
Unselected hosted identities must remain consistent; all active local source
and prerequisite refs must match their recorded snapshots. Merged remote source
refs may be deleted or retain the unchanged head. The pinned target must contain
the landings and remain on the live target's forward history, rechecked on apply.
No existing branch refs move; history pins and the previous manifest are retained.
Validation/readiness is cleared for selected nodes and active descendants, and
combined/source caches are cleared. This does not establish integration
freshness, composition, validation or publication.

Auto mode may approve the exact plan only when the user requested recording
these identified landings. Any rewritten submission, unrelated identity change,
or failure of this mode's checks needs human-approved recovery; do not silently
fall back to general adoption.

### Backup and interrupted-operation commands

See [safety and recovery](safety-and-recovery.md) for complete instructions.

```text
node "<helper>" plan backup --repo "<repo>" --graph feature --out "<plan>"
node "<helper>" plan fetch-backup --repo "<new-clone>" --remote origin --graph feature --out "<download-plan>"
node "<helper>" plan restore --repo "<new-clone>" --remote origin --graph feature --backup-ref "<downloaded-sha>" --out "<restore-plan>"
node "<helper>" plan resolve --repo "<repo>" --operation "<operation-id>" --out "<resolution-plan>"
node "<helper>" plan reconcile --repo "<repo>" --operation "<operation-id>" --out "<reconciliation-plan>"
node "<helper>" continue --repo "<repo>" --operation "<operation-id>" --yes --approve "<original-digest>"
node "<helper>" plan abort --repo "<repo>" --operation "<operation-id>" --out "<abort-plan>"
node "<helper>" plan abort --repo "<repo>" --operation "<operation-id>" --retain-published-refs --out "<retained-ref-abort-plan>"
node "<helper>" plan unlock --repo "<repo>" --out "<unlock-plan>"
```

Enable backup in a new or updated complete graph spec:

```json
{ "backup": { "enabled": true, "branch": "pr-graph/feature/metadata" } }
```

Backup contains committed code and reachable history. Opt-in backup writes are
included in lifecycle plans that perform publication, sync, readiness, merging,
or description changes. Local graph edits can remain unbacked-up until one of
those operations or an explicit backup.

In auto mode, backup uploads require evidence of prior user approval of the
unchanged destination, access and content scope, including unpublished committed
history; an enabled/restored manifest alone is insufficient. Requested
`fetch-backup` may download a verified pinned source to its private ref without
another prompt. Neither allowance authorizes restore. Exact-effect `reconcile`,
dead-owner `unlock`, and local `abort` for replanning with no remote effects may
also use the [conditional policy](../SKILL.md#conditional-auto-approvals).
Verified `abort --retain-published-refs` may also use that policy only for
replanning the original interrupted first publication, with no PR/provider
effects or pending patch and unchanged graph/local refs. Every remote ref must
match its original or exact approved candidate; apply rechecks the readback.
It preserves all refs and resources and does not authorize a new namespace,
publication payload or cleanup. Keep manual approval for uncertain or unexpected
effects and all cleanup. Approved setup replay is an agent-side
[receipt workflow](setup-replay.md), not a helper installation command.

Cleanup requires a finished or locally aborted operation and a precise spec:

```json
{
  "branches": ["pr-graph/feature/bases/model"],
  "remoteBranches": [],
  "closeRetired": [],
  "worktree": true
}
```

```text
node "<helper>" plan cleanup --repo "<repo>" --operation "<operation-id>" --spec "<cleanup-spec>" --out "<cleanup-plan>"
```

Only obsolete tracked helper branches or retired-node branches can be listed.
Remote branches and retired PR closure require their explicit lists. Worktree
removal never forces a dirty worktree. Source/target/metadata branches and
unknown directories are not cleanup targets. Reachability pins are retained.
