# `pr-graph` guide

Use `pr-graph` to split existing branches and manage changes as a multi-parent
dependency graph in local Git, GitHub, GitHub Enterprise Server, or Azure DevOps.
The [skill instructions](../skills/pr-graph/SKILL.md) and their references define
the workflow. See the [skill guide](skills.md) for the full catalog.

All published nodes start as drafts. Blocked drafts use helper integration
bases to show only their own changes. A node becomes eligible for review after
every prerequisite lands. Mutations require approval of the exact plan. Auto
mode lets the agent approve routine plans within the task and plans that meet
specific safety conditions. Merging and deleting source, refs, or worktrees
still require human approval in ordinary auto mode. Explicit YOLO mode lets the
agent approve all actions needed for the current task and invocation. Safety
checks still apply.

The skill can split changes within a file and reshape the graph. It supports
merge, squash, and rebase strategies. Users can authorize recovery of committed
snapshots on another machine. Footer refreshes leave completed Azure DevOps PR
descriptions unchanged. The skill labels their diagrams as historical snapshots.

```text
/pr-graph [--auto | --yolo] [split | view | select | history | interdiff | operation-diff | export-history | import-history | publication-policy | add | absorb | sync | retarget | ready | merge | describe | reshape | adopt | import-graph | checkpoint | remove-retired | backup | restore]
```

