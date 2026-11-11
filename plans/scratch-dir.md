---
status: done
done: 2026-11-11
depends: [kit-pack-sections]
specs:
  - specs/skills/opsbot-core.md
  - specs/architecture.md
pr: 76
---

# The pack and scratch files live in .scratch/

## Scope

`cold-start --write` wrote the pack to `~/.cache/<bot>/reground.md`, outside the bot's
repo. On a fresh bot the gate's required read stopped at a permission prompt for a path
outside the working directory, and the only grant that cleared it covered far more than one
file. Every bot's checkout now has a `.scratch/` directory, kept out of git by a `.scratch/`
line in the repository's `info/exclude`, never `.gitignore`.

- `cold-start --write` sets it up, since every session passes through it: start, resume,
  clear and compaction. The directory and the exclude line are each added only when missing.
  The exclude path comes from `git rev-parse --git-path info/exclude`, so a worktree checkout
  writes the shared file.
- The pack and its flag move to `.scratch/opsbot-core/`, the kit's own folder.
- The old home is honored once: while a flag is set there and none in the checkout, the gate
  holds for a whole read of the old pack, which clears it. `cold-start --write` removes the
  old flag. The old pack file is left alone.
- A kit pack section, `40-scratch.md`, carries the standing guidance: what goes in
  `.scratch/`, why not `/tmp` or `/dev/shm`, nothing that must last, never secrets, one
  folder per piece of work, and the kit's folder left alone.

## Validation

- [x] `bun test`: new tests pass. They cover creation and a single exclude line across two
      runs, a clean `git status` with files in `.scratch/`, an exclude file without a final
      newline or with the line already present, a worktree checkout, the old flag honored
      once with the old pack kept, and the new section in the pack. Existing gate tests pass
      against the new path.
- [x] `bun run type-check` and `bun run check`: clean; the committed bundles and SKILL.md
      match the source.
- [x] The built bundle, run in a throwaway repo with `HOME` isolated: it creates
      `.scratch/`, adds one exclude line over two runs, leaves `git status` empty, denies a
      tool until the pack is read whole, and writes nothing under `HOME`.

## Notes

- 2026-11-11: the operator's call, widened from the pack to a standard `.scratch/` for every
  bot, with the usage text shipped in the kit so a new bot has it from its first session.

## Follow-ups

- `opsbot-host status` could report whether `.scratch/` and its exclude line are in place.
- A bot's old `~/.cache/<bot>/reground.md` stays until someone deletes it.
