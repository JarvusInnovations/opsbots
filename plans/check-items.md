---
status: done
done: 2026-11-10
depends: [opsbot-core]
specs:
  - specs/skills/opsbot-core.md
---

# Check items: several seen keys, quiet items, extra commit paths

## Scope

Three additions to `check` and the commits around it.

- A heartbeat item may carry `keys`, an array of more seen keys. It is new when `key` or any
  of `keys` is not yet seen; when it is reported, all of them are recorded. A `keys` value
  that is not an array of non-empty strings makes the line a bad line.
- An item with `report: false` has its keys recorded as seen and is never shown or counted as
  new. A check whose only items are quiet is nothing new. The log line counts them per input as
  `quiet`, only when there are any, so existing lines keep their shape.
- `commit_paths` in `opsbot.json` lists repo-relative files that the check's commit and the
  `cycle end` commit also take when they exist and have changes. `settings validate` refuses
  a non-array, an empty or non-string entry, an absolute path, a `..` segment, and a path under
  `.git/` or `.claude/`.

## Validation

- [x] A group item records `key` and every `keys` entry; a re-run, and a member printed on its
  own later, are not reported.
- [x] An item is reported again when one of its `keys` is new; only the new key is recorded.
- [x] A `keys` value that is a string, holds an empty string, holds a number, or is null fails
  the input as a bad line.
- [x] A check whose only items are `report: false` exits 0 nothing new, records their keys, and
  logs `quiet`; the next run logs no `quiet`.
- [x] Beside reported items, a `report: false` item is not shown or counted; any other `report`
  value is reported.
- [x] The check's commit and the `cycle end` commit each take a changed listed file and an
  untracked one once it exists, skip a missing one, and leave an unlisted modified file
  uncommitted.
- [x] `settings validate` accepts relative paths and refuses each bad shape, exit 1 from the CLI.
- [x] Full suite passes; `tsc --noEmit` clean; bundles and SKILL.md `--check` clean.

## Notes

- 2026-11-10: from a support-desk bot's intake check. Its adapter printed one digest row for a
  burst of events, then each event again on its own; its own messages showed up in its digest;
  and a baseline file and helper logs sat modified in the checkout between cycles.
- A listed path is taken only when `git status` shows it changed or untracked, so a gitignored
  or unchanged file never reaches `git add` and cannot fail the commit.
- `report` is a control field and is left out of the digest; `keys` is shown, like `key`.
