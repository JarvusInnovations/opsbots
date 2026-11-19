---
status: done
done: 2026-11-18
depends: [fast-wake]
specs:
  - specs/skills/opsbot-core.md
  - specs/skills/opsbot-slack.md
  - specs/skills/opsbot-whatsapp.md
pr: 114
---

# Plan: one wake backstop, in the core

## Scope

`opsbot-core wake backstop`, and the Slack listener and the WhatsApp waker calling it in place
of their two copies of `makeWaker`. No change in behaviour or log lines.

## Validation

- [x] Every case the listeners' wake tests cover passes against the command: key seen in the grace, a newer check, a cycle already running, asleep, grace 0, a burst, a cooldown outcome, a refusal that keeps waiting, the 30-minute limit
- [x] Both listeners spawn it detached, one at a time, and log its line; their own copies are gone
- [x] The ack reaction and the read receipt still wait for the seen key
- [x] Every existing test passes

## Notes

Built in PR 114. Where each box is tested:
- The command: `tests/backstop.test.ts`, one test per case (seen in the grace; a newer check
  line, and a newer finish line that does not count; a running cycle, then nudged after it; the
  cycle ending with the key seen or a newer check; the grace expiring; asleep; grace 0; three at
  once sharing one nudge through the nudge's claim; a cooldown outcome; a mid-turn refusal noted
  once and kept waiting; the limit, shortened by `OPSBOT_WAKE_LIMIT_MS`; an unreachable runtime;
  usage errors). The runtime is the file-backed fake (`OPSBOT_RUNTIME_FAKE`), so the real
  `nudge --now` runs in process and its `outcome` decides.
- Spawned, one at a time, logged: "the wake: the core's backstop, one at a time" in
  `tests/slack.test.ts` and the backstop tests in the `monitor.d/20-whatsapp-waker` block of
  `tests/whatsapp.test.ts` (arguments, `OPSBOT_ROOT` and the tick passed on, notes and line in
  the journal, a burst being one run, a core that cannot run). `makeWaker` and
  `cycleBegunSince` are gone from both templates.
- Ack and receipt: "the ack reaction waits for the seen key, whatever the backstop said" (Slack),
  "the read receipt waits for the seen key, whatever the backstop said" and the mark-read tests
  (WhatsApp).
- `bun test`: all pass on the branch. Two timing tests flaked under heavy load
  (`watchdog > escalates once…`, WhatsApp `mark-read…`); the second flaked the same way on
  unchanged `develop`, and its fixed sleeps were replaced with waits for the condition.

Deviations and choices within the spec:
- The command prints TOON like every core command: `backstop: <line>`. Progress notes (`a cycle
  is running: waiting for it to end`, `asleep: nudging at once`, `nudge pending: …`) go to
  stderr, one per line, and the listeners log them as they come, so the journal keeps the lines
  it had. The final lines are the spec's: asleep now ends `asleep: nudged` (it was `nudged after
  <n>s`), a cooldown `already woken` as before, and the 30-minute end is logged
  `! wake gave up for <key>` (it was `! wake timed out for <keys>`).
- The nudge runs in process (`nudgeCommand`), so a test needs no stand-in core; its exit 1 on a
  runtime failure is reset, and the backstop always exits 0.
- One key per run. An event that arrives while a run is pending joins it; when that run ends
  `woken by monitor`, one more runs for the newest event that joined, since the check that
  answered may have begun before it arrived (the old wake started a new one for late events the
  same way). After a nudge, the joined events are covered by the prompt.
- The wake's limit is the spec's fixed 30 minutes; `ack_timeout_minutes` now bounds only the ack
  and the read receipt.
- A WhatsApp line whose event cannot be resolved still gets a wake, under `whatsapp:seq:<seq>`,
  a key no check records.
- Tick and limit are shortened for tests by `OPSBOT_WAKE_TICK_MS` and `OPSBOT_WAKE_LIMIT_MS`; a
  listener passes its own test tick on.

## Follow-ups
