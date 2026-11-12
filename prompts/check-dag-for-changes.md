Check whether the changes in this session already exist in the DAG that this
branch belongs to. For committed follow-up edits that do not, allocate them to
the semantically correct active, unlanded nodes automatically when ownership is
unambiguous. Report what already exists, what moved, and any unresolved allocation.

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

Use the skill's absorb workflow on an explicitly selected pinned committed delta.
Do not stage or commit dirty work implicitly. Determine per-hunk owners using
retained own patches and dependency context. Inspect
cross-node, binary, new/shared-file and inactive-owner provenance explicitly;
leave ambiguous ownership unassigned for a user decision. Never assign to an
inactive owner. Review and save the complete exact plan, including amended
ownership, preserved identities, descendant reconstruction, validations and
expected full tree. Apply unambiguous allocations under the skill's YOLO
contract, without another approval prompt.
