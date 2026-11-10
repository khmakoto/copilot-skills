# Copilot skills and prompts

[![skills.sh](https://skills.sh/b/khmakoto/copilot-skills)](https://skills.sh/khmakoto/copilot-skills)

Skills and prompt templates for GitHub Copilot CLI. Each skill contains workflow
instructions, approval rules, and supporting references. The prompts cover branch
and pull request maintenance.

The skills favor:

- Using code, documentation, and project history as evidence.
- Interactive triage presenting one item at a time.
- Creating issues or posting comments requires confirmation of the exact content.
- GitHub and Azure DevOps workflows using each provider's tools.

You can install the skills once and use them across repositories.

## Skills

Invoke any skill by name. Copilot can also select `brainstorm`, `pr-walkthrough`,
or `pr-graph` when a request matches its description. The other skills require
explicit invocation.

| Skill                                                 | Purpose                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`brainstorm`](docs/skills.md#brainstorm)             | Rank repository improvements and triage them one at a time. Create issues only after confirmation.                                        |
| [`ci-triage`](docs/skills.md#ci-triage)               | Diagnose failing checks, builds, or tests at a recorded revision. Reproduction, fixes, and remote reruns require approval.                |
| [`design-interview`](docs/skills.md#design-interview) | Interview the user about a selected improvement and agree on a design with observable acceptance criteria before implementation.          |
| [`pr-description`](docs/skills.md#pr-description)     | Draft or refresh PR descriptions from current changes and validation evidence. Preserve managed metadata and require approval to publish. |
| [`pr-feedback`](docs/skills.md#pr-feedback)           | Validate PR feedback and implement each approved fix. Remote actions need separate approval.                                              |
| [`pr-reviewer`](docs/skills.md#pr-reviewer)           | Review PRs or local branches for defects. Confirm each remote comment before posting.                                                     |
| [`pr-walkthrough`](docs/skills.md#pr-walkthrough)     | Build a read-only, dependency-ordered route for human review.                                                                             |
| [`pr-graph`](docs/skills.md#pr-graph)                 | Manage a PR dependency graph across Git providers, with approved follow-up allocation and portable historical evidence.                  |
| [`session-distill`](docs/skills.md#session-distill)   | Use session evidence to propose workflow improvements without saving changes automatically.                                               |
| [`skill-doctor`](docs/skills.md#skill-doctor)         | Audit skill definitions and apply only approved repairs.                                                                                  |
| [`unslop`](docs/skills.md#unslop)                     | Edit writing with Cursor's upstream unslop rules. Fetch the rules on each explicit invocation.                                            |

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
  request changes or merges. It uses `pr-graph` auto mode and recovers DAG context
  from the PR when needed.
  Diagrams retain already-landed PRs even after they leave the internal DAG model.
  Replace `[PR-NUMBER]` and `[updated/merged]` before using it.
- [`check-dag-for-changes.md`](prompts/check-dag-for-changes.md) checks whether
  session changes already exist elsewhere in the current branch's DAG and whether
  any new changes belong in another node.
- [`commit-and-push.md`](prompts/commit-and-push.md) commits and pushes changes,
  resolves active review comments that those changes address, and replies to
  resolved threads without referencing specific commits. It then updates the DAG
  for the changed branch or PR using `pr-graph` auto mode. Diagrams retain landed
  PRs even after they leave the internal DAG model.

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

Copy a complete skill directory into one of Copilot CLI's supported locations:

- personal skills: `~/.copilot/skills/` or `~/.agents/skills/`;
- project skills: `.github/skills/`, `.agents/skills/`, or `.claude/skills/`.

Keep the full directory contents together so that `SKILL.md` can access files
under `references/`. If Copilot CLI is already running, use `/skills reload`
after adding or updating a skill manually.

Each directory under `skills/` is self-contained and uses the `SKILL.md` format.
Copy and adapt templates from `prompts/`, then submit them to Copilot CLI.
