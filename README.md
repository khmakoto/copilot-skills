# Copilot Skills

A collection of reusable skills for extending GitHub Copilot CLI with focused,
repeatable software-engineering workflows.

## Objective

This repository turns common engineering activities into portable skills that
can be installed globally and used across repositories. Each skill packages the
instructions, guardrails, and supporting references needed for Copilot to carry
out a workflow consistently instead of relying on a one-off prompt.

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

Findings are presented one at a time, and no review comment is posted until the
user edits and confirms the exact text.

```text
/pr-reviewer <pull-request-url>
```

## Installation

Install a skill by copying or linking its directory into your global Copilot
skills directory. Keep the full directory contents together so that `SKILL.md`
can access any files under `references/`.

Each top-level skill directory is self-contained and uses the standard
`SKILL.md` format.
