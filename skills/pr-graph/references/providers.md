# Provider contracts and limitations

## Resolution

Remote and integration-target choices are explicit when ambiguous. Resolve the
remote default branch rather than assuming `origin` or `main`. Pin repository
identity separately from local paths and preserve node IDs through rewrites.

Supported transports include local paths/file remotes, GitHub SSH/HTTPS, explicit
GitHub Enterprise hosts, and Azure DevOps SSH/HTTPS service remotes. Use
`provider.kind: "local"` to opt out of hosting. Do not treat an unknown host as
GitHub without confirmation. Fork PRs and cross-repository graphs are out of
scope.

## Local Git

No `gh`, `az`, or hosting authentication is needed. Graph creation, splitting,
validation, helper bases, explicit readiness, merge/squash/rebase landings, and
optional Git-remote backup use the same core.

The integration branch cannot be checked out in another worktree when it must
move. External ancestry can prove an unambiguous landing; an ambiguous external
squash/rebase is a reconciliation blocker. Prefer the helper's explicit merge
operation, which records source, target, strategy, and landing commit.
For an external local landing, an approved `record-landing` plan can establish
the mapping only after exact own-change replay and target ancestry verification.

## GitHub and GitHub Enterprise Server

Use `gh` with explicit hostname and repository. The adapter uses native
`gh api` operations for PR lifecycle and an expected-head merge API rather than
`gh pr merge` behavior that may implicitly enable auto-merge or enqueue work.
GraphQL handles draft transitions. Paginate PR/file discovery.

Readiness requires the expected head, target/base, own-only diff, landed
dependencies, and current approved local validation. Merging additionally
requires observable clean mergeability, satisfied checks, and no outstanding
required review/rejection state. The server remains authoritative for branch
protection and allowed strategies. Unknown/pending facts block.

No administrator bypass, implicit auto-merge, branch deletion, or merge-queue
bypass is requested. If a repository requires a queue or unsupported capability,
report that constraint; do not weaken the gate to make the command succeed.

## Azure DevOps

Use configured native `az` authentication and commands. Read/create/policy
operations use the DevOps extension; target/draft updates and explicit strategy
completion use `az rest` with its configured authentication.

Do not extract, print, export, or put bearer tokens in temporary files. In an
environment with an approved auth broker/shim, follow that environment's
instructions. A broken authentication bridge is a blocker, not permission to
use another credential path.

The helper disables Azure CLI's dynamic extension installation. Install required
tools separately with approval. Executable-plus-argv invocation never joins
arguments into a shell command. Environments exposing only a `.cmd`/shell wrapper
that Node cannot launch must supply an approved executable invocation or report
the launcher limitation; do not work around it with unsafe shell quoting.

Retarget support is conditional. Read back every requested target, draft, and
description update; an ignored update is a failure. ADO descriptions are
bounded at 4000 characters by the adapter. Propose a shorter body explicitly;
do not truncate human text.

Policy checks paginate evaluation results, require enabled blocking policies to
pass, check required reviewer votes, and require successful merge status.
Completion explicitly disables policy bypass and source-branch deletion.
Asynchronous completion is not reported as a merge until confirmed completed.

ADO plans disclose non-atomic push behavior. Journals record partial progress;
there is no transaction across Git pushes, PR updates, and metadata snapshots.

## Dependency enforcement

Blocked PRs remain drafts against tool-owned bases. The helper refuses to ready
or merge them and refuses to merge into a helper target. It does not install
repository checks/policies and cannot stop every external UI/API action.

Detect and stop on observable unexpected heads, targets, closures, or
out-of-order landings. Do not silently reinterpret an external edit as a change
to the approved own delta or dependency graph.

## PR diagram images

Follow the [diagram workflow](pr-diagrams.md) after PR creation and when graph
state changes. Render Mermaid locally, highlight the node belonging to the
target PR, and place the hosted image in a separate managed block at the end
of the description. Preserve the helper footer and human text.

Probe rendering and provider attachment capabilities before publication.
Description-size checks include the image block. Unsupported uploads, access
problems, and failed readback are explicit blockers to completing this step;
do not fall back to public rendering services, local paths, or a Mermaid code
fence. The helper's lifecycle adapters do not upload images automatically.

## Validation status

Protocol fixtures and real local/bare Git integration tests exercise the
adapters' contracts and graph lifecycle. They are not live hosting certification.
Run live tests only against explicitly approved disposable repositories and
document the actual provider/server versions and capabilities tested.
