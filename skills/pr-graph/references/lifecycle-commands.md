# Lifecycle commands

Read the [command reference](commands.md) for shared invocation, freshness,
and plan/approve/apply requirements before using these commands.

## Lifecycle actions

```text
node "<helper>" plan publish --repo "<repo>" --graph feature --out "<plan>"
node "<helper>" plan publish --repo "<repo>" --graph feature --nodes model,consumer --out "<plan>"
node "<helper>" plan publish --repo "<repo>" --graph feature --select "dependents:model" --out "<plan>"
node "<helper>" plan sync --repo "<repo>" --graph feature --out "<plan>"
node "<helper>" plan sync --repo "<repo>" --graph feature --local-only --out "<plan>"
node "<helper>" plan sync --repo "<repo>" --graph feature --spec "<checks.json>" --out "<plan>"
node "<helper>" plan retarget --repo "<repo>" --graph feature --spec "<target.json>" --out "<plan>"
node "<helper>" plan ready --repo "<repo>" --graph feature --node model --out "<plan>"
node "<helper>" plan merge --repo "<repo>" --graph feature --node model --strategy squash --out "<plan>"
node "<helper>" plan describe --repo "<repo>" --graph feature --node model --body-file "<body>" --out "<plan>"
node "<helper>" plan record-landing --repo "<repo>" --graph feature --node model --landing "<commit>" --strategy squash --out "<plan>"
```

Apply each separately approved plan. `publish` creates all missing drafts;
`sync` only publishes already-published nodes. In local-provider mode, publish
pushes branches but creates no pretend PRs. Sync never promotes a draft.
`publish --nodes <id,id>` limits local and remote ref updates, PR creation/updates,
and footer refreshes to that exact selection and its required helper bases.
Unselected and landed PRs remain unchanged. Every unlanded prerequisite must
either be selected or already published at its exact realized head and target.
Selective publication retains the existing integration snapshot; sync separately
if freshness or source reconstruction would change unselected nodes. The selection
is pinned in the approval and retained for continuation; it never implies readiness.
Publish and sync preserve eligible existing PRs' observed draft/non-draft state,
including manual transitions, even when reconstruction changes their head/base.
Blocked or superseded nodes must be draft. A status change after planning
invalidates approval; replan rather than overwriting it.

`publish --select <selector>` expands the
[fixed selection vocabulary](commands.md#graph-relative-node-selection) once at
planning time into `selection.nodes` and the existing exact `publishNodes` list.
The approval digest includes the selector, ordered resolved IDs, exclusions,
graph digest, complete ref/PR observations, and operation effects. Plans show
requested nodes separately from prerequisite IDs (including landed/selected
status), selected helper bases and source refs with their SHAs, whole-graph
validation nodes, metadata persistence, and any enabled whole-graph backup.
Only selected nodes and their helper bases are published; prerequisite
requirements are not permission to publish more nodes. Missing or out-of-date
unselected prerequisites cause an error rather than automatic expansion.
An untracked live PR on a selected node requires separate explicit adoption.

Selector publication requires the current integration snapshot; sync separately
if it is behind, even within main/master grace. Apply and continue use only the
approved exact IDs, never reevaluating the selector against moving state.
They recheck graph state, local/remote refs (including the integration target),
and live PR observations, including PRs newly discovered for previously
unpublished nodes. External changes require a fresh selection plan, not a larger
target set or a renewed approval. Reconciliation may recognize only approved
selected-node effects after an uncertain response; it cannot adopt unselected
PR/ref changes or target movement under the old selection.
Abort/compensate an interrupted operation under the existing recovery contract
before replanning when necessary. Explicit `--nodes` behavior is unchanged.
Selectors add no authorization for readiness, merging, deletion, backup, or recovery.

`sync --local-only` reconstructs on the approved fresh target, runs validation,
and persists local branches and graph state without pushing refs or making any
hosting writes, including draft changes, footers, and backup uploads. It retains
PR identities and backup configuration; remote publication remains pending.
The flag is pinned in the plan and survives continuation. It is accepted only
for sync and does not relax freshness, leases, hooks, validation, or worktree
ownership. Worktree reuse is supported as for ordinary sync.

For recovered nodes without validation configuration, `plan sync --spec <json>`
can approve checks without a separate shape operation. The spec contains only
the graph `id` and a nonempty `validations` map from active, unlanded node IDs
to nonempty executable-plus-argv arrays:

```json
{"id":"feature","validations":{"model":[{"command":"yarn","args":["test"]}]}}
```

Only named nodes' checks are replaced. Changed checks clear their validation and
readiness receipts; all checks are pinned in the plan digest and run normally.
This option cannot change dependencies, source ownership, or landed nodes,
and does not permit omitting validation through an empty check list.
It can be combined with `--local-only` to defer publication.

`retarget` migrates a fully realized, unlanded graph to another integration
branch. Its spec contains only `{"id":"feature","target":"main"}`. The new
snapshot must contain the old integration snapshot. It preserves IDs, edges,
own changes and PR identities, reconstructs every active branch and prerequisite
base, verifies the combined tree, reruns configured validation, then publishes
already-hosted nodes using the normal leased sync workflow. Eligible PRs retain
their observed draft/non-draft state; it never promotes or merges. Old integration
refs and source provenance remain untouched.

This full reconstruction pins the approved source snapshot even if the new
remote target advances during execution. Only fast-forward target movement is
accepted; source/helper refs remain exact guarded inputs, and target rewinds or
rewrites stop the operation. The recorded `targetSha` remains the authored
snapshot, not a claim that it equals the latest main. Ready uses the bounded
main/master grace when applicable; merge remains strictly current-target.
Graphs with landing receipts need a separate graph.

Shape changes preserve local snapshots; hosted changed content is not published
until a separate publish/sync. Superseded PRs are marked draft with an explicit
footer; cleanup controls closing and deletion separately.
Eligible existing PRs retain their observed draft/non-draft state through
reshaping; newly blocked PRs return to draft, including manually promoted PRs.

`describe` replaces only the selected node's body with approved text plus the
managed footer. Routine operations preserve existing human bodies.
Description-only actions do not create or claim a worktree; an existing partial
checkout from an interrupted older helper remains retained and untouched.
Description-only plans tolerate verified remote integration fast-forwards and
corresponding PR preview-base advances while preserving the authored merge base.
They do not reconstruct, rebase, push, retarget, or promote source changes.
Source/helper refs, PR heads, human text, target branches and draft states remain
exact guarded inputs; ready still requires current/grace freshness and merge
requires the current integration snapshot.
Reconciliation cannot adopt changed human bodies under an old description
payload; abort and replan those replacements explicitly.

To approve several exact description replacements in one operation, omit
`--node`/`--body-file` and provide `--spec` containing only the graph `id` and a
`descriptions` object mapping existing active node IDs to full approved bodies.
The helper validates all entries before applying, rechecks each current PR
immediately before replacing its body, preserves source refs and draft states,
and journals each successful update. This is still a separate `describe` plan,
not an implicit body rewrite during sync. Include the terminal diagram block.

For an ambiguous external local squash/rebase, `record-landing` requires an
explicit node-to-commit mapping. It verifies that the commit is in the intended
target and that replaying the node's own change onto that commit's first parent
reproduces its exact tree. It does not guess from commit messages or mark a
different change as landed. Use normal sync for unambiguous ancestry/provider
receipts.

If the server cannot atomically push multiple refs, publication fails unless
`--allow-non-atomic` was included in the approved plan. ADO plans disclose this
mode automatically because its adapter declares non-atomic push behavior.
Individual successes are journaled and read back; no remote transaction is
claimed.
