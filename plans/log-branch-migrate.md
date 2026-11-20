---
status: planned
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

- [ ] On a copy of a real bot's repo, `log migrate --dry-run` counts match the files' line
      counts, and the real run puts every line on the branch or in `unparsed`.
- [ ] After the removal commit, a full cycle with posts, ledger and baseline writes leaves
      `git status` clean on the program branch.
- [ ] A bot whose checkout does not yet have the removal commit keeps writing files, and
      nothing is written to both places.
- [ ] `cycle begin` fast-forwards a clean checkout that is behind; a diverged or dirty one is
      reported once and the cycle goes on.
- [ ] `settings validate` on a config with `commit_paths` fails and names the command.
- [ ] No test or source file references `logs/cycle.jsonl`, `logs/intake/seen` or
      `commit_paths` except the migration.
