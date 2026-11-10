---
status: done
done: 2026-11-10
depends: [mode-presets]
specs:
  - specs/skills/opsbot-core.md
pr: 42
---

# Session drift: say when the session does not match the mode

## Scope

`cycle begin` compares the running session with what `opsbot.json` calls for: the compaction
window in its environment and the model on the last reply in the session log. A difference is
printed once per session, with the restart line.

## Validation

- [x] Nothing is checked outside a session; nothing is printed when both match.
- [x] A missing or different window and a model of another class are each named.
- [x] `cycle begin` prints the `session` field once, then stays quiet on later cycles.
- [x] Full suite passes; bundle and SKILL.md `--check` clean.

## Notes

- 2026-11-09: a project-lead bot restarted by hand ran with no window and stopped at its
  context limit. Chris prefers `start` setting these from the mode over a second copy in
  `.claude/settings.json`; this check covers the sessions `start` did not launch.
