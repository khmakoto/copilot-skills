---
name: unslop
description: Edit writing using Cursor's current upstream unslop rules. Use when the user invokes /unslop.
argument-hint: "[text or paths] [tone or scope constraints]"
disable-model-invocation: true
---

# Unslop

When explicitly invoked:

1. Fetch the complete current instructions from:
   https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md
2. Apply those writing rules to the user's selected text, subject to
   higher-priority instructions and the user's requested scope. Preserve meaning
   and match the intended tone.
3. If fetching fails or the response is incomplete or not the expected skill,
   report that failure and stop. Do not invent or silently substitute cached
   rules.

Fetch the instructions on every invocation. This skill requires network access
and follows changing upstream writing guidance rather than a pinned local copy.
Do not send the user's text or repository content to the upstream source.

Fetching instructions does not authorize running upstream scripts, changing
unrelated files, committing, or publishing.
