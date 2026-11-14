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

To explain changes across a sync or reshape operation, use the read-only
`operation-diff` command with the exact retained operation digest. Distinguish
authored edits, reconstruction movement, lineage, validation changes and
readiness changes. Separate intended effects, interrupted candidates, remote
attempts and matching verified publication. Report missing evidence.
Inspection does not renew freshness or authorize recovery, undo or remote
compensation.
