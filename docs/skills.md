# Skill guide

The instructions and references under [`skills/`](../skills/) define each
workflow. See the [README](../README.md) for an overview. Install complete skill
directories as described in the
[installation instructions](../README.md#installation).

Invoke any skill with the commands below. Agents can also select `brainstorm`,
`pr-walkthrough`, or `pr-graph` when a request matches their description. The other
skills require explicit invocation.

## `brainstorm`

The skill analyzes a local or remote repository. It ranks possible improvements
to the product, engineering practices, reliability, security, accessibility,
delivery, and design.

The skill presents one suggestion at a time for the user to refine or triage.
It can prepare a GitHub issue or Azure DevOps work item once the user confirms
the exact contents.

```text
/brainstorm [repository or path] [suggest-only] [count, focus areas, exclusions, or other constraints]
```

## `ci-triage`

The skill investigates failures in GitHub or Azure DevOps PR checks, workflow
runs, build runs, and local build or test commands. Before tracing the failure, it
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
It uses the current published diff, the repository's PR template when one applies,
and verified validation evidence. It supports GitHub Enterprise Server and legacy
Azure DevOps URLs through each provider's tools.

The skill preserves references, attachments, managed graph footers and diagram
blocks, and human-maintained content outside the requested scope. It separates
validation evidence for the current PR head from historical results. It also
reports pending, failed, or unavailable checks.

The user can edit the complete body and must approve its exact content before
publication. The skill checks for intervening changes before publishing.
It reads back the saved description to verify it. Draft-only mode makes no remote
changes.
Neither mode changes code, review threads, graph state, or other PR metadata.

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
whether tests are valid, and which behavioral branches they cover. Where relevant,
it runs focused checks for UI interactions, wrappers and adapters, design systems,
reactive state, service contracts, and package boundaries.

The skill presents one finding at a time. Keeping a local finding does not change
the worktree. Remote review comments can include suggestion blocks that the
reviewer can apply. The user can edit each comment and must approve its exact
text before the skill posts it.

```text
/pr-reviewer <pull-request-url | local-branch-name> [base branch or constraints]
```

## `pr-walkthrough`

The skill builds a walkthrough for manual review of a GitHub or Azure DevOps pull
request or a branch in the current local repository. It orders review stops by
their dependencies and makes no changes.

The walkthrough explains what to review and how the changes depend on each other.
It splits files with substantial behavior into focused review stops rather than
treating each file as one review unit.

```text
/pr-walkthrough <GitHub-or-Azure-DevOps-PR-URL | local-branch-name>
```

## `pr-graph`

The skill splits existing branches and manages changes as a multi-parent
dependency graph in local Git, GitHub, GitHub Enterprise Server, or Azure DevOps.

All published nodes start as drafts. Blocked drafts use helper integration
bases to show only their own changes. A node becomes eligible for review after
every prerequisite lands. Mutations require approval of the exact plan.
`--auto` lets the agent approve routine plans within the task. Conditional
allowances cover recovery, requested follow-up allocation, requested retired
metadata removal, and backup effects the user previously authorized.

The agent may also abort verified publication attempts while retaining refs,
or adopt requested landings without source rewrites. It may repeat unchanged
setup only when receipts prove successful execution and explicit approval in
the same task and invocation.

In ordinary auto mode, history transfers require separate permission for the
current invocation. The user must still approve merges and deletion of source,
refs, or worktrees.
Restore, general adoption, graph import, checkpoint, new setup, and new conflict
fixes also require human approval.
The agent pauses when outcomes are uncertain. It never bypasses digests or safety
checks.

Publication exclusions within a graph keep local-only node lineage, retained
versions, and metadata out of product refs, helper refs, backups, and history
exports. The user must separately approve the release of an exclusion, even in
ordinary auto mode. In YOLO mode, the agent may approve that separate release
only within established disclosure limits. These exclusions do not detect
secrets or protect against external tools. See the
[policy contract](../skills/pr-graph/references/publication-exclusions.md).

Explicit `--yolo` delegates all pr-graph human approvals needed for this task
and invocation. This includes merging, deletion, PR closure, recovery, new setup
and fixes, restore, graph import, checkpoint, exclusion release and history
transfer. It can irreversibly delete resources, execute setup scripts or disclose
unpublished or discarded source and metadata.

The agent first uses the task and verified context to establish the exact source,
destination, access permissions, and limits on retained data. Missing or ambiguous
intent or destinations still block the operation. So do unresolved remote
effects. Plans, digests, freshness, validation, hooks, and provider policies remain
mandatory. `--yolo` is not a helper flag. Its permission does not persist or apply
to other skills. Ordinary `--auto` remains unchanged. See the
[complete matrix](../skills/pr-graph/references/yolo-mode.md) and
[examples](pr-graph.md#yolo-mode).

```text
/pr-graph [--auto | --yolo] [split | view | select | history | interdiff | export-history | import-history | publication-policy | add | absorb | sync | retarget | ready | merge | describe | reshape | adopt | import-graph | checkpoint | remove-retired | backup | restore]
```

The helper requires Node.js 22+ and Git 2.31+. Hosted operations also require
authenticated `gh` or `az` for the selected provider. Install the complete skill
directory. It needs no dependency installation or build step.
During reconstruction, the helper can reuse verified sequences of previously
composed changes when their exact inputs and known execution context match.
Reuse does not carry over validation or freshness evidence.

See the [`pr-graph` guide](pr-graph.md) for detailed usage, requirements,
validation, and safety boundaries.

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
