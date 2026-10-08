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

Investigate thoroughly, then write selectively. The walkthrough is a reading route,
not a record of the investigation. A reviewer should quickly see where to start,
what to understand next, and which questions deserve their attention.

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

1. an explicitly supplied base branch;
2. the target branch of an associated remote PR, when provider-native metadata
   identifies it unambiguously;
3. branch metadata that unambiguously identifies the intended integration base;
4. the remote default branch.

Do not treat an upstream tracking the same published feature branch as its
comparison base. A configured upstream alone does not establish the intended
integration base. If an explicit base cannot be resolved, ask rather than
silently substituting another branch. If inferred sources conflict or the
comparison base remains materially ambiguous, use structured user input to ask
for the base branch.

Compare from the merge base through the named branch head so unrelated target-branch
changes are excluded. Inspect commits, changed files, rename or copy status, and the
complete diff.

If the named branch is currently checked out and the worktree has uncommitted changes,
include them as a clearly separated `Uncommitted local state` layer. Do not blend them
into the committed branch diff. If another branch is checked out, do not attribute
that worktree's changes to the target branch.

For the committed layer, read source, tests, documentation, and repository
or directory guidance from Git objects at the resolved target head. Read
before-change context from the comparison snapshot used by the diff. Do not
substitute another checked-out branch's files. Use worktree files for the
separate uncommitted layer only when the target branch is checked out, and
identify which layer supports each explanation or reference.

Use code-intelligence results only when they correspond to the reviewed
snapshot; otherwise use direct snapshot reads. If the target head or relevant
worktree state changes during analysis, refresh affected evidence before
presenting the walkthrough rather than mixing snapshots.

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

Aim for 4-6 stops for an ordinary PR, fewer for a small change. Add stops only when
independent behavioral concepts need them; do not squeeze a complex lifecycle into
one stop to meet the target. Minor styles, fixtures, release metadata, and mechanical
changes usually belong beside their behavior or in a compact lower-attention list,
not in standalone stops.

A review stop may cover:

- one important region in one file;
- connected regions in several files;
- a return to a previously visited file after another change supplies necessary
  context.

Do not let file boundaries determine stop boundaries. In particular, split a large
or behavior-dense file into multiple sequential stops when reading it as one stop
would require the reviewer to hold several distinct concepts in mind at once. Treat
the following as strong signals to split:

- the stop spans multiple phases such as input collection, derived state, branch
  selection, side effects, rendering, and cleanup;
- separate regions implement different modes, protocols, lifecycle paths, or failure
  behavior;
- a later region is understandable only after reviewing tests, a helper, or an
  external contract in between;
- the proposed `Read` range is broad enough that the reviewer would need to search
  within it to find the behavior being discussed;
- the explanation needs several unrelated sets of review questions for the same
  file.

Prefer stops centered on named symbols, cohesive branches, or narrow line ranges,
even when this means several consecutive stops in one file. Give each stop a
behavioral purpose, not labels such as "part 1" and "part 2." Keep tightly coupled
code together, and do not split merely to meet a line-count target. As a practical
check, reconsider any stop that asks the reviewer to read more than roughly 100-150
changed lines in one file unless those lines form one coherent unit.

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

Write a self-contained guide with four short sections: **Orientation**, **Reading
route**, **Cross-cutting checks**, and **Validation**. Include a **Lower-attention
files** list only when needed for complete file coverage.

### Length and readability

- Aim for 600-900 words for an ordinary PR; small changes should be much shorter.
  Exceed this only when distinct, high-attention behavior genuinely needs more
  explanation or the user requests detail. Word and stop counts are targets, not
  reasons to omit material evidence or combine unrelated behavior.
- Give the reviewer a mental model, not an exhaustive explanation of the code.
  Prefer "closing clears the query before restarting loading" over listing every
  state variable and hook.
- Use short paragraphs and behavioral headings. Avoid nested lists, wide tables,
  long runs of filenames, and repeated metadata.
- Do not repeat six labeled fields at every stop. Combine the reason for the order,
  the change, and its connections into natural prose.
