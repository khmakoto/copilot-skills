---
name: pr-reviewer
description: Review a GitHub or Azure DevOps pull request URL or a local Git branch with a specialist code-review agent, then present actionable suggestions one at a time for interactive triage, individually approved local fixes, or optional posting for remote PRs. Use when the user invokes /pr-reviewer.
argument-hint: "<pull-request-url | local-branch-name> [base branch or constraints]"
disable-model-invocation: true
---

# Interactive Pull Request Reviewer

Review the pull request or local branch supplied after `/pr-reviewer`, then walk
the user through confirmed findings one at a time. Let the user apply or retain
local findings, prepare remote comments, skip, defer, revise, or investigate.

## Input

Accept one GitHub or Azure DevOps pull request URL, or a local branch name in the
Git repository containing the current working directory. Honor an explicit base
branch and review constraints.

If no target is supplied inside a Git repository, use structured user input to
ask which branch or PR to review, suggesting the current branch without silently
selecting it. Outside a repository, request a PR URL or a local repository path
and branch. Clarify ambiguous arguments or multiple targets before review.

### Remote pull request

Parse the provider, organization or owner, project when applicable, repository,
and pull request number from the URL. Do not infer a PR from a local branch or
silently turn a local review into a remote review.

### Local branch

Resolve the repository root and verify that the named local branch exists.
Do not switch branches. Resolve the comparison base in this order:

1. An explicitly supplied base branch.
2. An associated PR's target branch, when provider-native metadata is available.
3. Branch metadata that unambiguously identifies the intended integration base.
4. The remote default branch, resolved from repository metadata.

Do not assume `main` or `master`, or treat a feature branch's upstream tracking
the same feature branch as its comparison base. If sources conflict or the base
cannot be resolved locally, ask the user. Do not fetch or modify refs implicitly.

Resolve the base, branch head, and merge-base commit IDs. Review the complete diff
from the merge base to the named branch head, excluding unrelated base changes.
Inspect commits, every changed file and hunk, and rename or copy information.
Report the repository, branch, resolved base, and exact comparison before triage.

When the named branch is checked out, include staged, unstaged, and non-ignored
untracked files as a separate `Uncommitted local state` layer. Account for staged
and unstaged versions without treating intermediate edits as independent defects.
Otherwise review committed branch content only; do not attribute the current
worktree's changes to another branch. Read that branch's source and instructions
from its Git objects rather than substituting the checked-out branch's files.

Use exact snapshot paths and lines for findings and identify their committed or
uncommitted layer. If relevant state changes during review, revalidate affected
findings before presenting them; do not silently mix snapshots.

## Safety and side effects

Review and discovery are read-only.

Local review and suggestion preparation use read-only Git commands. Only an
explicit **Apply locally** decision authorizes edits for the current suggestion
and the smallest relevant validation. Do not fetch, checkout, stash, stage,
commit, or push as part of applying a suggestion. Retaining a finding is not
authorization to edit code or publish it.

Do not post, update, reply to, resolve, or close a pull request comment unless the
user explicitly approves that exact action for the suggestion currently shown.
Do not edit code except through the approved local application workflow below.
Remote reviews remain read-only apart from individually approved comments.
Do not commit, push, change branches, or change the pull request.

Before posting, always show the exact proposed comment in an editable field and
require explicit confirmation. Approval of the finding is not approval of the
comment text.

Use provider-native tools. Do not scrape credentials, use raw authenticated HTTP
requests, or guess deferred tool schemas. Load or inspect a deferred tool before
calling it.

## 1. Review the target

Invoke the specialist code-review agent through the task tool with
`agent_type: "code-review"`.

Give the agent:

- the complete PR URL for a remote review, or the repository path, local branch,
  resolved base, merge-base and head commit IDs, and uncommitted scope for a local
  review;
- for remote reviews, instructions to retrieve the PR metadata, description,
  target branch, complete current diff, active threads, and source context;
- for local reviews, the local comparison and snapshot rules above, instructions
  to inspect the full committed diff and separate uncommitted layer when applicable,
  and instructions not to fetch, switch branches, edit files, or post comments;
- instructions to enumerate every changed file and inspect every changed hunk rather
  than sampling representative files;
