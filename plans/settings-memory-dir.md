---
status: done
done: 2026-11-24
pr: 135
depends: []
specs:
  - specs/skills/opsbot-core.md
issues: [133]
---

# Plan: settings validate accepts autoMemoryDirectory that is memory.dir

## Why

`settings validate` refused any `autoMemoryDirectory` in a bot's `.claude/settings.json`, even
the bot's own `memory.dir`. A repo that people also open in ordinary interactive sessions needs
that key: those sessions are not launched by `start`, so the project settings file is the only
way they share the bot's in-repo memory.

## Scope

In: the `.claude/settings.json` check in `settings validate`, its tests, the spec's settings
paragraph and *Auto memory* "Where" bullet, the command reference and the opsbot-core SKILL.md.

Out: `autoMemoryEnabled` in `.claude/settings.json` (still refused); what `start` passes (#80).

## Implements

- `specs/skills/opsbot-core.md`, *Settings*: `autoMemoryDirectory` is accepted when it is the
  same directory as `memory.dir` (relative to the repo root, `~/`, a trailing slash, symbolic
  links resolved where they exist); any other directory, or any value with `memory: false`, is
  refused naming both paths.
- *Auto memory*, "Where": a session `start` did not launch shares the memory when the bot's
  `.claude/settings.json` names the same directory.

## Approach

1. `resolveDir(root, p)` in `memory.ts`: `~` expanded, resolved against the repo root, through
   `realpath` when the path exists.
2. `autoMemoryDirectoryProblem(root, value, memory)`: null when both sides resolve alike;
   otherwise a line naming the value as written and resolved and `memory.dir` resolved; with
   memory off, a line saying so.
3. `settings validate` keeps refusing `autoMemoryEnabled` and calls the new check for
   `autoMemoryDirectory`.

## Validation

- [x] `memory`, `./memory`, `memory/`, the absolute path with and without a trailing slash, and
      the path through a symlinked temp directory are all accepted, before and after the
      directory exists; a custom `memory.dir` likewise.
- [x] `/elsewhere`, a subdirectory, a sibling, `~/memory` and a non-string are refused, the
      message naming the value and `memory.dir`'s absolute path.
- [x] With `memory: false`, any `autoMemoryDirectory` is refused.
- [x] `autoMemoryEnabled` in `.claude/settings.json` is still refused.
- [x] `bun run build`, `bun run type-check`, `bun run check` and `bun test` pass.

## Notes

- `resolveDir` resolves symbolic links through the nearest existing parent, so a path through a
  symlinked checkout matches before `memory/` exists, as `start` creates it only at launch.
- `bun test` passes on CI for the PR head. Locally, on a host at load average 40, three tests
  in other files (`drift`, `start --continue`, a Meet status test) hit the 5-second default
  timeout or a stray request in a full run; each passes alone or on CI and none touches this
  change.

## Follow-ups

None.
