---
name: pr-walkthrough
description: Build a read-only, dependency-ordered walkthrough for manually reviewing the current state of a GitHub or Azure DevOps pull request, or a branch in a local Git repository. Use when the user invokes /pr-walkthrough, provides a PR link and asks how to review it, or wants a guided human review route through branch changes.
argument-hint: "<GitHub-or-Azure-DevOps-PR-URL | local-branch-name>"
---

# Pull Request Walkthrough

Inspect the current state of a pull request or local branch and produce a practical
route for a human reviewer. Explain which changes to read in which order, why that
order is useful, what each notable change does, and how changes connect across files.

This is a review guide, not an automated approval, defect report, or line-by-line diff
dump. Optimize for helping a reviewer form the right mental model and spend attention
where it matters.

## Safety

This workflow is read-only.

- Do not edit files, switch branches, create commits, push, post comments, vote,
  approve, merge, or modify the pull request.
- Do not run commands that alter the worktree or repository state.
- Use provider-native tools for remote pull requests. Do not scrape credentials or
  use raw authenticated HTTP requests when a supported tool exists.
- Build the walkthrough from the latest retrievable PR iteration or current local
  repository state. State limitations rather than filling gaps with assumptions.

## 1. Resolve the review target

Accept exactly one of these target forms:

1. A GitHub pull request URL.
2. An Azure DevOps pull request URL.
3. A branch name in the Git repository containing the current working directory.

Treat arguments as flexible natural language. Extract a PR URL or branch name when
the intent is unambiguous.

If no target was provided:

- When the current directory is inside a Git repository, use structured user input
  to ask which local branch to review. Show the current branch as a suggested value,
  but do not silently choose it.
- When there is no local Git repository, use structured user input to request a
  GitHub or Azure DevOps PR URL.

If an argument could be either a branch name or other freeform text, or if multiple
targets were supplied, use structured user input to clarify before analysis.

### Remote pull request

Parse and verify the provider, owner or organization, project when applicable,
repository, and pull request number. Retrieve:

- title, description, author, status, draft state, and latest update;
- source and target branches and current head and base commits;
- complete current file list and diff;
- commits in the pull request;
- linked issues or work items when available;
- current checks or build status when available;
- existing review threads only when useful for identifying areas already under
  discussion or understanding an unusual change.

Do not let the PR description substitute for inspecting the actual diff and relevant
source.

### Local branch

Confirm the named branch exists locally or as an unambiguous remote-tracking branch.
Resolve the repository root, current branch, remotes, and default branch. Never assume
the default branch is `main` or `master`.

Determine the intended base in this order:

1. configured upstream or branch metadata that identifies a clear base;
2. remote PR metadata associated with the branch, when provider-native tools expose
   it unambiguously;
3. the remote default branch.

If these sources conflict or the comparison base remains materially ambiguous, use
structured user input to ask for the base branch.

Compare from the merge base through the named branch head so unrelated target-branch
changes are excluded. Inspect commits, changed files, rename or copy status, and the
complete diff.

If the named branch is currently checked out and the worktree has uncommitted changes,
include them as a clearly separated `Uncommitted local state` layer. Do not blend them
into the committed branch diff. If another branch is checked out, do not attribute
that worktree's changes to the target branch.

## 2. Establish repository context

Before interpreting the changes:

1. Read applicable repository and directory instructions, including `AGENTS.md`,
   `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`,
   `.github/instructions/**/*.instructions.md`, and `CONTRIBUTING.md`.
2. Read architecture, build, test, ownership, and package documentation directly
   relevant to the changed areas.
3. Inspect enough unchanged surrounding source to understand the changed symbols,
   their callers, callees, data contracts, and established neighboring patterns.
4. Use code-intelligence tools for symbols, call relationships, inheritance, and
   architecture when available. Use direct reads for exact source and local Git for
   read-only repository metadata and diffs.
5. Inspect generated files, lockfiles, snapshots, migrations, and vendored output
   enough to classify them, but do not let mechanical bulk obscure authored changes.

For large pull requests, start with the complete change inventory, then deepen only
the paths needed to explain the main behavior, boundaries, risks, and review route.
Do not sample in a way that omits a changed subsystem from the inventory.

## 3. Understand the change before ordering it

Build an internal change map containing:

- the stated goal and the behavior the diff actually implements;
- user-visible or externally observable behavior changes;
- entry points and public contracts;
- core control flow and data flow;
- state, persistence, schema, serialization, or migration changes;
- integrations, adapters, APIs, events, and dependency boundaries;
- configuration, feature flags, permissions, deployment, and compatibility concerns;
- tests and which production behavior each test exercises;
- documentation and generated artifacts;
- cross-file invariants that must remain aligned.

Group files by responsibility and connected behavior, not merely by directory or file
extension. Identify the smallest set of pivotal changes that unlocks understanding of
the rest of the diff.

Distinguish:

