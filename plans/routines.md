---
status: done
done: 2026-11-14
pr: 90
depends: [memory-in-repo, sleep-and-wake]
specs:
  - specs/skills/opsbot-core.md
  - specs/permissions.md
  - specs/architecture.md
---

# Routines: recurring work in every bot, with the memory review as the first

## Scope

One working bot built a routines system of its own: definitions and runs as two gitsheets
sheets read through an external CLI, a script that computes what is due, a `heartbeat.d/`
script that turns a due routine into a check item, and a `cycle.d/end/` script that lists it
at the close. It ran a week of real runs. This plan lifts the behaviour into the kit as a
standard part of `opsbot-core`, and makes the memory review the first built-in routine. The
operator's decisions:

- **Definitions are the bot's program; runs are its record. They live apart.** Definitions
  are `routines/<id>.md` (schedule in the frontmatter, instructions in the body); runs are
  one record each under `records/routine-runs/YYYY/MM/`. Both paths are settings
  (`routines.dir`, `routines.runs_dir`).
- **Definitions are governed** like the rule card: spec'd in `opsbot-core.md`, in
  `permissions.md` among what a bot may not change on its own, and in the pack. The core
  reads them at `HEAD` and never writes to them.
- **Zero runtime dependencies.** The core reads and writes the files itself; the format is
  gitsheets' markdown record, with optional sheet configs shipped as templates.
- **No model cost when nothing is due.** A due routine is one check item per occurrence;
  `cycle end`, the pack, `check --peek` and the sleep decision all see it.
- **Memory review is a routine.** The built-in `memory-review` replaces the memory feature's
  own due logic; `memory review --done` records a run.

Out of scope: moving any running bot's routines (see *After this plan*); a `routines add`
scaffold (decided against, below); grace periods and "overdue" (the source had them; the
operator's design does not ask for them, and the item already says when it became due).

## Approach

- `src/opsbot-core/frontmatter.ts`: a small TOML-frontmatter reader and writer. Reads basic
  and literal strings, whole numbers, booleans, bare dates (as strings) and arrays, across
  lines, with comments; refuses tables, multi-line strings, dotted keys and YAML `---`
  frontmatter with a reason. Writes sorted keys, double-quoted strings, one-line arrays.
- `src/opsbot-core/routine-store.ts`: definitions (read at `HEAD` through `git ls-tree` and
  `git show`, or the working tree), validation with every problem named, runs (read from the
  working tree, written by `writeRun`, never overwritten: `-2`, `-3` on a same-minute clash),
  the changed-run-file list for commits, and the pure due computation with the slot math in
  the bot's timezone (`Intl`, no library).
- `src/opsbot-core/routines.ts`: the definitions plus the built-in `memory-review` (state taken
  from `memoryStatus`, so the two never disagree), the check items, the `cycle end` and pack
  lines, and the next due times for the sleep decision.
- `check`: a built-in `routines` input after the heartbeat scripts. It is listed only when
  the bot has a definition file at `HEAD` or there is an item or a problem, so a bot without
  routines reads exactly as before. A problem fails the input by name (degraded). The check's
  and `cycle end`'s commits take changed run files the way they take memory files.
- `cycle end`: a `routines` field, one line per due routine; the memory review keeps its
  `memory` line. The pack: the same lines (five at most, the rest counted) under the cycle-log
  summary, and the `45-routines.md` kit section only when the bot has a definition.
- `dueTimes`: the core adds the next time each routine that is not due becomes due; a broken
  definition keeps the bot awake, as a failing `due.d/` script does.
- Memory: `memoryStatus` reads its last review from the `memory-review` runs, counting the
  `memory-review` cycle-log lines bots wrote before as runs, and uses the bot's own
  `routines/memory-review.md` when there is one. `memory review --done` writes a run record
  and still appends its cycle-log line with the counts.
- Commands: `routines [due [--all]]`, `routines view <id>`, `routines history <id>`,
  `routines done <id> …`, `routines validate [--head]`; `settings validate` also validates
  the definitions.
- Due at the boundary: a routine is due once its interval *has passed* (`now >= last +
  interval`), the same comparison the memory review used, so the next due time the sleep
  decision wakes for is a time the routine is due. The source used a strict `>`.

## Validation

- [x] `bun test`: 14 new tests in `tests/routines.test.ts`, 330 in all, passing. They cover
      the due computation for every cadence and `every`, `since` at local midnight, no
      `since` and no run, inactive, a slot in America/New_York before and after its time,
      satisfied by a later run and not by an earlier one, Saturday with no slot, and the
      spring and autumn daylight-saving changes; deterministic frontmatter round trips and
      refusals; validation messages; the settings; `done` writing the exact run file,
      clearing due, never overwriting, and its refusals; `history` with a missed stretch;
      `validate`, `settings validate` and `--head`; a broken committed definition degrading
      the check by name; a due slot routine as one item, then not again, in `cycle end`,
      under `--peek`, in the pack and in the sleep decision's due times; a run committed by
      the next check; an uncommitted definition changing nothing; a bot without routines
      showing no routines input, field or section; the built-in memory review as one item,
      `memory review --done` recording a run, a legacy cycle-log line counting, the override,
      and `memory: false`.
- [x] Every existing test passes unchanged: no expectation changed. `tests/memory.test.ts`
      asserts the due mechanism through `memory status`, the `memory review due` line in
      `cycle end` and the pack, and the cycle-log line `--done` writes; all still hold.
- [x] A bot without routines prints the same as before: the committed bundle from `develop`
      and the new one, run against two identical throwaway bots (`check --peek`, `cycle
      begin`, `cycle end`, `cold-start`, home, `settings validate`, `check`) with the same
      clock, differ only in the bundle's own path.
- [x] The suite under `env -i` with a fresh `HOME` and a `PATH` of the bun and node install
      directories plus `/usr/bin:/bin`: passes.
- [x] `bun run type-check`, `bun run build`, `bun run check`: clean.
- [x] The built CLI in a throwaway bot: two definitions (weekly from the template, a weekday
      08:30 slot in America/New_York) listed, viewed, reported once by `check`, recorded with
      `done` and two `--checked` items, the run committed by the next cycle.

## Decisions

- **No `routines add`.** Copying `templates/routines/weekly-backup-check.md` and running
  `routines validate` is all a scaffold would do, and leaving it out keeps the rule simple:
  no core command writes to `routines/`.
- **Unknown keys are refused** in a definition, as in `opsbot.json`: a typo such as `cadance`
  would otherwise make a routine silently unscheduled.
- **A slot needs `days`.** The source treated a missing `days` as every day; the kit asks
  for all seven, so "a slot with no days" is a named mistake, never a guess.

## gitsheets compatibility

Matched: TOML frontmatter between `+++` lines (gitsheets rejects YAML `---`), keys sorted,
one record per file named by its id, the runs path `${{ at: YYYY/MM }}/${{ id }}` (UTC, as
gitsheets buckets), the body as a field with the run's `# title` as its first line (so
`title = 'title'` in the runs config holds), string arrays written one line with `", "`
separators and an empty array as `[]`, as the source bot's gitsheets-written records show.
Not matched or not verified: gitsheets normalizes bodies with its markdown formatter on its
own writes, and the core writes bodies as given, so a core-written record may not be
byte-canonical for `gitsheets check` until gitsheets rewrites it; and the configs were not
run against gitsheets itself in this build (it was not available here), only written to
its documented grammar.

