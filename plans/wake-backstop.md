---
status: planned
depends: [fast-wake]
specs:
  - specs/skills/opsbot-core.md
  - specs/skills/opsbot-slack.md
  - specs/skills/opsbot-whatsapp.md
---

# Plan: one wake backstop, in the core

## Scope

`opsbot-core wake backstop`, and the Slack listener and the WhatsApp waker calling it in place
of their two copies of `makeWaker`. No change in behaviour or log lines.

## Validation

- [ ] Every case the listeners' wake tests cover passes against the command: key seen in the grace, a newer check, a cycle already running, asleep, grace 0, a burst, a cooldown outcome, a refusal that keeps waiting, the 30-minute limit
- [ ] Both listeners spawn it detached, one at a time, and log its line; their own copies are gone
- [ ] The ack reaction and the read receipt still wait for the seen key
- [ ] Every existing test passes

## Notes

## Follow-ups
