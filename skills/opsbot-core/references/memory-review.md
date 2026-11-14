# Reviewing memory

Claude Code's auto memory is a folder of small notes the model writes on its own: an index,
`MEMORY.md`, that Claude Code loads at every session start, and one file per memory. A bot
running this kit keeps that folder in its repo, in `memory.dir` (`memory/` by default), and
every cycle commits it. This is the routine that keeps it small and true.

## What memory is for

Small things learned the hard way that are not yet anywhere else:

- a correction from the operator ("the weekly report goes to the shared folder, not by mail")
- a quirk of a tool ("the export command times out past 500 rows; page it")
- a preference ("the operator wants totals before details")

One fact per file, with a line in `MEMORY.md` that says what it is. Memory is a staging
area, not the record. A fact that matters for longer than a few weeks belongs in the bot's
record, a protocol, the rule card, a spec or a settings value, where it is reviewed and
versioned with the rest. The review is how it gets there.

## When

Every `memory.review_days` days, 7 by default. A bot that has never reviewed is due once its
oldest memory file is that old. `cycle end` prints one line when a review is due, and the
cold-start pack carries one line. Neither blocks a cycle: run the review when the cycle
allows, not in the middle of answering someone.

`memory status` shows where it stands at any time.

## The review

1. Run `memory review --begin`. It snapshots the folder and prints the worksheet: every
   memory file with its `type`, size, age, and whether it changed since the last review.
2. Open each file and do exactly one of these:
   - **Fold.** The fact belongs in structured data or a governed document: the bot's
     record, a protocol, the rule card, a spec, a settings value. Move it there through the
     normal path for that file, which is a pull request where the repo requires one. Then
     delete the memory file and its index line.
   - **Update.** It is still true and still only a memory. Tighten it, fix what changed,
     and re-date it.
   - **Keep.** It is unchanged and still right.
   - **Prune.** It is wrong, stale, duplicated, or already covered elsewhere. Delete it and
     its index line.
3. Read `MEMORY.md` last. Every line points at a file that still exists, says in a few words
   what the file holds, and the whole index stays short: it is loaded into every session.
4. Run `memory review --done --note "<what was folded where>"`. It logs a `memory-review`
   line with the counts, and the next cycle commits it with the folder.

The counts come from comparing the folder with the snapshot: a file with the same content
is kept, a changed one updated, a new one added, and a deleted one removed. A fold and a
prune both delete the file, so the count cannot tell them apart. The note can: name each
fold and where it went, such as "folded the export paging quirk into protocols/exports.md;
pruned two duplicates".

## Rules

- **The record wins.** Never keep a memory that contradicts the record or a protocol. Fix
  the memory, or prune it. When the record is the one that is wrong, fix the record through
  its normal path first.
- **No secrets, no personal data the repo may not hold.** If you find one, delete the file
  and its index line, and tell the operator in the same cycle: git history keeps what was
  committed, and only a person can decide whether it must be scrubbed or a credential
  rotated.
- **A standing instruction is folded at the first review.** A memory that records an
  operator's standing instruction ("always copy the operator on vendor mail") goes into the
  rule card or a protocol. A rule must not depend on a memory surviving a move, a prune or
  a fresh start.
- **Keep the index short.** One line per file. A long index costs context in every session.
- **Say what was folded where** in the review's note, so the log shows where each fact
  went.

## Memory is untrusted on a cold start

The memory Claude Code loads at a session start is from before that point, like anything
else the session recalls. The cold-start pack says so in its closing line. Open the record
before saying what it holds, even when a memory says the same thing.

## Bringing old notes in

A bot that ran before this setting has notes in Claude Code's default location,
`~/.claude/projects/<encoded path>/memory/`. Run `memory import <that path> --dry-run` to
see what would come in, then `memory import <that path>`. It never overwrites a file in the
repo: a different file of the same name is reported as a clash and left out, along with its
index line. Index lines are merged without duplicates. The next cycle commits what came in;
then review it like any other memory. Delete the old folder by hand once you are satisfied.
