# `pr-graph` guide

This guide explains usage, requirements, and safety boundaries for
`pr-graph`. For the full skill catalog, see the [skill guide](skills.md).
The [skill instructions](../skills/pr-graph/SKILL.md) and their supporting
references define the workflow.

The skill splits existing branches and manages changes as a multi-parent
dependency graph in local Git, GitHub, GitHub Enterprise Server, or Azure DevOps.

All published nodes start as drafts. Blocked drafts use helper integration
bases to show only their own changes. A node becomes eligible for review after
every prerequisite lands. Sync, readiness, merges, and deletion require explicit
approval.

The skill can split changes within a file and reshape the graph. It supports
merge, squash, and rebase strategies. Users can opt in to recovery of committed
snapshots across machines. Footer refreshes leave completed Azure DevOps PR
descriptions unchanged. The skill labels their diagrams as historical snapshots.

```text
/pr-graph [--auto] [split | view | select | history | interdiff | export-history | import-history | add | absorb | sync | retarget | ready | merge | describe | reshape | adopt | import-graph | checkpoint | remove-retired | backup | restore]
```

## Allocate follow-up edits

Use `/pr-graph absorb` to propose which existing nodes should own follow-up edits.
The read-only helper `absorb --graph <id> --base <ref> --head <ref>` lists
the committed changes between the selected base and head. The base tree must
equal the graph's old combined tree. The inventory lists hunks and file changes
that cannot be split. It also shows retained node patches, their origins and
dependencies. Path matches suggest possible owners, but do not determine ownership
or authorize changes. The helper never stages or commits dirty work. Staging
and checkpoint preservation each require separate approval.

The agent proposes an owner for each change and explains the evidence. It leaves
ambiguous edits unassigned until the user decides. Edits to shared or new files,
cross-node changes, binary content and edits associated with landed or retired
nodes also need explicit decisions.

`plan absorb` requires an active, unlanded owner for every change. It also needs
a complete amended node spec and an expected source that includes the follow-up
edits. Supply validation commands or reasons for running no automated checks.
Absorb preserves node identities and dependency edges. New nodes or dependencies
need separate approved restructuring.

The user must approve the exact plan digest, even in auto mode. The helper then
checks each owner's changes against its assigned edits and compares the complete
combined tree with the approved source. It rebuilds dependent nodes and reruns
required checks. Changed inputs, occupied branches, conflicts and failed
validation stop the operation under the existing recovery rules. The helper
does not discard user work.

