---
status: planned
depends: []
specs:
  - specs/permissions.md
---

# `permissions render`: the bot user's auto-mode block from the repo

## Scope

`opsbot-core permissions render [--write]` prints the `autoMode` block (environment,
allow, soft_deny with `$defaults`) and the `permissions.defaultMode: auto` entry for the
bot user's `~/.claude/settings.json`, derived from `opsbot.json` (name, accounts, streams,
runtime) and the repo's remote; `--write` merges it into the user file after showing the
diff. `settings validate` warns when the bot's project `.claude/settings.json` lacks
`autoCompactEnabled: true` or an allow rule for a script in `bin/`. `hook install` writes
`autoCompactEnabled: true` alongside the hooks.

## Validation

- [ ] `permissions render` on the second kit bot reproduces the block its operator wrote by
      hand on 2026-11-07 (same trust slots, same allow entries), modulo wording.
- [ ] `settings validate` flags a missing `autoCompactEnabled` and a `bin/` script with no rule.
- [ ] `hook install` on a fresh repo leaves `autoCompactEnabled: true` in project settings.

## Notes

- 2026-11-07: planned when the second bot was being blocked on every routine action; the
  hand-written version went in that day. Not started.