- instructions to discover and read repository-wide and package-local contributor
  instructions, testing guidance, package documentation, and build conventions that
  govern the changed files. Existing review comments may identify useful evidence,
  but the agent must validate each concern independently against source or documented
  repository policy;
- instructions to review only changes in the selected PR or local comparison;
- instructions to report concrete bugs, security vulnerabilities, regressions,
  compatibility breaks, meaningful test gaps, and objectively verifiable
  architectural-boundary violations, including:
  - use of legacy or deprecated APIs in a new or replacement path;
  - mixing implementation systems that the target path is intended to replace
    or isolate;
  - dependencies from a new layer back into its legacy implementation;
  - violations of repository documentation, package conventions, or invariants
    demonstrated by canonical neighboring code;
- instructions to ignore subjective style, formatting, naming preferences, and
  speculative concerns. Do not classify implementation-system selection as
  subjective when repository evidence establishes it as an architectural or
  migration invariant;
- instructions not to edit files, post comments, or modify repository or PR state.

For every newly introduced adapter, new or replacement implementation, or
migration layer, require the agent to:

1. Locate the canonical implementation it wraps or replaces.
2. Compare imports, implementation systems, dependency direction, and
   package-level build conventions.
3. Compare the adapter's public props, slots, render-prop contracts, selectors,
   class-name constants, ARIA attributes, and design tokens with the canonical
   exported types and constants. Flag locally recreated contracts only when they
   can drift from the wrapped API or violate a documented convention.
4. Search changed files for dependencies on legacy implementations or use of
   deprecated APIs.
5. Report mismatches when the invariant is supported by source, configuration,
   documentation, or consistent neighboring implementations.

Before the focused passes, classify each changed file or hunk by evidence from its
content and repository context. A change may belong to multiple categories. Do not
classify the whole pull request under one broad label, and do not infer a category
from file extensions alone. Record which categories apply and why.

Always run these cross-cutting passes, even when another finding has already been
found:

1. **State and lifecycle:** For any stateful code, trace initialization, updates,
   repeated calls, cleanup, shutdown, error paths, and ownership boundaries using
   the lifecycle model appropriate to that technology. Check no-op writes, shared
   or injected state isolation, stale data, cleanup ordering, and mutations from
   inactive or already-closed code. Treat same-value writes as actionable only
   when they can notify consumers, erase another feature's state, cause unnecessary
   work, or produce an observable lifecycle error.
2. **Test validity:** For each changed test, verify that its preconditions can
   distinguish the claimed behavior, assertions would fail for the relevant
   regression, untouched stores or objects are compared on fields that could
   actually change, and assertions test production behavior rather than behavior
   invented by mocks. Apply the repository's required test harness and test-layer
   conventions. A passing test is still invalid when it mocks the implementation
   system under test or bypasses a documented required harness, because it cannot
   protect the production integration.
3. **Coverage of behavioral branches:** Map each newly introduced branch, mode,
   injected dependency, lifecycle path, and failure path to a meaningful test or
   other explicit contract. Pay special attention when one mode is covered but a
   sibling mode follows a different event, state, or error path.

Run each of the following passes only when at least one changed hunk contains
evidence for that category:

1. **Rendered UI and interaction:** When a change renders UI, handles user input,
   or participates in a browser/native event chain, follow keyboard and pointer
   events, `preventDefault`, `stopPropagation`, native activation, focus, and
   parent handlers through the real rendered component chain. Check accessibility
   contracts such as names, roles, and focus restoration. Do not accept a mocked
   control or isolated hook test as proof of integration behavior.
2. **Wrappers and adapters:** When a change wraps, adapts, proxies, or replaces an
   existing API or component, compare its public types and runtime contract
   directly with the canonical upstream contract. Look for omitted-and-redeclared
   properties, widened or narrowed types, duplicated selectors or constants,
   altered defaults, incomplete error propagation, and definitions that can
   silently diverge.
3. **Design systems and presentation:** When a change uses a design system,
   component library, CSS, styling API, or presentation tokens, check required
   semantic tokens, exported class-name constants, supported component APIs, and
   repository rules that prohibit mixing or mocking implementation systems.
4. **Persistence, stores, hooks, and reactive effects:** When a change uses a
   store, cache, subscription, reactive hook, observer, or effect system, trace
   mount/start, update, cleanup/unsubscribe, unmount/stop, already-closed, and
   repeated-call paths. Check cross-store isolation, subscription noise, cleanup
   races, stale closures, and whether inactive code can clear state owned by
   another feature.
