# Backup and recovery commands

Read the [command reference](commands.md) for shared invocation, freshness,
and plan/approve/apply requirements before using these commands.

## Backup and recovery actions

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

Both `adopt` and `checkpoint` require human approval even in auto mode and reject
`--fetch-observation`; neither extends or bypasses freshness for normal graph
operations. Apply the saved plan with the normal `--yes --approve <digest>`
contract. Retry an interrupted preservation/recovery only after inspecting its
journal, using `continue` with the original operation and approval digest.

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
