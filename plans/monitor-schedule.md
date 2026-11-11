---
status: done
done: 2026-11-11
depends: [live-wake, loop-modes]
specs:
  - specs/skills/opsbot-core.md
  - specs/principles.md
  - specs/architecture.md
pr: 59
---

# The schedule monitor: one bounded monitor as the loop's clock

## Scope

A new setting, `loop.schedule`: `self` (the default, unchanged) or `monitor`. With
`monitor`, one bounded `Monitor` is both the schedule and the live wake.

- `wake.ts`: the schedule command. It bakes in the seconds until the next cycle is due,
  polls every 2 seconds, and exits on a new line in any wake file (each prefixed with the
  file's basename, cut to 300 characters) or with one line, `cycle due`. Its `timeout_ms`
  is the deadline plus 60 seconds. With no wake files it is only the timer.
- `cadence.ts`: in monitor mode no delay passes 1 740 seconds, and the reason says when
  that cap applied.
- `cycle begin` (exit 0 and 30) and `cycle end` print a `wake` field with the state and
  the one call to make now. An armed monitor due later than the next cycle is stopped and
  replaced, never doubled. No self-paced guidance in this mode.
- `transcript.ts`: `lastMonitorCall` takes a matcher, so the schedule monitor is found by
  its description (`<bot> schedule`) and read as armed until its own baked deadline.
- The cold-start pack's wake section, in monitor mode, carries the state and the schedule
  rules, with or without wake files.
- `settings validate` refuses a `loop.prompt` that starts with `/` in monitor mode.
- The nudge's unset `nudge_minutes` and `nudge_cooldown_minutes` default to 35 in monitor
  mode. Explicit values win.
- Template comment, SKILL.md "A cycle", the generated command reference, the principle
  note.

## Not in scope

Changing the default. The per-file live wake in `self` mode. The nudge's turn-ended check.
Anything in opsbot-host.

## Validation

- [x] `self` explicit and unset print the same `cycle begin`, `cycle end` and `next-delay`
      output; every existing test passes unchanged.
- [x] Monitor mode: `cycle begin` (nothing new, at night) prints one call with
      `+ 1740` and `timeout_ms: 1800000`, no ScheduleWakeup text; a held begin prints no
      call; `cycle end` prints one call due at the next wake (hot: `+ 180`,
      `timeout_ms: 240000`); a refused begin (exit 30) prints the call too.
- [x] The generated command, run in bash: exits with `cycle due` at a 3-second deadline;
      exits with the new lines, basename-prefixed and cut to 300, when a wake file grows
      (a second, missing file counts as empty).
- [x] `next-delay` caps at 1 740 with `(capped at 29 min: a monitor's limit)`; a delay
      under it is untouched; the command prints the capped value.
- [x] `settings validate` refuses a slash prompt in monitor mode only, and an unknown
      schedule.
- [x] Nudge defaults: 35 in monitor mode, 50 in self mode, explicit values win; a loop
      quiet 40 minutes is nudged with the plain prompt in monitor mode and not in self mode.
- [x] State from a session-log fixture: armed until the baked deadline; expired, ended by
      a `cycle due` notice, or another bot's monitor is not armed; `cycle end` says
      nothing to do, or stop and replace when the armed one is due later.
- [x] The pack: monitor mode carries every schedule rule (even with no wake files) and not
      the per-file rules; self mode keeps the per-file rules.
- [x] 160 tests pass; `tsc --noEmit` clean; bundle and SKILL.md rebuilt and `check` clean.
- [ ] Trial on one bot.

## Notes

- Measured on a live bot: a wake that re-enters `/loop` adds about 8,000 characters each
  time, the command's body expanded again, about 80% of what a quiet cycle adds to the
  context. A monitor wakes the session with one short line.
- Decided by the operator 2026-11-10. Trial on one bot before the default changes.
- A wait (exit 30) prints the call as well as `next`, so a refused cycle still has a
  wake. A held `cycle begin` (exit 10 or 20) prints none: `cycle end` arms.
- The pack does not print the call: it says to run `cycle begin`, which prints it with
  the due time of that moment.
