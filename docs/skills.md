# Skill guide

Detailed behavior and invocation examples for the skills in this repository.
For an overview and installation, see the [README](../README.md).
Authoritative workflow contracts and supporting references live under
[`skills/`](../skills/); install complete skill directories as described in the
[installation instructions](../README.md#installation).

All skills can be invoked explicitly with the commands shown below. `brainstorm`,
`pr-walkthrough`, and `pr-graph` may also be selected automatically when a request
matches their descriptions. The other skills require explicit invocation.

## `brainstorm`

Analyzes a local or remote repository and builds a ranked queue of potential
improvements across product, engineering, reliability, security, accessibility,
delivery, and design concerns.

The skill presents suggestions individually for refinement or triage and can
prepare a GitHub issue or Azure DevOps work item after the user confirms the
exact payload.

```text
/brainstorm [repository or path] [suggest-only] [count, focus areas, exclusions, or other constraints]
```

## `ci-triage`

Investigates failing GitHub or Azure DevOps PR checks, workflow/build runs, or
local build/test commands. Pins the tested revision, run attempt, job/matrix,
and relevant configuration before tracing failures to their causes.

The skill distinguishes change-related, pre-existing, test-fixture,
infrastructure/environment, flaky, and undetermined causes, with evidence-backed
attribution and confidence. An unchanged failing file or a successful retry
alone does not establish that a failure is unrelated or flaky.

Root causes are triaged individually. Discovery is read-only; local reproduction,
fixes, and remote reruns have separate explicit authorization boundaries.
Diagnose-only mode makes no changes or reruns. Reports distinguish local
validation from hosted results and queued reruns from completed checks.

```text
/ci-triage <pull-request-url | run-url | failing-command> [diagnose-only] [scope or constraints]
```

## `design-interview`

Clarifies an already-selected feature or improvement through an evidence-backed
interview. Inspects the relevant implementation and supplied artifacts, then asks
one focused structured question at a time about goals, tradeoffs, and constraints.
Supports visual interfaces, terminal output, APIs, and agent workflows.

The resulting design separates explicit decisions from proposed defaults and
assumptions, defines scope and non-goals, and includes observable acceptance
criteria and proposed validation. Unresolved material choices keep it provisional.

The workflow is read-only and requires explicit approval of the final design.
Design approval does not authorize implementation, saving a document, running
validation, or publishing anything; implementation requires a separate instruction.

```text
/design-interview [feature or improvement] [paths, screenshots, or constraints]
```

## `pr-description`

Drafts or refreshes a GitHub or Azure DevOps pull request description using its
current published diff, applicable repository template, and verified validation
evidence. Supports GitHub Enterprise Server and legacy Azure DevOps URLs through
available provider-native tools.

The skill preserves human-maintained content outside the requested scope,
references, attachments, and managed graph footer/diagram blocks. Validation
results distinguish current-head evidence from historical results and disclose
pending, failed, or unavailable checks.

The complete body is editable and requires exact-payload approval before
publication. The skill rechecks for intervening changes and verifies the saved
description. Draft-only mode makes no remote changes; neither mode changes code,
review threads, graph state, or other PR metadata.

```text
/pr-description <pull-request-url> [draft-only] [scope or constraints]
```

## `pr-feedback`

Validates incoming GitHub or Azure DevOps pull request feedback against the
current code, classifies each concern, and presents review threads one at a time
for interactive triage.

The skill can implement individually approved fixes and run focused validation,
while replies, thread resolution, commits, pushes, and other remote changes
require separate explicit approval.

```text
/pr-feedback <pull-request-url> [scope or constraints]
```

## `pr-reviewer`

Reviews a GitHub or Azure DevOps pull request or a local Git branch with a
specialist code-review agent, retaining only concrete defects, regressions,
vulnerabilities, compatibility problems, and meaningful test gaps.

The review covers every changed hunk and applies cross-cutting checks for state and
lifecycle behavior, test validity, and behavioral branch coverage. It also runs
focused checks when relevant for UI interactions, wrappers and adapters, design
systems, reactive state, service contracts, and package boundaries.

Findings are presented one at a time. Local findings can be retained without
changing the worktree, while remote review comments can include directly
applicable suggestion blocks but are not posted until the user edits and confirms
the exact text.

```text
/pr-reviewer <pull-request-url | local-branch-name> [base branch or constraints]
```

## `pr-walkthrough`

Builds a read-only, dependency-ordered walkthrough for manually reviewing a
GitHub or Azure DevOps pull request or a branch in the current local repository.

The walkthrough explains what to review, in what order, and how the notable
changes connect so a human reviewer can form the right mental model efficiently.
Behavior-dense files are divided into focused review stops instead of being treated
as a single review unit.

```text
/pr-walkthrough <GitHub-or-Azure-DevOps-PR-URL | local-branch-name>
```

## `pr-graph`

Splits existing branches and manages incrementally developed changes as a
multi-parent dependency graph in local Git, GitHub, GitHub Enterprise Server,
or Azure DevOps.

All published nodes start as drafts. Blocked drafts use helper integration
bases to show only their own changes. Review eligibility requires every
prerequisite to land; sync, readiness, merges, and deletion have explicit
approval boundaries. The skill supports same-file splitting, graph reshaping,
merge/squash/rebase strategies, and opt-in committed snapshot recovery across
machines.

Eligible existing PRs retain their live draft/non-draft state through sync,
retargeting, and graph reshaping, including manual status changes. Blocked or
superseded PRs must be draft; non-draft status does not waive validation,
freshness, or merge checks. Status changes after planning require reapproval.

Use invocation-scoped `--auto` to approve routine in-scope plans, safe freshness
fetches/fast-forwards, expired-grace sync and revalidation, and diagram updates
without repeated prompts. Conflicts and other safety blockers pause for an
approved resolution, then auto mode resumes. Merges, removal/deletion/cleanup,
backup transfers, and restore still require confirmation; helper plan digests
and safety checks remain mandatory. An unambiguous instruction such as "Split
this branch using auto mode" enables the same behavior for the current task, even
when the agent selects pr-graph automatically. Merely mentioning or asking about
auto mode does not enable it.

Live progress is on by default: the helper reports per-node phases, branches,
PR identities, validation commands/results, and elapsed times to stderr while
keeping stdout results unchanged. Interactive terminals use colors/spinners;
redirected output uses plain lines. Quiet steps emit a heartbeat every two
minutes, and validation output is shown only on failure. Agent milestone
updates cover work outside the helper, including freshness preflight and PR
diagrams, without repeating every helper line. Helper `--quiet` suppresses
progress, not errors or results.

Per-node reports distinguish integration freshness, branch identity, and
validation status. Integration branches named `main` or `master` allow a
90-minute freshness grace for verified forward movement outside merging, avoiding
repeated source rewrites during review. The window starts when the last
successful fetch for the latest tip started, not when it finished or the plan
was applied. Merge always requires the current
integration tip; other integration branch names have no grace.

For GitHub, GitHub Enterprise Server, and Azure DevOps, exact server-side
ancestry checks can verify remote-only integration and PR-target commits
without refetching main/master during that grace window.
Live refs are still checked and the original expiry is preserved. Legacy
`visualstudio.com/DefaultCollection` repository URLs are also supported.

Reconstruction plans accept `--commit-trailers-file <json>` to pin required commit
trailers into the approved payload and generated commit messages, including
conflict recovery, without changing PR titles. This helper option is scoped to
each operation and does not change Git configuration or a graph-wide policy.

For `sync`, `publish`, and `retarget`, helper plans accept
`--reuse-worktree <operation-digest>` to explicitly reuse a completed or aborted
operation's clean detached worktree for the same graph and repository. Plans pin
its identity and HEAD; apply rechecks those leases and transfers ownership in
both journals, preserving the path and ignored installed tooling. Earlier owners
cannot recover or clean the transferred worktree. Reuse does not bypass
validation, hooks, or freshness checks, or renew the fetch clock.

Whole-graph retargeting reconstructs unlanded work on another integration branch
while preserving change ownership and existing PR identities. Batch description
updates leave source branches and draft states unchanged. Custom helper-branch
prefixes accommodate namespace restrictions, and explicitly approved recovery
can retain verified pushes after a partial first-publication failure.

Separately approved `adopt` recovery imports verified externally rewritten PRs
and landings into local graph state without publishing or claiming validation.
`checkpoint` preserves already-staged work on a new local branch to release an
occupied graph node, using normal hooks and signing. Both require human approval
even in auto mode.

`remove-retired --node <id>` removes only retired unpublished node metadata and
historical `supersedes`/`replacedBy` references to it. It refuses nodes with a PR,
landing, remote product branch, or dependents. The previous manifest stays in
the operation journal; Git refs, commits, files, indexes, worktrees, and existing
validation/readiness evidence are preserved. It does not reconstruct source,
publish, or upload a backup, and requires separate human approval even in auto
mode. Use `continue` with the original digest after an interrupted metadata write.

Each PR description ends with a rendered Mermaid DAG image highlighting its own
node. Diagrams use compact node cards, a small visual key, and a concise snapshot
summary to keep the full graph readable in a PR description. The skill workflow
requires every arrow to stay clear of unrelated nodes and labels, with
edge-by-edge inspection of each highlighted rendering before upload. Rerouting
and extra spacing take priority over compactness; obscured or ambiguous edges
block upload or image reuse. The workflow
refreshes these snapshots as graph state changes and requires an approved local
renderer and supported provider attachment mechanism.

```text
/pr-graph [--auto] [split | view | add | sync | retarget | ready | merge | describe | reshape | adopt | checkpoint | remove-retired | backup | restore]
```

The self-contained helper requires Node.js 22+ and Git 2.31+, with authenticated
`gh` or `az` only for the applicable hosting integration. No dependency install
or build step is needed. Install the complete `skills/pr-graph/` directory
globally using the [README installation instructions](../README.md#installation);
its scripts resolve independently of the repository being managed. See its
references for
[operation plans](../skills/pr-graph/references/commands.md),
[provider constraints](../skills/pr-graph/references/providers.md), and
[recovery](../skills/pr-graph/references/safety-and-recovery.md).

From the repository root, run the helper's local Git and provider-fixture tests:

```text
node skills/pr-graph/scripts/test.mjs
```

The `pr-graph` workflow runs this suite on Linux, macOS, and Windows with Node.js
22 and 24. Fixture coverage does not imply live hosting certification.

## `session-distill`

Extracts evidence-backed workflow lessons from the current session or explicitly
selected past sessions and turns them into bounded proposals for improving a
skill, repository instructions, or an explicitly stated user preference.

The skill presents proposals individually and does not save changes
automatically.

```text
/session-distill [selected session IDs] [focus] [proposals-only]
```

## `skill-doctor`

Audits personal skill definitions and supporting resources for concrete workflow
defects involving triggers, inputs, tools, authorization, evidence, failure
handling, interaction, and completion criteria.

Findings are presented individually, and repairs are applied only after approval
of the specific proposed change.

```text
/skill-doctor [skill names or paths] [audit-only] [focus or constraints]
```
