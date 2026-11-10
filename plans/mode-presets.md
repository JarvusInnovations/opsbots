---
status: done
done: 2026-11-09
depends: [loop-modes]
specs:
  - specs/principles.md
  - specs/skills/opsbot-core.md
pr: 39
---

# Mode presets: window, cadence and the escalation brief

## Scope

`loop.mode` sets more than the model. When `loop.autocompact` is unset the window follows the
mode (750k strategist, 300k dispatcher). A dispatcher with `wake.files` gets quiet delays at
the cap unless `opsbot.json` sets them. The dispatcher's escalation brief names the rule card
and the nearest recipes. The new-bot template sets `loop.mode` and leaves the model and the
window to it.

## Validation

- [x] `start --dry-run` passes 750000 for a strategist, 300000 for a dispatcher, and the
      explicit value when `loop.autocompact` is set.
- [x] A dispatcher with wake files gets `quiet_working` and `quiet` at its cap; without wake
      files, or with explicit values, the table stands; a strategist is unchanged.
- [x] The shipped template validates.
- [x] Full suite passes; bundle and SKILL.md `--check` clean.

## Notes

- 2026-11-09: from a review of the loop-modes decision against a support bot's log: 20M to
  98M cached tokens read a day for 0.02M to 0.06M written. Chris chose 300k over 200k on the
  measured trade (a fifth more per call, half the compactions).
