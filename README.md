# Copilot Skills and Prompts

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

### `pr-reviewer`

Reviews a GitHub or Azure DevOps pull request with a specialist code-review
agent, retaining only concrete defects, regressions, vulnerabilities,
compatibility problems, and meaningful test gaps.

The review covers every changed hunk and applies cross-cutting checks for state and
lifecycle behavior, test validity, and behavioral branch coverage. It also runs
focused checks when relevant for UI interactions, wrappers and adapters, design
systems, reactive state, service contracts, and package boundaries.

Findings are presented one at a time. Review comments can include directly
applicable suggestion blocks, but nothing is posted until the user edits and
confirms the exact text.

```text
/pr-reviewer <pull-request-url>
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

## Prompts

The `prompts/` directory contains reusable prompt templates for workflows that do
not need a full skill:

- `commit-and-push.md` commits and pushes the current changes, then replies to and
  resolves any pull request comments addressed by those changes.
- `resolve-active-comments.md` walks through active pull request feedback one item
  at a time and applies only the fixes the user keeps, without committing or
  pushing.
- `update-pr-stack.md` refreshes the base branch, checks a pull request stack for
  stale local branches, and updates the stack after one pull request changes.

Replace placeholders such as `[PR-LINK]`, `[PR-NUMBER]`, and `[PR-STACK]` before
using a template.

## Installation

Install a skill by copying or linking its directory into your global Copilot
skills directory. Keep the full directory contents together so that `SKILL.md`
can access any files under `references/`.

Each directory under `skills/` is self-contained and uses the standard `SKILL.md`
format. Prompt templates under `prompts/` can be copied, customized, and submitted
directly to Copilot CLI.