- authored behavior from mechanical or generated changes;
- functional changes from refactors;
- new paths from modifications to existing paths;
- implementation evidence from claims in descriptions or commit messages;
- confirmed behavior from questions a human reviewer should resolve.

## 4. Design the human review route

Choose an order that minimizes backtracking while preserving cause and effect. A
typical route is:

1. intent, external contract, or entry point;
2. central orchestration or domain behavior;
3. state and data model changes;
4. integrations and boundary adapters;
5. tests alongside the behavior they demonstrate;
6. configuration, migration, deployment, documentation, and generated output.

This is guidance, not a fixed template. Reverse or interleave the order when the code
is easier to understand from tests inward, schema upward, data flow forward, or an
adapter back to its contract.

A review stop may cover:

- one important region in one file;
- connected regions in several files;
- a return to a previously visited file after another change supplies necessary
  context.

Explicitly revisit files when useful. For example, read a public contract, follow its
implementation into storage and integration code, then return to the contract's tests
with that context. Never force a one-file-at-a-time walkthrough.

Prioritize review attention using:

- behavioral centrality;
- blast radius and reversibility;
- security, privacy, authorization, data-loss, and compatibility risk;
- concurrency, retry, failure, and partial-success behavior;
- public API, schema, protocol, or persistence changes;
- architectural boundaries and dependency direction;
- weak, indirect, or missing test evidence;
- code whose meaning depends on synchronized changes elsewhere.

Do not present alphabetical order, raw diff order, or directory order unless it
genuinely matches the best reasoning flow.

## 5. Produce the walkthrough

Write a self-contained walkthrough with the following sections.

### Review orientation

Include:

- target: PR URL or local branch and repository;
- comparison: exact base and head branch or commit;
- current state: open, draft, closed, merged, or local, plus checks when available;
- scope: concise counts for commits and changed files, with additions and deletions
  when available;
- intent: what the change appears to accomplish, reconciled with the actual diff;
- review shape: the main behavioral path and the highest-attention themes;
- limitations: missing provider data, incomplete diff access, unavailable generated
  inputs, or other material constraints.

### Recommended review route

Use numbered `Review stop` entries. Each stop must include:

- **Read:** exact file paths and narrow symbol, line, or diff-region references;
- **Why here:** why this is the right point in the review sequence;
- **What changed:** a concise explanation of notable behavior, not a transcription;
- **Connections:** how it depends on, drives, or must agree with other changed code;
- **Human review focus:** concrete questions, invariants, edge cases, or failure paths
  to verify manually;
- **Evidence:** relevant tests, configuration, documentation, or unchanged source
  that helps validate the change.

Use file links or provider line links when the available tools return stable URLs.
Otherwise use repository-relative `path:line` references. When exact line numbers are
unavailable or unstable, name the symbol and changed region rather than inventing a
line number.

Keep related tests near the production behavior they validate instead of placing all
tests in a final undifferentiated stop. Place mechanical artifacts after the authored
source that explains them.

Call out transitions such as:

- `Now follow the value created above into persistence.`
- `With the failure behavior understood, return to the entry point to verify how it
  is surfaced.`
- `Review these files together because the identifiers must remain synchronized.`

Use natural prose rather than repeating these phrases mechanically.

### Cross-cutting review checklist

End with a concise checklist tailored to this change. Cover only relevant items, such
as:

- contract and compatibility;
- authorization and trust boundaries;
- validation and error propagation;
- data consistency, migration, rollback, and partial failure;
- concurrency, ordering, idempotency, retries, and cancellation;
- observability and operational behavior;
- feature-flag and configuration defaults;
- test coverage across happy paths and important failures;
- documentation, generated artifacts, and deployment sequencing.

### Suggested validation

List the smallest existing tests, builds, or manual scenarios that would give the
reviewer confidence in the changed behavior. Clearly distinguish commands discovered
in repository documentation or automation from inferred manual scenarios. Do not run
validation unless the user asks.

## Quality bar

- Cover every changed file in the route or in an explicit low-attention/mechanical
  inventory. Do not silently omit files.
- Spend detail in proportion to risk and explanatory value, not diff size.
- Explain relationships across files and layers; do not produce isolated file
  summaries.
- Make review questions specific enough that a human can answer them from code or by
  running a scenario.
- Do not invent defects. Phrase unverified concerns as review questions and explain
  the evidence that makes them worth checking.
- If an actual high-confidence defect becomes apparent, flag it clearly as a
  `Potential blocking issue`, include the failure path and exact evidence, and keep
  it distinct from the walkthrough.
- Do not recommend approval or rejection. The final judgment belongs to the human
  reviewer.
- Avoid exhaustive narration of trivial formatting, generated noise, and obvious
  test data unless they affect behavior or review risk.

If the target cannot be accessed, the branch does not exist, or the diff cannot be
retrieved completely, explain the blocker and stop rather than producing a partial
walkthrough that appears complete.
