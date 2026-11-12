# Publication exclusions

## Contract

An exclusion belongs to one graph and a stable node ID, not a branch name or a
review freeze. It protects the node's retained versions, later versions of that
identity, and replacements connected through `supersedes`/`replacedBy`. Split
children inherit the exclusion; folding any excluded input excludes the result.
Absorb does not release an identity. Retirement and metadata removal do not
erase the policy or its accumulated evidence.

`plan publication-policy --graph <id> --spec <json>` accepts only
`{ "exclude": ["node-id"], "release": [], "reason": "..." }`. Either list may be
empty, but not both; IDs must be unique and disjoint. Release refers to original
exclusion IDs, not individual replacement nodes. Apply requires the normal
`--yes --approve <digest>` authorization. Every release retains the previous
evidence, reason and operation receipt. Neither shape specs nor imported state
can authorize relaxation. Ordinary skill auto mode must ask before releasing.

Explicit [YOLO mode](yolo-mode.md#disclosure-bounds-without-repeated-prompts)
delegates approval of necessary in-scope exclusion releases, not bypass of
exclusions. First identify the exact stable exclusions, protected lineage and
retained history, reason, recipient/access and all affected outbound routes.
If the direct task and verified context establish the disclosure bounds and
no user constraint requires continued exclusion, save, review and approve the
separate exact release plan without another human prompt. Apply it, then create
a new outbound plan pinned to the updated policy. Missing/ambiguous bounds or
an explicit "keep local" constraint block release. Importing release receipts
never supplies authorization in any mode.

The authoritative ledger is clone-local under the Git common directory.
Graph snapshots carry a copy for backup/restore and graph import. Incoming
active restrictions are unioned with destination restrictions; incoming release
receipts are evidence, never authority to release destination restrictions.
History archives carry the policy as data and import its active restrictions
without importing validation, readiness or mutation authorization.

## Enforcement

Plans pin the policy digest and complete outbound scope: selected product and
helper refs, affected hosted metadata, enabled whole-graph backup, or the exact
history archive. Apply and continue recheck that policy and payload. Before the
first outbound effect the helper checks the entire operation, not just its first
push. Reconstructed object IDs are recorded in the operation journal and checked
again before subsequent writes. Missing/unverifiable objects block transfer.

Protection includes exact object reachability without subtracting remote objects,
changed text-line fingerprints, and excluded metadata fingerprints. This catches
excluded content in prerequisite bases, multi-parent descendants, unrelated
branches carrying the same protected material, and ancestors no longer visible
in the tip tree. Whole-graph backups and history exports are blocked while they
include active policy evidence, even after the node is retired. Errors identify
the exclusion and outbound route, not source text. Unrelated selections may
proceed only if all their refs and metadata pass and enabled backup also passes.

Inspection, local reconstruction, incoming fetches and writing private retention
refs are not outbound publication. The helper does not omit prerequisites, alter
approved trees/history, disable backup, or relax reconstruction to make a plan
pass. A block after an earlier uncertain effect is not a successful rollback or
proof that nothing was disclosed; inspect retained journal evidence.

## Limits

This is explicit graph-scoped protection, not secret detection or a confidentiality
guarantee. Exact objects and text fingerprints do not recognize arbitrary encoded,
edited, or semantically equivalent copies. External Git/provider tools, other
graphs without the policy, hooks and user-supplied validation commands are outside
the outbound boundary. Prior remote exposure is never permission and removing an
exclusion does not retract anything. Backups/archives containing exclusions cannot
be transferred merely to carry the policy; local incoming recovery preserves any
restrictions present in previously approved snapshots.
