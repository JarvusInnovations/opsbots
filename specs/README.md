# Specs

What must be true of the kit: the skills it ships, what each installs, and the rules a
bot or a mothership built on it must satisfy. Declarative; not how it is coded.

## Status

October 2026. Written from three running bots and one retired one. The `mothership` skill's fleet sheets exist; `architecture.md` is the synthesis the
`opsbot-*` skills are extracted against, starting with `opsbot-core`. Unknowns are marked `TK`.

| File | Covers |
| --- | --- |
| `principles.md` | The stance every bot and mothership inherits |
| `architecture.md` | The operating model: composition, the loop, cold start, guards, gate word, deliver, escalation, the record, liveness, settings; divergences between the two source bots resolved with reasons |
| `mothership.md` | TK — the fleet sheets and the mechanic |
| `skills/opsbot-core.md` | The loop: cycle, check, cold start, liveness, the `opsbot.d/` contracts |
| `skills/opsbot-host.md` | The Linux user under a bot: bootstrap, desktop, browser, status |
| `skills/opsbot-slack.md` | Slack: the app manifest, listener, event reader, escalation DM, install and status |
- `writing.md`: the house style for every bot's messages, on every surface.
- `persona.md`: what a bot's personality file holds and the limits it works inside.
- `permissions.md`: scoped `bin/` scripts with narrow allow rules, the classifier's context, and why a bot can never widen its own reach.
