---
status: done
done: 2026-11-15
depends: []
specs:
  - specs/skills/opsbot-core.md
  - specs/skills/opsbot-slack.md
  - specs/skills/opsbot-whatsapp.md
pr: 102
---

# An event that lands during a cycle is not lost

## Scope

A second message arrived while a cycle was finishing and re-arming its monitor, and was never
picked up. Two causes: the listeners treated the cycle lock as "a cycle has begun since the
event", so they never nudged; and the session's monitor measured the wake file when it started,
so a line appended between the check and the arming was never delivered.

- Listeners: only a check line newer than the event counts; while a cycle holds the lock, wait
  for it to end, then look again and nudge at once if neither the key nor a newer check.
- Core: `cycle begin` records each wake file's line count as its check starts
  (`<git dir>/opsbot-wake-base`); every arm call printed after it starts the poller there.

## Validation

- [x] An event that lands while the lock is held is not treated as woken.
- [x] After the lock clears: key unseen → nudge at once; key seen or a newer check → no nudge.
- [x] An arm call built after a check that recorded N lines, run against N+1 lines, prints the
      new line and exits at once (both the wake and the schedule monitor).
- [x] No recorded count: waits as before. A truncated file is delivered from its start.
- [x] Old-form commands are still recognised in the session log.
- [x] Full suite in CI; bundle and SKILL.md `--check` clean.
