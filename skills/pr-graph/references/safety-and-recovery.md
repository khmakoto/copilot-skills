# Safety, state, and recovery

## State and approvals

Local state lives in `<git-common-dir>/pr-graph/`, shared by linked worktrees:

```text
graphs/<graph-id>.json
operations/<approval-digest>.json
mutation.lock
trees/<operation-id>/
```

Git refs under `refs/pr-graph/` pin original snapshots, candidate commits, and
downloaded metadata. They are not product branches.

Graph files are version-checked and atomically replaced. Corruption is an error,
not an empty graph. Journals record intent before changes and individual write
results afterward. The repository-wide mutation lock covers operations through
their writes; it is not expired based on age.

Each plan includes a digest, exact changes/commands, local/remote observations,
and provider payload inputs. The helper verifies approval and freshness.
Tool permissions and a generic `--yes` are not approval of a changed plan.

## Freshness before inspection or mutation

The skill's mandatory preflight checks all local DAG node branches, the actual
integration branch, and existing local `main`/`master` branches against freshly
fetched remote tips before any graph/change inspection or mutation. Before graph
creation, check the source and intended integration branches instead.

Minimal safety and branch-discovery reads are necessary to perform this check;
they do not authorize examining changes or executing the requested operation
against stale branches. Fetches and fast-forwards require concrete approval.
Use explicit private fetch refspecs and compare-and-swap local updates; never
trust cached tracking refs or arbitrary configured fetch mappings.

Only behind, non-divergent, unoccupied branches may advance. Ahead branches keep
their local commits. Divergence, inaccessible remotes, missing upstreams, moving
tips, and occupied branches needing updates are blockers, not permission to
reset, stash, force, rebase, or push. Report unpublished branches with no remote
counterpart and repositories with no remote without inventing a freshness check.

This prerequisite is enforced by the skill workflow, not automatically by the
helper CLI. It neither adopts changed node content into graph metadata nor
refreshes validation results. Reconcile changed DAG heads explicitly. Ref
changes invalidate affected approved plans and require replanning and approval.
For interrupted operations, establish ownership and recovery constraints before
moving any affected branch; do not invalidate an operation merely to pass this
gate.

## Failed or interrupted operations

After the freshness preflight, run `status` first. If an interrupted operation
prevents safe fast-forwarding, limit initial reads to its journal, refs, and
worktree safety facts and resolve that blocker explicitly. A running journal
prevents unrelated mutations.

- Fix a transient failure only when the approved plan's inputs remain valid,
  then `continue` using that operation's original approval digest.
- If the helper recorded a pending patch, inspect its named tool worktree.
  Resolve semantically, stage only the proposed fix there, and create a
  `resolve` plan. That plan includes the exact staged patch and HEAD.
- Approve/apply the resolution, then continue the original operation.
- If a remote request may have succeeded before its response was recorded,
  create a `reconcile` plan. It shows observed refs and PRs, including
  discoverable graph-identified PRs. Approve only understood effects.
- Reconciliation accepts only states consistent with the original candidate.
  Unknown content/landings remain blocked and require explicit investigation
  and compensation; do not edit journal JSON to bypass the check.

Local `abort` restores eligible pre-existing refs only if they are still
unoccupied and match the operation's recorded state. It retains newly created
refs, snapshots, and the worktree. Abort refuses automatic rollback when remote
effects may exist. A push-only failure with no provider writes can be aborted
after an approved readback proves the relevant remote refs remain at their
original values. Do not promise that a remote API call can be undone.

If a process died while holding a lock, `plan unlock` requires a same-host owner
whose PID is verifiably dead and rechecks that owner on apply. A live or
unobservable owner is not automatically overridden. Different-host lock
diagnosis requires environment-specific assistance.

## Portable committed snapshots

Opt-in backup uses a dedicated **normal branch** on the chosen remote, by
default `pr-graph/<graph-id>/metadata`. Its tree contains `graph.json`; its
parents pin the needed source/base/result snapshots, including committed work
that has no PR.

The metadata branch contains reachable product code and history with the
remote's access permissions. It is not private just because it has no PR.
Never enable it silently or transfer snapshots to a different service.

Backup does not include staged, unstaged, untracked, or ignored work. Explicit
status warnings identify unbacked-up working-tree edits. Local changes after the
last successful backup may be lost if the clone is lost.

Writes are guarded by the observed metadata head and local graph revision.
A second machine with stale metadata is refused; the helper does not merge
concurrent manifests.

### Restore on another machine

1. Clone the intended repository.
2. Plan/approve `fetch-backup` for the selected remote and graph ID. It fetches
   only the snapshot into a private local ref.
3. Inspect the manifest and plan/approve `restore --backup-ref <downloaded-sha>`.
4. Restore verifies repository identity and complete reconstructed content. It
   does not overwrite an existing graph or incompatible branch.
5. Re-read local repository instructions. Configure validations through an
   approved `deps` spec; restored commands/results are deliberately cleared.
6. Plan/approve sync to reconcile current remote state, then explicitly ready
   eligible nodes as appropriate.

Metadata paths and stored commands are never executed as authority. Machine-local
operation worktrees are not restored as if they existed on the new machine.

## Non-atomic remote writes

Use expected-SHA leases, never unconditional force pushes. Atomic multi-ref push
is preferred. Non-atomic fallback must be disclosed in the approved plan.
Partial failures are errors even when some refs or PRs were updated.

The helper fetches needed remote objects into private refs, without using a
repository's arbitrary configured fetch mappings to move user branches.
Server state is read back after writes.

Git refs, PR APIs, and metadata backup are separate systems. Journals and
approved reconciliation provide recoverability, not distributed rollback.

## Cleanup

List exact obsolete local/remote branches, retired PRs, and the specific
tool-owned worktree in a separate cleanup plan. No broad glob removal, forced
dirty-worktree deletion, source/target deletion, or automatic snapshot pruning.
Preserve unfinished operations and their pinned objects.

A clean completed worktree can be removed through `git worktree remove` without
force. Dirty retained worktrees require investigation and a separately approved
content-preserving resolution. Snapshot reachability pins are deliberately
retained rather than garbage-collected implicitly.