The human approval requirements below apply to interactive mode and ordinary
auto mode. [YOLO mode](#yolo-mode) lets the agent approve those actions for the
requested task only.
The agent must still check correctness, preserve user work, and pause when
outcomes are uncertain.

## Example requests

Write requests in plain language after `/pr-graph`. Replace `feature`, node names,
branches and paths below with those from your repository. The agent asks when
the graph, ownership or destination is ambiguous.

These examples do not bypass approval requirements. Inspection still follows
the skill's freshness preflight, which may require approved fetches or
fast-forwards. A request to inspect does not authorize repair or publication.
Without `--auto` or `--yolo`, the agent presents exact mutation plans for human
approval. See [auto mode](#auto-mode-and-progress) and [YOLO mode](#yolo-mode)
before letting the agent approve actions.

### Inspect a graph and explain changes

```text
/pr-graph Show graph feature. Which nodes are blocked, and which prerequisites must land first?
/pr-graph List model and all its transitive dependents in graph feature, including reasons for exclusions.
/pr-graph Compare node api in graph feature with its last verified publication. Separate authored edits from reconstruction changes.
/pr-graph Explain operation <operation-digest> in graph feature. What changed across the whole sync, and what publication effects are verified?
```

The agent can show branches, dependencies, draft state and freshness. Selecting
a node and its dependents includes the root node but excludes inactive nodes.
Node history and interdiff explain individual versions. Operation-wide diffs
explain changes across nodes, including lineage, validation and readiness.
The agent reports missing baselines or receipts rather than inferring results.
Equal comparisons do not establish merge safety.

### Split, reshape and allocate work

```text
/pr-graph Split my source branch into independently reviewable changes targeting trunk. Keep the result local and do not publish.
/pr-graph Split node api in graph feature into request parsing and response formatting. Preserve the combined changes.
/pr-graph Fold nodes parser and formatter in graph feature into one node. Show the resulting dependencies before applying.
/pr-graph Allocate the committed follow-up changes between <base-ref> and <head-ref> to their owners in graph feature. Ask about ambiguous hunks and leave dirty work untouched.
```

The agent chooses semantic boundaries and proposes dependencies. The helper
checks that approved splits and folds preserve the complete combined tree.
For absorb, select and pin the committed changes to allocate. Every change
needs an active, unlanded owner. Absorb preserves node identities and
dependencies. It does not stage dirty work, create new nodes or publish the
result.

### Sync, publish and prepare for review

```text
/pr-graph Sync graph feature locally after model lands. Rebuild dependent nodes and run their required checks, but do not push or update PRs.
/pr-graph Prepare a publication plan for api and ui in graph feature. Show any prerequisites and helper bases the selection needs before applying.
/pr-graph Prepare node model in graph feature for review. Explain any missing validation, freshness or prerequisite evidence before marking it ready.
/pr-graph Merge node model in graph feature into trunk using squash. Do not delete source branches or worktrees.
/pr-graph Prepare updated PR descriptions and diagrams for graph feature after this sync. Preserve human text and keep landed PRs in the diagrams.
```

Local-only sync leaves publication pending. Publication creates draft PRs or
updates existing PRs. Review diffs contain only each node's own changes.
Before marking a node ready or merging it, the helper requires landed
prerequisites, current validation and the relevant freshness and provider
checks. Sync and publication do not mark nodes ready or merge them. Diagram
uploads and description changes also require approval of their exact contents
and destinations.

### Keep work local, inspect recovery and transfer evidence

```text
/pr-graph Keep node experiment and its retained lineage in graph feature local. Prepare a publication-exclusion plan and show what uploads it would block.
/pr-graph Inspect interrupted operation <operation-digest> in graph feature. Separate verified effects from unknown outcomes and propose recovery without retrying writes.
/pr-graph Prepare a landing-only adoption plan for graph feature after model was merged outside the helper. Do not rewrite source branches.
/pr-graph Prepare an offline history export for graph feature to /path/to/review-history.json. Show discarded source, ancestry, metadata and retention costs before exporting.
/pr-graph Prepare a restore plan for graph feature in this clone from its verified remote backup. Show the refs and graph state it would restore.
```

Publication exclusions block the helper from uploading excluded content,
including retained history. They do not retract content already published.
Recovery requires evidence and a separate exact plan. Do not retry a remote
write while its outcome is unknown. Landing-only adoption records verified
landings without rewriting owned changes. History export transfers evidence
for inspection. It does not transfer executable recovery state. Restore is a
separate operation and does not establish current validation or readiness.

## Allocate follow-up edits

Use `/pr-graph absorb` to propose which existing nodes should own follow-up edits.
The read-only helper `absorb --graph <id> --base <ref> --head <ref>` lists
the committed changes between the selected base and head. The base tree must
equal the graph's old combined tree. The inventory lists hunks and file changes
that cannot be split. It also shows retained node patches, their origins, and
dependencies. Matching paths suggest possible owners. They do not determine
ownership or authorize changes. The helper never stages or commits dirty work.
Staging and checkpoint preservation each require separate approval.

The agent proposes an owner for each change and explains the evidence. It leaves
ambiguous edits unassigned until the user decides. Inspect shared or new files,
changes that span nodes, binary files, and the origins of landed or retired work
before assigning an owner. Do not assign by path alone. In auto mode, the agent
may select an active, unlanded owner when the evidence identifies which
node owns the behavior. Otherwise, it asks.

`plan absorb` requires an active, unlanded owner for every change. It also needs
a complete updated node spec and an expected source that includes the follow-up
edits. Supply validation commands or reasons for running no automated checks.
Absorb preserves node identities and dependency edges. New nodes or dependencies
need separate approved graph changes.

The user must approve the exact plan digest. Auto mode may approve a requested
allocation when ownership is unambiguous and the plan meets the
[conditional policy](../skills/pr-graph/references/auto-mode.md#conditional-auto-approvals).
The helper checks each owner's changes against its assigned edits. It compares
the complete combined tree with the approved source. It rebuilds dependent nodes
and reruns required checks. Changed inputs, occupied branches, conflicts and
failed validation stop the operation under the existing recovery rules. The
helper does not discard user work.

Absorb updates only local graph branches and state. Publication, hosted PR
updates, draft changes, backup uploads and readiness each need separate
authorization. See the
[full contract](../skills/pr-graph/references/change-specs.md#allocate-follow-up-edits-with-absorb).

## Node history and interdiff

The read-only helper command `history --graph <id> --node <id>` lists retained
versions, operation status, recovery receipts and changes. It includes earlier
operations that split or folded nodes. A node keeps its identity when its Git
commit IDs change.

Receipts record the before and after snapshots. The local clone retains these
receipts and pins available commits. The command reports missing evidence,
including gaps in legacy records. It also marks where history stops at an import
or restore. It does not repair these gaps.

Use `interdiff --graph <id> --node <id> --from <version|last-published|last-validated>`
to compare a retained version against `current`. Use `--to` to select another
comparison version. The command reports changes to the node's authored patch
separately from changes to its base or prerequisites.

It compares each version's realized base-to-head diff on a common base, including
conflict-resolution changes. The `last-published` baseline requires
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

## Operation-wide diffs

Use `operation-diff --graph <id> --operation <operation-digest>` to inspect what
a sync, reshape or other retained operation changed. Get the exact operation
digest from status, history or an apply result. The command defaults to JSON.
Use `--format text` to group graph changes and node comparisons with patches.

The report separates authored patch changes from changes to realized bases and
heads. It shows which nodes the operation added, removed or retired. It also
reports split and fold lineage, dependencies, metadata, validation invalidation,
readiness and landing changes. It compares retained before and after snapshots
rather than substituting today's graph. It reports the planned graph and
intended effects separately from execution records.

Matching publication receipts for individual nodes can prove partial publication
even after an interruption. Remote attempts, ref records and PR responses alone
do not verify publication. The helper may write a receipt before saving the
resulting graph. The receipt alone does not prove that it saved the graph.
The report lists gaps for missing or legacy snapshots, unavailable objects and
unmatched receipts. It does not infer success from incomplete evidence.

Inspection preserves worktrees, indexes, refs and operation state. It does not
fetch, repair, run checks, publish or renew freshness. It is not undo or remote
compensation. The normal skill preflight still applies. Equal comparisons do
not establish semantic equivalence, current validation or merge safety.
See the [operation report contract](../skills/pr-graph/references/commands.md#operation-wide-diffs).

## Portable historical evidence

Use `plan export-history --graph <id> --archive <file>` to export historical
snapshots and a self-contained Git pack. Use `plan import-history` with the same
flags to import them. Each plan requires approval of its exact contents. The user
may approve it directly. The agent may approve it under the separate transfer
opt-in described below, or under YOLO authorization that covers the task and
disclosure.

The archive preserves version IDs, interrupted candidate versions and records
of splits and folds. It also retains historical publication and validation
baselines. You can inspect them offline without the source checkout. Missing
objects block export. The archive reports gaps in legacy records when evidence
is incomplete.

Review the full export contents before approval. Discarded code, commit ancestry
and old descriptions can contain sensitive material. Keeping full history
increases storage and retention costs.

`history-archives --graph <id>` lists imports. Select one exact
`--archive <digest>` with `history` or `interdiff`. The output identifies the
archive's origin and the source of each baseline. Imported baselines never
replace local selectors. Imported `current` is unavailable. Choose an exact
`--to` version instead.

Digests detect changes to the archive. They do not authenticate its author or
verify its reported results. Import does not restore current validation,
readiness, or freshness. It never executes imported commands, resumes recovery,
moves product refs, or changes user worktrees, indexes, or existing approvals.
The helper stores evidence and object-retention refs in separate archive
namespaces.

Transfers work offline without the skill's normal live freshness preflight.
`--auto` alone does not authorize them. The user may separately authorize
transfers for the current invocation. That permission must cover the exact
source, destination, and retained data, including discarded source, ancestry,
metadata, and retention costs. The agent may approve reviewed plans only within
those limits. If the limits change or are unclear, it must ask again.
Backup, restore, and `import-graph` require their own approval. They do not include
the source clone's history unless separately authorized. The helper does not
transfer archives remotely or delete them without approval. It retains evidence
and private refs until the user approves their removal. See the
[archive format, trust and retention contract](../skills/pr-graph/references/history-archives.md).

## Publication and local sync

The helper command `plan publish --nodes <id,id>` publishes only selected nodes
and their required helper bases. It leaves unselected and landed PRs unchanged.
The selection must include unpublished or out-of-date prerequisites. Selective
publication keeps the existing integration snapshot. The helper refuses to
reconstruct branches if that would change unselected nodes. Sync separately when
needed.

The read-only command `select --graph <id> --select <selector>` previews exact
node IDs in stable dependency order. It reports why it excluded each node.

| Selector          | What it selects                                                               |
| ----------------- | ----------------------------------------------------------------------------- |
| `node:<id>`       | The named node.                                                               |
| `dependents:<id>` | The named node and all transitive dependents. Shared descendants appear once. |
| `eligible`        | Nodes whose prerequisites have landed.                                        |
| `unpublished`     | Nodes without a hosted PR, or without a remote product branch in local Git.   |

The helper excludes retired and landed nodes. Missing IDs produce an error.
A preview can return no nodes, but a mutation plan needs at least one.
Eligibility means only that prerequisites have landed. It does not show whether
validation or provider policies passed, or whether the node is ready.

Only `plan publish --select` accepts selectors for mutations. The helper rejects
them for other actions and rejects combinations with `--nodes`, `--node`, or
`--spec`. Plans separate requested IDs from required prerequisites and helper
bases. They list all effects, including whole-graph validation and enabled
backups.

The approval digest covers the selector, resolved IDs, graph state, and provider
observations. Apply and continue use that exact selection without reevaluating
or expanding it. External changes to the graph, refs, or PRs require a new plan.
The helper does not add prerequisites to the approved selection. Selection does
not authorize readiness, merging, or recovery. See the
[selection contract](../skills/pr-graph/references/commands.md#graph-relative-node-selection).

### Local-only publication exclusions

Selection is not a persistent "do not upload" policy. Use the helper's
`plan publication-policy --graph <id> --spec <json> --out <new-plan.json>`,
then approve and apply its exact digest. For example:

```json
{ "exclude": ["private-node"], "release": [], "reason": "Keep this work local." }
```

Exclusions follow stable node IDs through absorb, split, and fold. They retain
old objects and metadata after retirement. Before publication, the helper checks
all objects reachable from product and helper refs, along with hosted metadata.
This includes ancestors whose content no longer appears in the tip tree.
The helper also blocks enabled whole-graph backups and history exports that
contain excluded evidence. It does not disable them to permit publication.
It allows unrelated publication only after every outgoing ref and metadata
payload passes these checks. Plans record the exact policy and outgoing payload.
The helper rechecks both when applying or continuing an operation. If either
changes, replan.

To permit disclosure, prepare a separate policy plan with `exclude: []`,
`release: ["private-node"]` and an explicit reason. The user must approve it,
even in auto mode. Importing release receipts does not authorize a release.
Restore and import combine incoming active restrictions with the destination's
restrictions. The exclusions apply only within the graph and check exact objects
and text. They do not detect secrets or retract published content. They cannot
guarantee protection against external tools or transformed copies. Read the
[complete contract](../skills/pr-graph/references/publication-exclusions.md).

### Local-only sync

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

Preflight checks the journal to determine why branches differ. It distinguishes
approved local reconstruction awaiting publication from unexplained changes.
It does not push or repair branches in either case. Both cases still require
helper planning and authorization.

The same limits apply to diagram updates. Local-only sync performs no image
uploads or description edits, and selective publication refreshes only selected
PRs. Refreshes outside that scope need separate approval. They do not block
local-only sync.

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
The [conditional policy](../skills/pr-graph/references/auto-mode.md#conditional-auto-approvals)
also permits removing a lock whose owner is dead on the same host. It allows
reconciliation of verified effects that the user originally approved. The agent
may abort locally to replan when there are no remote effects.
The agent may carry out requested absorb operations when ownership is
unambiguous. It may also remove requested metadata for retired, unpublished nodes.
Routine backup uploads require prior user approval. The destination, access, and
content scope must remain unchanged, including unpublished committed history.
An enabled backup in the manifest is not enough. Requested, verified backup
downloads may write only private local refs. They must not restore branches or
execute commands.

Use verified `abort --retain-published-refs` to stop an interrupted first
publication and replan without removing refs or resources. The graph and local
refs must remain unchanged. There must be no PRs, provider writes, or pending patch.
Remote refs must match their original or exactly approved candidate values.
The helper rechecks readback on apply. New namespaces and publication payloads
require their normal authorization.

Requested landing-only adoption may use `plan adopt --landings-only` when the
helper proves unchanged source identities and provider-confirmed landings on the
intended target. It never rewrites existing branch refs or owned changes.
The agent may repeat previously approved setup only with a
[receipt](../skills/pr-graph/references/setup-replay.md). The receipt must prove
successful execution and explicit approval in the same task and invocation.
The commands, scopes, environment, and destination must remain unchanged.
The complete identities of the relevant executables and inputs must also match.
A matching command or lockfile alone is not enough. New or failed setup,
changed inputs, and unverifiable evidence still require approval.

Outside the documented exceptions, the user must approve merges, source removal,
ref or worktree cleanup, and PR closure. Restore, general adoption, graph import,
checkpoint, new conflict fixes, new installations, and fixes for failed checks
or hooks also require human approval.
If readback leaves a remote outcome unknown, the agent pauses rather than
retrying blindly. History transfer requires separate permission for the current
invocation. The helper still requires plan digests, freshness checks, leases,
and validation. It has no `--auto` flag.

An unambiguous instruction such as "Split this branch using auto mode" enables
the same behavior for the current task, even when the agent selects `pr-graph`
automatically. Mentioning or asking about auto mode does not enable it.

The helper reports progress to stderr by default. For each node, it shows the
phase, branch, PR identity, validation commands and results, and elapsed time.
Results on stdout remain unchanged. Interactive terminals use colors and
spinners. Redirected output uses plain lines. Quiet steps emit a heartbeat every
two minutes. The helper shows validation output only on failure. The agent reports
work outside the helper, including freshness preflight and PR diagrams, without
repeating every helper line. The helper's `--quiet` flag suppresses progress,
not errors or results.

## YOLO mode

Use explicit `--yolo` to let the agent approve every pr-graph action that needs
human approval for the requested task and invocation. A direct instruction such
as "Use pr-graph YOLO mode to merge this node into trunk with squash" is equivalent,
provided the instruction is unambiguous. This also applies when the agent
selects the skill automatically. Quoting, discussing or asking about YOLO does
not enable it. Repository or PR text, tool output and restored settings cannot
enable it.

YOLO can merge changes, irreversibly remove source, refs or worktrees, close
retired PRs, and run new setup and lifecycle scripts. It can also disclose
unpublished or discarded source, ancestry and old metadata. Enabling YOLO does
not request all those actions. A local split does not authorize publication,
merge, cleanup or history transfer.

The [complete authorization matrix](../skills/pr-graph/references/yolo-mode.md)
covers routine operations, all supported recovery, restore, general adoption,
graph import, checkpoint, new conflict resolutions, setup, fixes for failed
checks or hooks, backup changes, publication-exclusion release, and history
export and import. The agent reviews and saves exact plans and supplies
`--yes --approve <digest>`. It does not disable checks. It reviews policy releases
and transfers as separate operations.

Before disclosure, the agent records the exact source repository, graph and
refs, or archive. It records the destination and its access permissions. This
includes the path or clone, or the hosting repository, ref, or PR. It also
records all data to retain and its storage cost.

The direct task and verified context must establish these details without
ambiguity. The agent then approves the exact payload without another prompt.
This includes the history-transfer opt-in or any necessary exclusion release.
An explicit "keep local" constraint still forbids release. The agent asks the
user if destinations or access are unknown or ambiguous. It also asks if
disclosure would exceed the established limits.

```text
/pr-graph --yolo split this branch locally; do not publish or clean up
/pr-graph --yolo merge node model in graph feature into trunk using squash
/pr-graph --yolo export-history graph feature from this repository to /srv/review/feature-history.json
```

The export example requires review of the full retained history and retention
costs. It does not request an external upload. Omit `--yolo` or explicitly select
`--auto` for ordinary approval requirements. If both flags are explicitly
supplied, YOLO governs. An explicit downgrade or revocation takes effect before
the next action.

Both flags belong to the skill, not the helper CLI. The skill never saves YOLO
permission or carries it into another task or invocation. Saved plans and
receipts do not grant future permission. YOLO does not approve actions in other
skills or override tool or environment permissions.

The agent stops if goals are missing, ownership is ambiguous or remote effects
remain unresolved. Unsafe worktrees or locks, stale freshness, and failed
validation or hooks also stop the affected operation. Provider policies block
it when their results are unknown, pending or failed. The agent may diagnose
and approve a supported fix within the task's scope when evidence supports it.
It then reruns checks. It never blindly retries uncertain writes or bypasses
policies. Progress and verified completion reporting remain the same as in
auto mode.

See the [behavioral regression scenarios](../skills/pr-graph/references/approval-scenarios.md)
for expected mode isolation and blocker behavior.

## Freshness

Per-node reports separate integration freshness, branch identity, and
validation status. Integration branches named `main` or `master` allow a
3-hour freshness grace for verified forward movement. This avoids repeated
source rewrites during review. The grace period does not apply to merging.

The clock uses the recorded start time of the latest successful fetch of the
current tip. It does not start at fetch completion or plan application. Merge
always requires the current integration tip. Other integration branch names
have no grace.

For GitHub, GitHub Enterprise Server, and Azure DevOps, the helper can check exact
commit ancestry on the server to verify integration and PR-target commits
available only on the remote. These checks do not require refetching `main` or
`master` during the grace period. The helper still checks live refs and preserves
the original expiry. It also supports legacy
`visualstudio.com/DefaultCollection` repository URLs.

Before a long reconstruction or continuation, compare the remaining grace with
measured durations of similar operations. Allow extra time for hooks and
validation. If the grace period may expire, refresh and replan.
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
worktree from a completed or aborted operation in the same graph and repository.

The plan records the worktree's identity and HEAD. The helper rechecks both
before applying the plan. It records the ownership transfer in both journals.
It preserves the worktree's path and installed tools that Git ignores.
Earlier owners cannot recover or clean the transferred worktree.

The helper can also transfer verified reconstruction receipts from compatible
journals. It reuses committed results only when the parent, patch,
full message, and execution fingerprint match exactly. Reuse avoids repeated
patch applications and commit hooks. Changed or unknown inputs require
reconstruction. The helper still checks validation, full-tree composition, and
freshness. Legacy journals export no unverified cache entries. Inspection reports
how many patches the helper applied and how many cached results it reused from
another journal. Reuse does not renew the fetch clock.

During reconstruction, the helper reuses the longest verified sequence of
previously composed changes, called a composition prefix. It also reuses complete
prerequisite bases when their exact inputs match. A prefix records the pinned
target, the order of owned changes, commit messages and trailers, and the known
execution context. The helper must verify all supporting receipts, pins, and
objects. If the context is unknown, it applies each change separately.

Progress reports when the helper reuses a prefix. Inspection reports the work
counts `visits`, `prefixHits`, `prefixMisses`, and `prefixAvoided`. Reusing a prefix
does not carry over validation, readiness, or freshness evidence. The
[command reference](../skills/pr-graph/references/commands.md#reusing-a-retained-operation-worktree)
describes the evidence and differential measurements. Savings depend on the
graph's structure. Extra prefix metadata can increase journal size.

Whole-graph retargeting rebuilds unlanded work on another integration branch.
It preserves change ownership and existing PR identities. Batch description
updates leave source branches and draft states unchanged. Custom helper-branch
prefixes support namespace restrictions. If some pushes succeed before
publication fails, the user can approve recovery that keeps those verified
pushes.
Description-only actions do not create or claim a worktree. They leave partial
checkouts from interrupted older operations untouched.

General `adopt` recovery requires separate approval. It updates local graph state
with verified PR rewrites and landings made outside the helper. It does not
publish changes or establish validation. An adoption spec with
`"selective": true` can name only the externally updated nodes. It retains the
integration snapshot, helper namespace, and unselected unpublished work.
Unselected hosted heads and targets must still match recorded identities. The
helper clears validation and readiness for selected nodes and active descendants.
Adoption does not reconstruct or publish them.

`checkpoint` preserves already-staged work on a new local branch to release an
occupied graph node. It uses normal hooks and signing. General `adopt` and
`checkpoint` require human approval even in auto mode.

For explicitly requested landings when PR content has not been rewritten, use
`plan adopt --landings-only --spec <json>`. Include the graph ID and pinned
`targetSnapshot`. For each newly merged node, include its unchanged head, base,
base branch, and provider landing SHA. The helper rejects namespace changes,
attempts to repair source refs, unrelated PR identity changes, and target rewinds.
It retains owned changes and historical nodes. It clears validation and readiness
for selected nodes and descendants. It does not claim freshness or publish
anything.
Do not silently fall back to general adoption when these checks fail.

`import-graph --source-repo <path>` requires separate human approval, even in
auto mode. Use it to import changed node ownership or dependencies from another
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
source, publish, or upload a backup. The user must approve removal unless auto
mode covers their explicit request to remove that specific metadata. The agent
does not remove metadata on its own. Use `continue` with the original digest
after an interrupted metadata write.

## PR diagrams

The skill adds a rendered Mermaid DAG image to the end of each PR description
and highlights that PR's node. Diagrams use compact node cards, a small visual
key, and a short snapshot summary. Put freshness information in the summary,
not in node cards or their styling.

Every arrow must stay clear of unrelated nodes and labels. The agent inspects
each edge in each highlighted image before upload. Rerouting and extra spacing
take priority over compactness. Obscured or ambiguous edges block upload or image
reuse. The workflow refreshes diagrams when graph state changes. It requires an
approved local renderer and a supported provider attachment mechanism.

## Requirements and validation

The helper requires Node.js 22+ and Git 2.31+. Hosted operations also require
authenticated `gh` or `az` for the selected provider. It needs no dependency
installation or build step. Install the complete `skills/pr-graph/` directory
globally using the [README installation instructions](../README.md#installation).
Its scripts resolve independently of the repository it manages. See the
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

The helper batches local ref snapshots and metadata reads for immutable objects.
This needs no new flags and leaves result formats unchanged. Caches never
replace live write-boundary checks, validation, provider observations, or
freshness evidence.

To measure read times and Git subprocess counts for chains, diamonds, wide
graphs, and history, run:

```text
node --test skills/pr-graph/scripts/__tests__/read-performance.test.mjs
```

These tests check results and work counts. They report timings but do not require
a speedup.