5. **Service and data contracts:** When a change modifies an API, RPC, event,
   message, schema, serialization format, database interaction, or other external
   data boundary, check backward and forward compatibility, validation, error
   propagation, retries/idempotency, authorization, and all affected producers and
   consumers.
6. **Build and package boundaries:** When a change modifies imports, exports,
   dependencies, entry points, bundling, generated output, or build configuration,
   check dependency direction, independent consumability, tree-shaking or loading
   behavior, package conventions, and compatibility of public entry points.

If a conditional pass is skipped, require the agent to state briefly what evidence
was absent. If applicability is uncertain, inspect the relevant source or canonical
implementation rather than skipping the pass.

Do not turn these passes into style review. In particular, do not report equivalent
null checks, test-file organization, requests for explanatory comments, redundant
mock-call assertions when observable behavior is already proved, or opportunities
to shorten code unless there is a concrete failure mode or documented invariant.
Only flag recreated props, selectors, constants, or tokens when divergence is
observable, violates the canonical upstream contract, or breaks an explicit
repository invariant; cosmetic duplication alone is not a finding.

Require every finding to include:

- severity;
- confidence as both `1-10` and `Low`, `Medium`, or `High`;
- exact repository file path;
- exact changed line or narrow changed line range;
- concise title;
- failure path and impact;
- relevant code excerpt or context;
- recommended direction;
- a proposed review comment following the comment-drafting defaults below,
  ready to post for a remote PR or retain as a local finding;
- an applicable suggestion code block when supported and safe, or a brief reason
  why a code suggestion cannot be supplied.

Rank findings by severity, then confidence. Prefer synchronous execution unless
there is genuine independent work to perform in parallel.

If the agent cannot access the target or retrieve the complete scoped diff and
source, report the blocker accurately and do not invent findings or present an
incomplete review as complete.

Before accepting the agent's final result, require it to state briefly which
categories it identified, which focused passes it completed or skipped with
reasons, and which repository or package guidance it consulted.
If it reports `No findings`, require a second pass for:

- legacy dependencies, deprecated APIs, architecture boundaries, and
  implementation-system regressions when wrappers, migrations, imports, exports,
  dependencies, or replacement paths changed;
- no-op or cross-feature state mutations during initialization and cleanup when
  stateful, reactive, persistent, cached, or subscription-based code changed;
- event propagation through real parent components when rendered UI or user-input
  handling changed;
- ineffective test assertions and tests that validate mocks instead of production
  behavior when tests changed;
- missing tests for every applicable boundary and behavioral branch.

## 2. Prepare the review queue

Internally retain the complete ranked finding set, but never present it as a batch.
Remove duplicate findings that describe the same root cause.

If no actionable findings remain, say `No findings` and end with a concise review
summary.

Maintain an ordered queue with these states:

- unreviewed;
- skipped;
- deferred to end;
- withdrawn;
- retained locally;
- applied locally;
- posted.

A suggestion moved to the end must be shown again after every other unreviewed
suggestion. Do not create an infinite loop: if the user defers the same suggestion
again when it is the only item left, leave it deferred and end with that status.

## 3. Present exactly one suggestion

Show only the next suggestion. Do not reveal titles or details of later findings.

### Comment-drafting defaults

Apply these defaults to the first proposed comment, not only after the user
selects **Prepare to post**. Pass them to the review agent and refine its draft
before presenting it. Do not wait for the user to request more natural wording or
a suggestion code block.

**Write like a teammate.** Use plain, specific language and usually one to three
sentences before any code block. Name the concrete failure or missing protection,
then ask a direct, collaborative question when appropriate. Vary the wording to
fit the concern rather than starting every comment with the same phrase.
For example, "Could we cover Enter here? All the selection tests use clicks, so
broken keyboard activation would still pass."

Keep severity, confidence, diagnostic headings, and detailed investigation notes
in the review presentation, not in the posted comment. Avoid canned introductions,
generic praise, formal audit language, repeated context, and phrases such as
"It is important to note", "To ensure robustness", or "Consider adding coverage".
Do not soften a confirmed defect into speculation or call a test gap a proven
runtime bug.

