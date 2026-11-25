# Tree-first reconstruction experiment

## Decision

Do not adopt a tree-first execution path yet. Issue #54 permits a measured
research outcome without an execution change. The prototype lives only in
`scripts/__tests__/tree-first-differential.test.mjs`; there is no helper flag,
persisted setting, new approval mode, or production import. Normal reconstruction
and verified-prefix reuse remain available and unchanged.

An isolated index can cheaply compute candidate trees for a bounded subset of
patches. It cannot replace the observable operations that produced approved
commits. In particular, matching trees do not demonstrate filter execution,
successful hooks/signing, validation, or recoverability. Adding a candidate pass
before those mandatory operations would add work, not remove it. No current
caller needs an additional uncommitted candidate snapshot strongly enough to
justify that extra pass and its separate semantic contract.

## Baseline after prefix reuse and batched reads

Run from the repository root:

```sh
node --test skills/pr-graph/scripts/__tests__/composition-differential.test.mjs skills/pr-graph/scripts/__tests__/tree-first-differential.test.mjs
```

The existing composition benchmark compares real split operations on six-node
chains, diamonds, and wide graphs. The prefix-enabled path still uses the
current batched object readers. A local Linux run with Node.js 22.23.4 and Git
2.55.0.vfs.0.10 produced:

| Shape   | Git/helper subprocesses, prefix off -> on | Checkouts, off -> on | Patch visits, off -> on | New normal commits, off -> on |
| ------- | ----------------------------------------- | -------------------- | ----------------------- | ----------------------------- |
| Chain   | 761 -> 536                                | 34 -> 13             | 27 -> 6                 | 6 -> 6                        |
| Diamond | 731 -> 566                                | 30 -> 13             | 25 -> 8                 | 8 -> 8                        |
| Wide    | 448 -> 448                                | 14 -> 13             | 12 -> 11                | 11 -> 11                      |

The chain's reconstruction/composition phases measured approximately 3.49/0.52
seconds with prefixes, the diamond's 3.77/0.54 seconds, and the wide graph's
1.90/1.56 seconds. These are diagnostic observations, not performance promises
or elapsed-time test assertions. Prefix verification is included in these
enclosing phases and must not be added again.

The remaining materialization cost is concrete: initial worktree population,
checkout/status boundaries, and working-file/index updates during each required
patch/commit. This experiment does **not** establish physical filesystem I/O as
the dominant remaining cost; small fixtures also measure subprocess, receipt,
and hook-context overhead. Eliminating the remaining normal commits is not a
permitted optimization.

## Bounded prototype and measurements

Within `withObjectView`, initialize one disposable index with `read-tree`, apply
the approved full-index/binary patches in their supplied order using
`apply --cached --3way --whitespace=nowarn`, and record each `write-tree` result.
Compare **every intermediate tree**, not just the final result, against real
`applyChange`/`commitStaged` replay. There is no `commit-tree`, checkout, source
object write, product-ref update, or candidate receipt. Temporary trees and
conflict stages are destroyed with the isolated view.

For six independent text changes composed in order, a local run measured:

| Metric                                              | Normal replay | Candidate-only prototype |
| --------------------------------------------------- | ------------- | ------------------------ |
| Git processes, including worktree/object-view setup | 62            | 16                       |
| New worktree populations                            | 1             | 0                        |
| Normal commits                                      | 6             | 0                        |
| Trace2 `unpack_trees` regions                       | 38            | 2                        |
| Elapsed, SHA-1                                      | about 517 ms  | about 118 ms             |
| Elapsed, SHA-256                                    | about 518 ms  | about 121 ms             |

The normal replay's six tracked regular-file snapshots total 3,600 bytes.
`snapshotBytes` measures logical materialized content, **not bytes written to
disk**, symlink/submodule content, or filesystem syscalls. Trace2 regions measure
Git tree/index work, not physical I/O. The candidate path still writes temporary
index and object files. Its savings only apply to the candidate-only task: it
does not produce the six required approved commits or their evidence. A
candidate-then-commit design would pay both costs. End-to-end speedup has not
been established.

Counters are asserted where meaningful; elapsed values are emitted as test
diagnostics. Re-run on the intended workload/platform before drawing conclusions
from timing or filesystem cost. Full split counters and standalone candidate
counters have different scopes and must not be subtracted from each other.

## Safe subset and mandatory materialization boundaries

The supported **research subset** is complete, locally available Git objects
and patches whose candidate tree semantics do not depend on repository-local
configuration, custom merge drivers, filters, or working-directory state.
Full-tree comparisons cover text, binary blobs, rename-as-delete/add, executable
modes, symlink blobs and submodule gitlink IDs. Gitlinks are tree entries only:
the prototype does not initialize or validate submodule worktrees.

| Boundary                                     | Required behavior                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attribute/filter/merge configuration         | Keep normal Git execution. The isolated view deliberately does not inherit source configuration or external attributes. CRLF and deterministic clean/smudge examples can have identical trees but different materialized bytes and observable filter calls. No claim of general attribute/merge-driver equivalence. |
| Commit creation, messages, hooks and signing | Use normal `git commit` with exact approved messages and trailers. A successful candidate tree cannot override a rejecting hook, missing signer, or failed required filter. Do not use plumbing commits as substitutes.                                                                                             |
| Validation/setup                             | Retain approved checks, setup authorization, exact heads, receipts and isolation. A tree hash does not run checks or grant readiness.                                                                                                                                                                               |
| Conflicts and recovery                       | Retain the actual operation worktree, staged conflicts and journal. Disposable index stages are diagnostic evidence only, not a reusable resolution or published conflict commit. Require the existing exact recovery approvals.                                                                                    |
| Prefix reuse                                 | Reuse only verified commit receipts under current execution/context evidence. Do not convert candidate tree equality into reconstruction provenance.                                                                                                                                                                |
| Freshness/publication                        | Keep live observations, leases, approval digests and provider gates. Candidate computation grants no mutation or publication permission.                                                                                                                                                                            |
| Missing objects/network                      | Fail without fetching. The view has no source remotes/configuration, uses no-lazy-fetch settings and cannot hydrate missing promisor blobs.                                                                                                                                                                         |
| User checkout/index                          | Preserve dirty tracked/untracked files, staged content and HEAD. Read source objects through alternates; write only disposable objects/index.                                                                                                                                                                       |

## Evidence and limitations

The new tests compare all intermediate trees in SHA-1 and SHA-256 repositories,
inspect binary bytes and tree modes, preserve a dirty source index/worktree,
exercise missing promisor blobs, and compare index conflicts with retained real
worktree conflict markers. They demonstrate identical trees under CRLF and
clean/smudge conversion while detecting the materialization/observable-call
differences. Required-filter, signer and hook failures prove that candidate
success is not operation success. The exact-message assertion checks normal
replay, not a synthetic message approximation.

The prototype and its shell-free Git invocation use the existing portable
object-view helper. The suite is discovered by the existing Linux/macOS/Windows,
Node.js 22/24 CI matrix. The executable shell-hook test is skipped on Windows;
successful cryptographic signing, arbitrary user filters/merge drivers,
submodule checkout behavior and live hosted recovery are not certified by this
experiment. Signing failure is exercised without requiring a key or external
signing installation. No production path is expanded across those gaps.

Revisit only with a concrete candidate-only diagnostic consumer or evidence that
required materialization can be avoided without changing observable semantics.
Require workload-specific measurements, complete-tree differential tests and
behavior/refusal/recovery equivalence before adoption; retain the current path
until both parity and useful end-to-end savings are established.
