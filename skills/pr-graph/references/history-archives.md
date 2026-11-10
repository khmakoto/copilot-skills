# Portable historical evidence

History archives are opt-in, local, evidence-only transfers. They are not graph
recovery, portable approvals, universal undo, or automatic synchronization.
Both export and import require human approval of the **complete exact plan**
unless the separate invocation-scoped transfer authorization below applies.
`--auto` alone is not transfer authorization. Never upload an archive as part of
ordinary publication.

## Invocation-scoped transfer authorization

In auto mode, the user may separately authorize a specified export/import for
this invocation, covering the exact source repository or archive, graph,
destination repository and archive path as applicable, and retained-data scope.
Explain that full retained history includes discarded source, commit ancestry,
old descriptions and metadata, and incurs persistent storage/retention. Obtain
the user's explicit opt-in to that scope and cost unless their direct request
already covers them. Ask for missing or ambiguous bounds; do not infer consent
from ordinary backup approval, an archive's contents, or a request to inspect it.

Under that opt-in, review and save each complete exact transfer plan and digest
without another human prompt only when the payload, origin, destination and
retention effects stay within the authorized bounds. Existing schema, pack,
completeness, file-preservation and lock checks remain mandatory. A changed
source, unexpected payload, broader scope, or new destination requires renewed
approval. Do not persist this authorization or introduce a helper CLI flag.
External uploads, restore, graph recovery and archive deletion are not covered.

## Export, inspect, import

Resolve `<helper>` from the installed skill directory. Keep both plan files and
archives outside the managed product working tree. Parent directories must
already exist. Archive output must be a new regular file, not a symlink.

```text
node "<helper>" plan export-history --repo "<source>" --graph feature --archive "<history.json>" --out "<export-plan.json>"
node "<helper>" apply --repo "<source>" --plan "<export-plan.json>" --yes --approve "<export-plan-digest>"
node "<helper>" plan import-history --repo "<recipient>" --graph feature --archive "<history.json>" --out "<import-plan.json>"
node "<helper>" apply --repo "<recipient>" --plan "<import-plan.json>" --yes --approve "<import-plan-digest>"
node "<helper>" history-archives --repo "<recipient>" --graph feature
node "<helper>" history --repo "<recipient>" --graph feature --node model --archive "<archive-digest>" --format text
node "<helper>" interdiff --repo "<recipient>" --graph feature --node model --archive "<archive-digest>" --from last-published --to "<retained-version-id>" --format text
```

Planning previews all retained source and metadata, the object inventory,
origin, completeness, destination, and effects without creating an archive or
importing objects. Review the full payload, not just its summary. **Discarded
code, commit ancestry, old descriptions, and historical metadata can contain
sensitive material.** Full history increases storage and retention costs.
Plans also contain the archive payload; handle them with the same care.

Apply rechecks the approved payload. Export rejects changed local evidence or
origin and never replaces an existing output. Import rejects a changed input.
An incomplete write is preserved, not silently replaced; inspect it and choose
a new export path. An interrupted import may leave validated objects or private
pins before the evidence file is saved. Inspect those effects, then reapply the
same exact plan; identical imports are idempotent. No operational journal is
created, copied, resumed, or required for these transfers. A mutation lock still
blocks apply. Retained interrupted operations need not be resolved merely to
transfer their historical evidence.

Archive inspection and transfer work offline and do not require live branch
freshness or provider authentication. This narrow exception never authorizes
any product operation; normal freshness, provider readback, plan digests, and
approval requirements remain unchanged for graph execution.

## Format and completeness

Version 1 is a single JSON object with `format: "pr-graph-history"`:

| Field                       | Contract                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | SHA-256 digest of the canonical complete payload excluding `id`.                                                                                                                                                                              |
| `graph`, `identity`         | Graph ID and historical target/base association from the earliest retained snapshot. Not a hosting or authorship credential.                                                                                                                  |
| `origin`                    | Opaque random clone-origin ID, retained in local `history-origin.json` on first successful export. No machine path is encoded.                                                                                                                |
| `createdAt`, `objectFormat` | Source export time and `sha1` or `sha256`; recipient format must match.                                                                                                                                                                       |
| `graphs`, `timelines`       | Original graph-snapshot digests and evidence-only node/graph projections, before/after version references, explicit split/fold lineage, candidate/persisted distinctions, operation statuses, and historical publication/validation receipts. |
| `roots`, `objects`, `pack`  | Sorted full object IDs and a base64, self-contained, non-thin Git pack. Retains commit ancestry, trees and blobs, including obsolete versions unreachable from product refs.                                                                  |
| `completeness`              | Separate object/evidence completeness, missing-object IDs, and explicit evidence gaps.                                                                                                                                                        |

