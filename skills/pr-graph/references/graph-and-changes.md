# Graph and change model

## Edges and independent readiness

`dependencies` names direct prerequisites. The helper computes their transitive
closure, rejects cycles/missing IDs, and deduplicates shared ancestors. Branch
names and PR numbers are not node identities.

For `A+B -> C`, `B -> D`, `C+D+E -> F`, only A/B/E are initially eligible.
Landing B unlocks D, not C; C also needs A. F needs every one of C/D/E. Landing
a PR into an unintended branch does not satisfy the dependency.

Graph shape, realized Git refs, publication, draft state, validation, and
landing are separate facts. A draft can be eligible. A published draft can be
blocked. An eligible node may still fail checks. Nothing is merged merely
because it is eligible.

## Pinned own changes

A node owns a delta against an immutable base, not a whole accumulated branch:

- `base` + `head`: use their full binary/full-index diff.
- Add `paths` to select complete paths from that diff.
- `base` + `patch`: select specific hunks, including multiple nodes in the same
  file. Preserve full-index headers and binary data.

The plan stores the exact patch and resolved commit IDs. It does not depend on
mutable hunk line numbers. Inspect the original diff and surrounding behavior
before selecting hunks. A rename can be represented as delete/add without
losing the source path.

Changes to a newly added file that cannot exist independently need an ordered
base/result relationship or belong in the same node. Do not claim two
interacting additions are independent simply because their lines differ.
Binary objects and Git tree metadata are indivisible when text splitting is
not meaningful.

Three-way application handles shifted context and independent edits; it cannot
decide semantic conflicts. A conflict pauses in a retained worktree. An approved
resolution must preserve the intended behavior, and the final reconstruction
gate still applies.

Each node commits through normal Git hooks and signing configuration. If a hook
changes the staged tree, the helper rejects the discrepancy and retains
evidence. A successful hook exit alone is not proof the approved tree survived.

## Realization and clean draft diffs

For each active unlanded node:

1. Start from the pinned integration target.
2. Apply each unlanded prerequisite's own delta once, in stable topological
   order.
3. Use that result as the helper base when prerequisites remain unlanded.
4. Apply only the node's own delta to produce its product branch.
5. Run approved node validation and verify the hosted head/base and changed
   paths when publishing.

Thus F's base can contain A/B/C/D/E without including B twice, and an unrelated
unlanded node is never included. Already-landed prerequisites come from the
target branch, not replayed copies of old SHAs.

When all prerequisites land, sync constructs the node directly on the target,
retargets its PR, and keeps it a draft. `ready` is a separate operation.

Retargeting can change review/check behavior. Treat previous policy facts as
stale. Never use helper-target policies as evidence that final-target policies
passed.

## Preservation and validation

For a split, compose every active own change once in a separate integration
worktree and compare its complete Git tree with the pinned source tree.
Preserve file content, binary blobs, modes, symlinks, submodules, additions,
deletions, and generated files. No path category is silently ignored.

Split/fold/dependency transformations compare the old and new combined trees
on the same target. `remove` deliberately changes the combined tree and needs
its own approved plan.

Tree equality is not proof of green builds or a complete semantic dependency
graph. The agent selects concrete checks from actual repository guidance.
Every node records either those commands or a specific no-check rationale.
Restoration deliberately clears validation commands and results.

No ten-node limit or fixed files/lines target is imposed. Explain review size
using the target repository's norms and the complexity of the actual change.