**Include applicable code by default.** When the retrieved source establishes a
precise, type-safe, self-contained change and the provider supports applicable
suggestions, include the exact replacement in a suggestion code block in the
first draft. This applies to production fixes and missing tests or stories.
Do not omit a suggestion merely because it adds a new test, needs a local helper,
or requires moving the anchor away from the diagnostic line.

For local reviews, show a precise proposed replacement or patch when safe, rather
than claiming a provider-applicable suggestion is available. Name its snapshot
path and replacement range, and do not apply it before approval. The same source, type-safety,
and test-validity checks apply; no remote provider is required.

For a missing test, prefer a complete test or story using the existing imports,
fixtures, assertions, and required harness. Check that it distinguishes the
reported regression and exercises production behavior rather than inventing
behavior in a mock. Avoid timing races that could let the broken implementation
pass. Do not invent unavailable APIs or assume a fixture supports unverified
props.

For a self-contained test or story appended to a changed file, prefer an anchor
at the end of that file. Preserve the anchored closing line or lines in the
replacement, then append the new code. For other fixes, anchor exactly the lines
being replaced. Verify indentation, imports, types, fixture contracts, and anchor
boundaries against the current source. Keep the diagnostic location separate
from the replacement anchor when they differ.

If an applicable suggestion is unsafe because source context is missing, the
implementation is uncertain, coordinated edits elsewhere are required, or the
provider does not support it, use prose and briefly explain the limitation to
the user. Do not force a code block or claim proposed code was tested when it was
not. Keep any unexecuted-code qualification in the review presentation.

Use this shape:

```text
Suggestion <current> of <total>
Severity: <Critical|High|Medium|Low>
Confidence: <Low|Medium|High> (<1-10>/10)
Location: <path>:<line or range>

<Concise defect statement>

Impact: <specific failure or risk>
Evidence: <why the changed code causes it>

Relevant code:
<narrow excerpt>

Proposed review comment:
> <ready-to-post comment>
```

Include any applicable suggestion code block with the proposed comment and show
its replacement anchor if different from the diagnostic location.

Use the structured user-input tool to offer:

1. **Prepare to post** - proceed to editable comment confirmation.
2. **Skip** - mark skipped and continue.
3. **Move to end of queue** - defer and continue.
4. **Investigate or explain further** - stay on this suggestion.
5. **Something else** - follow the user's freeform direction when safe.
6. **Stop review** - stop presenting findings and summarize.

For remote reviews, when the current finding has multiple viable changed-line
anchors and could usefully be split into independently understandable comments,
actively include **Split into multiple comments, one per anchor** as an additional
decision option. Offer it during both finding triage and comment confirmation
when applicable. Do not wait for the user to request splitting, and do not offer
it for a single anchor or when separate comments would lack necessary context.

For local reviews, replace **Prepare to post** with **Apply locally** and also
offer **Keep finding**. Before offering Apply locally, show the proposed fix,
affected files, and intended validation. For fixes needing coordinated edits,
describe the complete bounded plan rather than forcing a single replacement.
Selecting Apply locally authorizes that displayed scope only. Keep retains the
finding without edits. Do not offer posting actions or imply that a PR exists.
Keep the other triage choices.

Never infer a side-effecting choice from ambiguous input.

## 4. Handle the decision

### Apply locally (local reviews)

1. Re-check the repository, branch head, worktree, and relevant source. Apply only
   when the reviewed branch is checked out in the target worktree. If it is not,
   explain the mismatch and keep the finding active; do not switch branches or
   edit another branch. Let the user select an existing worktree with the reviewed
   branch checked out or arrange the checkout themselves.
2. Revalidate the concern against current code and locate the fix by source
   context, not stale line numbers. If it no longer applies, withdraw it with an
   explanation. If the approved scope or approach must materially change, show
   the revised plan and obtain approval again before editing.
3. Read applicable contributor instructions and preserve existing staged,
   unstaged, and untracked work. If it conflicts with the fix, stop and ask rather
   than overwriting or reverting it.
4. Implement the smallest complete approved fix, including directly related
   tests and documentation where required. Do not fix other queued concerns
   without separate approval.
5. If repository conventions require a package change file, check branch changes
   relative to the review base and uncommitted files for an existing file for that
   package. Update a suitable existing file without erasing its entries rather
   than creating a duplicate. Explain any convention requiring a separate file.
