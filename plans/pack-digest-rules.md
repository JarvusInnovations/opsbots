---
status: done
done: 2026-11-07
depends: []
specs:
  - specs/skills/opsbot-core.md
pr: TBD
---

# Pack section: reading the digest

## Scope

A third kit pack section, `references/pack/30-digest.md`: the check output is read whole and
never piped through `grep`/`head`; an item's `reply` field is used verbatim; two threads are
two answers; mid-turn operator messages are items too. The delegation section's "pull what you
need with grep, jq or head" now carves out the loop's own output. Spec rule added.

## Why

The second bot, stress-tested with three parallel DM threads, filtered `cycle begin` to the
`text:` lines (losing `ts`/`thread_ts`) and answered two questions in the thread it had been
answering all evening. The channel skill supplies the address (`reply`); this section makes
the loop use it.

## Validation

- [x] `cold-start` prints the section as kit section 1.3 after writing and delegation
      (lexical order of `references/pack/`); existing pack tests pass unchanged.
- [x] Bundle and SKILL.md `--check` clean.

## Notes

- 2026-11-07: Chris: "do one and two" (the reply field in the bot's channel skill, and this).
