# Command reference

Run with Node.js 22+ and Git 2.31+. No dependency install is necessary.
`<helper>` below means the absolute installed `scripts/pr-graph.mjs` path.
Use quoted paths, particularly on Windows.

```text
node "<helper>" help
node "<helper>" analyze --repo "<repo>" --base "<integration-ref>" --head "<source>"
node "<helper>" status --repo "<repo>" --graph feature
node "<helper>" view --repo "<repo>" --graph feature
node "<helper>" check --repo "<repo>" --graph feature
```

Commands emit JSON except `help` and `view`. Failures emit a JSON error to stderr
and exit nonzero. Errors include the retained operation ID when applicable.
`doctor` is read-only; it does not repair state implicitly.

Before invoking any repository inspection or mutation command, complete the
skill's [branch freshness preflight](../SKILL.md#0-mandatory-branch-freshness-preflight).
Check local DAG branches, the actual target, and existing `main`/`master`
branches against freshly fetched tips, and obtain approval for required
fast-forwards. An integration target named exactly `main` or `master` may
remain behind during the documented one-hour grace outside merging; do not
advance it repeatedly during that window. Block on divergence or unsafe worktree updates. This prerequisite
is a skill workflow; these CLI commands do not automatically fetch or advance
branches. Local ref changes invalidate plans unless explicitly reconciled;
only documented remote-target fast-forwards are tolerated.

### Freshness reports

`status`, `check`, and `doctor` include a `freshness` map keyed by node ID;
`view` shows each node's integration, branch, and validation status. Plans and
graph operation results also include freshness, and status exposes running
candidate reports separately. These are live read-only observations, not
automatic fetches, branch updates, or renewed verification timestamps.

Each integration report includes `status` (`current`, `grace`, `stale`, or
`unknown`), `snapshot`, `observedTip`, `verifiedAt`, `ageMs`, `thresholdMs`,
`expiresAt`, `observedAt`, `scope`, and `mergeCurrent`. Timestamps are epoch milliseconds.
Branch reports compare recorded/local/remote heads and distinguish unpublished
and local-only scope. Validation is independently `current`, `stale`, or
`missing`; none of these imply dependency eligibility or provider-policy success.

Only `main`/`master` integration snapshots have a one-hour grace, measured from
the last recorded exact-target observation during an approved operation.
Later target observations must be verified fast-forwards; they never extend
the clock while the authored snapshot is behind. At exactly one hour grace
expires. Legacy/restored snapshots without verification evidence get no grace,
and neither do rewinds, future-dated evidence, or other target branch names.
Unchanged exact-current snapshots remain current regardless of age.

During grace, shape plans and publication preserve the authored snapshot and
`ready` may promote an otherwise eligible, validated node. Grace is rechecked
on apply/continue and does not relax source/helper/PR identity checks. Explicit
`sync` still adopts its approved current snapshot. `merge` always requires the
actual current integration tip; a node readied within grace may need sync and
another ready operation before it can merge. Metadata-only description
updates can report stale integration freshness without rewriting branches.

## Plan, approve, apply

```text
node "<helper>" plan split --repo "<repo>" --spec "<spec.json>" --out "<plan.json>"
node "<helper>" apply --repo "<repo>" --plan "<plan.json>" --yes --approve "<digest>"
```

The plan's `approval` field is a digest of the full payload. The agent must
obtain human approval before using it. This is an integrity check and workflow
contract, not cryptographic evidence that a human clicked Approve.

Plans contain code and descriptions. Keep them outside the product working
tree and use a new filename per revision. Without `--out`, the plan is printed
as JSON; persist it unchanged before applying.

### Complete split spec

```json
{
  "id": "feature",
  "title": "Feature work",
  "remote": "upstream",
  "target": "trunk",
  "source": { "base": "<integration-commit>", "head": "<source-commit>" },
  "backup": { "enabled": false },
  "nodes": [
    {
      "id": "model",
      "title": "Introduce the shared model",
      "description": "Fill the repository's PR template for this change.",
      "dependencies": [],
      "change": {
        "base": "<comparison-commit>",
        "head": "<source-commit>",
        "paths": ["src/model.ts"]
      },
      "validations": [
        { "command": "node", "args": ["--test", "test/model.test.mjs"] }
      ]
    },
    {
      "id": "consumer",
      "title": "Use the shared model",
      "description": "Standalone description for the consumer change.",
      "dependencies": ["model"],
      "change": {
        "base": "<comparison-commit>",
        "patch": "diff --git ...\n"
      },
      "validations": [],
      "validationReason": "Documentation-only; no applicable automated check."
    }
  ]
}
```

