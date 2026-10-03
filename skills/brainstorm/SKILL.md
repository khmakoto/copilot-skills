---
name: brainstorm
description: Analyze a current or specified repository and its code, documentation, issues or work items, and pull requests to propose evidence-backed improvements, then triage them one at a time with optional confirmed issue creation. Use when the user invokes /brainstorm or asks for an interactive repository improvement brainstorm.
argument-hint: "[repository or path] [suggest-only] [count, focus areas, exclusions, or other constraints]"
---

# Interactive Repository Brainstorm

Generate a diverse, evidence-backed queue of repository improvements, then present
exactly one suggestion at a time for the user to keep, defer, discard, requeue, or
refine. Create an issue or work item only after the user has edited and explicitly
confirmed the exact payload.

Read these skill resources before beginning:

- `references/analysis-checklist.md`
- `references/provider-workflows.md`

## Safety and side effects

Repository discovery, code analysis, and suggestion generation are read-only.

Do not edit repository files, create branches, commit, push, or modify existing
issues, work items, pull requests, labels, or tags as part of this workflow.

A choice to keep a suggestion is not permission to create an issue, work item,
label, or tag. Immediately before every write:

1. re-check the target and possible duplicates;
2. show the complete exact payload;
3. use structured user input to request explicit confirmation for that write.

Do not claim that an item was created without a successful provider response that
returns an ID or URL.

Use provider-native tools. Do not scrape credentials, expose authentication
details, use raw authenticated HTTP requests when a supported tool exists, or
guess the schema of a deferred tool. Load or inspect deferred tools before calling
them.

## 1. Interpret the request

Treat arguments after `/brainstorm` as flexible natural-language instructions, not
as a rigid command-line grammar.

Default behavior:

- target the Git repository containing the current working directory;
- generate 10 suggestions;
- analyze local code and documentation plus remote open and closed issues or work
  items and pull requests;
- allow issue or work item creation after per-suggestion confirmation;
- consider all opportunity areas in the analysis checklist.

Honor explicit overrides for:

- a local repository path;
- a GitHub URL or `owner/repository`;
- an Azure DevOps repository URL;
- one or more repositories;
- suggestion count;
- focus areas or excluded areas;
- files, documents, constraints, goals, user research, or other supplied context;
- local-only or remote-only analysis;
- suggestion-only, report-only, dry-run, or no-issue-creation mode.

If the user supplies multiple repositories, make the repository target visible on
every suggestion. Never create an item until its exact destination is confirmed.

If a target, provider, or requested side effect cannot be resolved unambiguously,
use structured user input to request only the missing information. Do not infer a
remote repository merely from a similarly named directory.

## 2. Establish repository context

For each target:

1. Confirm whether it is a local Git repository, a remote GitHub repository, or an
   Azure DevOps repository.
2. Resolve the repository root, remote provider, owner or organization, project
   when applicable, repository name, current branch, and remote default branch.
   Never assume `main` or `master`.
3. Read applicable instructions and contributor guidance before analysis,
   including files such as:
   - `AGENTS.md`
   - `CLAUDE.md`
   - `GEMINI.md`
   - `.github/copilot-instructions.md`
   - `.github/instructions/**/*.instructions.md`
   - `CONTRIBUTING.md`
   - build, test, architecture, product, and design documentation
4. Inspect representative source, tests, configuration, dependencies, automation,
   and recent change history using the analysis checklist.
5. Inspect representative open and closed issues or work items and active,
   completed, and abandoned or closed pull requests using the provider workflow.

Prefer code-intelligence tools for concepts, symbols, call relationships, and
architecture. Use filesystem search and direct file reads for repository structure
and local state. Use Git only for read-only repository metadata and history.

If the repository is very large, sample deliberately instead of loading every
file or remote item. Expand the search only to validate a candidate, understand an
important subsystem, or check for duplicates.

If a source is unavailable, continue with the evidence that remains useful and
record the limitation. If there is too little evidence for responsible
suggestions, explain that rather than inventing repository details.

## 3. Build the suggestion queue

Aim for the requested number of evidence-backed candidates and build the retained
queue internally before presenting the first one. If fewer candidates meet the
quality bar after representative analysis and candidate validation, state the
shortfall and proceed with the qualifying candidates. Use the actual retained
count in suggestion numbering. If none qualify, explain the evidence limitations
and finish without inventing suggestions. Do not reveal the queue as a batch.

Every retained candidate must:

- be grounded in concrete repository or remote-history evidence;
- identify meaningful user, maintainer, reliability, security, accessibility,
  delivery, or design value;
- be distinct from the other candidates;
- have an actionable and reasonably bounded scope;
- not be materially duplicated by an existing open issue or work item;
- not describe work already implemented;
- not revive a clearly rejected proposal without new evidence.

Use the opportunity taxonomy and effort rubric in
`references/analysis-checklist.md`. Do not force a weak suggestion merely to cover
a category, but keep reasonable diversity across the queue.

Rank candidates internally by:

1. expected value and risk reduction;
2. confidence in the evidence;
3. urgency;
4. feasibility;
5. category diversity.

Each suggestion must contain:

- title;
- area;
- effort: `Low`, `Medium`, or `High`;
- target provider and repository;
- description;
- evidence and rationale;
- expected outcome or acceptance direction;
- suggested GitHub label or Azure DevOps tag.

## 4. Present exactly one suggestion

Show only the next unreviewed suggestion. Do not reveal titles, details, or a
category preview for later suggestions.

Use this shape:

```text
Suggestion <current> of <total>
Area: <area>
Effort: <Low|Medium|High>
Target: <provider and repository>
Suggested label/tag: <name>

<Title>

<Description>

Why this is worth considering:
<specific value and rationale>

Evidence:
<concise repository paths, documentation, history, issue/work item, or PR evidence>

Expected outcome:
<observable result or acceptance direction>
```

Then use structured user input to offer:

1. **Keep and prepare issue** - retain the suggestion and begin editable issue or
   work item preparation. In suggestion-only mode, label this **Keep** and do not
   offer a write.
2. **Skip for later** - do not revisit it during this run, but retain it in the
   final summary.
3. **Skip entirely** - discard it and omit it from retained suggestions.
4. **Move to back of queue** - put it behind every other unreviewed suggestion and
   revisit it later in this run.
5. **Refine or investigate** - stay on this suggestion, follow the user's
   direction, gather only the needed evidence, and update it when warranted.
6. **Stop brainstorming** - stop without revealing remaining suggestions
   individually.

Allow a freeform response for other safe directions. Never infer a side-effecting
choice from ambiguous input.

## 5. Handle queue decisions

Maintain these internal states:

- unreviewed;
- retained;
- skipped for later;
- discarded;
- moved to back;
- withdrawn;
- created;
- creation failed.

### Keep and prepare issue

Proceed to the editable preparation and confirmation workflow in the next section.

### Skip for later

Record the full suggestion for the final summary and continue immediately. This
state lasts only for the current invocation; do not create persistent state.

### Skip entirely

Record only the discarded count and continue. Do not repeat the full suggestion in
the final summary.

### Move to back of queue

Move the suggestion behind all other unreviewed items and continue. If it is the
only item remaining and the user moves it back again, leave it deferred, record
that state, and finish rather than creating an infinite loop.

### Refine or investigate

Stay on the current suggestion. Answer questions or gather more context, then
update the title, area, effort, description, evidence, expected outcome, or
suggested label/tag if the evidence changes. If investigation disproves the
suggestion, say so and mark it withdrawn. Otherwise ask for a disposition again.

### Stop brainstorming

Stop presenting suggestions. Record only the count of unreviewed suggestions, not
their individual titles or details.

## 6. Prepare and confirm a kept item

Use structured user input to let the user edit or replace all relevant fields.
Prepopulate the fields with the current suggestion.

For every provider, include:

- provider;
- repository and project when applicable;
- title;
- description/body;
- effort;
- area label or tag.

Use a body that is useful without being over-prescriptive:

```markdown
## Summary

<what should improve>

## Motivation and evidence

<why this matters and the repository evidence>

## Expected outcome

<observable result or acceptance direction>

## Estimated effort

<Low|Medium|High>
```

Let the user freely revise this structure. Preserve the user's edited text exactly
for the final payload unless they explicitly ask for another rewrite.

For GitHub, also allow the user to edit labels and other supported issue metadata
they request.

For Azure DevOps, always ask the user to select or enter the work item type for
this item. Do not assume that `Issue`, `Bug`, `User Story`, or `Task` exists in the
project's process.

After editing:

1. resolve the target again;
2. search for materially equivalent open items;
3. if a likely duplicate exists, show it and offer to cancel, revise, continue
   anyway, or return the suggestion to the queue;
4. inspect whether the requested label or tag exists;
5. show the complete final create payload;
6. ask the user to confirm **Create this exact issue/work item**.

If the requested GitHub label or Azure DevOps tag does not exist, do not silently
create or apply it. Separately show the exact taxonomy write or new tag application
and require explicit confirmation. If the user declines, create the item without
that label or tag if they still confirm the item itself.

Creation confirmation applies to one item only. It does not approve later items.

## 7. Create the confirmed item

Follow `references/provider-workflows.md`.

For GitHub, create the issue with GitHub CLI using the exact confirmed repository,
title, body, and approved existing or newly created labels.

For Azure DevOps, create the exact confirmed work item using the configured work
item write tool, selected work item type, title, Markdown description, and approved
tags.

On success, record the returned URL or ID and mark the suggestion created. Then
continue to the next queued suggestion.

On failure:

- report the provider error accurately;
- do not retry with changed fields or broader permissions without approval;
- keep the same suggestion active;
- offer to retry unchanged, revise, retain without creating, move it to the back,
  or stop.

## 8. Finish

When the queue is complete or the user stops, provide a concise summary containing:

- repositories and evidence sources analyzed;
- created issues or work items with title and URL or ID;
- retained suggestions that were kept without creation;
- suggestions skipped for later;
- counts for discarded, withdrawn, moved/deferred, and unreviewed suggestions;
- access, duplicate-check, label/tag, or creation limitations and failures.

Do not repeat discarded suggestions. Do not list unreviewed suggestions that were
never presented. In suggestion-only mode, include the full retained suggestions in
a compact, reusable form.
