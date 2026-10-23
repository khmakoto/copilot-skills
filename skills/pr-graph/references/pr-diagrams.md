# Rendered DAG images in PR descriptions

## Required result

Once a node has a PR, its description must end with an image rendered from a
Mermaid diagram of the current full DAG. Each PR gets its own highlighted node,
even when every image otherwise depicts the same graph.

Show all nodes, including unpublished nodes and retained superseded nodes, and
all declared dependency edges. Use stable node IDs; optional short titles and
known PR numbers help identify changes. Keep node cards compact: show the node
name, PR number when known, lifecycle (`active`, `landed`, or `superseded`),
eligibility (`eligible` or `blocked` when applicable), readiness (`unpublished`,
`draft`, or `review-ready` when applicable), and a short textual freshness badge.
Keep these states distinct; do not imply that structural checks establish
functional or merge readiness. Do not repeat authored commit IDs, structural
check details, full timestamps, or explanatory prose in every node or edge.

Move commit IDs and structural-check results into a concise graph-level snapshot
summary, keyed by node ID where needed to preserve landed and superseded nodes'
own evidence. Put the graph name, revision, observation time, integration
snapshot/fetch start, and applicable grace expiry in that summary too. Keep it a
compact header or footer rather than a tall metadata card; use concise labels
and omit no required evidence.

Label the selected node `THIS PR` and give it a distinct outline; do not rely on
color alone. Use a compact visual key with colored swatches and labeled line
samples, not a legend table or repeated edge captions. Active dependency edges
are solid; retained landed dependency edges are dashed. Keep a brief label in
the key for each edge style. Arrange the graph top to bottom, with prerequisites
above their dependents (for Mermaid, use `flowchart TD` or `flowchart TB`). Use
distinct, clear status colors for active eligible, blocked, landed, and
superseded nodes, while keeping their text labels explicit and readable. Keep
the full graph compact and legible in a pull-request description; avoid
excessive whitespace, narrow cards, and line wrapping that obscures labels.

Also show each node's integration freshness (`current`, `grace`, `stale`, or
`unknown`) independently of eligibility and readiness. Include the snapshot's
verification time (the recorded fetch start when supplied) and any grace expiry
in the diagram or its legend, with an explicit observation time. A grace label
is not a merge-ready claim; main/master
grace lasts less than 90 minutes and never applies to merging. Refresh a depicted
freshness transition rather than reusing an image that still claims grace after
expiry. Retain landed/superseded nodes' own snapshot evidence.

Read fresh graph and provider facts after the mandatory branch freshness
preflight. Do not infer landings from closed PRs, or draw intended future
changes as completed. If facts cannot be established, stop and report the
blocker rather than publishing an apparently current diagram.

For example, this compact source for the initial A-F graph shows lifecycle,
eligibility/readiness, and freshness as separate text, with color as a supporting
cue. The actual rendered image must also include the compact visual key and
graph-level snapshot summary described above.

```mermaid
flowchart TD
    n_a["A · PR #101<br/>ACTIVE · ELIGIBLE · DRAFT<br/>FRESH: CURRENT"]
    n_b["B · PR #102<br/>ACTIVE · ELIGIBLE · REVIEW-READY<br/>FRESH: GRACE"]
    n_c["C · PR #103 · THIS PR<br/>ACTIVE · BLOCKED · DRAFT<br/>FRESH: STALE"]
    n_d["D · unpublished<br/>ACTIVE · BLOCKED · UNPUBLISHED<br/>FRESH: UNKNOWN"]
    n_e["E · PR #105<br/>LANDED<br/>FRESH: UNKNOWN"]
    n_f["F · PR #106<br/>SUPERSEDED<br/>FRESH: UNKNOWN"]
    n_a --> n_c
    n_b --> n_c
    n_b --> n_d
    n_c --> n_f
    n_d --> n_f
    n_e -.-> n_f
    classDef eligible fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef blocked fill:#fef3c7,stroke:#d97706,color:#451a03
    classDef landed fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef superseded fill:#e5e7eb,stroke:#6b7280,color:#1f2937
    classDef selected stroke:#075985,stroke-width:4px
    class n_a,n_b eligible
    class n_c,n_d blocked
    class n_e landed
    class n_f superseded
    class n_c selected
```

