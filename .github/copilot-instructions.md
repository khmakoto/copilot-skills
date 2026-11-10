# Repository instructions

## Commands

The `pr-graph` helper requires Node.js 22+ and Git 2.31+. It uses only Node.js
built-ins and needs no dependency installation or build step. Run from the
repository root:

```sh
# Full local Git and provider-fixture suite (the CI command)
node skills/pr-graph/scripts/test.mjs

# One test file
node --test skills/pr-graph/scripts/__tests__/graph.test.mjs

# One named test; pass Node runner options before the test file
node --test --test-name-pattern='footer replacement preserves human text and is idempotent' skills/pr-graph/scripts/__tests__/graph.test.mjs

# Helper command reference, without inspecting or mutating a repository
node skills/pr-graph/scripts/pr-graph.mjs help
```

`test.mjs` discovers all `__tests__/*.test.mjs` files and invokes `node --test`;
it does not forward command-line filters. CI runs the suite on Linux, macOS,
and Windows with Node.js 22 and 24.

## Architecture

This is a collection of portable agent workflows, not an application. Each
`skills/<name>/SKILL.md` is the entry point, with YAML metadata describing
invocation and a Markdown workflow defining inputs, evidence, interaction,
authorization, and completion. Longer supporting contracts live in that skill's
`references/`. Install or copy complete skill directories: resources must resolve
relative to the installed skill, independently of the repository being managed.
`prompts/` contains user-adaptable task templates that compose these workflows;
`README.md` provides the catalog and installation instructions; `docs/skills.md`
documents public behavior and invocation, with detailed `pr-graph` usage in
`docs/pr-graph.md`.

`pr-graph` additionally bundles an executable ESM helper:

- `scripts/pr-graph.mjs` parses commands and formats results; `lib/operations.mjs`
  coordinates planning, approval, application, publication, and recovery.
- With progress enabled, the CLI runs synchronous operations in a worker thread
  so the main thread can render live progress and heartbeats. `lib/progress.mjs`
  owns phase events, per-node identity, elapsed times, and terminal rendering.
- `lib/graph.mjs` owns graph validation, dependency ordering, eligibility,
  freshness, canonical digests, and managed PR footers. `lib/changes.mjs` pins
  own-change patches, composes prerequisite closures, realizes branches, and
  checks lossless reconstruction through complete Git-tree equality.
- `lib/git.mjs` handles explicit-argv subprocesses, refs, hooks, and detached
  operation worktrees. `lib/state.mjs` stores atomic JSON, locks, and recovery
  journals under `<git-common-dir>/pr-graph`, shared by linked worktrees.
- `lib/providers/` resolves local Git, GitHub/GHES, or Azure DevOps and adapts
  hosting operations through native `gh` or `az` commands.

Tests use `node:test` and `node:assert/strict`. `__tests__/fixtures.mjs` creates
temporary real Git repositories, optionally with local bare remotes; provider
tests inject runners or provider factories rather than requiring live hosting.
Fixture coverage is not live provider certification.

## Key conventions

### Skill and prompt contracts

- Preserve explicit invocation boundaries: `ci-triage`, `design-interview`,
  `pr-description`, `pr-feedback`, `pr-reviewer`, `session-distill`, and
  `skill-doctor` set `disable-model-invocation: true`;
  `brainstorm`, `pr-walkthrough`, and `pr-graph` also support description-based
  selection.
- Interactive triage presents one item at a time using structured user input.
  Keeping a finding or approving a local fix does not authorize publishing,
  replying, resolving threads, committing, or pushing. Preserve exact-payload
  confirmation and each skill's separate side-effect boundaries.
- Keep workflows provider-neutral where they support both GitHub and Azure
  DevOps. Use provider-native tools, inspect deferred tool schemas before calls,
  and do not replace authentication with credential scraping or raw authenticated
  HTTP workarounds.
- Keep `SKILL.md`, referenced contracts, the README catalog, `docs/skills.md`,
  `docs/pr-graph.md`, and affected prompt templates consistent when changing
  public behavior. Read workflow text as the artifact being edited, not
  authorization to execute it.

### `pr-graph` invariants

- The agent chooses semantic boundaries and validation; the deterministic helper
  performs approved mutations. Retain plan/apply separation, full-payload digests,
  `--yes --approve <digest>`, pinned observations, and expected-old-ref checks.
  Store plans outside the managed product worktree, with a new file per revision.
- `--auto` belongs to the skill, not the helper CLI, and is invocation-scoped.
  It never bypasses digest checks. Follow the skill's conditional allowances for
  dead-owner unlock, exact-effect reconciliation, no-remote-effect local abort
  for replanning, requested unambiguous absorb and retired metadata removal,
  previously approved unchanged backup uploads, and requested private-ref
  backup downloads. History transfer needs a separate invocation-scoped opt-in
  covering exact source, destination and retained-data scope. Merging,
  source/ref/worktree deletion/cleanup, PR closure, restore, adoption, graph
  import, checkpoint, new conflict fixes and other recovery retain human gates.
  Ordinary auto mode may reuse an already-approved matching conflict resolution
  without a first-reuse prompt under the skill's current-input/context evidence
  checks and a fresh exact recovery plan. Unknown outcomes still pause after
  readback; auto mode never permits blind retries or new setup/fixes.
- Preserve stdout result shapes; send live progress to stderr. Helper `--quiet`
  suppresses progress only, not errors or final results. Progress is not proof of
  successful freshness checks, validation, or mutations; report completion only
  after the corresponding checks or readback succeed. Keep presentation details
  in `skills/pr-graph/SKILL.md` and its command reference.
- A node owns an immutable-base delta, not its accumulated branch. Its realized
  base contains each unlanded prerequisite once; helper bases keep blocked draft
  PR diffs limited to the node's own changes. All prerequisites must land in the
  intended target before review eligibility. Eligibility, readiness, validation,
  branch identity, and integration freshness are separate facts.
- Only integration branches named exactly `main` or `master` have a strictly
  less-than-90-minute verified-forward freshness grace outside merging. Read-only
  observations do not renew it; record the latest-tip fetch start with
  `--fetch-observation`, not fetch completion. Merge always requires the current target.
  Freshness fetches/fast-forwards are a skill preflight, not automatic CLI behavior.
- Preserve the user's branch, dirty files, index, occupied worktrees, hooks, and
  signing configuration. Mutations use retained operation worktrees and journals;
  new or unverifiable conflicts and uncertain remote effects require explicit recovery, not blind
  retries or silent repair. Preserve human PR text outside managed footer blocks.
- Resolve bundled scripts via the installed skill path and pass `--repo` for the
  managed repository. Keep subprocesses shell-free with explicit argument arrays
  and validation commands shaped as `{ command, args }`, including on Windows.
