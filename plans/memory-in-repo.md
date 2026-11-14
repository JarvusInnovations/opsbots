---
status: done
done: 2026-11-14
depends: [start-command, scratch-dir]
pr: 89
specs:
  - specs/skills/opsbot-core.md
  - specs/architecture.md
---

# A bot's auto memory lives in its repo, is committed, and is reviewed

## Scope

Claude Code's auto memory is a folder under `~/.claude/projects/<encoded path>/memory/`: a
`MEMORY.md` index loaded at every session start and one small file per memory, which the
model writes on its own. Bots on this kit filled it unprompted. The notes were useful, but
unversioned, unreviewable, and lost when a bot moved hosts. The operator's decision: keep the
habit, version everything in the bot's repo, and review the files on a routine so each is
folded into structured data, updated, kept or pruned.

- A `memory` setting, `{dir, review_days}` (defaults `memory`, `7`) or `false`. `dir` must
  stay inside the repo and out of `.git/`, `.claude/` and `.scratch/`. `false` turns auto
  memory off. No value leaves it at Claude Code's default location.
- `start` adds `autoMemoryEnabled` and `autoMemoryDirectory` (absolute) to its one
  `--settings` object and creates the directory; with `memory: false` it passes
  `autoMemoryEnabled: false` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- The check's commit and the `cycle end` commit take every changed file under the directory,
  deletions included, listed one by one from `git status`.
- `memory status`, `memory review --begin|--done [--note]`, `memory import <path> [--dry-run]`,
  and a `memory` line in the home view.
- A due review prints one line at `cycle end` and one line in the cold-start pack, never
  blocking.
- The protocol as a pack section (`50-memory.md`, ridden only while memory is on) and as
  `references/memory-review.md`.
- `settings validate` also refuses `.claude/settings.json` setting `autoMemoryEnabled` or
  `autoMemoryDirectory` (one value, one place).

Out of scope: migrating any running bot (each operator runs `memory import` once), and any
scrub of secrets from git history (the protocol says to tell the operator).

## Approach

- `src/opsbot-core/memory.ts`: the directory, the changed-file list for commits, the listing
  (size, frontmatter `type`, last change, content hash), status and due logic, the review
  snapshot under `.git/opsbot-memory-review.json` and its counts.
- A file's last change is the earlier of its last commit and its file time: a fresh
  checkout's file times are all new, and a review's edits are committed after the review. A
  file changed since its last commit has only its file time.
- Due: at least one memory file, and the last `memory-review` log line `review_days` old;
  with no review yet, the oldest memory file that old (so a bot's first note does not make a
  review due at once).
- Counting: same hash kept, different hash updated, gone removed, new added. A fold and a
  prune both delete the file, so they are counted together as `removed`; the `--note` says
  what was folded where.
- `memory import` never overwrites; a same-name file with other content is a clash, left out
  with its index line. Index lines merge by exact text or by link target.

## Validation

- [x] `bun test`: 14 new tests in `tests/memory.test.ts`. They cover settings defaults, bad
      directories, `false` and `true`; the `.claude/settings.json` refusal; `start --dry-run`
      carrying the absolute directory and the enable flag in one `--settings`, the disable
      pair with `memory: false`, and no directory created by a dry run; memory written
      between cycles committed by the next check, a deletion committed, a custom directory,
      nothing outside it riding along; the same through `cycle end`; status counts and the
      due logic before and after a review; `--begin` and `--done` counts and the log line;
      the due line once in `cycle end` and in the pack when due and not otherwise; the pack
      section skipped with memory off; `import` merging, refusing to overwrite, and writing
      nothing on a dry run.
- [x] Every existing test passes unchanged. None asserted the whole `--settings` string, so
      no expectation changed.
- [x] `bun run type-check`, `bun run build` and `bun run check`: clean; the committed
      opsbot-core bundle and SKILL.md match the source.
- [x] The suite run with an empty environment and a fresh `HOME`
      (`env -i HOME=$(mktemp -d) PATH=<bun>:<node>:/usr/bin:/bin bun test`): passes.
- [x] The built CLI in a throwaway repo: `start --dry-run` prints the settings object with
      the absolute directory; a memory file written outside a cycle is committed by `check`
      and an untracked file elsewhere is not; `review --begin` prints the worksheet with the
      frontmatter type; a deletion after `--done` is committed with the review line.
- [x] A real session writes to the repo's memory directory and a restarted one recalls it.
      Verified first-hand by the operator on 2026-11-14 with a throwaway repo and
      `--settings '{"autoMemoryEnabled":true,"autoMemoryDirectory":"<absolute path>/memory"}'`:
      nothing was written under `~/.claude/projects/.../memory`, and a session launched
      without the setting did not recall the memory.

## After this plan

- On a working bot, after `start --continue`: confirm its first memory write lands in
  `memory/` and is committed by the next cycle.
- On a bot that ran before this setting: `memory import` from its old directory, then the
  first review, and read the `memory-review` line and its note.
- After a week: does the due line get acted on without prompting, and does the review keep
  the index short?

## Notes

- 2026-11-14: the operator's call to version memory in the repo and review it on a routine;
  `memory: false` added as the only alternative, so no bot keeps unversioned memory.
- Claude Code honours a repo-supplied `autoMemoryDirectory` only under workspace trust, and
  loads nothing when `permissions.blockReadsOutsideWorkingDirectories` is on and the
  directory is outside the working directory. Passing it on the command line from `start`,
  inside the checkout, avoids both.

## Follow-ups

- `opsbot-host status` could report whether the bot's old default memory folder still holds
  files that were never imported.
