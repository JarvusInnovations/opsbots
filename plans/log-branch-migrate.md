---
status: done
pr: 129
depends: [log-branch-core, log-branch-ledgers]
specs:
  - specs/behaviors/log-branch.md
  - specs/skills/opsbot-core.md
---

# Moving a bot to the log branch, and the pull that replaces repo-sync hooks

## Scope

The migration command, the removal of `commit_paths` and the file-based writer, and
`cycle begin` fast-forwarding the checkout. After this plan the log branch is the only way
the kit writes its log. Each bot's own migration (running the command, merging the removal
commit, deleting its sync hooks) is that bot's work, not this plan's.

## Implements

`specs/behaviors/log-branch.md`: "What this removes", "What it needs" (the migration), and the
`repo_sync` rule.

## Approach

1. **`opsbot-core log migrate`.** Reads every file `commit_paths` lists plus the kit's own log
   files, writes them to the log branch as dated records under the root commit, and prepares
   a branch with one commit that removes those files, `commit_paths` and any `.gitignore`
   lines for them, and sets `log.branch`. It prints the PR to open and changes nothing on the
   current branch. `--dry-run` prints counts per sheet. Lines it cannot parse are listed and
   kept in a `ledgers/unparsed` sheet, never dropped.
   It also lists every tracked file under `logs/` that `commit_paths` does not name (an
   adopting bot had an 8 MB probe log tracked, uncommitted for weeks, dirtying its tree) and
   every baseline a hook reads from the working tree, and stops until each is assigned: a
   ledger, a state record, or untracked and ignored.
   The shapes are `log-branch-ledgers`': a baseline becomes a `state` record `{name, at, value}`,
   a post-log line a `posts/<channel>` record keeping its own `at`, an unparsed line a record of
   ledger `unparsed` in the `ledgers` sheet; written through the log module, not `log append`
   (whose declared-name check does not apply). The Slack and WhatsApp skill specs' listener
   passages still name `logs/intake/seen`; step 5 rewrites them.
2. **One writer at a time.** A bot writes the old way until the removal commit is in its
   checkout; `cycle begin` picks the writer from `log.branch` in the checked-out settings.
3. **`repo_sync`.** `pull` (default) fast-forwards at `cycle begin` when the tree is clean and
   the branch is behind; `never` skips it. Not fast-forwardable is a heartbeat item naming
   both commits, keyed by the remote's head so it is said once per change.
4. **Removal.** Delete the file writer, the commit-and-roll-back paths, `commit_paths`, and
   their tests; `settings validate` names `log migrate` when it meets `commit_paths`.
5. **Docs.** SKILL.md files, `architecture.md` and the skill specs describe the branch; the
   builder lists every passage it changed in the PR for the spec author's review.

## Validation

- [x] On a copy of a real bot's repo, `log migrate --dry-run` counts match the files' line
      counts, and the real run puts every line on the branch or in `unparsed`.
- [x] After the removal commit, a full cycle with posts, ledger and baseline writes leaves
      `git status` clean on the program branch.
- [x] A bot whose checkout does not yet have the removal commit keeps writing files, and
      nothing is written to both places.
- [x] A tracked log file that `commit_paths` does not name stops the migration until it is
      assigned, and the dry run lists it.
- [x] A bot several releases behind is refused with the release to update to first; the
      migration runs only from the release before this one.
- [x] `cycle begin` fast-forwards a clean checkout that is behind; a diverged or dirty one is
      reported once and the cycle goes on.
- [x] `settings validate` on a config with `commit_paths` fails and names the command.
- [x] No test or source file references `logs/cycle.jsonl`, `logs/intake/seen` or
      `commit_paths` except the migration.

## Notes

