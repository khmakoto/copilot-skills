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

The skill's explicit, invocation-scoped
[`--auto` mode](../SKILL.md#invocation-scoped-auto-mode) authorizes the agent to
review and approve exact routine in-scope plans and preflight commands without
repeated human prompts. The helper's digest and all safety checks remain
mandatory. This exception does not authorize merging, removal/deletion/cleanup,
backup upload/download (including backup effects embedded in routine plans),
restore, adoption, or checkpoint preservation. Conflicts, failed checks,
unexpected changes, and uncertain remote effects require a pause and a
human-approved resolution/recovery plan. After
that resolution, recheck inputs and resume auto mode only for the original task.
Never treat auto mode as permission to resolve conflicts or retry ambiguous
writes automatically.

## Freshness before inspection or mutation

The skill's mandatory preflight checks all local DAG node branches, the actual
integration branch, and existing local `main`/`master` branches against freshly
fetched remote tips before any graph/change inspection or mutation. Before graph
creation, check the source and intended integration branches instead.
The integration branch alone may remain behind within the documented 90-minute
main/master grace outside merging. Report that status explicitly, keep
checking live history, and do not repeatedly fast-forward it during grace.
Record the live target SHA and the start time of the successful fetch for the
latest tip, then pass `--fetch-observation` when planning. A slow fetch consumes
the window; its completion and later observations do not restart the clock.
Verified main/master forward movement during that window is the only moving-tip
exception, including before initial graph creation.

Minimal safety and branch-discovery reads are necessary to perform this check;
they do not authorize examining changes or executing the requested operation
against stale branches. Fetches and fast-forwards require concrete approval.
In auto mode, review those exact commands under the invocation's authorization
instead of prompting; expired main/master grace permits necessary safe updates,
sync/replanning, and revalidation, not skipping freshness or extending the clock.
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
changes invalidate affected approved plans and require replanning and approval,
except for explicitly supported remote-target fast-forwards or approved recovery.
For interrupted operations, establish ownership and recovery constraints before
moving any affected branch; do not invalidate an operation merely to pass this
gate.

## Failed or interrupted operations

### Releasing an occupied node without stashing

`plan checkpoint --graph <id> --spec <json>` preserves the selected checkout's
already-staged source on a new local branch before reconstructing its occupied
graph node. The spec contains the graph `id`, new `branch`, and exact commit
`message`. This separate preservation operation needs concrete approval and
does not reconstruct against main/master, publish, or change graph metadata.
The checkout HEAD must match its recorded node; a stale integration snapshot
does not prevent preserving work on its original authored base.

The plan refuses unstaged or untracked work rather than staging it implicitly.
Apply rechecks the exact staged patch, creates and switches only this checkout
to the approved new branch, and commits through normal hooks/signing. The
original graph branch remains unchanged. Commit-hook failures preserve the
checkpoint checkout/index and journal; fix the actual hook blocker before
retrying the same plan with `continue`. Unknown commits or changed staged
content block recovery. Keep the checkpoint branch after repartition; its
cleanup requires separate approval.

### Adopting external graph recovery

`plan adopt --graph <id> --spec <json>` is a separately approved, local-only
recovery operation, not interrupted-operation `reconcile`. Use it when existing
hosted PRs were externally reconstructed or landed after the persisted graph
snapshot. The spec contains `id`, an immutable fetched `targetSnapshot`, an
optional `helperBranchPrefix`, and every node's `id`, `head`, `base`,
`baseBranch`, plus `landing` for merged nodes. Node IDs, branches and dependency
edges are retained.

Establish live source/helper refs and provider receipts before planning.
Explicitly investigate divergent or deleted branches; approval of adoption
must cover their exact old/new identities. The plan verifies each authored
own-change merge base and that provider-confirmed landings reach the pinned
target snapshot. Previously recorded landing identities remain immutable.
It does not prove that reconstructed dependency closures compose losslessly.

Application preserves the full previous manifest in its journal, pins old/new
snapshots, and updates only listed unoccupied local branches in an expected-SHA
Git transaction. An unchanged occupied branch and its dirty index/worktree are
left alone. No remote refs, PR metadata, worktrees, or main/master refs change.
Validation, readiness and combined/reconstruction caches are invalidated.
The journal supports an identical-plan `continue` if graph finalization was
interrupted; unknown local/remote/PR changes block it.

This recovery permits read-only comparisons of the adopted, pinned node deltas
without first reconstructing source against a moving main/master. Report stale
or unknown authored snapshots explicitly; do not claim current validation or
verified composition. Moving integration tips and their PR preview bases do
not change the approved authored snapshot; current-target ancestry is not
implied by this metadata operation. Publication, sync, readiness and merge
still require their normal freshness preflight, composition checks and
separate approvals.

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

For a first publication interrupted during pushes, `plan abort
--retain-published-refs` can stop the operation without rolling back verified
candidate refs. It requires unchanged persisted graph and local refs, no
pending patch or provider writes, and no discoverable PR for any node. Every
remote ref must equal its original value or its exact approved candidate;
target/metadata changes and unknown content are refused. The plan captures
the full readback, which is rechecked on apply. All refs, snapshots and the
worktree remain; only the operation is marked aborted. Replan and separately
approve any namespace change and subsequent publication. Ordinary abort
behavior is unchanged.

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

A full `retarget` operation keeps its approved reconstruction snapshot fixed.
It can observe later fast-forwards of the new remote integration branch without
adopting them as authored content. Reconciliation may record only such forward
target movement, exact candidate refs, and understood PR updates. Rewound targets,
unexpected source/helper content, and landings remain blockers. Conflicts still
require the normal staged-resolution approval; partial publication retains the
same operation and PR identities.

Description-only operations use the same forward-target observation rules,
without reconstructing or publishing source refs.

When the mandatory native preflight independently fast-forwards local integration
during a paused retarget or description-only operation, an exact reconciliation can adopt that observation only
if it descends from the original local tip and remains on the observed remote
integration history. A forward-target reconciliation plan explicitly permits subsequent
remote integration fast-forwards while keeping its approved local observation
fixed. A PR preview base may advance with that target only while preserving its
authored own-change merge base; its head, body, branch, draft and other facts
remain exact. All other observed refs remain exact. The original
reconstruction snapshot stays fixed. Other changed local refs are not implicitly
adopted.

Non-merge source operations and readiness may also tolerate remote main/master
fast-forwards during their recorded 90-minute freshness grace. Reconciliation
does not renew that clock or change the authored snapshot; apply/continue
recheck expiry. Source/helper refs, PR content, and validation identities remain
guarded. A stale readiness/source plan must be aborted or otherwise safely
resolved and replanned after an explicitly approved sync; extending its
timestamp by editing state is not recovery. Merge has no grace exception.

## Cleanup

List exact obsolete local/remote branches, retired PRs, and the specific
tool-owned worktree in a separate cleanup plan. No broad glob removal, forced
dirty-worktree deletion, source/target deletion, or automatic snapshot pruning.
Preserve unfinished operations and their pinned objects.

A clean completed worktree can be removed through `git worktree remove` without
force. Dirty retained worktrees require investigation and a separately approved
content-preserving resolution. Snapshot reachability pins are deliberately
retained rather than garbage-collected implicitly.
