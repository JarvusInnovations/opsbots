# opsbot-core

The loop every ops bot runs: one cycle at a time behind a writer lock, one check over every
stream with no model involved, the cycle log and intake state committed to git, outage
accounting, the cadence, a cold start that refuses every tool until the reground pack has
been read, and the watchdog and nudge timers that keep the loop alive.

It ships as one self-contained CLI (`scripts/opsbot-core`, a committed bundle that runs
under plain `node` 20 or later) plus the protocol in `SKILL.md`.

```bash
npx skills add JarvusInnovations/opsbots --skill opsbot-core
```

## Set up a bot

1. Copy `templates/opsbot.json` to the bot repo's root as `opsbot.json`, fill it in,
   commit it, and run `scripts/opsbot-core settings validate`.
2. Put at least one stream adapter in `opsbot.d/heartbeat.d/` (a channel skill installs
   one) and an escalation script in `opsbot.d/escalate.d/`.
3. `scripts/opsbot-core hook install` for the cold-start hook and read-gate.
4. Start the session as a named agent in the runtime (herdr), give it `loop.prompt`, and
   run `scripts/opsbot-core infra install` for the watchdog and nudge timers.

`scripts/opsbot-core hooks list` shows what runs at each lifecycle point. The full
protocol and command reference are in [`SKILL.md`](SKILL.md); the contract is
[`specs/skills/opsbot-core.md`](../../specs/skills/opsbot-core.md).

## Developing

The CLI's source is `src/opsbot-core/`. After changing it, run `bun run build` and commit
the rebuilt bundle and `SKILL.md`; CI's `bun run check` fails when either is stale.
