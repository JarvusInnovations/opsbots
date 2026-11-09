---
status: done
done: 2026-11-07
depends: []
specs:
  - specs/skills/opsbot-core.md
pr: 23
---

# The session log in the cold-start pack

## Scope

After its first compaction the second kit bot resumed from the summary and the pack, and
never looked at its own session log. The summary is lossy and not ours to control, and the
operator's own words in the log are the highest-authority record of intent there is. The
SessionStart hook hands `cold-start` a JSON payload with `transcript_path`, so the pack
now carries a "Before this start" section read from the log since the last compaction, in
three layers with different standing: the operator's messages verbatim (turn-initial and
mid-turn), the last twelve tool calls with result heads as data, and the bot's last three
statements flagged as its own claims. Model-free; the gate forces it to be read. The
footer line is reworded: what you remember is untrusted; the record and the session log
are sources; the operator's words outrank everything.

## Validation

- [x] Fixture log with a compaction marker, a turn-initial message, a mid-turn message, a
      slash-command fragment, a tool call and result, and an assistant statement: the
      section carries only post-compaction content, the operator's words verbatim and first,
      the call with its result, the statement in quotes, and the command fragment is dropped.
- [x] No transcript, no section; pack order and budget tests still hold (97 tests).
- [x] Spec row and footer updated; bundle rebuilt.

## Notes

- 2026-11-07: Chris: "human messages in the transcript are the most trustworthy data we
  have." The section and the footer are written around that. The richer reader (pan, zoom,
  find across sessions) is `agent-session-axi`; this stays a small embedded reader.
