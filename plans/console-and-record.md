---
status: done
done: 2026-11-18
depends: [opsbot-core]
specs:
  - specs/principles.md
  - specs/skills/opsbot-core.md
pr: 111
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

- [x] Both pack sections ship verbatim and ride every cold-start pack in order, ahead of the mode section
- [x] A `cold-start` recall prints its rows as a pack section inside the `wake.d` budget; a `cycle-end` recall prints with the closing lines; an `item` recall adds matching rows to a check item
- [x] `today` resolves in the bot's timezone; `limit` and "… N more" hold
- [x] A missing sheet or failing query is one line, never an empty section, and `settings validate` reports it
- [x] `record status` lists every sheet, flags one no recall names, and counts open rows
- [x] A recall never writes (the repo is unchanged after every surface runs)
- [x] The two templates validate with gitsheets and their recall comments are valid entries
- [x] Every existing test passes

## Risks

- The pack grows by two sections; keep them within the lengths in the spec.

## Notes

Built in PR 111. The tests for each Validation box are in `tests/record.test.ts` unless named:
- Pack sections: "12-console.md and 14-record.md carry the spec's text verbatim…" (compares each file with the spec's quoted block) and "they sort after the writing section and before the mode sections, and ride every pack" (both modes, memory off); `tests/coldstart.test.ts` checks the 1.1–1.4 order
- The three surfaces: "a cold-start recall is a pack section after wake.d…", "the recall sections share the wake budget…", "a cycle-end recall prints with the closing lines…", "an item recall adds the rows whose match is the item's from or conv, capped"
- `today`, `limit`, "… N more": "today is the date in the bot's timezone" (a UTC+14 zone), plus the 25-row and capped-item tests above
- Missing sheet or failing query: "a missing sheet or a failing query is one line…" (also a missing binary) and "a failing item recall is one line in the check output…"
- `record status`: "record status lists every sheet, flags one no recall names, and counts open rows"
- Never writes: "a recall never writes…" (HEAD and status unchanged after cold-start, record status and both validates; the cycle's commits touch only `logs/`; the stand-in saw only `query`; the temp dir is empty)
- Templates: "work.toml / promises.toml is a gitsheets config…" (parsed with `Bun.TOML`, recall comments through `recordProblems`), and "with the real gitsheets-axi…", which runs when `gitsheets-axi` is on PATH (locally, 2.11.0; CI skips it): a valid row is taken, a bad one refused, the recalls answer
- Every existing test: CI on PR 111

Decisions within the spec's latitude:
- `filter` is a string (one clause) or a list (several), because `gitsheets-axi query` takes repeated `--filter` flags. A string holding two clauses, like the spec's illustrative `"status=open due<=today"`, is refused with "write them as a list". `today` is replaced only as a clause's whole value.
- Rows are read from `--json-out=<temp file>`, never from the TOON. The open-row count in `record status` also comes from `query --json-out`, because `count` has no file output.
- A `cycle-end` recall runs at `cycle end`, as `cycle.d/end/` scripts do, not on a quiet `cycle begin`. It prints nothing when no row matches.
- The default `fields` are the first four the sheet's config declares, in file order. gitsheets-axi's own `sheets view` sorts them, so the order comes from the config text.
- `settings validate` also refuses an `item` recall on a sheet whose schema declares no `match` field.
- gitsheets reads configs and records from the committed tree, so a recall sees `HEAD` and a new sheet must be committed before its recall runs. `settings validate` passes on gitsheets-axi's own message saying so.

Gap in the CLI: `14-record.md` says `gitsheets-axi sheets` "lists them and what each is for". In 2.11.0 it lists name, format, record count and root, with no description. The purpose lives only in each config's header comment.

## Follow-ups
