---
status: done
done: 2026-11-07
depends: []
specs:
  - specs/skills/opsbot-core.md
  - specs/writing.md
  - specs/principles.md
pr: 15
---

# Kit sections in the cold-start pack

## Scope

House rules that must be in front of every session (the writing style, the delegation
rubric) were either copied into each bot's CLAUDE.md by hand or left in a reference file
nobody reads. Both drift. The pack is rebuilt at every start, resume, clear and
compaction, and the gate refuses to let the bot act until it has read it, so the rules
ride the pack: `references/pack/*.md` shipped with the skill, read in order right after
the rule card, whole, titled by their H1, numbered 1.1, 1.2 so `wake.d/` numbering is
unchanged. They count against a budget raised to 16 000 bytes. `OPSBOT_PACK_DIR`
overrides the directory. Two sections ship: writing (moved from `references/writing.md`)
and delegation (distilled from the principle).

## Validation

- [x] `bun test`: the new tests pass (sections present and ordered, HTML comment stripped,
      override honoured) and the existing pack tests still hold within the budget.
- [x] `bun run check`: the committed bundle and SKILL.md match the source.
- [x] Run from a bot's checkout, `cold-start` prints `═══ 1.1 Writing` and `═══ 1.2 Delegation`
      between the rule card and the first `wake.d` section (checked on JarJar after the skill update).

## Notes

- 2026-11-07: asked by the operator: "are these going in an installable/updatable skill or
  left to a protocol for copying CLAUDE.md? this stuff often needs to be in CLAUDE.md to work
  but should also be updatable." The pack is the answer the kit already had.

## Follow-ups

- Bots not yet on the kit (the campaign bot) keep hand-copied rules until migrated.
