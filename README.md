# Copilot Skills and Prompts

[![skills.sh](https://skills.sh/b/khmakoto/copilot-skills)](https://skills.sh/khmakoto/copilot-skills)

A collection of reusable skills and prompt templates for extending GitHub Copilot
CLI with focused, repeatable software-engineering workflows.

## Objective

This repository turns common engineering activities into portable skills and
prompts that can be reused across repositories. Skills package the instructions,
guardrails, and supporting references needed for Copilot to carry out a workflow
consistently. Prompts provide ready-to-adapt starting points for common branch and
pull request maintenance tasks.

The skills favor:

- evidence-backed analysis grounded in code, documentation, and project history;
- interactive triage that presents one actionable item at a time;
- explicit confirmation before creating issues or posting comments;
- provider-native workflows for GitHub and Azure DevOps; and
- reusable guidance that remains independent of any single codebase.

## Skills

All skills can be invoked explicitly with the commands shown below. `brainstorm`
and `pr-walkthrough` may also be selected automatically when a request matches
their descriptions. The other skills require explicit invocation.

### `brainstorm`

Analyzes a local or remote repository and builds a ranked queue of potential
improvements across product, engineering, reliability, security, accessibility,
delivery, and design concerns.

The skill presents suggestions individually for refinement or triage and can
prepare a GitHub issue or Azure DevOps work item after the user confirms the
exact payload.

```text
/brainstorm [repository or path] [suggest-only] [count, focus areas, exclusions, or other constraints]
```

### `pr-feedback`

Validates incoming GitHub or Azure DevOps pull request feedback against the
current code, classifies each concern, and presents review threads one at a time
for interactive triage.

The skill can implement individually approved fixes and run focused validation,
while replies, thread resolution, commits, pushes, and other remote changes
require separate explicit approval.

```text
/pr-feedback <pull-request-url> [scope or constraints]
```

### `pr-reviewer`

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

### `pr-walkthrough`

Builds a read-only, dependency-ordered walkthrough for manually reviewing a
GitHub or Azure DevOps pull request or a branch in the current local repository.

The walkthrough explains what to review, in what order, and how the notable
changes connect so a human reviewer can form the right mental model efficiently.
Behavior-dense files are divided into focused review stops instead of being treated
as a single review unit.

```text
/pr-walkthrough <GitHub-or-Azure-DevOps-PR-URL | local-branch-name>
```

### `session-distill`

Extracts evidence-backed workflow lessons from the current session or explicitly
selected past sessions and turns them into bounded proposals for improving a
skill, repository instructions, or an explicitly stated user preference.

The skill presents proposals individually and does not save changes
automatically.

```text
/session-distill [selected session IDs] [focus] [proposals-only]
```

### `skill-doctor`

Audits personal skill definitions and supporting resources for concrete workflow
defects involving triggers, inputs, tools, authorization, evidence, failure
handling, interaction, and completion criteria.

Findings are presented individually, and repairs are applied only after approval
of the specific proposed change.

```text
/skill-doctor [skill names or paths] [audit-only] [focus or constraints]
```

## Prompts

The `prompts/` directory contains `update-pr-stack.md`, a reusable template that
refreshes the base branch, checks a pull request stack for stale local branches,
and updates the stack after one pull request changes.

Replace `[PR-NUMBER]`, `[updated/merged]`, and `[PR-STACK]` before using the
template.

## Installation

### Install with GitHub Copilot CLI

Clone this repository, then register its skill collection with Copilot CLI:

```text
copilot skill add ./skills
```

This keeps each skill together with its referenced resources. Use
`copilot skill list` to inspect the registered skills, and
`copilot skill enable <name>` or
`copilot skill disable <name>` to control availability.

### Install with skills.sh

Install skills from this repository with the `skills` CLI:

```text
npx skills add khmakoto/copilot-skills
```

The CLI discovers the available skills and lets you select which ones to install
for GitHub Copilot or another supported agent.

### Install manually

Alternatively, copy a complete skill directory into one of Copilot CLI's
supported locations:

- personal skills: `~/.copilot/skills/` or `~/.agents/skills/`;
- project skills: `.github/skills/`, `.agents/skills/`, or `.claude/skills/`.

Keep the full directory contents together so that `SKILL.md` can access files
under `references/`. If Copilot CLI is already running, use `/skills reload`
after adding or updating a skill manually.

Each directory under `skills/` is self-contained and uses the standard `SKILL.md`
format. Prompt templates under `prompts/` can be copied, customized, and submitted
directly to Copilot CLI.
