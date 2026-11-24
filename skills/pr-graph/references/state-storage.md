# Retained state storage

Local storage is versioned independently of graph, plan, history-receipt, and
portable archive schemas. Approval hashes always cover the complete logical
payload, never storage references. The helper expands and verifies local storage
before using existing approval, history, validation, or recovery checks.

## Format and integrity

New graph files, operation journals, and history receipts use an envelope with
`format: "pr-graph-state"`, `version: 1`, and an encoded `value`. Encoded values
are tagged pairs: `value` for a JSON scalar, `object` for sorted key/value pairs,
and `array` for ordered values. A reference is the triple
`["ref", "text" | "tree", "<sha256>"]`. This encoding cannot confuse a user's
object or string with a storage reference.

Large collections can use tagged `object-parts` or `array-parts` pairs whose
values are encoded pages. Object pages form a four-way radix tree over SHA-256
key hashes; maps split when their encoding reaches 4096 bytes and they have more
than 32 keys. Array pages preserve order with 16-element leaves and 16-way
internal pages. Small leaf pages may exceed 4096 bytes when their entries are
large. Unchanged pages are shared; updates and array appends do not retain a new
complete copy of growing receipt collections. Decoding rejects wrong page types
and duplicate object keys across pages.

Blocks live at `<git-common-dir>/pr-graph/payloads/<sha256>`. Their address hashes
the UTF-8 bytes of the kind, a newline, and the block contents. Text blocks hold
raw UTF-8 strings; tree blocks hold compact JSON-encoded values. Strings and
encoded subtrees of at least 4096 bytes are shared, including plans, patches,
graph snapshots, and growing execution evidence. Smaller values stay inline
except for shared collection pages. Strings with unpaired UTF-16 surrogates stay
JSON-escaped in trees rather than being lossily converted to raw UTF-8 text.
Each read verifies the kind, address, encoding, and reference closure. Missing,
corrupt, unsupported, or symlinked payloads stop inspection/execution with their
path; they are not silently replaced, ignored, or regenerated from a candidate.
Read caches are limited to one read boundary, never retained across mutations.

## Publication and interruption

Writers create child payloads before parents. Every new file is written to a
private same-directory temporary file, fsynced, and atomically published; parent
directories are synced where the platform supports directory fsync. Existing
payloads are verified, not overwritten. Only after the complete payload closure
is durable is the small journal/receipt/graph envelope atomically replaced and
synced. Existing intent-before-effect and attempted-versus-verified receipt
boundaries remain unchanged; no journal write or fsync is deferred or coalesced.

A crash before record replacement leaves the previous complete record and
possibly unreferenced blocks/temporary files. A crash after replacement leaves a
complete new record, not a partially updated payload graph. These files are
retained, not automatically garbage-collected. History receipts still precede
graph persistence, and completion still follows it: a retained candidate or
receipt alone does not establish that a graph was persisted. Existing recovery
and exact-plan approval rules apply after interruption, including uncertain
remote effects and pending commands.

## Compatibility, retention, and history transfer

Legacy inline JSON remains readable alongside envelopes. Merely inspecting it
does not migrate it. The next already-authorized write replaces only that record
with the new encoding; no historical record, Git pin, or source is deleted.
Older helpers cannot read envelopes: use a helper supporting this storage format
once a record has been written. Do not downgrade by manually stripping envelopes.

Payload sharing is local storage deduplication, not authorization deduplication.
Portable history exports remain self-contained version-1 archives with expanded
logical evidence and unchanged provenance checks; they never contain local
payload references. Import stays in the private archive namespace and cannot
install execution journals, approval authority, or current validation/readiness.
Graph transfer likewise uses expanded logical snapshots. Copy complete retained
state, including `payloads/`, when backing up the local state directory.

History lookup continues to scan authoritative receipts and journals. There is
no secondary history index to become stale, override evidence, or require
rebuilding. Storage tests measure serialized/written bytes, durable writes,
retained size, and history-read work without elapsed-time thresholds. A future
index needs separate measured justification and must remain rebuildable.

## Bounded measurements

`scripts/__tests__/storage.test.mjs` compares real inline writes with shared
records over 16 operations and 160 durable transitions, including repeated
48-KiB patches in plans and snapshots. On the Linux fixture, serialized JSON
fell from about 408 MB to 5.55 MB, file bytes written to 284 KB, and retained
state from 40.8 MB to 93 KB. File fsyncs increased from 160 to 162 for the new
immutable blocks; all 160 record flushes remain. Directory flushes are measured
separately. These deliberately repetitive inputs demonstrate sharing, not a
promise about ordinary repositories or elapsed-time performance.

A separate 20-operation history fixture compares complete timelines with inline
and shared snapshots: read volume fell from about 5.54 MB to 335 KB, while file
opens increased from 41 to 62. This is not evidence that a secondary lookup index
would improve latency; no index is introduced. Tests gate logical equivalence,
byte/work reductions, complete reference integrity and crash recovery, not
wall-clock thresholds.

The growing-evidence fixture starts with 512 receipts in both a map and an
array, then updates/adds receipts across 12 transitions. It checks that written
bytes are less than a quarter of complete unshared evidence copies, preserves
old pages, and verifies insertion, update, append and shrink round-trips.