- **One writer, and no compatibility writer.** This release has no file writer, so "a bot keeps
  writing the old way until the removal commit is in its checkout" holds only for releases
  before this one. `logWriter` decides from the settings at HEAD: `log.branch` (or
  `opsbot/log` when unset), unless the checkout is still set up for the files (`commit_paths`
  in `opsbot.json`, or one of the kit's four `logs/` files tracked with no `log.branch`). Such a
  checkout is written nowhere: `cycle begin`, `check`, `outage`, the watchdog, `log append` and
  every other command that reads or writes the log refuse with exit 2, naming `log migrate`
  and, once it has run, `opsbot/log-migrate` to merge. `settings validate` names the command
  for `commit_paths`, `routines.runs_dir` and the old `repo_sync` values. A new bot with none of
  the old files needs no migration and no setting.
- **`log migrate`** (`src/opsbot-core/commands/migrate.ts`; the old names live only in
  `legacy.ts`) reads the working tree, so lines a failed commit left uncommitted move too. It
  writes all records in one commit after the branch's root (on top of an existing branch for a
  bot that opted in, never replacing a different record) with `Migrated-From`, and builds
  `opsbot/log-migrate` with a private index, so the current branch, the index and the working
  tree are untouched. A second run writes nothing and prepares the branch again. Shapes are
  `log-branch-ledgers`': cycle lines (an older bot's outage lines become `outages`), seen keys,
  outages, routine runs, `posts/<channel>` keeping their own `at`, a `.jsonl` file the old
  setting listed as a ledger named for it, a `.json` one as a `state` record. A record with no
  time of its own takes the time its line was committed (`git blame`). A line it cannot place
  is a record of ledger `unparsed` with its file, line, text and reason, written through the log
  module.
- **The release check.** The kit stores no release in a bot's repo, so the migration reads it
  from the log: every release since v0.15.0 writes `check` on a cycle's check line. With none of
  the newest twenty check lines carrying it, it refuses and names v0.16.0 (`PREVIOUS_RELEASE`;
  bump it if another release that writes the files ships first). v0.15.0 and v0.16.0 write the
  same shapes, so the check cannot, and need not, tell them apart.
- **`repo_sync`** (`src/opsbot-core/sync.ts`) runs on full cycles only, after the lock: a fast
  cycle leaves it for the next full one. Clean means no tracked change; an untracked file the
  fast-forward would overwrite fails it, and that is the item. A fetch that fails is said on the
  cycle's line (`not pulled: …`), not an item and not degraded. After a fast-forward the
  settings are read again. The item is a core input, `repo-sync`, keyed `repo-sync:<remote
  head>` through the seen keys.
- **Performance.** gitsheets-axi takes one sheet per `upsert`, so a commit's sheets are already
  one call each; nothing to batch further. Removed instead: the branch's root holds the `cycles`
  config alone (each other sheet's config rides the first commit that writes it), so a new
  branch costs one gitsheets call, not seven; the git directory is asked once per process, not
  once per path; what a command reads of the branch (tips, trees, quiet runs) is remembered
  until it writes; the quiet runs up to the tip's sealed parent are cached, so a read no longer
  walks the branch's whole history; and the commit a write made is read from gitsheets-axi's
  answer. A command's own git calls fell from 68–86 to 22–44. Measured (local bare remote, load 11–17, medians of three alternating rounds of nine): a quiet `cycle begin` 1.73 s before, 1.49 s after (with `repo_sync`'s fetch); a busy cycle with one post and two ledger records 5.28 s before, 4.68 s after, `cycle end` 4.21 s and 3.95 s. The rest is gitsheets-axi: one `upsert` per sheet written and one `push`, about 0.4 s each. The push stays inline: in the
  background, a refused push could not fail the command that made it.
- **Tests.** Every test now runs on the log branch. The readers' equivalence test compares
  against the answers the files gave on the same run, recorded from the last build that had
  both writers (`tests/fixtures/log-readers.json`). The migration's "real bot" is a fixture
  repo built in `tests/log-migrate.test.ts`: no real bot's data.
- **Validation evidence** (`tests/log-migrate.test.ts`). Box 1: "the dry run's counts match the
  files' lines…", on a fixture bot repo built in the test (no real bot's data, as asked). Boxes 2
  and 3: "until the removal commit is in the checkout nothing writes the log, to either place;
  after it, a full cycle leaves the program branch clean"; box 3's "keeps writing files" is the
  release before this one, which this release cannot be, so the test shows the other half:
  refused, nothing written anywhere. Box 4: "a tracked log no setting names, and a file a hook
  names, stop it until assigned…". Box 5: "a bot several releases behind is refused…". Box 6:
  the three "repo_sync" tests. Box 7: "settings validate on a config with the old file list…".
  Box 8: `grep -rln 'logs/cycle.jsonl\|logs/intake/seen\|commit_paths' src tests skills/*/scripts
  skills/*/templates` finds `src/opsbot-core/legacy.ts` and `tests/log-migrate.test.ts` only.
- **Found, not fixed:** a `routines` record's path ends at the second, so two runs of one
  routine in the same second share a path (the id gets `-2`, the record does not).
