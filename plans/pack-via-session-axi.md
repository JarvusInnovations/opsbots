---
status: done
done: 2026-11-09
depends: [pack-session-log]
specs:
  - specs/skills/opsbot-core.md
pr: TBD
---

# The pack's session-log section through agent-session-axi

## Scope

The "Before this start" section is now read by `agent-session-axi` 0.1.0 (a pinned dev
dependency, inlined into the committed bundle) instead of the kit's text reader, which keyed on
the rendered compaction and mid-turn strings. The library reads the log's structure:
`compact_boundary`/`isCompactSummary`, `queued_command` attachments, `!` commands, hook output.
Layers get their own shares (operator messages 2 400 bytes newest-first and whole; 10 calls; 3
statements), because the library's own resume pack drops every call and claim before any older
operator message and so returns neither on sessions with long pasted text. The loop prompt is
excluded from the operator layer. The kit's reader stays as the fallback.

## Validation

- [x] On a real kit-bot log the section shows the operator's typed words only (the nudge's loop
      prompt excluded), the last 10 calls with ok/error/pending status, and the last statements.
- [x] The cold-start test uses the log's real shapes (compact_boundary, queued_command) and
      passes; the whole suite passes; `check` is clean.
- [x] The committed bundle, copied alone with no node_modules, renders the library section.

## Notes

- 2026-11-09: Chris: "Switch the cold-start pack to agent-session-axi". The resume pack's
  all-or-nothing drop order for C layers is the library's spec for its own command and is kept;
  the kit composes the library's readers instead of calling `buildResumePack`.
