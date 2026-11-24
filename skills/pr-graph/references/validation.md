# Standalone graph validation

## Explicit publish-first, validate-last plans

Validation-first remains the default. Only a direct request to run automated
validation last permits adding `--defer-validation` to a new allocation, sync or
publish plan. The flag is accepted for `init`, `split`, `add`, `deps`,
`split-node`, `fold`, `remove`, `absorb`, `sync` and `publish`; it is not a graph
setting, persistent preference, apply/continue override or readiness/merge option.
Auto/YOLO approval alone does not request deferral. Review each exact plan under
the invocation's normal approval contract; changing the flag or commands changes
the full-payload digest.

```text
node "<helper>" plan publish --repo "<repo>" --graph feature --defer-validation --out "<publish-plan.json>"
node "<helper>" apply --repo "<repo>" --plan "<publish-plan.json>" --yes --approve "<publish-digest>"
node "<helper>" plan validate --repo "<repo>" --graph feature --select "dependents:model" --out "<validation-plan.json>"
node "<helper>" apply --repo "<repo>" --plan "<validation-plan.json>" --yes --approve "<validation-digest>"
```

Deferral retains every executable/argv check and explicit no-check reason; missing
configuration still blocks. Full-tree composition, ownership verification,
hooks, worktree safety, pinned observations, leases, freshness and provider checks
run normally. Every active unlanded node loses its validation and readiness
receipts, even with selective publication; unselected refs and PRs remain untouched.
The plan exposes `deferValidation: true`; resulting nodes carry
`validationPending` with exact head, command digest and originating operation.
Results (`freshness.<id>.validation`), views and managed footers say
**validation pending**, not successful validation or review readiness. Eligible
existing hosted PRs may remain non-draft under the normal preservation contract;
that status does not restore the cleared local readiness receipt.

After the requested allocation/sync/publication steps, prepare a separately
approved `plan validate` from the resulting graph. Review its exact heads and
configured checks; choose a selector covering the pending nodes (use `node:<id>`
or `dependents:<id>` as needed for already-published blocked nodes, not only
`unpublished` or `eligible`). Changed pinned heads require a new plan, not
validation of replacement content under the old approval. The ordinary safe
failure-collection and interruption rules below apply. Successful nodes clear
`validationPending`; unsuccessful nodes retain a failed marker and no validation
receipt. Checks never grant readiness: explicitly ready only after successful
exact-head validation and independent dependency/freshness/provider checks.
Validation-only operations never update PRs; refresh hosted footers
and diagrams through separately approved description/publication operations
(or an explicitly requested ready operation) before claiming current hosted evidence.
Deferral does not authorize merging, extend main/master grace or
defer any mandatory safety check.

## Validation-only invocation

`plan validate` runs existing configured checks without reconstruction or
publication. Running repository code is not read-only inspection: review and
approve the exact saved plan, including commands and their effects, before apply.

```text
node "<helper>" select --repo "<repo>" --graph feature --select "dependents:model"
node "<helper>" plan validate --repo "<repo>" --graph feature --select "dependents:model" --out "<new-plan.json>"
node "<helper>" apply --repo "<repo>" --plan "<new-plan.json>" --yes --approve "<digest>"
```

`<helper>` is the installed skill's `scripts/pr-graph.mjs`. Keep plans outside
the product worktree. There is no unapproved `validate` execution command.
Interactive mode requires human approval. Ordinary auto mode can approve an
in-scope validation plan; YOLO uses its normal task-bound authorization. Neither
mode permits fixes, setup, sync or publication merely because validation fails.

## Pinned scope and execution

