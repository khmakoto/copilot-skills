Commit and push these changes. Resolve any active comments that these changes
address. Reply to each comment you resolve. Write replies in natural language
and do not mention specific commits.

Then update the DAG to reflect the branch or PR changes. Keep landed PRs in the
diagrams even if they are no longer in the internal DAG model.

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
It does not approve other skills' actions, including review-thread replies or
resolution, or override tool or environment permissions.

Allocate follow-up edits with the skill's absorb workflow. Explicitly select
and pin the committed delta. Do not stage or commit dirty work as an implicit
part of absorb. Use retained own patches and dependency context to determine
each hunk's owner. Check provenance for cross-node changes, binary changes,
new or shared files, and inactive owners. Leave ambiguous ownership unassigned
for the user to decide. Never assign edits to an inactive owner.

Review and save the complete exact plan. It must include amended ownership,
preserved identities, descendant reconstruction, validations and the expected
full tree. Apply unambiguous allocations under the skill's YOLO contract
without another approval prompt.

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
