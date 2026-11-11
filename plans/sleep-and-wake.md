---
status: in-progress
depends: [monitor-schedule, live-wake, loop-modes, wake-budget]
specs:
  - specs/skills/opsbot-core.md
---

# Plan: sleep after a quiet stretch, wake on an event

## Why

Replaying two bots' session logs under this rule (compact after 60 quiet minutes, make no
call until something happens) gave these daily costs, in input-token equivalents at list
ratios (cache read 0.1, one-hour cache write 2, output 5). The no-sleep model matched each
bot's real usage within 5%.

| Bot | Today | Compact and sleep | Compact only | Sleep only |
| --- | --- | --- | --- | --- |
| A dispatcher, 750k window | 6.7M | 1.5M (23%) | 3.0M (45%) | 3.4M (51%) |
| The same traffic at 300k | 3.6M | 1.3M (36%) | 2.8M (76%) | 1.8M (49%) |
| A busy strategist, 965k window | 21.8M | 9.4M (43%) | 10.4M (48%) | 19.4M (89%) |

The dispatcher would have slept 88% of the time, with 1.4 sleeps a day. In 40 days only 63
of its 2 300 cycles found anything. For the large-context bot the saving is the compaction;
sleep alone saves little because waking a large context cold costs nearly what the skipped
ticks did.

What the replay could not measure: whether more compactions make the work worse. The
dispatcher goes from 0.4 a day to 1.3; the strategist from 0.6 to 3.5 at a 60-minute
threshold. That is what the trial is for.

## Scope

The spec's *Sleep* section, the `sleep` settings row, and the `check --peek` and
`sleep tick` commands (all in this PR's spec diff).

- `settings.ts`: the `sleep` object, its defaults, and the refusal without
  `loop.schedule: "monitor"`.
- `check.ts`: `--peek`. Adapters run exactly as in a check; nothing is recorded, logged or
  committed. An adapter that cannot run without side effects of its own is the bot's to
  fix; the plan's first step is to read the shipped templates for any that write.
- `cycle begin` (nothing new) and `cycle end`: the sleep decision, `.git/opsbot-sleep`, the
  `sleep` field in place of `wake`, the `sleep` log entry. `cycle begin` clears the file and
  logs `wake` with the reason and the latency.
- `sleep tick`: going down (idle, then `/compact` through the adapter), asleep (wake files,
  peek, due time, `max_minutes`), the unanswered-wake outage. The herdr adapter already
  types a prompt; typing a slash command is the same call.
- `nudge` and `watchdog`: stand down while `.git/opsbot-sleep` exists; `nudge --now` wakes.
- `infra install`: a `sleep` timer at `probe_minutes`, rendered only when `sleep` is set;
  `infra status` and the home view show the state.
- The cold-start pack's wake section and the dispatcher mode section: what a `sleep` field
  means (arm nothing, end the turn) and that a wake arrives as the loop prompt.
- Log reader: `next-delay`, the 48-hour summary and the stopped-outage test treat a
  `sleep`…`wake` span as intended silence, not a gap.

## Not in scope

Sleep in `self` schedule mode. Starting a fresh session at the wake in place of a
compaction. Push for any particular stream: the peek makes every polled stream a wake
source at `probe_minutes`; a push listener only makes its stream faster. Changing any
default: `sleep` absent means today's behavior exactly.

## Order

1. `check --peek` and its tests. Useful on its own.
2. Settings, the sleep decision, the state file, the log entries; `nudge` and `watchdog`
   standing down. Tested with fixtures; no timer yet, so nothing can leave a bot asleep.
3. `sleep tick` and the timer unit, with the unanswered-wake outage.
4. Pack and skill text, the generated reference.
5. The trial, below.

## Validation

- [x] `sleep` absent: every existing test passes unchanged, and `cycle begin`, `cycle end`
      and `next-delay` print what they print today.
- [x] `check --peek` on a fixture with new items exits 10 and leaves the watermark, the
      seen keys, the log and `git status` untouched; the `check` that follows reports the
      same items.
- [x] The decision: quiet for `after_minutes` writes the state file and prints `sleep` and
      no `wake` field; a promise due sooner, or a cycle that found something, does not.
- [x] Asleep: `nudge` does nothing, `watchdog` reports no outage, `nudge --now` wakes.
- [x] `sleep tick` against a stub runtime: types `/compact` once when idle and not before;
      wakes on a wake-file line, on a peek that exits 10 or 20, at the due time and at
      `max_minutes`; does nothing otherwise; `--dry-run` types nothing.
- [x] A wake with no `cycle begin` inside `watchdog_minutes` escalates once.
- [ ] First-hand, on a real session: the typed `/compact` runs while idle, the hook writes
      the pack, no model call follows until the wake, and the wake's first call writes the
      compacted context once (seen as cache creation in the session log).
- [ ] The trial: one dispatcher bot, seven days with `sleep` set. From its logs: calls a
      day and cost equivalents against the seven days before; every wake's latency from
      event to `cycle begin`; no event found late by more than `probe_minutes` plus one
      cycle; no stopped outage; the count of compactions. The operator's read of whether
      its work got worse decides whether the setting is recommended for dispatchers.

## Risks

- **A bot asleep through something it should have seen.** The peek runs the same adapters
  as the check, so a stream the check would catch, the peek catches. A failing stream wakes
  the bot (exit 20). `max_minutes` bounds the worst case.
- **Compaction quality.** More compactions is the cost. The pack carries the bot across; the
  trial is where it shows.
- **The idle test.** `/compact` typed into a working session would be wrong. The tick uses
  the same idle test the nudge uses, including the session-log check for an ended turn.
