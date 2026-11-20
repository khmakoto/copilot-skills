# Standalone graph validation

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

Execution is serial, using one newly owned detached worktree per selected node
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
No worker pooling, general result cache, content transformations, regression
search, automatic fixes or concurrency is included in this operation.
