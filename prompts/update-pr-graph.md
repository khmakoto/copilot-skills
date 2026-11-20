PR [PR-NUMBER] has been [updated/merged]. Update its PR DAG to reflect this
change. If you do not know how the DAG was built, get that information from
the PR.

Keep landed PRs in the diagrams even if they are no longer in the internal
DAG model.

Use the `pr-graph` skill's YOLO mode for this task and invocation. Follow its
full YOLO contract. The agent reviews and approves every pr-graph action that
needs human approval for this task. Do not repeat approval prompts for those
actions.

This covers merging, deletion, recovery, new setup and fixes, exclusion release
and history transfer within the task. It does not add goals or authorize
unrelated cleanup. Before the first mutation, state the task's scope and any
risks of irreversible changes or disclosure. Before disclosing content, establish
the exact source, destination, access and retained-data scope.
Review and save exact plans, then apply them with
`--yes --approve <digest>`.

Preserve prerequisite evidence, plans, digests, freshness, validation, hooks,
provider policies and user work. Do not bypass correctness failures or unknown
outcomes. Stop if intent or destinations are missing or ambiguous, or if remote
effects remain unresolved. Authorization ends with this task and invocation.
It does not approve other skills' actions or override tool or environment
permissions.

Preserve publication exclusions across lineage and retained history. A blocked
outbound scope is not permission to release an exclusion, disable backup, or
rewrite approved content. Under YOLO, the agent may approve a separate exact
release only after establishing the requested disclosure's scope and checking
that no keep-local constraint forbids it. Never bypass the helper's exclusion
checks.

For checks that do not require reconstruction, use a separately approved
`plan validate --select <selector>`. Proactively prefer warm workers whenever
safe, supported reuse is possible. This prompt requests warm worker and artifact
reuse for necessary validation within this task. Review and approve the exact
`--validation-environment <json>` policy under the skill's YOLO contract.
Verify cache semantics and complete input identity, set worker and cache-byte
limits, and select compatible healthy workers from their latest owners.
Use fresh workers when reuse cannot be verified or when clean execution is
requested. Preserve rejected workers and their output; do not bypass pending
recovery or retry uncertain commands. Always rerun checks. Do not add checks or
extra validation runs just to warm a cache. Cache presence does not authorize
setup replay, installation, fixes or cleanup. This worker policy does not apply
to reconstruction validation.

To explain changes across a sync or reshape operation, use the read-only
`operation-diff` command with the exact retained operation digest. Distinguish
authored edits, reconstruction movement, lineage, validation changes and
readiness changes. Separate intended effects, interrupted candidates, remote
attempts and matching verified publication. Report missing evidence.
Inspection does not renew freshness or authorize recovery, undo or remote
compensation.
