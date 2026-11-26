# Skill guide

The instructions and references under [`skills/`](../skills/) define each
workflow. See the [README](../README.md) for an overview. Install complete skill
directories as described in the
[installation instructions](../README.md#installation).

Invoke any skill with the commands below. Agents can also select `brainstorm`,
`pr-walkthrough`, or `pr-graph` when a request matches their description. The other
skills require explicit invocation.

## `brainstorm`

The skill analyzes a local or remote repository and ranks possible improvements.
It covers product behavior, engineering practices, reliability, security,
accessibility, delivery, and design.

The skill presents one suggestion at a time for the user to refine or triage.
It can prepare a GitHub issue or Azure DevOps work item once the user confirms
the exact contents.

```text
/brainstorm [repository or path] [suggest-only] [count, focus areas, exclusions, or other constraints]
```

## `ci-triage`

The skill investigates failed GitHub or Azure DevOps pull request checks,
workflow runs, build runs and local build or test commands. It first records the
tested revision, run attempt, job or matrix entry and relevant configuration.

The skill classifies each cause as change-related, pre-existing, test-fixture,
infrastructure or environment, flaky, or undetermined. It gives evidence and a
confidence level for each cause. An unchanged failing file or a successful
retry alone does not prove that a failure is unrelated or flaky.

The skill presents one root cause at a time for triage. Discovery is read-only.
Local reproduction, fixes, and remote reruns each require separate approval.
Diagnose-only mode makes no changes and runs no retries. Reports distinguish
local validation from hosted results. They also distinguish queued reruns from
completed checks.

```text
/ci-triage <pull-request-url | run-url | failing-command> [diagnose-only] [scope or constraints]
```

## `design-interview`

The skill clarifies a selected feature or improvement. It inspects the relevant
implementation and supplied materials, then asks one structured question at a
time about goals, tradeoffs, and constraints. It covers visual interfaces,
terminal output, APIs, and agent workflows.

The design records decisions, proposed defaults, and assumptions separately.
It defines scope, non-goals, observable acceptance criteria, and validation plans.
The user must resolve choices that affect the design before approving it.

The workflow is read-only. The user must approve the final design. That approval
does not authorize implementation, saving a document, running validation, or
publishing anything. Implementation requires a separate instruction.

```text
/design-interview [feature or improvement] [paths, screenshots, or constraints]
```

## `pr-description`

The skill drafts or updates a GitHub or Azure DevOps pull request description.
It uses the current published diff and the repository's pull request template
when one applies. It reports verified validation evidence. It supports GitHub
Enterprise Server and legacy Azure DevOps URLs through each provider's tools.

The skill preserves references, attachments, managed graph footers and diagram
blocks. It leaves human-maintained content outside the requested scope
unchanged. It separates validation evidence for the current pull request head
from historical results. It also reports pending, failed, or unavailable checks.

The user may edit the complete body and must approve its exact content before
the skill publishes it. The skill checks for intervening changes before
publishing.
It reads back the saved description to verify it. Draft-only mode makes no remote
changes. Neither mode changes code, review threads, graph state, or other pull
request metadata.

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

The skill uses a specialist code-review agent to review a GitHub or Azure DevOps
pull request or a local Git branch. It reports defects, regressions,
vulnerabilities, compatibility problems and gaps in test coverage.

The review covers every changed hunk. It checks state and lifecycle behavior,
whether tests are valid, and which behavioral branches they cover. When needed,
it runs focused checks for UI interactions, wrappers and adapters, design
systems, reactive state, service contracts and package boundaries.

The skill presents one finding at a time. Keeping a local finding does not change
the worktree. Remote review comments may include suggestion blocks for the
reviewer to apply. The user may edit each comment and must approve its exact
text before the skill posts it.

```text
/pr-reviewer <pull-request-url | local-branch-name> [base branch or constraints]
```

## `pr-walkthrough`

The skill builds a walkthrough for manual review of a GitHub or Azure DevOps pull
request or a branch in the current local repository. It orders review stops by
their dependencies and makes no changes.

The walkthrough explains what to review and how the changes depend on each other.
It splits files with substantial behavior into separate review stops.

```text
/pr-walkthrough <GitHub-or-Azure-DevOps-PR-URL | local-branch-name>
```

## `pr-graph`

The skill splits existing branches and manages changes as a multi-parent
dependency graph in local Git, GitHub, GitHub Enterprise Server, or Azure DevOps.

The read-only `dependencies` command reports redundant edges and their alternate
paths. It also lists sequencing candidates for the agent to assess.
The report does not prove that the sequencing is unnecessary. For each
hypothetical edge removal, it shows the affected nodes and changes to their
prerequisite closures and dependency eligibility.
The agent reviews owned patches, consumers and the reason for each edge before
proposing a change. If evidence is missing, it reports the gap instead of
recommending removal. The command does not run checks or reconstruct nodes.
The helper applies approved dependency changes through `deps` plans.
Those plans preserve the complete combined tree and run required validation. See
[dependency advice](pr-graph.md#simplify-dependencies-and-review-sequencing).

The read-only `operation-diff` command reports graph and node changes for a
retained operation. It includes lineage, validation and readiness evidence.
It distinguishes verified publication from planned effects, interrupted
candidate states and attempted remote writes. It reports missing evidence
rather than inferring success. Its output does not authorize undo, renew
freshness or prove that a merge is safe.

The helper stores digest-addressed immutable payloads shared by local journals
and snapshots. It reads legacy inline state. Older helpers cannot read state
written in the new format. Keep `payloads/` with local state backups. Portable
history archives remain self-contained. They do not authorize execution. See
[storage compatibility](../skills/pr-graph/references/state-storage.md).

The helper reruns configured checks at existing pinned heads through a separate
approved `plan validate --select <selector>` plan. It does not reconstruct or
publish nodes. By default, it runs checks in a separate worktree for each node.
An approved environment policy lets the helper reuse validation workers and build
artifacts. The policy limits worker counts and cache bytes. Clean mode starts
each node in a fresh worker. Neither mode reuses test results or replays setup.
The helper records each check's result. It distinguishes no-check reasons from stale or
unavailable inputs. It preserves source checkouts, refs and pull requests.
Failed checks do not authorize fixes or setup. See
[standalone validation](pr-graph.md#standalone-validation).

Validation-first is the default. An explicit request to run validation last
permits `--defer-validation` in approved allocation, sync or publication plans.
The helper retains all checks and safety requirements. Results and diagrams say
**validation pending**. The helper clears validation and readiness receipts for
all active unlanded nodes. Approve a separate validation plan for the exact
resulting heads before any readiness operation. Auto mode and YOLO mode do not
request deferral. See
[publish-first ordering](pr-graph.md#explicit-publish-first-validate-last-ordering).

All published nodes start as drafts. Blocked drafts use helper integration
bases to show only their own changes. A node becomes eligible for review after
every prerequisite lands. Mutations require approval of the exact plan.
`--auto` lets the agent approve routine plans within the task. Conditional
permissions cover recovery, requested follow-up allocation, requested removal
of retired metadata, and backup effects the user previously authorized.

The agent may also abort verified publication attempts and retain their refs.
It may adopt requested landings without source rewrites. Repeating unchanged
setup requires receipts that prove successful execution and explicit approval
in the same task and invocation.

In ordinary auto mode, history transfers require separate permission for the
current invocation. The user must still approve merges and deletion of source,
refs, or worktrees. Restore, general adoption, graph import, checkpoint, new
setup, and new conflict fixes also require human approval. The agent pauses
when outcomes are uncertain. It never bypasses digests or safety checks.

Publication exclusions prevent the helper from uploading local-only node lineage,
retained versions, and metadata through product refs, helper refs, backups, and
history exports. The user must approve the release of an exclusion in a separate
plan, even in ordinary auto mode. In YOLO mode, the agent may approve that release
only within established disclosure limits. These exclusions do not detect
secrets or protect against external tools. See the
[policy contract](../skills/pr-graph/references/publication-exclusions.md).

Review freezes protect authored content and identity or an exact realized review
snapshot and its review configuration. Authored-content freezes allow
reconstruction. Exact-review-snapshot freezes block indirect prerequisite
reconstruction. Separate digest-bound `review-freeze` plans freeze or unfreeze
nodes and retain history. Ordinary auto mode requires human approval for both
actions. It cannot unfreeze a node without that approval to satisfy freshness.
The helper reports external drift. Supported transfers preserve policy and
evidence, not current validation or authorization. See
[review freezes](pr-graph.md#preserve-an-active-review-baseline).

Explicit `--yolo` lets the agent approve every pr-graph action that needs human
approval for this task and invocation. These actions include merging, deletion,
pull request closure, recovery, new setup and fixes, restore, graph import,
checkpoint, exclusion release, explicit review freezing and unfreezing, and history
transfer. It can irreversibly delete resources, execute setup scripts or disclose
unpublished or discarded source and metadata.

The agent establishes the exact source, destination, access permissions and limits
on retained data from the task and verified repository evidence. The operation
stops if intent or destinations are missing or ambiguous, or if remote effects
remain unresolved. Plans, digests, freshness, validation, hooks and provider
policies remain mandatory. `--yolo` is not a helper flag. Its permission ends
with this task and invocation and does not apply to other skills. Ordinary
`--auto` remains unchanged. See the
[complete matrix](../skills/pr-graph/references/yolo-mode.md) and
[examples](pr-graph.md#yolo-mode).

```text
/pr-graph [--auto | --yolo] [split | view | dependencies | select | validate | history | interdiff | operation-diff | export-history | import-history | publication-policy | review-freeze | add | absorb | sync | retarget | ready | merge | describe | reshape | adopt | import-graph | checkpoint | remove-retired | backup | restore]
```

The helper requires Node.js 22+ and Git 2.31+. Hosted operations also require
authenticated `gh` or `az` for the selected provider. Install the complete skill
directory. It needs no dependency installation or build step.
During reconstruction, the helper can reuse verified sequences of previously
composed changes when their exact inputs and known execution context match.
Reuse does not carry over validation or freshness evidence.

The helper batches reads from the provider within a check. It never caches them
across checks. Selecting nodes does not skip checks for graph-wide changes or
readback after writes.

See the [`pr-graph` guide](pr-graph.md) for requirements, validation and approval
rules, and [example requests](pr-graph.md#example-requests) for invocations.

## `session-distill`

The skill uses evidence from the current session or selected past sessions to
propose changes to a skill, repository instructions, or an explicitly stated user
preference.

The skill presents one proposal at a time. It does not save changes automatically.

```text
/session-distill [selected session IDs] [focus] [proposals-only]
```

## `skill-doctor`

The skill audits personal skill definitions and supporting resources for workflow
defects. It checks triggers, inputs, tools, authorization, evidence, failure
handling, interaction, and completion criteria.

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
installed skill is a local wrapper. It fetches the complete instructions from
`https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md`
on every explicit invocation, not during installation.

The skill requires network access and follows changing upstream writing guidance
rather than a pinned local copy. If the fetch fails or returns incomplete or
unexpected content, the skill stops. It does not invent rules, silently use cached
rules, or send the user's text or repository content upstream.

The upstream rules remain subject to higher-priority instructions and the user's
scope and tone constraints. Fetching does not authorize running upstream scripts,
unrelated edits, commits, or publication.

```text
/unslop [text or paths] [tone or scope constraints]
```
