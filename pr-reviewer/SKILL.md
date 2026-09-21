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
  current diff, and relevant source context;
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
3. Search changed files for dependencies on legacy implementations or use of
   deprecated APIs.
4. Report mismatches when the invariant is supported by source, configuration,
   documentation, or consistent neighboring implementations.

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

Before accepting a `No findings` result, require a focused second pass for:

- legacy dependencies introduced into new or replacement paths;
- deprecated API usage;
- architecture or package-boundary violations;
- implementation-system regressions;
- missing tests for those boundaries.

Require the agent to state briefly which focused checks it completed.

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