## After this plan

- A working bot adopts it and runs a week: read its `routine-runs` records, the items each
  due occurrence made, and whether a slot routine woke a sleeping bot on time.
- **Adoption for a bot that already keeps routines in gitsheets** (two sheets, `routines`
  with `status/id` paths and `routine-runs` partitioned by routine and month, a `bin/routines`
  script, `heartbeat.d/` and `cycle.d/end/` scripts calling it):
  1. In one PR a person merges: for each active routine, write `routines/<id>.md`. Keep
     `id`, `title`, `cadence` (or `at` and `days`; drop `cadence` from a slot routine, and
     give `days = [1, 2, 3, 4, 5, 6, 7]` where it had none), `since`, `owner`. Map
     `status = "active"` to nothing and `paused`/`retired` to `active = false` (or leave a
     retired routine out). Move the fields the kit does not read (`checklist`, `gate`,
     `grace_days`, `audience`, `deliver`, `skill`, `source`) into the body as instructions:
     the checklist as a list under "What to check", where the output goes and through which
     skill under "What done looks like". `routines validate` must pass.
  2. Run history: either move the run records into `records/routine-runs/YYYY/MM/` (the kit
     reads `routine`, `at`, `outcome`, `by`, `checked`, `handed_to` and the body's notes;
     the file name and id need not follow the kit's pattern), or point `routines.runs_dir`
     at the old sheet's root and read them in place: the kit walks every `.md` under it, so
     a `routine/YYYY/MM/` partition reads as well. New runs then land under `YYYY/MM/` there.
  3. In the same PR remove `heartbeat.d/30-routines` and `cycle.d/end/30-routines` (the core
     now does both; keeping them reports each due routine twice) and retire `bin/routines`
     or make it a two-line shim to `opsbot-core routines`. Keep or drop the old
     `.gitsheets/*.toml`; to keep querying with gitsheets, install the kit's templates with
     `root` set to the bot's directories.
  4. After the merge: `routines due --all` lists each routine with the right last run, and
     the first `check` reports only what is truly due. Keys differ from the old script's,
     so a routine due at the switch is reported once more.
- On a bot with memory: confirm the first `memory review --done` writes a run record and the
  next review's due date reads from it.

## Notes

- 2026-11-14: design with the operator: definitions apart from runs, definitions governed
  and read at `HEAD`, zero runtime dependencies, gitsheets-compatible files, one item per
  due occurrence, memory review as the first built-in.
- The source keyed an interval routine's item by the date of its last run; the kit keys it
  by the full time, so two runs on one day cannot collide.

## Follow-ups

- `opsbot-host status` or the home view could show the count of due routines.
- A monthly day-of-month slot (`on = 1`), which the source also left out.
