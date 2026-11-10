---
status: done
done: 2026-11-10
depends: [opsbot-host]
specs:
  - specs/skills/opsbot-host.md
pr: 47
---

# opsbot-host: bootstrap

## Scope

`scripts/bootstrap.sh` and `opsbot-host bootstrap` (the same script): the PATH block, asdf,
node, the GitHub CLI, the AXI tools, Claude Code, herdr, and `npx skills` for the repo's
`skills-lock.json`; idempotent, printing what it changed. Plain bash so it runs before node
exists and can be piped from the repo, for a bot's user or a person's fresh VM.

Moved out: the whole skill rehearsed on a newly created Linux user (bootstrap, then
`sessions keep`, `desktop install`, `browser install`, then `status` all ok). That needs root
to create the user; it is `plans/opsbot-host-fresh-user.md`.

## Validation

- [x] On an empty home with only `/usr/bin:/bin` on PATH, the script installs ten pieces
      (PATH, asdf 0.20.2, node 22.23.4, five tools, Claude Code, herdr) and exits 0; a new
      shell finds every one.
- [x] A rerun installs nothing and leaves `.bashrc` byte-identical.
- [x] `--dry-run` writes nothing; `--tools`, `--node`, `--no-herdr` and the repo's
      `.tool-versions` and `skills-lock.json` are honoured; an unknown flag and a tool name
      that is not a package name are refused.
- [x] A system node (18) does not satisfy the node step.
- [x] Two bots on one host get different displays, VNC ports and bridge ports with no
      configuration (the uid derivation, covered since the first plan).
- [x] Full suite passes; bundle and SKILL.md `--check` clean.

## Notes

- 2026-11-10: Chris: teammates want it for fresh VMs too, so nothing in it is about bots.
- First design put the logic in the bundled CLI; a fresh machine has no node to run it.