Replace all placeholders; `patch` must be a real full-index Git patch, not
`diff --git ...`. See [change representation](graph-and-changes.md).
For repositories restricting branch namespaces, set `helperBranchPrefix` in
the complete graph spec, for example `"user/alias/feature-bases"`. Prerequisite
bases use `<prefix>/<node-id>`; the default remains `pr-graph/<graph-id>/bases`.
Changing the prefix requires an approved shape plan (such as `deps`) and
separate publication. It preserves unchanged node commits and retains old
helper refs; it does not rename or delete them.
When no remote exists, omit it and supply a target. Multiple remotes need an
explicit selection. The target need not be `main`.

For local-only behavior with a hosted remote:

```json
{ "provider": { "kind": "local" } }
```

For GHES, specify `"provider": { "kind": "github" }`; host/owner/repository come
from the chosen remote URL, not a hard-coded hostname.

`source.base` must equal the pinned integration target for `split`. The complete
combined result must match `source.head` exactly. Prepare a behind-target source
explicitly rather than weakening the losslessness check.

Each node needs a stable ID, title, own change, prerequisites, and either
validation argv arrays or a specific reason why no automated check applies.
Descriptions are authored by the agent, not generated by the helper.

### Shape actions

| Action       | Spec and behavior                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `init`       | New graph from a complete spec; optional source reconstruction gate                              |
| `split`      | New graph; requires exact source reconstruction                                                  |
| `add`        | Existing graph plus a complete active-node spec; existing own changes immutable                  |
| `deps`       | Complete active-node spec; existing own changes immutable; update edges/validation configuration |
| `split-node` | Complete replacement spec with `supersedes`; preserve combined tree                              |
| `fold`       | Complete replacement spec with `supersedes`; preserve combined tree                              |
| `remove`     | Complete remaining active-node spec; retire omitted nodes; explicitly changes combined tree      |

Omit previously retired nodes from specs. Their snapshots and IDs remain
reserved. Nodes omitted by split/fold/remove become retired rather than losing
their content. Active descendants cannot depend on an unlanded retired node.

For example, folding A+B into AB:

```json
{
  "id": "feature",
  "nodes": [
    {
      "id": "ab",
      "title": "Combine the model changes",
      "dependencies": [],
      "supersedes": ["a", "b"],
      "change": { "base": "<base>", "head": "<combined-commit>" },
      "validationReason": "Specify applicable checks or a real no-check reason."
    }
  ]
}
```

Splitting AB into A2+B2 maps both new nodes to `"supersedes": ["ab"]`.
Retaining the original node ID is allowed while changing its own selection in a
split/fold, but explicitly map any retired identities. Retired IDs cannot be
reused.

To adopt a same-repository PR in `init`/`add`, supply its existing branch and
`"adoptPr": <number>` on the node, plus an explicit own-change selection. The
helper verifies PR identity rather than inferring a multi-parent graph from
base branches.

### Lifecycle actions

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

### Backup and recovery actions

See [safety and recovery](safety-and-recovery.md) for complete instructions.

```text
node "<helper>" plan backup --repo "<repo>" --graph feature --out "<plan>"
node "<helper>" plan fetch-backup --repo "<new-clone>" --remote origin --graph feature --out "<download-plan>"
node "<helper>" plan restore --repo "<new-clone>" --remote origin --graph feature --backup-ref "<downloaded-sha>" --out "<restore-plan>"
node "<helper>" plan resolve --repo "<repo>" --operation "<operation-id>" --out "<resolution-plan>"
node "<helper>" plan reconcile --repo "<repo>" --operation "<operation-id>" --out "<reconciliation-plan>"
node "<helper>" continue --repo "<repo>" --operation "<operation-id>" --yes --approve "<original-digest>"
node "<helper>" plan abort --repo "<repo>" --operation "<operation-id>" --out "<abort-plan>"
node "<helper>" plan abort --repo "<repo>" --operation "<operation-id>" --retain-published-refs --out "<retained-ref-abort-plan>"
node "<helper>" plan unlock --repo "<repo>" --out "<unlock-plan>"
```

Enable backup in a new or updated complete graph spec:

```json
{ "backup": { "enabled": true, "branch": "pr-graph/feature/metadata" } }
```

Backup contains committed code and reachable history. Opt-in backup writes are
included in lifecycle plans that perform publication, sync, readiness, merging,
or description changes. Local graph edits can remain unbacked-up until one of
those operations or an explicit backup.

Cleanup requires a finished or locally aborted operation and a precise spec:

```json
{
  "branches": ["pr-graph/feature/bases/model"],
  "remoteBranches": [],
  "closeRetired": [],
  "worktree": true
}
```

```text
node "<helper>" plan cleanup --repo "<repo>" --operation "<operation-id>" --spec "<cleanup-spec>" --out "<cleanup-plan>"
```

Only obsolete tracked helper branches or retired-node branches can be listed.
Remote branches and retired PR closure require their explicit lists. Worktree
removal never forces a dirty worktree. Source/target/metadata branches and
unknown directories are not cleanup targets. Reachability pins are retained.
