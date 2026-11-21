---
status: done
depends: []
pr: 123
specs:
  - specs/behaviors/log-branch.md
  - specs/skills/opsbot-core.md
  - specs/skills/opsbot-host.md
---

# The cycle log on its own branch

## Scope

The kit's own log (cycles, seen keys, outages, routine runs) is written to the log branch
through gitsheets, and everything in core that read the log files reads the branch. Out of
scope here: bot-declared ledgers and state, the channel skills, and the migration of an
existing bot (`log-branch-ledgers`, `log-branch-migrate`). Until `log-branch-migrate` lands, a
setting (`log.branch`, unset by default) selects the new writer, so released bots are
unaffected.

## Implements

`specs/behaviors/log-branch.md`: "What is on the log branch" (the kit's sheets), "Provenance",
"Watermark", "Quiet cycles", "Pushing", "Readers".

## Approach

1. **A log module in core** that owns every call to `gitsheets-axi --branch <log.branch>`:
   init the branch and its sheet configs on first use (root commit with the program commit as
   second parent), write records in one commit with `Program`, `Watermark` and `Check`
   trailers, read the tip with `head --json-out`, and query sheets. Nothing else in the kit
   shells out to gitsheets for the log.
2. **Cycle commit.** `check` and `cycle end` collect the cycle's records and make one log
   commit. The second parent is added only when the tip's `Program` trailer differs from the
   program head.
3. **Quiet runs.** A quiet cycle replaces an open quiet tip (`commit --allow-empty --replace
   <tip>`, `Quiet-Cycles` one higher, `Quiet-Since` kept) or opens a new one. A tip is open
   when it is quiet, unpushed and from the current hour. `TIP_MISMATCH` and `TIP_PUBLISHED`
   fall back to a new quiet commit, never an error.
4. **Push.** `cycle end` pushes up to the newest sealed commit with `push --to`. A refused
   push is a failed check with the remote's tip named.
5. **Readers.** The watchdog, `next-delay`, the sleep timer, the cold-start pack, the
   fast-check window, the wake backstop and the memory review read through the log module.
   Liveness and the watermark come from the tip's trailers alone.
6. **Host.** `opsbot-host` installs gitsheets-axi 2.15 or later and its status row shows the
   version; `settings validate` refuses `log.branch` without it.
7. **Hook failures (issue 119, the part this makes cheap).** `cycle begin` writes a hook's
   failure or timeout to the log branch as it happens, and the watchdog's message carries the
   newest one.

## Validation

- [x] With `log.branch` set, a cycle that found something makes one log commit and leaves the
      program branch's head and working tree unchanged.
- [x] Two records of one sheet made at the same minute and second of different hours of a day
      are two files (`outages`, `routines`).
- [x] The root holds only the sheet configs; the second parent is on the first log commit
      after it and on the first after the program head moved, and on no other; every log
      commit after the root has `Program`, `Watermark` and `Check`.
- [x] Ten quiet cycles in an hour are one commit with `Quiet-Cycles: 10`; the hour turning and
      a non-quiet cycle each seal it; a sealed or pushed commit is never replaced.
- [x] `cycle end` pushes sealed commits only; the open quiet tip stays local; a refused push
      fails the check and loses nothing.
- [x] A cold start in a fresh clone resumes from the newest pushed `Watermark` and reports
      nothing twice.
- [x] The watchdog, `next-delay`, the sleep timer, the cold-start pack, the fast-check window
      and the wake backstop give the same answers from the branch as from the files, on a
      recorded run replayed both ways.
- [x] A hook that times out leaves a record on the log branch before the cycle ends, and the
      watchdog message quotes it.
- [x] With `log.branch` unset, every existing test passes unchanged.

## Risks

- A gitsheets call per cycle costs more than a file append. Measure a quiet cycle and a busy
  one; the fast cycle's budget in `specs/skills/opsbot-core.md` must still hold.
- Two processes writing the branch at once (a cycle and a hand-run script). The log module
  retries once on `TIP_MISMATCH` for non-quiet writes.

## Notes

- **What gitsheets decided.** gitsheets requires every path-template field in the record, so
  each record carries `at`; and it gives an orphan commit no additional parent, so the root is a
  setup commit and the first log commit after it carries the program as second parent. The
  spec was amended to both (5677533).
- **Trailers (now in the spec):** quiet commits also carry `Quiet-Until` (the last cycle's
  time; a fast check holds `Watermark`, so it cannot say when a fast run was alive) and `Since`
  (the window the last check read, which the fast-check window reuses). A quiet run is replaced
  only by a quiet check of the same `Check` kind on the same `Program`, so the last full check
  is never lost under a fast one.
- **One record per line, not per cycle.** A cycle that found something writes its check line and
  its finish line as two `cycles` records in its one commit (`<mmss>-new`, `<mmss>-finished`),
  so the readers get the file writer's exact lines and liveness is the finish time. Sleep, wake
  and memory-review lines are `cycles` records too; outage ends are `outages` records of kind
  `end`.
- **Staging.** What lands between `check` and `cycle end`, and what the watchdog, `outage`,
  `memory review --done` and `routines` write outside a cycle, is staged in
  `<git dir>/opsbot-log-pending.json` and rides the next log commit, as uncommitted log lines
  rode the next cycle commit before. Readers include it.
- **Reads.** The tip (liveness, watermark) is one `git log` call; when the tip is a sleep commit
  the same call looks a few commits down. Records come from `gitsheets-axi query --json-out`,
  cached per sheet tree in `<git dir>/opsbot-log-cache.json`; the writer updates the cache with
  what it wrote, so a running bot never re-queries its own writes.
- **gitsheets quirk:** an expression on the date-bucket field (`at.slice(11,13)` for the hour)
  receives a Date while a range query walks the partitions and fails the query; the sheet
  configs guard it with `typeof at == 'string'`. `outages` and `routines` paths carry the hour
  (`<hhmmss>`); an outage record also carries `edge` (`start` or `end`) for its path, and an
  end takes the kind of the outage it ends.
- **Program branch.** Memory and `commit_paths` files a cycle changed are still committed there
  (`chore(bot): …`) until `log-branch-ledgers` and `log-branch-migrate`; with nothing changed the
  program branch's head does not move and it is not pushed.
- **Cost, measured** (local bare remote, a shared host under load ~12, medians of 12 runs):
  a quiet `cycle begin` 0.5 s with the files, 0.9 s on the branch (one `gitsheets-axi commit`,
  about 0.7 s of node start-up each, plus a push only when a sealed commit is new); a busy cycle
  (`begin` + `end`) 0.9 s with the files, 2.7 s on the branch (one upsert per sheet written,
  usually `cycles` and `seen`, and the push). A fast cycle stays in single seconds; the cost is
  per gitsheets-axi process, so a sheet less per cycle or an in-process gitsheets would cut it.

