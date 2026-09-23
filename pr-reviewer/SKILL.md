---
name: pr-reviewer
description: Review a pull request URL with a specialist code-review agent, then present actionable suggestions one at a time for interactive triage and optional posting. Use when the user invokes /pr-reviewer with a PR link or asks for this workflow.
argument-hint: "<pull-request-url>"
disable-model-invocation: true
---

# Interactive Pull Request Reviewer

Review the pull request identified by the URL supplied after `/pr-reviewer`, then
walk the user through confirmed findings one at a time. Let the user post, skip,
defer, revise, investigate, or otherwise direct each suggestion.

## Input

A pull request URL is required.

- Accept GitHub and Azure DevOps pull request URLs.
- Parse the provider, organization or owner, project when applicable, repository,
  and pull request number from the URL.
- If the argument is missing or is not an unambiguous pull request URL, use the
  structured user-input tool to request a valid URL before doing any review work.
- Do not infer a pull request from the current branch when a URL was not supplied.

## Safety and side effects

Review and discovery are read-only.

Do not post, update, reply to, resolve, or close a pull request comment unless the
user explicitly approves that exact action for the suggestion currently shown.
Do not edit code, commit, push, change branches, or change the pull request.

Before posting, always show the exact proposed comment in an editable field and
require explicit confirmation. Approval of the finding is not approval of the
comment text.

Use provider-native tools. Do not scrape credentials, use raw authenticated HTTP
requests, or guess deferred tool schemas. Load or inspect a deferred tool before
calling it.

## 1. Review the pull request

Invoke the specialist code-review agent through the task tool with
`agent_type: "code-review"`.

Give the agent:

- the complete pull request URL;
- instructions to retrieve the PR metadata, description, target branch, complete
  current diff, current active review threads, and relevant source context;
- instructions to enumerate every changed file and inspect every changed hunk rather
  than sampling representative files;
- instructions to discover and read repository-wide and package-local contributor
  instructions, testing guidance, package documentation, and build conventions that
  govern the changed files. Existing review comments may identify useful evidence,
  but the agent must validate each concern independently against source or documented
  repository policy;
- instructions to review only changes in the PR;
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
- instructions not to post comments or modify the PR.

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
- a ready-to-post review comment.

Rank findings by severity, then confidence. Prefer synchronous execution unless
there is genuine independent work to perform in parallel.

If the agent cannot access the PR or retrieve a complete diff, report the blocker
accurately and do not invent findings.

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
- posted.

A suggestion moved to the end must be shown again after every other unreviewed
suggestion. Do not create an infinite loop: if the user defers the same suggestion
again when it is the only item left, leave it deferred and end with that status.

## 3. Present exactly one suggestion

Show only the next suggestion. Do not reveal titles or details of later findings.

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

Use the structured user-input tool to offer:

1. **Prepare to post** - proceed to editable comment confirmation.
2. **Skip** - mark skipped and continue.
3. **Move to end of queue** - defer and continue.
4. **Investigate or explain further** - stay on this suggestion.
5. **Something else** - follow the user's freeform direction when safe.
6. **Stop review** - stop presenting findings and summarize.

Never infer a side-effecting choice from ambiguous input.

## 4. Handle the decision

### Prepare to post

1. Re-check current active PR threads for a materially equivalent comment.
2. Verify that the file and changed-line anchor are still valid in the latest PR
   iteration.
3. Rewrite the draft to be concise, specific, natural, and human-sounding. Avoid
   canned headings, excessive explanation, repeated context, and AI-like phrasing.
4. Present an editable text field containing the exact comment.
5. Offer `Post this exact comment`, `Skip`, `Move to end`, and `Revise again`.
6. Post only when the user selects `Post this exact comment`.
7. Use the edited text exactly as supplied, without silently rewriting it.
8. Prefer an inline comment on the relevant changed line. If the provider rejects
   a valid-looking anchor, explain the failure and return to the same suggestion;
   do not silently post a general comment.
9. Record the returned thread or comment ID.

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
suggestions are posted, skipped, withdrawn, or left deferred, or until the user
stops.

Finish with a concise summary containing:

- pull request reviewed;
- comments posted with file, line, and thread or comment ID;
- count of skipped and withdrawn suggestions;
- deferred or unreviewed count;
- any access, diff, anchor, or posting failures.

Do not repeat the full text of every finding. Do not claim a comment was posted
without a successful provider write-tool response.
