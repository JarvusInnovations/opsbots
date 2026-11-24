---
status: in-progress
depends: [log-branch-core]
specs:
  - specs/skills/opsbot-core.md
  - specs/behaviors/log-branch.md
issues: [119]
---

# Plan: cycle begin --skip-hook, and begin-hook times

## Why

Issue 119 had four asks. The log-branch release met two: a hook's failure is written to the
log as it happens, and the watchdog quotes it. This plan meets the other two. A bot whose
`cycle.d/begin/` script is broken can still run cycles inside the loop without that script.
A script that is growing toward the 300-second limit is seen before it crosses it.

## Scope

In: `cycle begin --skip-hook <name>` (repeatable), the skip in the cycle's output and record;
each begin script's wall time on the cycle's record (and a quiet run's trailer); the
three-in-a-row heartbeat item; `.git/opsbot-hook-times.json`; the args parser's repeatable
value flag; tests; spec, command reference and SKILL.md.

Out: timing or skipping `cycle.d/end/` scripts (their failures are notes, not stops); a
per-script limit setting.

## Implements

- `specs/skills/opsbot-core.md`: the `cycle begin` row, the files table row, the
  `cycle.d/begin/` row, and *Hook times and skipping a hook*.
- `specs/behaviors/log-branch.md`, *Quiet cycles*: the `Hook-Times` trailer.

## Approach

1. `parseArgs` takes `repeat` value flags, collected into `lists`.
2. `cycle begin` checks every `--skip-hook` against `discover(cycle.begin)` before the lock.
3. The begin loop skips the named scripts, times the rest, and passes `hooks` and
   `skipped_hooks` to the check as fields of its record (`record` option) and to the failure
   line; the timing state file is updated after the loop, and its item goes in as a core input.
4. `branchState` adds the fields to its line; a cycle with a skip is never quiet; a quiet
   commit gets a `Hook-Times` trailer (`Quiet.extra`).
5. The cycle's first output line ends `· skipped cycle.d/begin/<name>`.

## Validation

- [ ] `--skip-hook` with an unknown name exits 2 naming the installed scripts, and takes no lock.
- [ ] A cycle whose broken begin script is skipped runs its check; its output says the skip; its
      record on the log branch carries `skipped_hooks` even when nothing was new; the next cycle
      without the flag runs the script again (and fails on it).
- [ ] `--skip-hook` is repeatable.
- [ ] Each cycle's record carries `hooks` with every begin script's time; a quiet run's commit
      carries `Hook-Times`; the failure line of a failing begin script carries the times so far.
- [ ] A script over 60% of the limit on three cycles in a row gives one item naming it and its
      three times; a fourth slow cycle gives no second item; a fast cycle in between ends nothing;
      after a cycle under 60%, three more slow ones give a new item.
- [ ] Every existing test passes unchanged.
- [ ] `bun run build`, `bun run type-check`, `bun run check` and `bun test` pass.

## Notes

## Follow-ups
