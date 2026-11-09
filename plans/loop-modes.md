---
status: done
done: 2026-11-09
depends: []
specs:
  - specs/principles.md
  - specs/skills/opsbot-core.md
pr: TBD
---

# Loop modes: strategist and dispatcher

## Scope

A principle with the decision table and the dispatcher's escalation conditions; `loop.mode`
in `opsbot.json` (`strategist` default, `dispatcher`), which sets the model `start` passes when
`loop.model` is unset (fable, opus) and which mode section of the pack rides the cold start
(`references/pack/25-mode-strategist.md`, `25-mode-dispatcher.md`).

## Validation

- [x] `settings validate` rejects an unknown `loop.mode`.
- [x] `start --dry-run` passes `--model opus` for a dispatcher with no `loop.model`, `--model
      fable` for a strategist, and `loop.model` when it is set.
- [x] The pack carries exactly the matching mode section; a bot with no mode gets the
      strategist's.
- [x] Full suite passes; bundle and SKILL.md `--check` clean.

## Notes

- 2026-11-09: Chris: "implement that in the opsbot repo and migrate rocketbot to dispatcher".
  The first dispatcher (RocketBot) is not on the kit yet; its protocol carries the same rules.
