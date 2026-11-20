---
status: in-progress
depends: []
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

- [ ] With `log.branch` set, a cycle that found something makes one log commit and leaves the
      program branch's head and working tree unchanged.
- [ ] Two records of one sheet made at the same minute and second of different hours of a day
      are two files (`outages`, `routines`).
- [ ] The root holds only the sheet configs; the second parent is on the first log commit
      after it and on the first after the program head moved, and on no other; every log
      commit after the root has `Program`, `Watermark` and `Check`.
- [ ] Ten quiet cycles in an hour are one commit with `Quiet-Cycles: 10`; the hour turning and
      a non-quiet cycle each seal it; a sealed or pushed commit is never replaced.
- [ ] `cycle end` pushes sealed commits only; the open quiet tip stays local; a refused push
      fails the check and loses nothing.
- [ ] A cold start in a fresh clone resumes from the newest pushed `Watermark` and reports
      nothing twice.
- [ ] The watchdog, `next-delay`, the sleep timer, the cold-start pack, the fast-check window
      and the wake backstop give the same answers from the branch as from the files, on a
      recorded run replayed both ways.
- [ ] A hook that times out leaves a record on the log branch before the cycle ends, and the
      watchdog message quotes it.
- [ ] With `log.branch` unset, every existing test passes unchanged.

## Risks

- A gitsheets call per cycle costs more than a file append. Measure a quiet cycle and a busy
  one; the fast cycle's budget in `specs/skills/opsbot-core.md` must still hold.
- Two processes writing the branch at once (a cycle and a hand-run script). The log module
  retries once on `TIP_MISMATCH` for non-quiet writes.