6. Run the smallest existing validation covering the fix. Inspect the resulting
   diff to confirm the approved scope and preservation of existing work. Record
   changed files and actual validation results; do not claim unrun checks passed.
7. Mark successfully implemented and verified findings as applied locally.
   If implementation or validation fails or is blocked, explain the remaining
   work and any edits already made, keep the finding active, and ask how to
   proceed. Do not silently move on or revert other people's work.
8. Refresh the affected snapshot and revalidate remaining findings as they are
   presented, accounting for prior approved fixes. Withdraw concerns already
   addressed by an earlier fix rather than applying stale suggestions.

Leave changes uncommitted and unpushed. Do not stage files, post comments, or
resolve remote threads as a side effect of local application.

### Keep finding (local reviews)

Record the finding as retained locally and continue to the next suggestion.
Do not edit code, create files, or post comments. Include retained findings in
the final response so the user can act on them later.

### Prepare to post

This action is available only for a remote PR review. If the user wants to publish
a local finding, request an explicit PR target and revalidate the finding against
its latest diff and threads before entering this confirmation workflow. Never
publish uncommitted-only changes as though they were already part of the PR.

1. Re-check current active PR threads for a materially equivalent comment.
2. Verify that the file and changed-line anchor are still valid in the latest PR
   iteration.
3. Refresh the draft using the comment-drafting defaults above. It should already
   be natural and concise; preserve the concrete failure path while incorporating
   any user direction and newly retrieved evidence.
4. Re-check whether an applicable suggestion can now be included. Include it by
   default when safe, including for a new test or story; otherwise explain the
   limitation briefly rather than silently dropping it.
5. Verify the exact replacement code and anchor against the latest PR iteration.
   For an appended test or story, use the end-of-file anchor and preserve the
   replaced closing lines. Show the final anchor alongside the editable draft.
6. Present an editable text field containing the exact comment.
7. Offer `Post this exact comment`, `Skip`, `Move to end`, and `Revise again`.
   Include `Split into multiple comments, one per anchor` when applicable above.
8. If the user asks for different framing, such as making the comment a question
   or adding an applicable suggestion block, revise the editable draft and require
   confirmation again.
9. Post only when the user selects `Post this exact comment`.
10. Use the edited text exactly as supplied, without silently rewriting it.
11. Prefer an inline comment on the relevant changed line. If the provider rejects
    a valid-looking anchor, explain the failure and return to the same suggestion;
    do not silently post a general comment.
12. Record the returned thread or comment ID.

If the user selects splitting, keep the shared root cause as one queue finding.
Prepare one editable draft per anchor, show each file and line range, and state
whether each comment creates a thread or replies to an existing one. Disclose
materially equivalent existing threads. Require explicit confirmation of all
exact texts and destinations before posting; selecting splitting is not posting
approval. Record each successful comment or thread ID separately. If only some
writes succeed, report the partial result and keep the finding active; obtain a
decision before retrying failures, and never repost successful comments.

### Skip

Mark the suggestion skipped and continue immediately to the next item.

### Move to end of queue

Move the current suggestion behind every other unreviewed item and continue.

### Investigate or explain further

Stay on the current suggestion. Gather only the context needed to answer the
question or validate the concern. Update or withdraw the finding if the evidence
changes, then ask for a decision again.

### Something else

Follow the user's explicit direction if it is safe and within the review workflow.
If the direction would cause a write or another side effect, show the exact effect
and obtain explicit confirmation first.

### Stop review

Stop presenting suggestions. Do not reveal the remaining findings individually.

## 5. Continue and finish

After each completed decision, show the next queued suggestion. Continue until all
suggestions are posted, applied locally, retained locally, skipped, withdrawn, or
left deferred, or until the user stops.

Finish with a concise summary containing:

- PR reviewed, or local repository, branch, base, merge-base and head commit IDs;
- whether uncommitted local state was included;
- retained local findings with location, impact, and recommended direction;
- locally applied fixes with changed files and validation results;
- partially applied or blocked fixes, and whether local changes remain uncommitted;
- comments posted with file, line, and thread or comment ID;
- count of skipped and withdrawn suggestions;
- deferred or unreviewed count;
- any access, diff, anchor, application, validation, or posting failures.

Do not repeat the full text of every finding. Do not claim a comment was posted
without a successful provider write-tool response.
