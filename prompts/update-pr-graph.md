PR [PR-NUMBER] has been [updated/merged]. It was part of a PR DAG, so please update it accordingly. If you don't have information about the DAG construction, get it from the PR itself.

Keep the already landed PRs as part of the diagrams even if they're not in the internal DAG model anymore.

Use auto mode for the `pr-graph` skill for this invocation. Apply its full
routine and conditional auto-approval policy to the requested work; do not add
prompt-specific approval gates. This includes permitted freshness, lifecycle,
diagram, recovery, approved-resolution reuse, and backup operations when their
conditions are met. Review and save exact plans and apply them with
`--yes --approve <digest>` without asking again for authorized effects.
Preserve the skill's task-scope limits, prerequisite evidence, separate-request
and history-transfer opt-in requirements, and remaining human-approval gates.
Preserve publication exclusions across lineage and retained history. A blocked
outbound scope is not permission to release an exclusion, disable backup, or
rewrite approved content; policy relaxation still requires human approval.
