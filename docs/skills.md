# Skill guide

This guide covers how each skill works and how to invoke it. The instructions
and references under [`skills/`](../skills/) define each workflow. For an
overview, see the [README](../README.md). Install complete skill directories
as described in the
[installation instructions](../README.md#installation).

Invoke any skill with the commands below. Agents can also select `brainstorm`,
`pr-walkthrough`, or `pr-graph` when a request matches their description. The other
skills require explicit invocation.

## `brainstorm`

The skill analyzes a local or remote repository and ranks possible improvements
to the product, engineering, reliability, security, accessibility, delivery, and
design.

The skill presents one suggestion at a time for refinement or triage. It can
prepare a GitHub issue or Azure DevOps work item after the user confirms the
exact payload.

```text
/brainstorm [repository or path] [suggest-only] [count, focus areas, exclusions, or other constraints]
```

## `ci-triage`

The skill investigates failing GitHub or Azure DevOps PR checks, workflow or
build runs, and local build or test commands. It records the tested revision, run
attempt, job or matrix entry, and relevant configuration before tracing the failure.

The skill classifies causes as change-related, pre-existing, test-fixture,
infrastructure or environment, flaky, or undetermined. It gives evidence and a
confidence level for each cause. An unchanged failing file or a successful
retry alone does not prove that a failure is unrelated or flaky.

The skill presents one root cause at a time for triage. Discovery is read-only.
Local reproduction, fixes, and remote reruns each require separate approval.
Diagnose-only mode makes no changes and runs no retries. Reports distinguish local
validation from hosted results and queued reruns from completed checks.

```text
/ci-triage <pull-request-url | run-url | failing-command> [diagnose-only] [scope or constraints]
```

## `design-interview`

The skill clarifies a selected feature or improvement. It inspects the relevant
implementation and supplied materials, then asks one structured question at a
time about goals, tradeoffs, and constraints. It supports visual interfaces,
terminal output, APIs, and agent workflows.

The design records explicit decisions, proposed defaults, and assumptions
separately. It defines scope, non-goals, observable acceptance criteria, and
proposed validation. The user must resolve choices that affect the design
before it is final.

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
blocks, and human-maintained content outside the requested scope. It distinguishes
validation evidence for the current PR head from historical results and reports
pending, failed, or unavailable checks.

The user can edit the complete body and must approve its exact content before
publication. The skill checks for intervening changes and reads back the saved
description to verify it. Draft-only mode makes no remote changes. Neither mode
changes code, review threads, graph state, or other PR metadata.

```text
/pr-description <pull-request-url> [draft-only] [scope or constraints]
```

## `pr-feedback`

The skill validates incoming GitHub or Azure DevOps pull request feedback against
the current code, classifies each concern, and presents review threads one at a
time for interactive triage.

The skill can implement each approved fix and run focused validation. Replies,
thread resolution, commits, pushes, and other remote changes require separate
explicit approval.

```text
/pr-feedback <pull-request-url> [scope or constraints]
```

## `pr-reviewer`

The skill reviews a GitHub or Azure DevOps pull request or a local Git branch with a
specialist code-review agent. It reports concrete defects, regressions,
vulnerabilities, compatibility problems, and meaningful test gaps.

The review covers every changed hunk and checks state and lifecycle behavior,
test validity, and behavioral branch coverage. It also runs
focused checks when relevant for UI interactions, wrappers and adapters, design
systems, reactive state, service contracts, and package boundaries.

The skill presents one finding at a time. Keeping a local finding does not change
the worktree. Remote review comments can include suggestion blocks that the
reviewer can apply. The skill lets the user edit each comment and requires
confirmation of the exact text before posting.

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
versions, operation status, recovery receipts, what changed, and explicit
split and fold lineage. Node identity stays the same when Git commit IDs change.
Receipts record the before and after snapshots. These receipts and available
commit pins stay in the local clone. The command reports legacy gaps, missing
evidence, and import or restore boundaries without repairing them.

The helper command `interdiff --graph <id> --node <id> --from <version|last-published|last-validated>`
compares against `current` by default, or a version selected with `--to`.
It separates authored-patch changes from changes to the base or prerequisites.
It compares each version's realized base-to-head diff on a common base,
including conflict-resolution changes. The `last-published` baseline requires
verified readback, not an attempted write. The `last-validated` baseline can
include a recorded reason for running no automated checks, which the output
labels as such. Missing baselines produce errors rather than inferred history.

Both commands default to JSON and accept `--format text`. They preserve user
worktrees, refs, and indexes. Neither command fetches objects, writes to the
hosting service, or renews validation, readiness, or freshness evidence.
The normal skill preflight still applies. Conflicting comparisons are
inconclusive. Equal transported trees do not prove semantic equivalence or
merge safety. See the
[historical inspection contract](../skills/pr-graph/references/commands.md#node-history-and-interdiff).

### Publication and local sync

The helper command `plan publish --nodes <id,id>` limits publication to selected
nodes and their required helper bases. It leaves unselected and landed PRs unchanged.
Unpublished or out-of-date prerequisites must also be selected. Selective
publication retains the existing integration snapshot and refuses reconstruction
that would change unselected nodes. Sync separately when needed.

The helper command `plan sync --local-only` reconstructs and validates local
branches without pushes, PR updates, draft changes, hosted footer refreshes, or
backup uploads.
The helper preserves hosting identities and backup configuration. Publication
remains pending. Approved plans record the publication selection and local-only
mode, and continuation uses those settings. Neither option bypasses safety
checks or marks nodes ready.

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
freshness, or merge checks. Status changes after planning require reapproval.

### Auto mode and progress

Use `--auto` to authorize routine plans within the current task without repeated
prompts. It also covers safe freshness fetches and fast-forwards, sync and
revalidation after the grace period expires, and diagram updates.

The skill may reuse an already-approved matching conflict resolution, including
on its first reuse, without another prompt. It must verify the current inputs
and context and review a fresh, exact recovery plan. New or unverifiable conflicts
and other safety blockers require human approval before auto mode resumes.
Merges, removal, deletion, cleanup, backup transfers, and restore still require
confirmation. Helper plan digests and safety checks remain mandatory.

An unambiguous instruction such as "Split this branch using auto mode" enables
the same behavior for the current task, even when the agent selects `pr-graph`
automatically. Mentioning or asking about auto mode does not enable it.

The helper reports live progress to stderr by default. It shows each node's
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
avoids repeated source rewrites during review. The clock starts immediately before
the last successful fetch for the latest tip begins, not at fetch completion or
plan application. Merge always requires the current integration tip. Other
integration branch names have no grace.

For GitHub, GitHub Enterprise Server, and Azure DevOps, exact server-side
ancestry checks can verify remote-only integration and PR-target commits
without refetching main/master during that grace window.
The helper still checks live refs and preserves the original expiry. It also
supports legacy `visualstudio.com/DefaultCollection` repository URLs.

Before a long reconstruction or continuation, compare the remaining grace with
measured durations of similar operations. Allow extra time for hooks and
validation. If the remaining grace is too short, refresh and replan safely.
Do not extend the validity of old evidence. Establish recovery constraints for
pending operations before moving refs.

### Reconstruction and recovery

Reconstruction plans accept `--commit-trailers-file <json>`. The helper records
the required trailers in the approved payload and adds them to generated commit
messages, including during conflict recovery. It does not change PR titles. The
option applies to one operation and changes neither Git configuration nor
graph-wide policy.

For `add`, `fold`, `sync`, `publish`, and `retarget`, helper plans accept
`--reuse-worktree <operation-digest>`. This reuses a completed or aborted
operation's clean detached worktree for the same graph and repository. Plans
record its identity and HEAD. The helper rechecks both when applying the plan and
records the ownership transfer in both journals. It preserves the path and
ignored installed tooling. Earlier owners cannot recover or clean the transferred
worktree.

The helper can also transfer verified, pinned reconstruction receipts from
compatible journals. It reuses committed results only when the parent, patch,
full message, and execution fingerprint match exactly. Reuse avoids repeated
patch applications and commit hooks. Changed or unknown inputs require
reconstruction. The helper still checks validation, full-tree composition, and
freshness. Legacy journals export no unverified cache entries. Inspection reports
patch application and inherited-cache-use counts. Reuse does not renew the fetch
clock.

Whole-graph retargeting reconstructs unlanded work on another integration branch
without changing which node owns each change or replacing existing PRs. Batch
description updates leave source branches and draft states unchanged. Custom
helper-branch prefixes support namespace restrictions. After a partial
first-publication failure, an approved recovery can retain verified pushes.
Description-only actions do not create or claim a worktree. They leave partial
checkouts from interrupted older operations untouched.

The `adopt` recovery requires separate approval. It imports verified externally
rewritten PRs and landings into local graph state without publishing or claiming
validation. An adoption spec with `"selective": true` can name only the externally
updated nodes while retaining the integration snapshot, helper namespace, and
unselected unpublished work. Unselected hosted heads and targets must still match
recorded identities. The helper clears validation and readiness for selected
nodes and active descendants. Adoption does not reconstruct or publish them.

`checkpoint` preserves already-staged work on a new local branch to release an
occupied graph node. It uses normal hooks and signing. Both `adopt` and
`checkpoint` require human approval even in auto mode.

The `import-graph --source-repo <path>` recovery requires separate approval. It
recovers changed node ownership or dependencies from another verified local clone
when `adopt` cannot represent the new DAG shape. The plan records both manifests
and live hosted identities. The helper preserves prior snapshots and the
destination's remote and backup settings. It atomically updates only approved,
unoccupied local branches. It never pushes, edits PRs, changes integration
branches or worktrees, uploads backups, or executes imported commands.
It clears imported validation commands and results, readiness,
freshness timestamps, and composition evidence. Configure validation before
subsequent source-changing operations. It requires human approval even in auto
mode. Resume interrupted imports with `continue` and the original operation and
digest.

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
PR's node. Diagrams use compact node cards, a small visual key, and a concise
snapshot summary. Put freshness information in the summary, not in node cards or
their styling.

Every arrow must stay clear of unrelated nodes and labels. The agent inspects
each edge in each highlighted image before upload. Rerouting and extra spacing
take priority over compactness. Obscured or ambiguous edges block upload or image
reuse. The workflow refreshes diagrams as graph state changes. It requires an
approved local renderer and a supported provider attachment mechanism.

```text
/pr-graph [--auto] [split | view | history | interdiff | add | sync | retarget | ready | merge | describe | reshape | adopt | import-graph | checkpoint | remove-retired | backup | restore]
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
approves the specific change.

The skill returns to deferred findings after the other unreviewed findings.
If the user defers the only remaining finding again, triage ends and that finding
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
