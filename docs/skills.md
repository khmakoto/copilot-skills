# Skill guide

This guide covers how each skill works and how to invoke it. The instructions
and references under [`skills/`](../skills/) define each workflow. For an
overview, see the [README](../README.md). Install complete skill directories
as described in the [installation instructions](../README.md#installation).

Invoke any skill with the commands below. Agents can also select `brainstorm`,
`pr-walkthrough`, or `pr-graph` when a request matches their description. The other
skills require explicit invocation.

## `brainstorm`

The skill analyzes a local or remote repository. It ranks possible improvements
to the product, engineering practices, reliability, security, accessibility,
delivery, and design.

The skill presents one suggestion at a time for refinement or triage. It can
prepare a GitHub issue or Azure DevOps work item after the user confirms the
exact payload.

```text
/brainstorm [repository or path] [suggest-only] [count, focus areas, exclusions, or other constraints]
```

## `ci-triage`

The skill investigates failing GitHub or Azure DevOps PR checks, workflow or
build runs, and local build or test commands. Before tracing the failure, it
records the tested revision, run attempt, job or matrix entry, and relevant
configuration.

The skill classifies causes as change-related, pre-existing, test-fixture,
infrastructure or environment, flaky, or undetermined. It gives evidence and a
confidence level for each cause. An unchanged failing file or a successful
retry alone does not prove that a failure is unrelated or flaky.

The skill presents one root cause at a time for triage. Discovery is read-only.
Local reproduction, fixes, and remote reruns each require separate approval.
Diagnose-only mode makes no changes and runs no retries. Reports separate local
validation from hosted results. They also distinguish queued reruns from
completed checks.

```text
/ci-triage <pull-request-url | run-url | failing-command> [diagnose-only] [scope or constraints]
```

## `design-interview`

The skill clarifies a selected feature or improvement. It inspects the relevant
implementation and supplied materials, then asks one structured question at a
time about goals, tradeoffs, and constraints. It supports visual interfaces,
terminal output, APIs, and agent workflows.

The design distinguishes decisions, proposed defaults, and assumptions. It
defines scope, non-goals, observable acceptance criteria, and proposed validation.
The user must resolve choices that affect the design before approving it.

The workflow is read-only. The user must approve the final design. That approval
does not authorize implementation, saving a document, running validation, or
publishing anything. Implementation requires a separate instruction.

```text
/design-interview [feature or improvement] [paths, screenshots, or constraints]
```

## `pr-description`

The skill drafts or refreshes a GitHub or Azure DevOps pull request description
using its current published diff, applicable repository template, and verified
validation evidence. It supports GitHub Enterprise Server and legacy Azure DevOps
URLs through each provider's tools.

The skill preserves references, attachments, managed graph footers and diagram
blocks, and human-maintained content outside the requested scope. It separates
validation evidence for the current PR head from historical results. It also
reports pending, failed, or unavailable checks.

The user can edit the complete body and must approve its exact content before
publication. The skill checks for intervening changes and reads back the saved
description to verify it. Draft-only mode makes no remote changes. Neither mode
changes code, review threads, graph state, or other PR metadata.

```text
/pr-description <pull-request-url> [draft-only] [scope or constraints]
```

## `pr-feedback`

The skill checks GitHub or Azure DevOps pull request feedback against the current
code. It classifies each concern and presents one review thread at a time for
triage.

The skill can implement each approved fix and run focused validation. Replies,
thread resolution, commits, pushes, and other remote changes require separate
explicit approval.

```text
/pr-feedback <pull-request-url> [scope or constraints]
```

## `pr-reviewer`

The skill reviews a GitHub or Azure DevOps pull request or a local Git branch with a
specialist code-review agent. It reports defects, regressions, vulnerabilities,
compatibility problems, and gaps in test coverage.

The review covers every changed hunk. It checks state and lifecycle behavior,
test validity, and behavioral branch coverage. Where relevant, it runs focused
checks for UI interactions, wrappers and adapters, design systems, reactive state,
service contracts, and package boundaries.

The skill presents one finding at a time. Keeping a local finding does not change
the worktree. Remote review comments can include suggestion blocks that the
reviewer can apply. The user can edit each comment and must confirm its exact
text before the skill posts it.

```text
/pr-reviewer <pull-request-url | local-branch-name> [base branch or constraints]
```

## `pr-walkthrough`

The skill builds a read-only, dependency-ordered walkthrough for manually
reviewing a GitHub or Azure DevOps pull request or a branch in the current local
repository.

The walkthrough explains what to review, in what order, and how the changes
depend on each other. It splits files with substantial behavior into focused
review stops rather than treating each file as one review unit.

```text
/pr-walkthrough <GitHub-or-Azure-DevOps-PR-URL | local-branch-name>
```

## `pr-graph`

The skill splits existing branches and manages changes as a multi-parent
dependency graph in local Git, GitHub, GitHub Enterprise Server, or Azure DevOps.

All published nodes start as drafts. Blocked drafts use helper integration
bases to show only their own changes. A node becomes eligible for review after
every prerequisite lands. Sync, readiness, merges, and deletion require explicit
approval.

The skill can split changes within a file and reshape the graph. It supports
merge, squash, and rebase strategies, with opt-in recovery of committed snapshots
across machines. Footer refreshes leave completed Azure DevOps PR descriptions
unchanged. The skill reports their diagrams as historical snapshots.

### Node history and interdiff

The read-only helper command `history --graph <id> --node <id>` shows retained
versions, operation status, recovery receipts, and what changed. It also shows
how nodes were split or folded. Node identity stays the same when Git commit IDs
change.

Receipts record the before and after snapshots. The local clone retains these
receipts and pins available commits. The command reports missing evidence,
including gaps in legacy records. It also marks where history stops at an import
or restore. It does not repair these gaps.

The helper command `interdiff --graph <id> --node <id> --from <version|last-published|last-validated>`
compares against `current` by default. Use `--to` to select another version.
It separates authored-patch changes from changes to the base or prerequisites.
It compares each version's realized base-to-head diff on a common base. This
includes conflict-resolution changes. The `last-published` baseline requires
verified readback, not an attempted write. The `last-validated` baseline can
include a recorded reason for running no automated checks. The output labels
that reason rather than reporting passing tests. Missing baselines produce
errors. The helper does not infer them.

Both commands default to JSON and accept `--format text`. They preserve user
worktrees, refs, and indexes. Neither command fetches objects, writes to the
hosting service, or renews validation, readiness, or freshness evidence.
The normal skill preflight still applies. Conflicting comparisons are
inconclusive. Equal transported trees do not prove semantic equivalence or
merge safety. See the
[historical inspection contract](../skills/pr-graph/references/commands.md#node-history-and-interdiff).

### Portable historical evidence

Use `plan export-history --graph <id> --archive <file>` to export historical
snapshots and a self-contained Git pack. Use `plan import-history` with the same
flags to import them. Each plan requires separate approval.

The archive preserves version IDs, interrupted candidate versions, split and fold
lineage, and historical publication and validation baselines. You can inspect
them offline without the source checkout. Missing objects block export. The
archive reports gaps in incomplete legacy evidence.

Review the full payload before approving export. Discarded code, commit ancestry
and old descriptions can contain sensitive material. Keeping full history
increases storage and retention costs.

`history-archives --graph <id>` lists imports. Select one exact
`--archive <digest>` with `history` or `interdiff`. The output identifies the
archive's origin and the source of each baseline. Imported baselines never
replace local selectors. Imported `current` is unavailable. Choose an exact
`--to` version instead.

Digests detect changes to the payload. They do not authenticate its author or
prove that its results are trustworthy. Import does not restore current
validation, readiness or freshness. It never executes imported commands, resumes
recovery, moves product refs, or changes user worktrees, indexes or existing
approvals. The helper stores evidence and object-retention refs in separate
archive namespaces.

Transfers require human approval even in auto mode and work offline, without
the skill's normal live freshness preflight. Backup, restore and `import-graph`
still require separate approval and do not include the source clone's history
automatically. There is no automatic remote transfer or archive deletion.
Evidence and private refs remain until the user approves their removal. See the
[archive format, trust and retention contract](../skills/pr-graph/references/history-archives.md).

### Publication and local sync

The helper command `plan publish --nodes <id,id>` publishes only selected nodes
and their required helper bases. It leaves unselected and landed PRs unchanged.
The selection must include unpublished or out-of-date prerequisites. Selective
publication retains the existing integration snapshot and refuses reconstruction
that would change unselected nodes. Sync separately when needed.

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
Dependency eligibility does not mean validation or provider policies have
passed, or that a node is ready.

Only `plan publish --select` accepts selectors for mutations. The helper rejects
them for other actions and rejects combinations with `--nodes`, `--node`, or
`--spec`. Plans list the requested IDs separately from required prerequisites
and helper bases. They disclose all effects, including whole-graph validation
and enabled backups.

The approval digest covers the selector, resolved IDs, graph state, and provider
observations. Apply and continue use that exact selection without reevaluating
or expanding it. External changes to the graph, refs, or PRs require a new plan.
The helper never silently publishes prerequisites. Selection does not authorize
readiness, merging, or recovery. See the
[selection contract](../skills/pr-graph/references/commands.md#graph-relative-node-selection).

The helper command `plan sync --local-only` reconstructs and validates local
branches without pushes, PR updates, draft changes, hosted footer refreshes, or
backup uploads. The helper preserves hosting identities and backup configuration.
Publication remains pending. Approved plans record the publication selection and
local-only mode, and continuation uses those settings. Neither option bypasses
safety checks or marks nodes ready.

Use `plan sync --spec <json>` to configure validation for recovered nodes without
a separate graph-reshaping operation. The spec contains only the graph `id` and a
nonempty `validations` map. Each entry names an active, unlanded node and supplies a
nonempty list of checks. Each check specifies an executable and its argument
array. The helper replaces checks only for the named nodes and clears their
validation and readiness records when their checks change. The approved plan
pins the checks, and the helper runs them. Combine this option with `--local-only`
to defer publication. The helper rejects empty check lists and changes to
ownership or dependencies.

Preflight checks the journal to distinguish pending publication after approved
local reconstruction from unexplained divergence. It never pushes or repairs
branches to resolve that difference. Normal helper planning and authorization
still apply.

Diagram updates respect the same scope. Local-only sync performs no image
uploads or description edits, and selective publication refreshes only selected
PRs. Refreshes outside that scope wait for separate approval and do not block
completion of local-only sync.

Eligible existing PRs retain their live draft or non-draft state through sync,
retargeting, and graph reshaping, including manual status changes. Blocked or
superseded PRs must be drafts. Non-draft status does not waive validation,
freshness, or merge checks. Status changes after planning require a new approval.

### Auto mode and progress

Use `--auto` to authorize routine plans within the current task without repeated
prompts. It also covers safe freshness fetches and fast-forwards, sync and
revalidation after the grace period expires, and diagram updates.

The skill may reuse an approved conflict resolution without another prompt,
even on its first reuse. It must verify that the current inputs and context
match, then review a fresh, exact recovery plan. New or unverifiable conflicts
and other safety blockers require human approval before auto mode resumes.
Merges, removal, deletion, cleanup, backup transfers, and restore still require
confirmation. Helper plan digests and safety checks remain mandatory.

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

### Freshness

Per-node reports distinguish integration freshness, branch identity, and
validation status. Integration branches named `main` or `master` allow a
90-minute freshness grace for verified forward movement outside merging. This
avoids repeated source rewrites during review. The clock uses the recorded start
time of the latest successful fetch of the current tip. It does not start at
fetch completion or plan application. Merge always requires the current
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

### Reconstruction and recovery

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
worktree from a completed or aborted operation for the same graph and repository.
The plan records the worktree's identity and HEAD. The helper rechecks both before
applying the plan. It records the ownership transfer in both journals and
preserves the path and installed tools that Git ignores. Earlier owners cannot
recover or clean the transferred worktree.

The helper can also transfer verified reconstruction receipts pinned in
compatible journals. It reuses committed results only when the parent, patch,
full message, and execution fingerprint match exactly. Reuse avoids repeated
patch applications and commit hooks. Changed or unknown inputs require
reconstruction. The helper still checks validation, full-tree composition, and
freshness. Legacy journals export no unverified cache entries. Inspection reports
how many patches the helper applied and how many cached results it reused from
another journal. Reuse does not renew the fetch clock.

Whole-graph retargeting reconstructs unlanded work on another integration branch
without changing which node owns each change or replacing existing PRs.
Batch description updates leave source branches and draft states unchanged.
Custom helper-branch prefixes support namespace restrictions. If the first
publication fails after some pushes succeed, an approved recovery can retain
the verified pushes.
Description-only actions do not create or claim a worktree. They leave partial
checkouts from interrupted older operations untouched.

The `adopt` recovery requires separate approval. It imports verified externally
rewritten PRs and landings into local graph state without publishing or claiming
validation. An adoption spec with `"selective": true` can name only the externally
updated nodes. It retains the integration snapshot, helper namespace, and
unselected unpublished work. Unselected hosted heads and targets must still match
recorded identities. The helper clears validation and readiness for selected
nodes and active descendants. Adoption does not reconstruct or publish them.

`checkpoint` preserves already-staged work on a new local branch to release an
occupied graph node. It uses normal hooks and signing. Both `adopt` and
`checkpoint` require human approval even in auto mode.

The `import-graph --source-repo <path>` recovery requires separate human approval,
even in auto mode. It imports changed node ownership or dependencies from another
verified local clone when `adopt` cannot represent the new graph.
The plan records both manifests and live hosted identities. The helper preserves
prior snapshots and the destination's remote and backup settings. It atomically
updates only approved, unoccupied local branches. It never pushes, edits PRs,
changes integration branches or worktrees, uploads backups, or executes imported
commands. It clears imported validation commands and results, readiness, freshness
timestamps, and composition evidence. Configure validation before subsequent
source-changing operations. Resume interrupted imports with `continue` and the
original operation ID and approval digest.

`remove-retired --node <id>` removes only retired unpublished node metadata and
historical `supersedes`/`replacedBy` references to it. It refuses nodes with a PR,
landing, remote product branch, or dependents. The previous manifest stays in
the operation journal. The helper preserves Git refs, commits, files, indexes,
worktrees, and existing validation and readiness evidence. It does not reconstruct
source, publish, or upload a backup. It requires separate human approval even in
auto mode. Use `continue` with the original digest after an interrupted metadata
write.

### PR diagrams and requirements

Each PR description ends with a rendered Mermaid DAG image that highlights that
PR's node. Diagrams use compact node cards, a small visual key, and a short
snapshot summary. Put freshness information in the summary, not in node cards or
their styling.

Every arrow must stay clear of unrelated nodes and labels. The agent inspects
each edge in each highlighted image before upload. Rerouting and extra spacing
take priority over compactness. Obscured or ambiguous edges block upload or image
reuse. The workflow refreshes diagrams as graph state changes. It requires an
approved local renderer and a supported provider attachment mechanism.

```text
/pr-graph [--auto] [split | view | select | history | interdiff | export-history | import-history | add | sync | retarget | ready | merge | describe | reshape | adopt | import-graph | checkpoint | remove-retired | backup | restore]
```

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

## `session-distill`

The skill uses evidence from the current session or selected past sessions to
propose changes to a skill, repository instructions, or an explicitly stated user
preference.

The skill presents one proposal at a time and does not save changes automatically.

```text
/session-distill [selected session IDs] [focus] [proposals-only]
```

## `skill-doctor`

The skill audits personal skill definitions and supporting resources for concrete
workflow defects involving triggers, inputs, tools, authorization, evidence,
failure handling, interaction, and completion criteria.

The skill presents one finding at a time and applies a repair only after the user
approves that change.

After reviewing the other findings, the skill returns to deferred findings.
If the user defers the only remaining finding again, triage ends. That finding
stays deferred.

```text
/skill-doctor [skill names or paths] [audit-only] [focus or constraints]
```

## `unslop`

The skill edits selected writing using Cursor's upstream `unslop` rules. The
installed skill is a local wrapper that fetches the complete instructions from
`https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md`
on every explicit invocation, not during installation.

The skill requires network access and follows changing upstream writing guidance
rather than a pinned local copy. If the fetch fails or returns incomplete or
unexpected content, the skill stops. It does not invent rules, silently use cached
rules, or send the user's text or repository content upstream.

Upstream rules remain subject to higher-priority instructions and the user's
scope and tone constraints. Fetching does not authorize running upstream scripts,
unrelated edits, commits, or publication.

```text
/unslop [text or paths] [tone or scope constraints]
```