Absorb updates only local graph branches and state. Publication, hosted PR
updates, draft changes, backup uploads and readiness each need separate
authorization. See the
[full contract](../skills/pr-graph/references/change-specs.md#allocate-follow-up-edits-with-absorb).

## Node history and interdiff

The read-only helper command `history --graph <id> --node <id>` shows retained
versions, operation status, recovery receipts, and what changed. It also shows
how earlier operations split or folded nodes. Node identity stays the same when
Git commit IDs change.

Receipts record the before and after snapshots. The local clone retains these
receipts and pins available commits. The command reports missing evidence,
including gaps in legacy records. It also marks where history stops at an import
or restore. It does not repair these gaps.

The helper command `interdiff --graph <id> --node <id> --from <version|last-published|last-validated>`
compares against `current` by default. Use `--to` to select another version.
It reports changes to the node's authored patch separately from changes to its
base or prerequisites.
It compares each version's realized base-to-head diff on a common base. This
includes conflict-resolution changes. The `last-published` baseline requires
the helper to read back and verify the published result. An attempted write is
not enough. The `last-validated` baseline can include a recorded reason for
running no automated checks. The output labels that reason rather than reporting
passing tests. Missing baselines produce errors. The helper does not infer them.

Both commands default to JSON and accept `--format text`. They preserve user
worktrees, refs, and indexes. Neither command fetches objects or writes to the
hosting service. Neither renews validation, readiness, or freshness evidence.
The normal skill preflight still applies. Conflicting comparisons are
inconclusive. Equal trees after applying both diffs to a common base do not prove
semantic equivalence or merge safety. See the
[historical inspection contract](../skills/pr-graph/references/commands.md#node-history-and-interdiff).

## Portable historical evidence

Use `plan export-history --graph <id> --archive <file>` to export historical
snapshots and a self-contained Git pack. Use `plan import-history` with the same
flags to import them. Each plan requires separate approval.

The archive preserves version IDs, interrupted candidate versions, records of
splits and folds, and historical publication and validation baselines. You can
inspect them offline without the source checkout. Missing objects block export.
The archive reports gaps in incomplete legacy evidence.

Review the full export contents before approval. Discarded code, commit ancestry
and old descriptions can contain sensitive material. Keeping full history
increases storage and retention costs.

`history-archives --graph <id>` lists imports. Select one exact
`--archive <digest>` with `history` or `interdiff`. The output identifies the
archive's origin and the source of each baseline. Imported baselines never
replace local selectors. Imported `current` is unavailable. Choose an exact
`--to` version instead.

Digests detect changes to the archive. They do not authenticate its author or
prove that its results are trustworthy. Import does not restore current
validation, readiness or freshness. It never executes imported commands, resumes
recovery, moves product refs, or changes user worktrees, indexes or existing
approvals. The helper stores evidence and object-retention refs in separate
archive namespaces.

Transfers work offline without the skill's normal live freshness preflight.
They require human approval even in auto mode. Backup, restore and `import-graph`
still require separate approval and do not include the source clone's history
automatically. There is no automatic remote transfer or archive deletion.
The helper retains evidence and private refs until the user approves their
removal. See the
[archive format, trust and retention contract](../skills/pr-graph/references/history-archives.md).

## Publication and local sync

The helper command `plan publish --nodes <id,id>` publishes only selected nodes
and their required helper bases. It leaves unselected and landed PRs unchanged.
The selection must include unpublished or out-of-date prerequisites. Selective
publication keeps the existing integration snapshot. The helper refuses to
reconstruct branches if that would change unselected nodes. Sync separately when
needed.

The read-only command `select --graph <id> --select <selector>` previews exact
node IDs in stable dependency order. It gives a reason for each excluded node.

| Selector          | What it selects                                                               |
| ----------------- | ----------------------------------------------------------------------------- |
| `node:<id>`       | The named node.                                                               |
| `dependents:<id>` | The named node and all transitive dependents. Shared descendants appear once. |
| `eligible`        | Nodes whose prerequisites have landed.                                        |
| `unpublished`     | Nodes without a hosted PR, or without a remote product branch in local Git.   |

The helper excludes retired and landed nodes. Missing IDs produce an error.
Empty previews succeed, but mutation plans require at least one selected node.
Eligibility says only that prerequisites have landed. It does not show whether
validation or provider policies passed, or whether the node is ready.

Only `plan publish --select` accepts selectors for mutations. The helper rejects
them for other actions and rejects combinations with `--nodes`, `--node`, or
`--spec`. Plans list the requested IDs separately from required prerequisites
and helper bases. They list all effects, including whole-graph validation
and enabled backups.

The approval digest covers the selector, resolved IDs, graph state, and provider
observations. Apply and continue use that exact selection without reevaluating
or expanding it. External changes to the graph, refs, or PRs require a new plan.
The helper never silently publishes prerequisites. Selection does not authorize
readiness, merging, or recovery. See the
[selection contract](../skills/pr-graph/references/commands.md#graph-relative-node-selection).

The helper command `plan sync --local-only` rebuilds and validates local branches.
It does not push, update PRs, change drafts, refresh hosted footers, or upload
backups. It preserves hosting identities and backup configuration. Publication
remains pending. Approved plans record which nodes to publish and whether sync
is local-only. Continuation uses those settings. Neither option bypasses safety
checks or marks nodes ready.

Use `plan sync --spec <json>` to configure validation for recovered nodes without
a separate graph-reshaping operation. The spec contains only the graph `id` and a
nonempty `validations` map. Each entry names an active, unlanded node and lists
one or more checks. Each check specifies an executable and its argument array.
The helper replaces checks only for the named nodes. When checks change,
it clears those nodes' validation and readiness records. The approved plan
records the exact checks for the helper to run. Combine this option with
`--local-only` to defer publication. The helper rejects empty check lists and
changes to ownership or dependencies.

Preflight checks the journal to distinguish pending publication after approved
local reconstruction from unexplained divergence. It never pushes or repairs
branches to resolve that difference. Both cases still require helper planning
and authorization.

Diagram updates follow the same limits. Local-only sync performs no image
uploads or description edits, and selective publication refreshes only selected
PRs. Refreshes outside that scope wait for separate approval and do not block
completion of local-only sync.

Eligible existing PRs retain their live draft or non-draft state through sync,
retargeting, and graph reshaping, including manual status changes. Blocked or
superseded PRs must be drafts. Non-draft status does not waive validation,
freshness, or merge checks. Status changes after planning require a new approval.

## Auto mode and progress

Use `--auto` to authorize routine plans within the current task without repeated
prompts. It also covers safe freshness fetches and fast-forwards, sync and
revalidation after the grace period expires, and diagram updates.

The skill may reuse an approved conflict resolution without another prompt,
even on its first reuse. It must verify that the current inputs and context
match, then review a fresh, exact recovery plan. New or unverifiable conflicts
and other safety blockers require human approval before auto mode resumes.
Merges, removal, deletion, cleanup, backup transfers, and restore still require
approval. Helper plan digests and safety checks remain mandatory.

An unambiguous instruction such as "Split this branch using auto mode" enables
the same behavior for the current task, even when the agent selects `pr-graph`
automatically. Mentioning or asking about auto mode does not enable it.

The helper reports progress to stderr by default. It shows each node's
phases, branch, PR identity, validation commands and results, and elapsed time.
Results on stdout remain unchanged. Interactive terminals use colors and
spinners. Redirected output uses plain lines. Quiet steps emit a heartbeat every
two minutes. The helper shows validation output only on failure. The agent reports
work outside the helper, including freshness preflight and PR diagrams, without
repeating every helper line. The helper's `--quiet` flag suppresses progress,
not errors or results.

## Freshness

Per-node reports separate integration freshness, branch identity, and
validation status. Integration branches named `main` or `master` allow a
90-minute freshness grace for verified forward movement. Merging is excluded.
This avoids repeated source rewrites during review. The clock uses the recorded
start time of the latest successful fetch of the current tip. It does not start
at fetch completion or plan application. Merge always requires the current
integration tip. Other integration branch names have no grace.

For GitHub, GitHub Enterprise Server, and Azure DevOps, exact server-side
ancestry checks can verify remote-only integration and PR-target commits
without refetching `main` or `master` during that grace window.
The helper still checks live refs and preserves the original expiry. It also
supports legacy `visualstudio.com/DefaultCollection` repository URLs.

Before a long reconstruction or continuation, compare the remaining grace with
measured durations of similar operations. Allow extra time for hooks and
validation. If the remaining grace is too short, refresh and replan safely.
Do not extend the validity of old evidence. Establish recovery constraints for
pending operations before moving refs.

## Reconstruction and recovery

If a commit hook creates a commit whose tree differs from the approved tree,
use a separately approved `resolve` plan to record that commit. Recovery requires
a clean worktree owned by the operation. The commit must have the exact pending
parent and full message. The plan pins HEAD, the tree, and the complete patch
from the parent to the resulting commit. The `apply` command rechecks those
inputs without rewriting the commit or bypassing hooks.
Continuation never accepts the change implicitly. Recovery does not establish
validation or readiness. Historical inspection retains the recovery evidence.

Reconstruction plans accept `--commit-trailers-file <json>`. The helper records
the required trailers in the approved payload and adds them to generated commit
messages, including during conflict recovery. It does not change PR titles. The
option applies to one operation and changes neither Git configuration nor
graph-wide policy.

For `add`, `fold`, `sync`, `publish`, and `retarget`, helper plans accept
`--reuse-worktree <operation-digest>`. This option reuses a clean detached
worktree. Its previous operation must be completed or aborted and belong to the
same graph and repository.
The plan records the worktree's identity and HEAD. The helper rechecks both
before applying the plan. It records the ownership transfer in both journals.
It preserves the worktree's path and installed tools that Git ignores. Earlier
owners cannot recover or clean the transferred worktree.

The helper can also transfer verified reconstruction receipts pinned in
compatible journals. It reuses committed results only when the parent, patch,
full message, and execution fingerprint match exactly. Reuse avoids repeated
patch applications and commit hooks. Changed or unknown inputs require
reconstruction. The helper still checks validation, full-tree composition, and
freshness. Legacy journals export no unverified cache entries. Inspection reports
how many patches the helper applied and how many cached results it reused from
another journal. Reuse does not renew the fetch clock.

Whole-graph retargeting rebuilds unlanded work on another integration branch.
It preserves change ownership and existing PR identities.
Batch description updates leave source branches and draft states unchanged.
Custom helper-branch prefixes support namespace restrictions. If the first
publication fails after some pushes succeed, an approved recovery can retain
the verified pushes.
Description-only actions do not create or claim a worktree. They leave partial
checkouts from interrupted older operations untouched.

The `adopt` recovery requires separate approval. It imports verified PR rewrites
and landings made outside the helper into local graph state. It does not publish
or claim validation. An adoption spec with `"selective": true` can name only the
externally updated nodes. It retains the integration snapshot, helper namespace,
and unselected unpublished work. Unselected hosted heads and targets must still
match recorded identities. The helper clears validation and readiness for selected
nodes and active descendants. Adoption does not reconstruct or publish them.

`checkpoint` preserves already-staged work on a new local branch to release an
occupied graph node. It uses normal hooks and signing. Both `adopt` and
`checkpoint` require human approval even in auto mode.

The `import-graph --source-repo <path>` recovery requires separate human approval,
even in auto mode. It imports changed node ownership or dependencies from another
verified local clone when `adopt` cannot represent the new graph.
The plan records both manifests and live hosted identities.

The helper preserves prior snapshots and the destination's remote and backup
settings. It atomically updates only approved, unoccupied local branches. It
never pushes, edits PRs, changes integration branches or worktrees, uploads
backups, or executes imported commands. It clears imported validation commands
and results, readiness, freshness timestamps, and composition evidence. Configure
validation before subsequent source-changing operations. Resume interrupted
imports with `continue` and the original operation ID and approval digest.

`remove-retired --node <id>` removes only a retired unpublished node's metadata and
historical `supersedes` and `replacedBy` references to it. It refuses nodes with a
PR, landing, remote product branch, or dependents. The previous manifest stays
in the operation journal. The helper preserves Git refs, commits, files, indexes,
worktrees, and existing validation and readiness evidence. It does not reconstruct
source, publish, or upload a backup. It requires separate human approval even in
auto mode. Use `continue` with the original digest after an interrupted metadata
write.

## PR diagrams

Each PR description ends with a rendered Mermaid DAG image that highlights that
PR's node. Diagrams use compact node cards, a small visual key, and a short
snapshot summary. Put freshness information in the summary, not in node cards or
their styling.

Every arrow must stay clear of unrelated nodes and labels. The agent inspects
each edge in each highlighted image before upload. Rerouting and extra spacing
take priority over compactness. Obscured or ambiguous edges block upload or image
reuse. The workflow refreshes diagrams as graph state changes. It requires an
approved local renderer and a supported provider attachment mechanism.

## Requirements and validation

The helper requires Node.js 22+ and Git 2.31+. Hosted operations also require
authenticated `gh` or `az` for the selected provider. It needs no dependency
installation or build step. Install the complete `skills/pr-graph/` directory
globally using the [README installation instructions](../README.md#installation).
Its scripts resolve independently of the repository being managed. See its
references for
[operation plans](../skills/pr-graph/references/commands.md),
[provider constraints](../skills/pr-graph/references/providers.md), and
[recovery](../skills/pr-graph/references/safety-and-recovery.md).

From the repository root, run the helper's local Git and provider-fixture tests:

```text
node skills/pr-graph/scripts/test.mjs
```

The `pr-graph` workflow runs this suite on Linux, macOS, and Windows with Node.js
22 and 24. These tests use provider fixtures, not live hosting services.
