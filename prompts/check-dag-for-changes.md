Check whether the changes in this session already exist in the DAG that this
branch belongs to. Allocate committed follow-up edits that are missing to the
active, unlanded nodes that own them. Do this automatically only when ownership
is unambiguous. Report which changes already exist, which you allocated, and
which allocations remain unresolved.

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

Use the skill's absorb workflow. Explicitly select and pin the committed delta.
Do not stage or commit dirty work implicitly. Use retained own patches and
dependency context to determine each hunk's owner. Check provenance for
cross-node changes, binary changes, new or shared files, and inactive owners.
Leave ambiguous ownership unassigned for the user to decide. Never assign edits
to an inactive owner.

Review and save the complete exact plan. It must include amended ownership,
preserved identities, descendant reconstruction, validations and the expected
full tree. Apply unambiguous allocations under the skill's YOLO contract
without another approval prompt.
