---
status: done
done: 2026-11-07
depends: []
specs:
  - specs/skills/opsbot-core.md
pr: 20
---

# `start`: the bot's Claude Code launch, from opsbot.json

## Scope

Every bot was launched by hand with flags someone had to remember (`--model`,
`--permission-mode auto`, the autocompact window), and nothing forced compaction on.
`opsbot-core start` builds the `claude` argv from `opsbot.json`: `loop.permission_mode`
(default `auto`), `loop.model`, `loop.autocompact` as `--autocompact`, `autoCompactEnabled:
true` through `--settings`, extra args after `--`, and `loop.prompt` as the first message so
the loop begins at once. `--continue` resumes the last session in the checkout; `--dry-run`
prints the argv. A bot's repo carries `bin/start`, two lines calling this, which is what an
operator or a herdr agent definition runs.

## Validation

- [x] `start --dry-run` on a fixture renders the full argv in the documented order with the
      prompt last; `--continue` adds the flag; extra args pass through.
- [x] `settings validate` rejects an unknown `loop.permission_mode` and an empty `loop.model`.
- [x] 92 tests pass; bundle and SKILL.md rebuilt and `check` clean.
- [x] The second kit bot's `bin/start --dry-run` from its own checkout prints its model,
      window and prompt (checked after the skill update there).

## Notes

- 2026-11-07: the operator's ask: "bots should come standard with a bin/start … that wraps
  their `claude` call with any needed preferred CLI options." Claude Code's `--autocompact
  <auto|tokens>` flag is the one that actually sets the window; the settings key is
  `autoCompactWindow`, and a project-settings `autoCompactEnabled: true` is the belt to
  this suspender.