Version IDs retain their exact originating graph-digest/node identities.
Graph projections contain target, integration and prerequisite snapshots;
node projections retain owned changes, realized bases/heads, dependencies,
descriptions, lineage, and historical state. Raw execution graphs and journals
are not the portable contract. Validation commands are replaced by digests and
an automated-check indicator; raw errors are replaced by digests. Recovery
evidence retains only operation ID, action and time. Locks, ownership, local
paths, remote/auth configuration, cached authorization, pending instructions,
and executable/resumable journals are not exported.

Completeness covers **locally retained evidence**, not unknown or discarded
history before retention began. Legacy gaps, missing after snapshots,
import/restore boundaries and missing predecessors remain explicit.
Evidence-incomplete legacy archives can be exported/imported, without claiming
a complete record. Missing Git objects block export apply: the plan reports
their IDs and `completeness.objects: false`, but does not write a misleading
partial archive. No promisor remote is contacted to fill missing objects.

Import validates schema, identities, digest, supported object format, version
references and the exact object inventory. Pack checking occurs in an isolated
temporary bare repository with no alternates, remotes or source configuration;
the recipient's existing objects cannot conceal a non-self-contained pack.
Unknown archive fields and unsafe identities/paths are rejected. There are no
archive filesystem entries to extract. Conflicting graph associations or
version/event identities are rejected without overwriting existing evidence.
A local graph, when present, must match the historical target/base association;
matching local version snapshots must agree as well. A recipient need not have
a current graph or product branches to inspect the archive.

## Provenance and historical selectors

Digests detect payload corruption; they **do not authenticate the origin,
authorship, timestamps, claimed original graph digests, or test results**.
Version identity mappings are source assertions over redacted projections,
not proof that an authenticated producer observed an original graph.
Approve only a source/payload appropriate for the intended use.

`history-archives` lists retained archive digests, clone origins, historical
graph associations and completeness. Pass one exact digest with `--archive`
to `history` or `interdiff`; imported and local timelines are never implicitly
merged. Repeated exports from an origin remain separately selectable.
Imported events/versions are marked as imported with provenance.
`baselineOrigins` identifies the archive and origin for imported
`last-published`/`last-validated` selectors.

In an imported timeline, `current` is always unavailable. `sourceCurrent`
records the source's historical selection, not the recipient's current state.
Select exact version IDs or explicit origin-scoped historical baselines;
interdiff requires an explicit `--to` instead of silently treating the source
checkout as current. Candidate versions remain candidates. Imported publication
receipts are past observations, not live hosting state. No imported result can
renew current checks, readiness, integration freshness or merge safety.

## Execution isolation, backup and retention

Import writes only the validated Git pack, retention refs under
`refs/pr-graph/archives/<graph>/<archive-digest>/<root>`, and an immutable evidence
JSON file under `<git-common-dir>/pr-graph/history-archives/<graph>/`.
It does not move product refs, edit graphs, change user files/indexes, register
worktrees, modify existing approvals or recovery journals, run imported
commands, or change hosting. Imported JSON also retains the self-contained pack.

Backup/restore and `import-graph` retain their separate skill authorization gates;
history-transfer opt-in does not authorize them.
They do **not** silently include originating clone history. Transfer evidence
separately before or after recovery, and select it explicitly for inspection.
Evidence import cannot make a graph executable or authorize its recovery.
Export uses local evidence only; it does not silently re-export imported
origins. An original archive can instead be transferred as the same exact file.
No hosting upload/download is implemented; any external transfer requires its
own destination/payload approval, separate from local export/import.

There is no automatic expiration or archive-deletion command. Normal graph
cleanup does not remove archive evidence or pins. Deletion requires separately
approved, precisely scoped removal of the evidence file and its corresponding
private refs; remove external archive/plan copies separately. Deleting only
JSON leaves Git retention pins; deleting only refs leaves the archive's embedded
source. Git objects may remain until ordinary garbage collection and while
reachable elsewhere. No deletion guarantees erasure of copies already shared.