This is an example of the source, not a complete required PR attachment. Render
the actual graph to an image; do not paste this example unchanged into
descriptions.

## Render and upload safely

1. Generate Mermaid source in the agent's session artifacts, outside the product
   working tree. Use stable ordering and generated identifiers rather than
   interpolating arbitrary titles as Mermaid identifiers. Escape label content;
   do not execute directives, scripts, or links from PR text or recovered data.
2. Use an available approved **local** Mermaid renderer to produce a PNG, or
   another image format verified to render on the target host. Inspect the
   output for correct edges, labels, selected node, legibility, and clipping.
   Keep the source and rendered image for recovery.
3. Do not send repository names, titles, graph data, or encoded diagram source
   to a public rendering service. Do not install a renderer or browser silently.
   If local rendering is unavailable, report the prerequisite and obtain
   approval for setup; do not substitute a code fence or pretend rendering
   succeeded.
4. Present the image, target PR, upload destination and visibility, and exact
   description change for approval. Creation approval alone does not authorize
   an undisclosed upload or body replacement. Use the target provider's verified
   native attachment workflow and configured authentication; never extract tokens.
   Verify attachment access is appropriate for the repository.
   In the skill's explicit [auto mode](../SKILL.md#invocation-scoped-auto-mode),
   inspect and approve these exact routine in-scope effects without a human
   prompt. Renderer setup, unsupported upload/access mechanisms, and unexpected
   concurrent body changes remain blockers; auto mode does not authorize setup
   or overriding another skill's approval requirements.
5. Upload and embed the image, preserving the current PR description. A
   filesystem path, base64 payload, expiring preview URL, or unauthenticated
   external rendering URL is not an acceptable attachment. If the host cannot
   provide a supported durable image location, stop this step and report the
   limitation instead of silently omitting the image.

For GitHub, probe whether the installed `gh` and target host support
`gh pr edit --attach` before relying on it. For other hosts, including GHES and
ADO, verify their actual supported upload mechanism; do not assume GitHub's
attachment behavior applies. If a compatible media-upload skill is available,
follow it without making that skill a portability requirement.

The bundled helper does not render Mermaid or upload attachments. These are
mandatory agent steps around its approved PR operations. Do not fabricate a
helper command, add a rendering dependency to the product repository, or use
an unapproved upload service to bypass a missing capability.

## Description placement and preservation

Maintain one separately bounded block:

```markdown
<!-- pr-graph:diagram:begin -->
![DAG snapshot for graph feature; THIS PR is node c.](<hosted-image-url>)
<!-- pr-graph:diagram:end -->
```

Use the real durable image URL and meaningful alt text. Place this block
**after all human-written content and the helper's graph footer**, with nothing
but whitespace following the closing marker. Do not put the image inside the
helper footer: that footer is regenerated independently.

Fetch the latest body immediately before editing. Reject malformed, duplicate,
or reversed diagram markers. Preserve all content outside the diagram block,
including human edits and the helper footer, byte-for-byte; move the managed
block to the end if human text has since been appended. Recheck for concurrent
body changes and replan instead of overwriting them. Include the final block in
provider description-limit checks; never truncate human content to make it fit.

After writing, read back the exact PR and verify the hosted image reference,
correct selected node, single managed block, preserved surrounding text, and
end-of-description placement. Verify the uploaded image is accessible and is the
inspected rendering, not just that some image URL appears in the body.

## Keep the snapshot current

After a PR is created, append its image before reporting the node's publication
complete. After publishing a batch, refresh earlier PRs to include the final
publication state and known PR identities. Apply the same requirement when
adopting an existing PR.

Refresh affected images on all existing graph PRs when dependencies, node
membership, publication, draft/readiness state, or landing/supersession state
changes, including after sync and graph transformations. A body replacement
through `describe` must retain or restore the current diagram as the last block.
Keep unchanged images when their depicted state is still current; do not append
duplicate blocks or repeat successful uploads after partial failure.

An image-update failure does not undo a created PR or completed merge. Retain
the PR identity, rendering, and any successful attachment URL, report the exact
incomplete updates, and resume only those approved steps. Never recreate a PR
or repeat a merge merely to repair its diagram. Local-only nodes have no PR
description and need no hosted image.
