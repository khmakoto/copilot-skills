# Skill guide

This guide covers each skill's behavior and invocation. For an overview and
installation, see the [README](../README.md).
The workflow instructions and supporting references under
[`skills/`](../skills/) define the skills' behavior. Install complete skill
directories as described in the
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
confidence level for each attribution. An unchanged failing file or a successful
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

The design separates explicit decisions from proposed defaults and assumptions.
It defines scope, non-goals, observable acceptance criteria, and proposed
validation. The design remains provisional until the user resolves material
choices.

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

The skill preserves human-maintained content outside the requested scope,
references, attachments, and managed graph footer and diagram blocks. Validation
results distinguish evidence for the current PR head from historical results.
They disclose pending, failed, or unavailable checks.

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
bases to show only their own changes. Review eligibility requires every
prerequisite to land. Sync, readiness, merges, and deletion require explicit
approval. The skill supports splitting changes within a file, reshaping the
graph, merge, squash, and rebase strategies, and opt-in recovery of committed
snapshots across machines. Footer refreshes leave completed Azure DevOps PR
descriptions unchanged. The skill reports their diagrams as historical snapshots.

### Publication and local sync

Helper `plan publish --nodes <id,id>` limits publication to selected nodes and
their required helper bases. It leaves unselected and landed PRs unchanged.
Unpublished or out-of-date prerequisites must also be selected. Selective
publication retains the existing integration snapshot and refuses reconstruction
that would change unselected nodes. Sync separately when needed.

Helper `plan sync --local-only` reconstructs and validates local branches without
pushes, PR updates, draft changes, hosted footer refreshes, or backup uploads.
The helper preserves hosting identities and backup configuration, and publication
remains pending. Approved plans record the publication selection and local-only
mode. Continuation uses those same settings. Neither option bypasses safety
checks or marks nodes ready.

Preflight distinguishes journal-verified pending publication after approved local
reconstruction from unexplained divergence. It never pushes or repairs branches
to resolve that difference. Normal helper planning and authorization still apply.

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
revalidation after the grace period expires, and diagram updates. Already-approved
matching conflict resolutions may be reused without another first-reuse prompt,
with verified current inputs/context and a fresh exact recovery plan. New or
unverifiable conflicts and other safety blockers pause for human approval.
Auto mode then resumes. Merges, removal, deletion, cleanup, backup transfers, and
restore still require confirmation. Helper plan digests and safety checks remain
mandatory. An unambiguous instruction such as "Split this branch using auto mode"
enables the same behavior for the current task, even
when the agent selects pr-graph automatically. Merely mentioning or asking about
auto mode does not enable it.

The helper reports live progress to stderr by default. It shows each node's
phases, branch, PR identity, validation commands and results, and elapsed time.
Results on stdout remain unchanged. Interactive terminals use colors and
spinners. Redirected output uses plain lines. Quiet steps emit a heartbeat every
two minutes. The helper shows validation output only on failure. Agent milestone
updates cover work outside the helper, including freshness preflight and PR
diagrams, without repeating every helper line. Helper `--quiet` suppresses
progress, not errors or results.

### Freshness

Per-node reports distinguish integration freshness, branch identity, and
validation status. Integration branches named `main` or `master` allow a
90-minute freshness grace for verified forward movement outside merging. This
avoids repeated source rewrites during review. The window starts when the last
successful fetch for the latest tip started, not when it finished or the plan
was applied. Merge always requires the current integration tip. Other integration
branch names have no grace.

For GitHub, GitHub Enterprise Server, and Azure DevOps, exact server-side
ancestry checks can verify remote-only integration and PR-target commits
without refetching main/master during that grace window.
The helper still checks live refs and preserves the original expiry. It also
supports legacy `visualstudio.com/DefaultCollection` repository URLs.

