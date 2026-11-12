Commit and push these changes. If there are any active comments that would be resolved by them, then resolve them. If you resolve any comments, leave a reply. The reply should be humanlike and not sound like AI. Do not include any specific commits in the reply.

Then, since the branch/pr will be updated, update the dag accordingly. Keep the already landed PRs as part of the diagrams even if they're not in the internal DAG model anymore.

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
approve other skills' actions (including review-thread replies or resolution)
or override tool/environment permissions.

Allocate follow-up edits using the skill's absorb workflow on an explicitly
selected pinned committed delta. Do not stage or commit dirty work implicitly
as part of absorb. Determine per-hunk owners using retained own patches and
dependency context. Inspect
cross-node, binary, new/shared-file and inactive-owner provenance explicitly;
leave ambiguous ownership unassigned for a user decision. Never assign to an
inactive owner. Review and save the complete exact plan, including amended
ownership, preserved identities, descendant reconstruction, validations and
expected full tree. Apply unambiguous allocations under the skill's YOLO
contract, without another approval prompt.
