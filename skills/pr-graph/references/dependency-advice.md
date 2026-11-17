# Dependency simplification and parallelization advice

Use this workflow when asked to simplify dependencies or identify unnecessary
sequencing in an existing graph. It does not automatically reshape the graph.
Complete the skill's normal freshness preflight first.

```text
node "<helper>" dependencies --repo "<repo>" --graph feature
```

`<helper>` is the installed skill's `scripts/pr-graph.mjs`. The command accepts
only `--graph`, `--repo` and `--quiet` and emits JSON. It reads the saved graph,
not live provider state, and uses recorded landing receipts for eligibility.
It performs no fetch, reconstruction, executable probe, validation, ref/state
write, publication or freshness renewal. It does not check object availability.
Normal skill preflight is still required; an unavailable provider is not an
offline exemption for the agent.

## Separate structural facts from semantic proposals

The report pins `graphDigest` and separates:

- `redundantEdges`: direct edges with an `alternatePath`, in prerequisite-to-
  consumer order. For `a -> b -> c` plus `a -> c`, the latter edge has alternate
  path `["a", "b", "c"]`. Removing that direct edge preserves reachability and
  dependency eligibility, including through diamonds/shared ancestors. It can
  still remove useful explicit policy or documentation intent. Retain it unless
  its removal is accepted and approved.
- `sequencingCandidates`: all other direct edges between active, unlanded
  endpoints, marked `unassessed` with `missingEvidence`. These are review
  candidates, **not findings of unnecessary sequencing**. Removing such an edge
  changes reachability; the helper cannot decide whether that constraint is real.
- `excludedEdges`: edges with a retired or landed endpoint. Do not propose
  rewriting landing receipts or retired provenance. These nodes still
  participate in reachability and retained evidence.

Each finding's `removal` considers **only that one edge**, independently of all
other findings. It lists exact direct dependencies before/after and the active
consumer plus all active transitive dependents in `affected`. For each affected
ID it shows before/after full and unlanded prerequisite closures, removed IDs,
and dependency eligibility under recorded landing receipts. Descendants appear
once even with shared prerequisites; some may have unchanged closure. This is
an impact inventory, not the helper's reconstruction or publication selection.
No claim is made about passing checks, readiness, integration/branch freshness
or provider policies.

For example, dropping `b -> c` from `a -> b -> c` loses **both** `a` and `b` from
c's closure. To propose b/c as siblings that still require a, consider an
explicit `dependencies: ["a"]` for c, but only after reviewing the semantics.
Do not silently rewire edges or treat single-edge removal effects as the
effects of that different proposal. For multiple accepted edits, recompute the
complete proposed DAG's closures and eligibility together; independent previews
are not additive.

## Agent evidence and advice

`evidence` contains each node's retained own patch and immutable change
coordinates, title/description, direct prerequisites and consumers, realized
base/head, integration and landing records, configured check argv/no-check
reason, and recorded validation/readiness. These are inspection inputs, not
proof that source objects are available, checks ran against a hypothetical
graph, or the saved graph matches today's provider state.

Review candidates one at a time:

1. Inspect the pinned own patches and surrounding source, producer/consumer
   contracts, tests, configuration and explicit edge intent. Trace same-file
   interactions as well as cross-file imports, schemas, generated artifacts and
   runtime behavior. Record concrete node/file/symbol evidence and a rationale
   for retaining or proposing each relationship. Disjoint paths can still have
   semantic dependencies; edits in the same file can be independent.
2. Keep proven reachability redundancy separate from a semantic parallelization
   proposal. For the latter, state the precise proposed dependencies and the
   evidence for each retained or removed requirement. Clean patch application,
   disjoint paths and passing checks, individually or together, do not prove
   independence. Missing source, unclear intent, absent consumer context or
   insufficient checks means **uncertain; retain the edge**, not an affirmative
   recommendation. Existing successful validation describes the old graph only.
3. If isolated reconstruction or checks are needed, disclose the exact candidate
   graph, commands and effects and obtain authorization through the existing
   plan workflow. A read-only advice request never authorizes speculative Git
   plumbing, hooks, installs or test runs. With no authorized execution evidence,
   label the proposal provisional and the reconstruction/checks unperformed.
4. Before approval, show the complete proposed edges, affected IDs, full and
   unlanded closure changes and expected eligibility effects, including shared
   ancestors and all affected descendants. Explain validation/readiness
   invalidation and any new uncertainty. Approval to keep a finding or explore
   it is not approval to apply it.

## Apply only with existing dependency plans

For accepted changes, prepare a **complete active-node spec** under the existing
[`deps` contract](change-specs.md#shape-actions), retaining stable IDs, branches,
own changes, required real prerequisites and landing receipts. Do not replace
patch ownership, retire nodes or weaken validations to make advice pass.

```text
node "<helper>" plan deps --repo "<repo>" --graph feature --spec "<spec.json>" --out "<new-plan.json>"
node "<helper>" apply --repo "<repo>" --plan "<new-plan.json>" --yes --approve "<approval-digest>"
```

Save a new exact plan outside the product worktree. Review its full effects and
obtain exact approval under the invocation's unchanged interactive/auto/YOLO
contract; the diagnostic digest is **not** a mutation approval. The normal helper
reconstructs prerequisite bases and nodes, preserves the complete combined tree,
runs required validation and enforces pinned observations and expected-old refs.
Conflicts or failed checks stop for the existing explicit recovery workflow,
not silent fixes or automatic edge restoration/retry.

Recheck the realized graph and report actual effects. Publication, diagram
updates, readiness, merging and cleanup remain separately authorized operations.
Diagnostics never automatically remove even a transitively redundant edge.
