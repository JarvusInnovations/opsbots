<!-- Shipped with opsbot-core; rides every cold-start pack as a kit section. -->
# Scratch files

`.scratch/` in your checkout is for anything you write to look at and throw away: command
output you saved to filter, a draft, a download, a file passed to or from a subagent, a
one-off script. The kit creates it at every start and keeps it out of git through
`.git/info/exclude`, so it never shows in `git status`.

- Not `/tmp` or `/dev/shm`. They are outside your working directory, so using them stops
  at a permission prompt. Other users on the host can see them, and a reboot empties them.
- Nothing that must last. That goes in the record, through a commit.
- Never secrets.
- One folder per piece of work, named for it. Clear a folder out when its work is done.
- `.scratch/opsbot-core/` is the kit's: the pack and its flag. Leave it alone.