- Keep the investigation map, full build listing, and incidental retrieval details
  out of the output. Mention a limitation only when it affects interpretation or
  confidence. Never hide missing snapshot or comparison data.

### Orientation

Lead with 2-3 sentences explaining what the PR actually does, what it deliberately
does not do, and the main behavior or boundary to watch. Reconcile material
differences between the description and the inspected diff here or at the relevant
stop, without repeating them.

Use compact metadata, not a large orientation table:

- Identify the PR URL/title or branch and repository, author when available,
  open/draft/merged/local state, and scope counts.
- Record the exact reviewed head and comparison snapshot, with branch names.
  Distinguish the target snapshot from the merge base when they differ or the
  provider does not expose the latter. Keep full hashes in this one place.
- Summarize checks in one line. Identify a relevant failed or pending check rather
  than enumerating every successful job. Qualify unavailable commit counts or
  update timestamps instead of implying they are exact.

### Reading route

Use numbered behavioral headings such as `1. Understand who owns the open state`,
not repetitive headings such as `Review stop 1`. Aim for 50-90 words per stop,
excluding references. Each stop has this shape:

```markdown
### 1. Understand who owns the open state

**Read:** `path/to/Shell.tsx:80-115`; `path/to/Shell.stories.tsx` - handoff story.

The shell derives visibility from shared state rather than keeping its own open
flag. Start here because the close handlers below must preserve a replacement
surface's ownership.

**Check:** Does switching surfaces preserve the new owner's state?
```

This is an illustrative format, not code or evidence for the target PR. For each
actual stop:

- **Read:** Give exact paths and narrow line ranges, symbols, or diff regions.
  Include the most useful test or unchanged dependency here, or cite it inline
  where it supports the explanation. State meaningful gaps in test evidence.
- Explain what changed and why it matters in 2-3 sentences. Make the dependency
  on the preceding or following stop clear when it is not obvious.
- **Check:** Give one concrete review question or invariant; add a second only
  when independently important. Avoid laundry lists of speculative edge cases.
- Mark only the 1-2 highest-attention stops when useful. Do not assign a risk badge
  to every stop or turn the guide into an automated defect report.

When revisiting a file, name the new behavior and use a narrower range. Keep tests
beside the behavior they demonstrate. Do not repeat the same explanation in the
orientation, multiple stops, and the final checklist.

Use file links or provider line links when available and stable; otherwise use
repository-relative `path:line` references. Never invent line numbers. If many files
share a long prefix, state it once and use unambiguous paths relative to that prefix.

### Lower-attention files

Account for every changed file, but do not give every file equal airtime. Group
remaining files by purpose in a short list with exact paths and one shared reason
they need less attention. For example, group generated outputs beneath the authored
input that explains them. Do not silently classify behavior-changing configuration,
migrations, or snapshots as mechanical.

Do not append a second full inventory when the reading route already covers every
file. Keep authored behavior in the route; this list is not a shortcut for omitting
a changed subsystem.

### Cross-cutting checks

Use 3-5 short checklist items only when there are invariants spanning multiple stops,
such as ownership, ordering, compatibility, or deployment sequencing. Do not repeat
each stop's question. If there are no additional cross-cutting checks, omit this
section.

### Validation

Suggest 2-4 focused existing commands or manual scenarios, scaled down for small
changes. Identify which commands were discovered in repository documentation or
automation and which scenarios are inferred. Favor specific tests over a default
full-suite recommendation. Do not run validation unless the user asks.

State briefly if suggested validation was not run. Avoid ending with a recap or
an offer to continue.

## Quality bar

- Cover every changed file in the route or in an explicit low-attention/mechanical
  inventory. Do not silently omit files.
- Spend detail in proportion to risk and explanatory value, not diff size.
- Break behavior-dense single files into enough stops that each stop has one primary
  reasoning objective; a large file is not itself a review unit.
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
- Before sending, check whether a reviewer can identify the starting point, the
  highest-attention behavior, and the validation route in a 30-second scan. Remove
  repetition and incidental detail before shortening necessary evidence.

If the target cannot be accessed, the branch does not exist, or the diff cannot be
retrieved completely, explain the blocker and stop rather than producing a partial
walkthrough that appears complete.
