# Explicit review freezes

A freeze is a local rewrite/review-baseline policy, not a publication exclusion,
server-side lock, validation receipt or permission to merge. Never infer one from
draft state, review activity or a provider response. Use a separate exact-approved
`review-freeze` plan for every freeze or unfreeze. Ordinary auto mode requires
human approval for both; it must pause rather than silently unfreeze to satisfy
freshness or complete a reshape. YOLO may approve a separate necessary unfreeze
only within the requested task and without contradicting a preserve-review
constraint. Replan subsequent changes after unfreezing; their old approvals do
not acquire new authority.

## Protected fields

Both modes require an existing, realized, active unlanded node. The policy records
digests of protected fields, the exact approval operation and a nonempty reason.

| Mode                    | Protected baseline                                                                                                                                                                                                                                                                 | Permitted effects without unfreezing                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `authored-content`      | Stable node ID and source branch; complete pinned own-change record (immutable base, source head, full patch and fingerprint); retirement state and supersedes/replacedBy lineage.                                                                                                 | Reconstruct base/head on changed prerequisites or integration snapshots while preserving owned content and identity. Dependency edits, descriptions, checks, publication and lifecycle actions retain their normal independent gates.                              |
| `exact-review-snapshot` | All authored-content fields, plus realized base/head/base branch, integration target name and helper namespace, direct dependencies, title/description, validation commands/reason, and recorded PR ID/source branch/head/preview base/target branch/draft state/title/human body. | Unchanged reconstruction, rerunning unchanged checks and recording their results, freshness observations and managed-footer refreshes. Landing is allowed when it preserves these fields and satisfies all existing current-target, validation and provider gates. |

Generated footer contents and final newline separators, validation/readiness
receipts, freshness timestamps, PR lifecycle state and landing receipts are not
frozen. Local readiness intent
is distinct from a hosted draft-state change. PR creation or draft promotion
changes an exact snapshot and requires unfreezing. Human text outside the managed
footer remains protected; external preview-base movement is observable drift,
not permission to accept a new exact review snapshot.

Exact mode also rejects reconstruction when the pinned target or prerequisite
composition recipe would change, even if the resulting tree might match. This
conservative preflight avoids running a rebuild to discover whether it happens
to reproduce the same commits. Missing reconstruction signatures after recovery
require explicit unfreezing before reconstruction. Authored mode permits that
reconstruction, not a redefinition of its immutable-base owned delta.

Direct edits, split/fold/retirement and removal of frozen identity are blocked in
both modes. Indirect prerequisite changes that rebuild an exact-frozen descendant
are blocked before product-ref or hosting writes. Unchanged frozen nodes remain
in the plan's `freezes` report; permitted authored reconstruction is identified
explicitly. Apply/continue recheck policy, pinned observations and realized fields
before refs/publication; a fresh plan is required after drift.

## Plans and inspection

```json
{
  "freeze": [{ "node": "api", "mode": "exact-review-snapshot" }],
  "unfreeze": [],
  "reason": "Preserve the active review baseline."
}
```

```text
node "<helper>" plan review-freeze --repo "<repo>" --graph feature --spec "<freeze.json>" --out "<new-plan.json>"
node "<helper>" apply --repo "<repo>" --plan "<new-plan.json>" --yes --approve "<digest>"
```

The spec accepts only `freeze`, `unfreeze` and `reason`. Each node appears once
across both lists. To change mode, explicitly unfreeze first, then prepare a new
freeze from current evidence. Unfreeze uses `"freeze": [], "unfreeze": ["api"]`
and a nonempty reason. It releases all active retained freezes for those IDs,
not source/ref cleanup or any subsequent change. An active freeze cannot be
replaced or omitted through a shape spec or general recovery plan.

Plans and apply pin graph/ref/PR observations, including for unfreeze. Freeze
creation refuses observable branch/helper/PR identity drift. Unfreeze can be
planned against newly observed drift, but never adopts or repairs it. Interrupted
operations must be recovered first. These actions change only graph policy and
retain before/after history receipts; they do not reconstruct, validate, renew
freshness, write product/helper refs, publish or mutate hosting state. User
worktree/index/dirty files stay untouched.

`status`/`check`/`doctor` expose `freezes` with mode, originating operation and
field/observation drift; `view` labels frozen nodes. Missing or changed local,
remote, helper or PR identities remain explicit blockers. The helper cannot
prevent edits through a hosting UI or another tool; no automatic adoption,
re-fingerprinting, ref repair or relaxation follows from observation.

## Retention and transfers

Graph snapshots retain freeze and release records even after explicitly released
nodes are retired and their metadata removed. Local history exposes those policy
changes. Backup/restore carry the graph policy; local graph import unions source
records with destination records, never using an incoming release to release an
active destination freeze. Incoming releases for an existing local record are
retained as `observedReleases` evidence, without changing its local release state.
Conflicting records for the same freeze identity block
instead of choosing a winner. Existing destination freezes still protect imported
changes, including check-configuration changes caused by clearing execution data.

Restore/import still clear imported commands, validation/readiness and freshness
authority. An incoming exact freeze keeps its original baseline: cleared checks
may therefore be reported as drift. Explicitly unfreeze before configuring new
checks or reconstructing; do not mark validation current to make the freeze fit.
Portable history archives retain freeze/release evidence in version snapshots,
but history import installs neither active graph policy nor executable approvals.
Imported operation digests identify historical evidence, not current authorization.

Freeze policy is clone-local and relies on intact helper-managed state. Copy
complete graph/payload state or use supported transfers; do not promise protection
against manual state deletion, older helpers or external Git/hosting tools.
