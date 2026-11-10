Do any of the changes in this session already exist in the dag that this branch is a part of? If they don't, should any of them be moved to another node? Use auto mode for the `pr-graph` skill.

For follow-up allocation, use the skill's absorb workflow on an explicitly
selected pinned delta. Do not stage or commit dirty work implicitly. Propose
per-hunk owners using retained own patches and dependency context, leaving
ambiguous, cross-node, binary and inactive-owner cases unassigned for an explicit
decision. Show the complete exact plan, including amended ownership, preserved
identities, descendant reconstruction, validations and expected full tree.
Absorb and any checkpoint preservation require human approval even in auto mode;
publication and readiness remain separately authorized.
