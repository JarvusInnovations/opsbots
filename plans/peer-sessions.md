---
status: done
done: 2026-11-10
depends: [pack-via-session-axi]
specs:
  - specs/skills/opsbot-core.md
  - specs/principles.md
---

# Peer sessions: a session log as a stream

## Scope

`templates/heartbeat.d/50-peer-sessions`: a heartbeat adapter that reads each peer session
named in `streams.peers.sessions` through `agent-recall-axi` and prints the operator's messages
to the peer verbatim, the peer's state-changing statements, and a rollover item. The principle
says a peer is topology, not a mode. No peers block beyond the stream's own values.

## Validation

- [x] No peers: nothing printed, exit 0.
- [x] Operator messages verbatim; peer statements only on a state match; keys are event ids;
      a custom `state_pattern` and `max_text` are honoured.
- [x] One rollover item for a newer session; none for the watched session or the bot's own.
- [x] An unreadable peer exits non-zero and the other peers still report.
- [x] Run against a live dev-foreman session over three hours: seven state-change items, no
      false rollover.
- [x] Full suite passes; bundle and SKILL.md `--check` clean.

## Notes

- 2026-11-09: Chris asked whether a ride-along dev foreman is a third mode. The first pairing
  ran this as a hand-written section of one bot's tick; this is the generic form.
- Not here: moving that first bot onto the adapter (it is not on the kit yet).
