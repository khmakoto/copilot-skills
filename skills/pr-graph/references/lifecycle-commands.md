# Lifecycle commands

Read the [command reference](commands.md) for shared invocation, freshness,
and plan/approve/apply requirements before using these commands.

## Lifecycle actions

```text
node "<helper>" plan publish --repo "<repo>" --graph feature --out "<plan>"
node "<helper>" plan sync --repo "<repo>" --graph feature --out "<plan>"
node "<helper>" plan retarget --repo "<repo>" --graph feature --spec "<target.json>" --out "<plan>"
node "<helper>" plan ready --repo "<repo>" --graph feature --node model --out "<plan>"
node "<helper>" plan merge --repo "<repo>" --graph feature --node model --strategy squash --out "<plan>"
node "<helper>" plan describe --repo "<repo>" --graph feature --node model --body-file "<body>" --out "<plan>"
node "<helper>" plan record-landing --repo "<repo>" --graph feature --node model --landing "<commit>" --strategy squash --out "<plan>"
```

Apply each separately approved plan. `publish` creates all missing drafts;
`sync` only publishes already-published nodes. In local-provider mode, publish
pushes branches but creates no pretend PRs. Sync never promotes a draft.

`retarget` migrates a fully realized, unlanded graph to another integration
branch. Its spec contains only `{"id":"feature","target":"main"}`. The new
snapshot must contain the old integration snapshot. It preserves IDs, edges,
own changes and PR identities, reconstructs every active branch and prerequisite
base, verifies the combined tree, reruns configured validation, then publishes
already-hosted nodes using the normal leased sync workflow. Rewritten non-draft
PRs return to draft before pushes; it never promotes or merges. Old integration
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

`describe` replaces only the selected node's body with approved text plus the
managed footer. Routine operations preserve existing human bodies.
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
