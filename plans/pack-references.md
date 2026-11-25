---
status: planned
depends: [opsbot-core, console-and-record]
specs:
  - specs/skills/opsbot-core.md
---

# Plan: pack section: every issue and pull request is a link

## Why

Bots talk about issues and pull requests all day, and they write them as `#123`, `PR 123` or a
bare URL. A reader then has to work out which repository is meant and go find it. The operator's
rule: link every issue and pull request in one standard form, `TAG#123` or `TAG PR#123`, as a hard
rule, never mentioned without the link.

## Scope

In: `references/pack/16-references.md`, `references.repos` in `opsbot.json` (validated by
`settings validate`), `cold-start` listing the bot's tags under the section, the spec, SKILL.md,
the `opsbot.json` template's comment, and tests.

Out: rewriting a bot's posts in code (the post command does not look for bare numbers); a tag for
anything but a GitHub-style `owner/repo`.

## Implements

- `specs/skills/opsbot-core.md`: *Issue and pull request references* (the verbatim section, the
  tags, where the table goes); the `references` row in the settings table and its validation;
  the cold-start command's list of kit sections; the house-rules line.

## Approach

1. `references/pack/16-references.md`: the spec's text under a one-line comment header, like 12
   and 14. It sorts after `14-record.md` and before the `25-mode-*` sections, and rides every
   pack.
2. `settings.ts`: `references` joins the top-level keys; `referenceProblems()` checks it; the
   parsed settings carry `references.repos` (empty when unset).
3. `kitSections()` takes the repos and, on the `NN-references.md` section, appends `Your tags:`
   and a table when there is at least one.
4. SKILL.md (settings, *What the kit puts in every cold start*), the command reference, the
   template, and the bundle.

## Validation

- [ ] `16-references.md` carries the spec's text verbatim under a one-line comment header.
- [ ] It sorts after `14-record.md` and before every mode section, and rides the pack for
      either mode and with memory off.
- [ ] The tags table appears under the section only when `references.repos` has a tag.
- [ ] `settings validate` refuses an unknown key under `references`, a `repos` that is not an
      object, a lowercase or punctuated tag, a value that is not `owner/repo`, and a repository
      named twice; it accepts a valid object and a `//` comment.
- [ ] `bun run type-check`, the relevant tests and `bun run check` pass.

## Notes

## Follow-ups
