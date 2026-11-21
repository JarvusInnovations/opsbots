---
status: done
done: 2026-11-20
depends: [wake-race, sleep-and-wake]
specs:
  - specs/skills/opsbot-core.md
issues: [122]
pr: 126
---

# Every wake path waits from the count taken at cycle begin

## Scope

An adopting bot lost one wake: a line was appended to a wake file while the loop was mid-turn,
`nudge --now` stood down, and the monitor armed afterwards counted the line as already there.
The issue asks that both monitors start from the count recorded at `cycle begin`.

`wake-race` (PRs 101/102, released in v0.15.0) already did that for both monitors: `cycle begin`
records `<git dir>/opsbot-wake-base` as its check starts; `wake wait` (the schedule monitor) and
the per-file arm call start there; `cycle end` reports `arrived` from it. A bot on a kit before
v0.15.0, or a session still holding the pre-v0.15.0 command, has the defect as the issue
describes it.

One path was left: the sleep. A quiet `cycle begin` (or `cycle end`) that decides a sleep took
each wake file's count at the decision, after the check had run, so a line written while the
check ran was inside the sleep's count and never woke it. The sleep now copies the wake base,
counted in the same unit (newlines, as `wc -l` and the monitors count).

Out: a marker left by a refused `nudge`. A line written during a cycle is reported by that
cycle's `cycle end` (`arrived`, from the base); one written after it is delivered by the monitor
armed next (it starts at the base) or wakes the sleep (now from the base). A marker would report
the same line a second time.

## Implements

`specs/skills/opsbot-core.md`: The live wake ("armed from where the last check read to, never
from now"), the `sleep tick` wake on a wake-file line, the `.git/opsbot-sleep` counts (one-line
clarification: the count is the one the deciding cycle's check started from).

## Approach

- `decideSleep` takes the wake base; `wakeLineCounts` returns the base's count per file, the
  count now for a file it does not name. `cycle` passes `readWakeBase(root)`.
- `sleep.ts` uses `wake.ts`'s `lineCount`, so the sleep timer compares counts in the base's unit.
- Tests run the commands `cycle begin` actually prints: `wake wait` and the per-file poller after a
  line appended between begin and arming, after a rotation, and with nothing new; a heartbeat
  input that writes the wake file while the check runs, before a sleep.

## Validation

- [x] Schedule monitor: a line appended after `cycle begin`, before arming, is printed at once by
      the printed `wake wait` call.
- [x] Per-file monitor: the printed command, run after such a line, prints it at once.
- [x] A file rotated since `cycle begin` is delivered from its start, on both monitors.
- [x] Nothing new: `wake wait` prints `cycle due` at its time; the per-file poller keeps waiting.
- [x] A line written while a quiet `cycle begin`'s check runs: the sleep's count is the one the
      check started from, and the next `sleep tick` wakes the session instead of compacting it.
- [x] A quiet sleep with nothing written still compacts and is not woken.
- [x] The monitor tests fail with the base dropped (arm-time counting, as the issue describes); the
      sleep test fails on `develop`'s source.
- [x] Full suite, type-check, bundle and SKILL.md `--check` clean locally; CI green.

## Risks / unknowns

- A sleep file written by an earlier kit counted an unterminated last line; on upgrade such a file
  reads one line shorter and wakes once. Wake files are newline-terminated JSONL.

## Notes

The issue's text quotes the pre-v0.15.0 shell poller (`n0=$(c "$f0")`); the kit has not printed
it since `wake-race`.

## Follow-ups

None.
