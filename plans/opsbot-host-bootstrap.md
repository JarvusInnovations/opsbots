---
status: planned
depends: [opsbot-host]
specs:
  - specs/skills/opsbot-host.md
---

# opsbot-host: bootstrap

## Scope

`opsbot-host bootstrap`: asdf with the pinned node, the AXI tools the bot's `opsbot.json`
streams imply (`gws-axi`, `slack-axi`, `gitsheets-axi`, `gh-axi`), Claude Code, herdr, and
`npx skills` for the repo's `skills-lock.json`; idempotent, printing what it changed. Then the
whole skill on a fresh user.

## Validation

- [ ] On a fresh user, `bootstrap`, `sessions keep`, `desktop install` and `browser install` bring
      up a bot whose `cold-start` runs and whose headless and headed browser smoke tests pass.
- [ ] Two bots on one host get different displays, VNC ports and bridge ports with no
      configuration.
- [ ] `status` reads all ok on the first bot once its numbers are pinned in `opsbot.json`.
