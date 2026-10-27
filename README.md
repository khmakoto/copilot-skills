# Copilot Skills and Prompts

[![skills.sh](https://skills.sh/b/khmakoto/copilot-skills)](https://skills.sh/khmakoto/copilot-skills)

A collection of portable skills and prompt templates for extending GitHub Copilot
CLI with focused, repeatable software-engineering workflows across repositories.
Skills package instructions, guardrails, and supporting references for consistent
execution. Prompts provide ready-to-adapt starting points for branch and pull
request maintenance.

The skills favor:

- evidence-backed analysis grounded in code, documentation, and project history;
- interactive triage that presents one actionable item at a time;
- explicit confirmation before creating issues or posting comments;
- provider-native workflows for GitHub and Azure DevOps; and
- reusable guidance that remains independent of any single codebase.

## Skills

All skills can be invoked explicitly. `brainstorm`, `pr-walkthrough`, and
`pr-graph` may also be selected automatically when a request matches their
descriptions. The other skills require explicit invocation.

| Skill                                                 | Purpose                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`brainstorm`](docs/skills.md#brainstorm)             | Rank repository improvements and triage them one at a time, with optional confirmed issue creation.                                           |
| [`ci-triage`](docs/skills.md#ci-triage)               | Diagnose failing checks, builds, or tests from revision-pinned evidence; fixes, reproduction, and remote reruns require approval.             |
| [`design-interview`](docs/skills.md#design-interview) | Interview the user about a selected improvement and agree on a design with observable acceptance criteria before implementation.              |
| [`pr-description`](docs/skills.md#pr-description)     | Draft or refresh PR descriptions from current changes and validation evidence, preserving managed metadata and requiring approval to publish. |
| [`pr-feedback`](docs/skills.md#pr-feedback)           | Validate PR feedback and implement individually approved fixes; remote actions need separate approval.                                        |
| [`pr-reviewer`](docs/skills.md#pr-reviewer)           | Review PRs or local branches for actionable defects, with individually confirmed remote comments.                                             |
| [`pr-walkthrough`](docs/skills.md#pr-walkthrough)     | Build a read-only, dependency-ordered route for human review.                                                                                 |
| [`pr-graph`](docs/skills.md#pr-graph)                 | Manage a PR dependency DAG across local Git, GitHub/GHES, and Azure DevOps, with draft-first publication and explicit approval boundaries.    |
| [`session-distill`](docs/skills.md#session-distill)   | Turn session lessons into evidence-backed improvement proposals without automatically saving changes.                                         |
| [`skill-doctor`](docs/skills.md#skill-doctor)         | Audit skill definitions and apply only specifically approved repairs.                                                                         |

See the [skill guide](docs/skills.md) for invocation examples, detailed behavior,
requirements, and safety boundaries.

## Prompts

The `prompts/` directory contains reusable templates for branch and pull request
maintenance:

- [`update-pr-stack.md`](prompts/update-pr-stack.md) refreshes the base branch,
  checks a pull request stack for stale local branches, and updates the stack
  after one pull request changes. Replace `[PR-NUMBER]`, `[updated/merged]`, and
  `[PR-STACK]` before using it.
- [`update-pr-graph.md`](prompts/update-pr-graph.md) updates a PR DAG after a pull
  request changes or merges, using `pr-graph` auto mode and the PR itself to
  recover DAG context when needed.
  Diagrams retain already-landed PRs even after they leave the internal DAG model.
  Replace `[PR-NUMBER]` and `[updated/merged]` before using it.
- [`check-dag-for-changes.md`](prompts/check-dag-for-changes.md) checks whether
  session changes already exist elsewhere in the current branch's DAG and whether
  any new changes belong in another node.
- [`commit-and-push.md`](prompts/commit-and-push.md) commits and pushes changes,
  resolves active review comments addressed by those changes, and replies to any
  resolved threads without referencing specific commits, then updates the DAG
  for the changed branch/PR using `pr-graph` auto mode. Diagrams retain
  already-landed PRs even after they leave the internal DAG model.

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