Before long reconstruction or continuation, compare remaining grace against
observed comparable durations plus hook/validation margin. Insufficient
headroom calls for safe refresh/replanning, not an extension of old evidence.
Establish pending-operation recovery constraints before moving refs.

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
records the ownership transfer in both journals. The path and ignored installed
tooling remain intact. Earlier owners cannot recover or clean the transferred
worktree. Compatible journals also transfer verified pinned reconstruction
receipts. Exact parent, patch, full message and execution-fingerprint matches
reuse committed results without repeating patch applications or commit hooks.
Changed or unknown inputs reconstruct normally; required validation, full-tree
composition and freshness checks remain. Legacy journals export no unverified
cache entries. Inspect reports actual application and inherited-cache-use
counts. Reuse does not renew the fetch clock.

Whole-graph retargeting reconstructs unlanded work on another integration branch
without changing which node owns each change or replacing existing PRs. Batch
description updates leave source branches and draft states unchanged. Custom
helper-branch prefixes support namespace restrictions. After a partial
first-publication failure, an approved recovery can retain verified pushes.
Description-only actions do not create or claim a worktree. They leave partial
checkouts from interrupted older operations untouched.

The `adopt` recovery requires separate approval. It imports verified externally
rewritten PRs and landings into local graph state without publishing or claiming
validation.
An adoption spec with `"selective": true` can name only the externally updated
nodes while retaining the integration snapshot, helper namespace, and unselected
unpublished work. Unselected hosted heads and targets must still match recorded
identities. The helper clears validation and readiness for selected nodes and
active descendants. Adoption does not reconstruct or publish them.

`checkpoint` preserves already-staged work on a new local branch to release an
occupied graph node. It uses normal hooks and signing. Both require human approval
even in auto mode.

The `import-graph --source-repo <path>` recovery requires separate approval. It
recovers changed node ownership or dependencies from another verified local clone
when `adopt` cannot represent the new DAG shape. The plan records both manifests
and live hosted identities. The helper preserves prior snapshots and the
destination's remote and backup settings. It atomically updates only approved,
unoccupied local branches.
It never pushes, edits PRs, changes integration branches or worktrees, uploads
backups, or executes imported
commands. It clears imported validation commands and results, readiness,
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

Each PR description ends with a rendered Mermaid DAG image that highlights its own
node. Diagrams use compact node cards, a small visual key, and a concise snapshot
summary to keep the full graph readable in a PR description. Freshness information
belongs in the snapshot summary, not in node cards or their styling. The skill workflow
requires every arrow to stay clear of unrelated nodes and labels. The agent
inspects each edge in each highlighted image before upload. Rerouting and extra
spacing take priority over compactness. Obscured or ambiguous edges block upload
or image reuse. The workflow refreshes these snapshots as graph state changes.
It requires an approved local renderer and supported provider attachment mechanism.

```text
/pr-graph [--auto] [split | view | add | sync | retarget | ready | merge | describe | reshape | adopt | import-graph | checkpoint | remove-retired | backup | restore]
```

The self-contained helper requires Node.js 22+ and Git 2.31+, with authenticated
`gh` or `az` only for the applicable hosting integration. No dependency install
or build step is needed. Install the complete `skills/pr-graph/` directory
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

The skill presents proposals individually and does not save changes
automatically.

```text
/session-distill [selected session IDs] [focus] [proposals-only]
```

## `skill-doctor`

The skill audits personal skill definitions and supporting resources for concrete
workflow defects involving triggers, inputs, tools, authorization, evidence,
failure handling, interaction, and completion criteria.

The skill presents one finding at a time and applies a repair only after the user
approves the specific change.

Deferred findings return after the other unreviewed findings. Deferring the sole
remaining finding again ends triage with that finding left deferred.

```text
/skill-doctor [skill names or paths] [audit-only] [focus or constraints]
```

## `unslop`

The skill edits selected writing using Cursor's upstream `unslop` rules. The
installed skill is a local wrapper that fetches the complete instructions from
`https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md`
on every explicit invocation, not during installation.

The skill requires network access and trusts changing upstream writing guidance
rather than a pinned local copy. If the fetch fails or returns incomplete or
unexpected content, the skill stops without inventing or silently using cached
rules. It does not send the user's text or repository content upstream.

Upstream rules remain subject to higher-priority instructions and the user's
scope and tone constraints. Fetching does not authorize running upstream scripts,
unrelated edits, commits, or publication.

```text
/unslop [text or paths] [tone or scope constraints]
```
