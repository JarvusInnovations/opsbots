---
status: planned
depends: [monitor-schedule, sleep-and-wake]
specs:
  - specs/skills/opsbot-core.md
  - specs/skills/opsbot-slack.md
  - specs/skills/opsbot-whatsapp.md
issues: [106]
---

# Plan: a wake that costs what it needs

## Why

A bot answering a chat message spent 23 of 31 seconds checking inputs the wake had nothing to
do with, made five model calls where three would do, re-typed a 600-token poller at every
cycle, and left messages that arrived mid-turn waiting for a monitor to be armed and fired.

## Scope

In: the core (`cycle begin`, `cycle end`, `check`, the new `wake wait`, the arm call and its
recognition in the session log, the pack's rules), both channel skills' `install` output and
listeners' logging, their tests, SKILL.md and README text. Out: running inputs concurrently;
any change to what an input script is.

## Implements

`specs/skills/opsbot-core.md`: "A fast cycle", the `wake wait` command, the schedule monitor's
new command and state, the `check` setting, the `cycle begin` and `cycle end` rows. The
`install` line in both channel skills.

## Approach

1. `wake wait`: the poller as a core command, from the recorded counts; the arm call printed in
   the new form; the session-log reader recognising all three forms.
2. `wake.files` object entries; the fast check and its conditions; `--full`; the cycle log's
   `fast` line; the watermark left alone.
3. `cycle end`: `arrived` and `next 0 arrived`.
4. The pack rules; the listeners' once-per-wake log line; `install` output.

## Validation

- [ ] `wake wait` delivers a line appended after the recorded count at once, waits otherwise, prints `cycle due` at its time, refuses a time more than 1 800 seconds ahead; its output matches the old poller's
- [ ] The arm call is the short form, and a session log holding either old form is still read as armed until the right time
- [ ] A wake from a file that names its inputs runs only those inputs, leaves the watermark, marks the log line `fast`, and a later full check reports nothing twice and misses nothing (an item that arrived for a skipped input during fast cycles is reported by the next full check)
- [ ] Each condition that forces a full check does: no named inputs, a full check older than `check.full_minutes`, a failed input, `--full`, `cycle due`, `check.full_minutes: 0`
- [ ] `cycle.d/begin/` scripts run on a fast cycle only when named `.fast`
- [ ] `cycle end` prints `arrived` and `next 0 arrived` with no `wake` field when a wake file grew since the check, and the usual fields otherwise
- [ ] The watchdog and `next-delay` treat a fast cycle as a cycle; a run of fast cycles does not postpone a full check past `check.full_minutes`
- [ ] Both skills' `install` print the object form; both listeners log a mid-turn refusal once per wake
- [ ] Every existing test passes

## Risks

- An input that keeps its own cursor (the WhatsApp reader) advances it on a fast check; that is
  correct, since the seen keys record what it reported.
- A repository-sync script in `cycle.d/begin/` no longer runs on every wake; a bot that relies
  on it per cycle keeps it un-suffixed and gets it on every full check.

## Notes

## Follow-ups