Use the [fixed selectors](commands.md#graph-relative-node-selection): `node:<id>`,
`dependents:<id>` (root included), `eligible`, or `unpublished`. Landed and retired
nodes are excluded; shared descendants run once in dependency-first order.
An empty selection is an error. Other prerequisites are not implicitly selected
or reconstructed. Do not combine `--select` with `--nodes`, `--node` or `--spec`.
Configure or change checks through separately approved existing spec workflows,
not an override on this operation. Restored/imported historical commands or
receipts are not current execution authority.

The plan pins exact IDs in `validationSelection`, existing realized heads and
explicit `{ command, args }` commands/reasons in `validationInputs`, the complete
graph digest, live graph-wide local/remote ref and PR observations, publication
policy, and freshness evidence. Apply rechecks these before and after commands
and before persisting evidence. Changed heads, configurations, refs, PRs, policy
or availability require a new plan. No automatic fetch, integration observation
renewal, target movement, reconciliation, setup or dependency installation occurs.
Current snapshots and the existing strictly-less-than-three-hour verified-forward
main/master grace are accepted. Expiring grace stops execution; it is not extended.

By default execution is serial, using one newly owned detached worktree per selected node
with executable checks. Each starts at that node's exact realized head, including
its already-realized prerequisites. Commands execute in order with explicit argv,
without a shell. Existing successful graph validation is **always rerun**; it is
not a cache hit. An explicit no-check reason executes nothing. Missing local
objects/configuration or stale branch/integration inputs are reported as
`unavailable` or `stale`, not as passing checks or permission to repair them.

Clean nonzero exits and missing executables are aggregated without abandoning
other selected checks. Tracked, staged or untracked output marks that node
`dirty`, retains the worktree and skips its remaining checks. Other nodes run
in different worktrees, so generated/ignored files cannot leak between nodes.
As with existing checks, ignored build output can remain in the node's own
worktree. Worktree/HEAD identity changes, unverifiable state, signaled processes,
and ambiguous spawn/recording outcomes stop the operation. Repository commands
are **not sandboxed**: arbitrary checks can access shared refs, configuration,
network and files outside their working directory. Approval must review these
effects; isolation is checkout separation, not a security guarantee.

## Explicit managed validation environments

For incremental builds, add `--validation-environment "<policy.json>"` only to
`plan validate`. This is a separately reviewed part of the exact approval payload,
not persisted graph configuration or permission to install/replay setup. Example:

```json
{
  "mode": "warm",
  "identity": "project-toolchain-and-cache-contract-v1",
  "maxWorkers": 2,
  "maxCacheBytes": 1073741824,
  "inputPaths": ["package-lock.json", "build.config.json"],
  "caches": [".build", ".dependency-cache"],
  "reuse": []
}
```

Use only ignored, untracked, relative directories containing regular files;
no traversal, `.git`, symlinks, overlapping directories or tracked input overlap.
Identify the complete relevant dependency/configuration input closure in
`inputPaths` and the supported build-cache semantics in `identity`. Approval must
establish that the build tool invalidates artifacts when source inputs change;
this is not a general purity detector or cached test-success mechanism. Unknown
cache semantics require default fresh worktrees or `clean` mode, not guessed reuse.
Commands in managed mode must name absolute installed executable paths. The
helper fingerprints their bytes, exact commands, the declared tracked input
trees (including root `.gitignore`; include relevant nested ignore/config files),
environment, Git configuration, hooks and local/global
ignore files. It stores only opaque fingerprints of environment/configuration.
Changing these inputs prevents reuse; changes after approval block apply.
Missing executables do not authorize setup. Cache presence is not an approved
setup receipt and never causes the helper to replay setup or install dependencies.

Execution remains **serial (concurrency 1)**. A run owns at most `maxWorkers`
(1..4) retained workers, with at most `maxCacheBytes` of allowed cache files per
worker. These are cache-byte limits checked at observed boundaries, not OS quotas
or command memory/time limits. Dependency-first ordering keeps nearby pinned
revisions together; the most recently allocated compatible healthy worker is
preferred. Different command/configuration keys need separate workers. When the
budget is exhausted, remaining nodes are `unavailable`, with no checks or implicit
cleanup/new workers. Dirty output, unknown ignored files, oversized caches and
failed checks quarantine their worker; another approved slot isolates later nodes.
Every configured check still runs, including when the checkout/head or build
artifacts are reused. The helper never reuses another operation's test results.

To retain a warm worker across runs, explicitly select its latest local owner:
`"reuse": [{ "operation": "<completed-operation-digest>", "worker": 0 }]`.
The plan pins the source journal, detached worktree identity/head and cache file
content manifest. Only compatible, healthy workers from completed or safely
aborted local validation operations may transfer. Each transfer records ownership
in both journals before checkout or execution. The former owner cannot reuse or
clean the transferred worker. Changed bytes, dirty output, uncertain commands,
failed checkout hooks or ownership drift block reuse. No automatic cache clearing,
eviction, source-worktree pooling or user-output deletion occurs.

`"mode": "clean"` requires an empty `reuse` list. It starts every node in a fresh
worker with no inherited artifacts; only declared cache directories may hold new
ignored build output. Declare enough worker slots or select a smaller scope.
Fresh output is retained for diagnosis, never reused in clean mode.
The default mode still preserves the original
per-node behavior, including retained ignored diagnostic/build output.

Managed per-node `environment` evidence distinguishes `worktreeReused`,
`artifactsReused`, `setupReplayed: false` and `resultsReused: false`, and records
`checkoutMs`, `cacheBytes` and `cacheFiles`. Check timestamps/output retain command
timings and tool-reported setup/build/check metrics. `validation.workers` (also
`validationWorkers` in status operations) reports final worker heads, content snapshots,
quarantine and transfer ownership; historical per-node heads need not equal a
shared worker's final head. Compare cold/warm command process counts and actual
cache bytes alongside timings; a cache hit alone is not a demonstrated speedup.

## Results and current evidence

The JSON result contains `validation.success` and per-node `validation.results`.
Nodes report `passed`, `failed`, `dirty`, `no-check`, `unavailable` or `stale`.
Each attempted check retains exact argv, timestamps, exit code, stdout/stderr,
errors, dirty status and its worktree path. Checks skipped after dirty output
are `skipped` with `source: "not-executed"`. Newly attempted checks use
`source: "executed"`; replaying a completed apply/continue or resuming past a
durably completed check uses `source: "retained-operation"`, not a new test run.
No-check nodes retain their reason and `source: "explicit-reason"`.

Only a fully observed run with unchanged graph/configuration, heads, refs, PRs,
policy, available objects and acceptable integration freshness can update local
current validation evidence. All checks for a node must pass with a clean
tracked/untracked worktree and unchanged identity, or an explicit no-check reason
must apply. Unsuccessful selected nodes lose their previous current validation
receipt; unselected nodes are unchanged. Readiness intent is preserved, not
promoted, and readiness/merge still require their independent live checks.
Receipts identify this operation and whether checks ran or a reason was recorded.
The graph revision/history changes, but source heads, owned deltas, dependencies,
integration snapshots, product/helper refs, backups and PRs do not.

The CLI exits zero only when all selected nodes pass or have explicit no-check
reasons. Aggregate failures return the full JSON report on stdout, a summary
error on stderr and exit nonzero, including with `--quiet`. Unsafe interruptions
return an error and retained operation ID; inspect `status --graph <id>` for
partial `validationResults`, `pendingValidation`, `pendingValidationWorktree`
and `worktrees`. Progress is
not proof that the complete validation succeeded.

## Recovery and retention

Reapplying a completed plan returns its receipts without rerunning commands.
Prepare a **new plan** to intentionally rerun checks; each plan has a distinct
run identity. A safely interrupted operation can continue under its original
approval only while inputs and worktree evidence still match. An interrupted
in-flight command has an uncertain outcome and cannot be blindly resumed:
inspect diagnostics and explicitly abort, then obtain a new plan to rerun.
Interrupted worktree creation or a failed checkout hook also requires explicit
abort; an existing clean checkout is not proof that its hooks succeeded.
There are no reconstruction/remote effects to `resolve` or `reconcile` here.

`plan abort --operation <digest>` only stops the validation journal and retains
refs, graph state, worktrees and output. It does not roll back arbitrary command
effects. Cleanup requires a completed or aborted operation, a separate exact
`plan cleanup --operation <digest> --spec <json>` with only
`{ "branches": [], "worktree": true }`, and unchanged clean owned worktrees.
It removes only those validation worktrees, never forces dirty/ignored-output deletion
or removes product refs/PRs. Dirty output requires explicit user handling first.
Managed workers are deduplicated during cleanup and must be cleaned by their
latest owner. Approved artifacts remain ignored output: cleanup never forces their
deletion. Explicit user handling may remove output first, followed by a fresh
cleanup plan. No general result cache, content transformations, regression search,
automatic fixes or parallel command execution is included.
