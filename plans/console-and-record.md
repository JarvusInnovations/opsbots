---
status: planned
depends: [opsbot-core]
specs:
  - specs/principles.md
  - specs/skills/opsbot-core.md
---

# Plan: a quiet console and a record with a way back

## Why

Bots write recaps to a terminal nobody reads, and keep what must survive a compaction in
free-text files nothing ever reads back to them.

## Scope

In: the two pack sections, `record.recall` in the core (settings, validation, cold-start
sections, cycle-end lines, item decoration), `record status`, the two sheet templates, the
pack rule about ending a turn, SKILL.md, tests. Out: migrating any bot's existing files.

## Implements

`specs/principles.md`: "Nobody reads the terminal", "What must outlive a compaction goes in a
record with a way back". `specs/skills/opsbot-core.md`: "The console, and the record".

## Validation

- [ ] Both pack sections ship verbatim and ride every cold-start pack in order, ahead of the mode section
- [ ] A `cold-start` recall prints its rows as a pack section inside the `wake.d` budget; a `cycle-end` recall prints with the closing lines; an `item` recall adds matching rows to a check item
- [ ] `today` resolves in the bot's timezone; `limit` and "… N more" hold
- [ ] A missing sheet or failing query is one line, never an empty section, and `settings validate` reports it
- [ ] `record status` lists every sheet, flags one no recall names, and counts open rows
- [ ] A recall never writes (the repo is unchanged after every surface runs)
- [ ] The two templates validate with gitsheets and their recall comments are valid entries
- [ ] Every existing test passes

## Risks

- The pack grows by two sections; keep them within the lengths in the spec.

## Notes

## Follow-ups
