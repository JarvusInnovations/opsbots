---
status: done
done: 2026-11-10
depends: [kit-pack-sections]
specs:
  - specs/skills/opsbot-core.md
pr: 56
---

# The wake sections get their own budget

## Scope

The cold-start pack had one 16 000-byte budget that the rule card and the kit's own sections
counted against. The kit's sections have grown to about 12 700 bytes, so a bot with a
6 700-byte rule card was over budget before any `wake.d/` section, and each section fell to
the 300-byte floor: one of nine owed items shown. The wake sections now share 6 000 bytes of
their own; the fixed parts are whole and outside it.

## Validation

- [x] A long wake script adds at most the wake budget to the pack, with "… N more lines".
- [x] The rule card and kit sections print whole.
- [x] Full suite passes; bundle and SKILL.md `--check` clean.

## Notes

- 2026-11-10: found while preparing a support-desk bot's move onto the kit.
