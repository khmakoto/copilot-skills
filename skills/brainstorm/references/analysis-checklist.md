# Repository Analysis and Suggestion Quality

Use this checklist to gather representative evidence and produce a diverse,
high-signal suggestion queue. It is guidance, not a requirement to exhaustively
read every source or produce one suggestion from every category.

## Evidence sources

Inspect the sources that exist and are relevant:

- repository instructions and contribution guidance;
- README, product goals, roadmaps, architecture decisions, design documents, and
  user-facing documentation;
- top-level structure and ownership boundaries;
- primary application and library entry points;
- central domain models, services, APIs, UI flows, and data paths;
- tests, fixtures, test coverage patterns, and untested critical paths;
- dependency manifests, lockfiles, compiler settings, and runtime configuration;
- CI, release, deployment, observability, and operational automation;
- accessibility semantics, keyboard interactions, focus management, color and
  motion behavior, and responsive layouts where UI exists;
- authentication, authorization, secret handling, input validation, trust
  boundaries, dependency risk, and sensitive-data flows;
- performance-sensitive loops, queries, rendering, network use, caching, and
  concurrency;
- recent commits and recurring change hotspots;
- representative open and closed issues or work items;
- active, completed, closed, and abandoned pull requests;
- existing labels, tags, milestones, releases, and repository conventions.

For large repositories, begin with breadth:

1. map major subsystems and user journeys;
2. sample central and recently active code;
3. inspect issue and pull request themes;
4. deepen only where a candidate needs validation.

For minimal repositories, stay honest about the evidence. Suggestions may focus on
foundational product definition, repository scaffolding, contribution readiness,
architecture decisions, or validation strategy, but must not pretend that missing
implementation was inspected.

## Opportunity taxonomy

Consider all applicable areas:

| Area | Examples |
|---|---|
| Feature | New user capability, integration, workflow, automation, or product extension |
| Bug | Incorrect behavior, edge case, data loss, race, error handling, or compatibility defect |
| Accessibility | Semantics, keyboard support, focus, contrast, motion, screen-reader experience, or inclusive content |
| Security | Authentication, authorization, injection, secrets, supply chain, privacy, or unsafe defaults |
| Reliability | Recovery, retries, idempotency, consistency, fault isolation, or resilience |
| Performance | Latency, throughput, memory, rendering, query efficiency, caching, or scalability |
| Testing | Missing coverage, brittle tests, realistic fixtures, integration testing, or regression protection |
| Developer experience | Setup, local workflow, diagnostics, tooling, debugging, or feedback speed |
| Code quality | Duplication, complexity, unclear contracts, typing, error propagation, or maintainability |
| Repository organization | Structure, ownership, contribution guidance, automation, templates, or discoverability |
| Architecture | Boundaries, coupling, dependency direction, extensibility, state management, or data design |
| Documentation | User, API, operational, architectural, onboarding, or troubleshooting documentation |
| Design and UX | Information architecture, interaction design, consistency, responsiveness, content, or visual hierarchy |
| Observability | Logging, metrics, tracing, auditability, diagnostics, or actionable alerts |
| Delivery | CI/CD, release safety, environments, migrations, rollbacks, packaging, or dependency updates |

Use a concise area label suitable for repository taxonomy, such as `feature`,
`bug`, `accessibility`, `security`, `performance`, `testing`, `developer-experience`,
`code-quality`, `architecture`, `documentation`, `design`, or `operations`. Prefer
an existing repository label or tag with equivalent meaning.

## Suggestion quality bar

A suggestion is ready for the queue only when it answers:

1. **What should improve?** State one coherent outcome.
2. **Why does it matter?** Identify user, maintainer, risk, or delivery value.
3. **What supports it?** Cite concrete files, docs, behavior, issue/work item
   themes, PR history, or a clearly identified absence.
4. **What would success look like?** Give an observable result or acceptance
   direction without pretending to have a complete implementation design.
5. **Is it already tracked or done?** Check open items and current code.
6. **Is it distinct?** Merge candidates that share the same root cause.

Reject or revise:

- generic best-practice checklists with no repository evidence;
- style preferences without meaningful impact;
- speculative vulnerabilities without a plausible trust boundary or failure path;
- features that conflict with stated product goals;
- duplicates of existing open items;
- tasks already completed by current code;
- enormous rewrites when a bounded improvement captures the value;
- suggestions whose evidence is only an unavailable source.

Closed items and abandoned pull requests are context, not an automatic veto.
Reconsider an old proposal only when current evidence, changed constraints, or a
narrower scope materially alters the case.

## Diversity and ranking

Generate more candidates than needed when evidence allows, remove weak and
duplicate items, then retain up to the requested count. If fewer qualify, report
the shortfall and use the actual retained count; never pad the queue to meet a quota.

Rank by:

- expected user or maintainer value;
- severity or risk reduction;
- confidence in evidence;
- breadth of positive impact;
- urgency;
- implementation feasibility.

Avoid a queue dominated by one obvious category when similarly strong candidates
exist elsewhere. Do not lower the quality bar merely to create artificial
category balance.

## Effort rubric

Use relative implementation complexity, not calendar estimates.

### Low

- localized change with clear ownership and behavior;
- usually limited to one component or a few closely related files;
- little or no migration, compatibility, design, or rollout complexity;
- existing test and implementation patterns can be reused.

### Medium

- spans multiple components or layers;
- needs non-trivial tests, UX decisions, provider integration, or compatibility
  work;
- may require coordinated documentation, configuration, or staged rollout;
- architecture remains substantially intact.

### High

- cross-cutting architectural or product change;
- major data, API, security, migration, or backward-compatibility implications;
- affects multiple subsystems, clients, teams, or deployment stages;
- requires significant discovery or design before implementation.

When uncertain between levels, state the main uncertainty in the suggestion and
choose the higher level only when the risk or coordination justifies it.
