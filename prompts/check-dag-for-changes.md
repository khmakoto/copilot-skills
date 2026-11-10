Check whether the changes in this session already exist in the DAG that this
branch belongs to. For committed follow-up edits that do not, allocate them to
the semantically correct active, unlanded nodes automatically when ownership is
unambiguous. Report what already exists, what moved, and any unresolved allocation.

Use auto mode for the `pr-graph` skill for this invocation. Apply its full
routine and conditional auto-approval policy to the requested work; do not add
prompt-specific approval gates. This includes permitted freshness, lifecycle,
diagram, recovery, approved-resolution reuse, and backup operations when their
conditions are met. Review and save exact plans and apply them with
`--yes --approve <digest>` without asking again for authorized effects.
Preserve the skill's task-scope limits, prerequisite evidence, separate-request
and history-transfer opt-in requirements, and remaining human-approval gates.

Use the skill's absorb workflow on an explicitly selected pinned committed delta.
Do not stage or commit dirty work implicitly. Determine per-hunk owners using
retained own patches and dependency context. Inspect
cross-node, binary, new/shared-file and inactive-owner provenance explicitly;
leave ambiguous ownership unassigned for a user decision. Never assign to an
inactive owner. Review and save the complete exact plan, including amended
ownership, preserved identities, descendant reconstruction, validations and
expected full tree. Apply unambiguous allocations under the skill's conditional
auto policy, without another approval prompt.
