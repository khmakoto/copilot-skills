PR [PR-NUMBER] has been [updated/merged]. It was part of a PR DAG, so please update it accordingly. If you don't have information about the DAG construction, get it from the PR itself.

Keep the already landed PRs as part of the diagrams even if they're not in the internal DAG model anymore.

Use YOLO mode for the `pr-graph` skill for this task and invocation. Apply its
complete YOLO contract: the agent reviews and approves every pr-graph human
gate needed for the requested work, without repeated human approval prompts.
This includes in-scope merging, deletion, recovery, new setup and fixes,
exclusion release and history transfer; it does not add goals or authorize
unrelated cleanup. State task bounds and irreversible/disclosure risks before
the first mutation. Establish exact source, destination, access and retained-data
bounds before disclosure. Review and save exact plans and apply them with
`--yes --approve <digest>`.

Preserve prerequisite evidence, plans, digests, freshness, validation, hooks,
provider policies, user work and all correctness/uncertainty blockers. Missing
or ambiguous intent or destinations and unresolved remote effects still block
the operation. Authorization does not persist beyond this task/invocation,
approve other skills' actions or override tool/environment permissions.

Preserve publication exclusions across lineage and retained history. A blocked
outbound scope is not permission to release an exclusion, disable backup, or
rewrite approved content. Under YOLO, the agent may approve a separate exact
release only when the requested disclosure is fully bounded and no keep-local
constraint forbids it; never bypass the helper's exclusion checks.
