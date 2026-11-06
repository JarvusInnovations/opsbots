---
status: done
depends: []
specs:
  - specs/skills/opsbot-core.md
  - specs/architecture.md
pr: 2
---

# opsbot-core: extract the loop into the first kit skill

## Scope

Port the support-desk bot's cycle scripts (`check`, `cycle-begin`, `cycle-end`,
`next-delay`, `cold-start`, `outage`, `lib.sh`, `bin/watchdog`, `bin/nudge`,
`infra/*`) into `skills/opsbot-core/` as one bundled AXI CLI per the `axi-skills`
recipe, generalized: streams, monitors, cycle hooks, pack sections and escalation
become scripts discovered in `opsbot.d/<point>.d/` (lexical order, one environment
contract), cadence and thresholds come from `opsbot.json`, the runtime is an adapter, and the campaign bot's
reground gate replaces inline hook output. Fix the drift the synthesis found (one
autocompact value; one timer interval). No channel adapters, no send guard, no gate
judge, no sheets in this plan.

Out of scope: installing it into either running bot (next plan).

## Implements

- `specs/skills/opsbot-core.md` — every command, the settings schema, the adapter contract, the rules
- `specs/architecture.md` — the loop, cold start, liveness, settings sections

## Approach

1. Repo build scaffold per `axi-skills`: `package.json` (bun; pinned `axi-sdk-js`,
   `@toon-format/toon`, `esbuild`), `scripts/build-cli.ts` and `build-skill.ts` with
   `TARGETS` for a multi-skill repo, `.gitattributes`, `.github/workflows/check.yml`.
2. `src/opsbot-core/` TypeScript: `reference.ts` as the single source of truth for
   `DESCRIPTION` + `COMMAND_GROUPS`; `cli.ts` with `runAxiCli()`; `commands/*`;
   `invocation.ts`; settings loader with validation; a `--version` fast path.
3. Port each script's logic, reading the originals for the exact rules (lock
   abandonment, watermark pinning, exit codes, seen-key format, pack order and budget,
   nudge preconditions). Keep the cycle log line shape byte-compatible with the
   support-desk bot's so its history reads under the new tool.
4. Fixtures only: a file-backed fake `heartbeat.d/` stream, a fake `wake.d/` section, a
   fake `escalate.d/` sink and a fake runtime, so check, cold-start, watchdog and nudge
   are testable without a channel skill. `hooks list` shows discovery order.
5. Tests (`bun test`): exit codes, watermark refusals, lock takeover rules, cadence
   table, pack budget, gate deny/allow, settings validation.
6. `SKILL.md`: protocol prose (adapted from the architecture spec) + generated reference.
7. Commit the bundle and shim executable; `bun run check` passes; CI green.

## Validation

- [x] `npx skills add JarvusInnovations/opsbots --skill opsbot-core` into an empty repo yields a runnable `scripts/opsbot-core` with no install step (verified from GitHub after merge, 2026-10-21)
- [x] `opsbot-core` with no args prints the home view; `--version` answers under the fast-path floor
- [x] `settings validate` rejects an unknown key and a cadence over the cap
- [x] `hooks list` shows scripts from `opsbot.d/*` in lexical order and skips non-executables
- [x] `check` with a fixture stream returns 0 / 10 / 20 / 2 in the four cases and never writes "nothing new" when any input failed
- [x] `cycle end` refuses a future watermark, a backwards move, and no-check-since-lock
- [x] `cycle begin` refuses on a live lock and takes over an abandoned one with an outage recorded
- [x] `next-delay` reproduces the support-desk bot's table for its hours and the kit defaults otherwise
- [x] `cold-start --write` + `gate check` deny until the pack is read whole, allow after
- [x] `infra install` renders units whose intervals come from `opsbot.json` and `infra status` shows them
- [x] `bun run check` (both `--check` builds) and tests pass in CI
- [x] No instance names anywhere in the skill

## Risks / unknowns

- `axi-sdk-js` quirks (flags-before-command, `.mjs` hook no-op) — follow the recipe's gotchas.
- The herdr runtime adapter cannot be exercised in CI; fake runtime covers the logic, herdr is verified on install into a bot.
- Byte-compatibility of the cycle log may conflict with generalizing field names; prefer compatibility and alias.

## Notes

- **Spec settled first.** Two `docs(opsbot-core)` commits at the head of the branch name
  what the spec left open: `timezone`, `rule_card`, `gate_word`,
  `liveness.wake_cooldown_minutes` and `liveness.interval_minutes` (the timer interval, so
  the "documented at one value, installed at another" drift cannot recur), `night_hours`
  for the night span (the spec used `night` for both the delay and the span), the env
  values (`OPSBOT_CONFIG` is a HEAD snapshot in the git dir; monitors also get
  `OPSBOT_CORE`), the outage line shape, and the exit codes below.
- **Outages live in `logs/outages.jsonl`** as the spec's file table says, not in the cycle
  log where the support-desk bot wrote them. Every reader takes outage lines from both
  files, so that bot's history still reads. The check and cycle end commit the outage file
  with their own, as the source's "the next cycle carries it" did.
- **Cycle-log bytes are pinned by a test**: `{at,outcome,inputs,new,failed,watermark}` and
  `{at,outcome:"finished",records,watermark,degraded}` match the source byte for byte;
  `--summary` adds a trailing `summary` field only when given. Heartbeat inputs are named by
  the script's file name.
- **Exit codes**: `cycle end` is 0 / 1 (refused, or could not commit) / 2 (usage) where the
  source used 0 / 2 / 3; `watchdog` exits 1 when it cannot escalate (the source used 3),
  so a systemd unit shows failed; `nudge` "cannot" is 1 (source 3).
- **The gate** prints its deny reason on stdout (TOON) and stderr and exits 2, because
  Claude Code reads a PreToolUse refusal from stderr on exit 2; the campaign bot's script
  returned a JSON `permissionDecision` on exit 0. `cold-start` prints the pack as text, not
  TOON, since the pack is what the session reads. Both are recorded in the spec.
- **The nudge sends `loop.prompt` verbatim.** The source prepended `/loop ` and required an
  operator-specific cache marker in the prompt; both are now just part of the configured
  prompt (the template shows `/loop …`).
- **No heartbeat scripts is degraded**, not nothing new (a check that can see nothing must
  say so). A failing `cycle.d/begin/` script logs a degraded line naming it and keeps the
  lock for `cycle end --degraded`.
- **`infra status` ignores the `Environment=PATH=` line** when comparing, since it follows
  whichever shell ran `install`; anything else that differs from a fresh render is stale.
- **Versions**: `axi-sdk-js` 0.1.13 has the `fast-path` subpath the recipe describes; its
  built-in npm `update` command is shadowed with a pointer to `npx skills add`. `bun add`
  pinned TypeScript 7.0.2. The version probe test compares against the `node -e 1` floor
  (median of five, under 2.5x + 60 ms): the bundle is one file, so parse cost remains and
  only evaluation of the command graph is skipped.
- **Verified locally, not from GitHub**: `npx skills add <local clone> --skill opsbot-core`
  into an empty git repo installed `.agents/skills/opsbot-core/` (symlinked for Claude
  Code); the shim ran with no install step, `settings validate` passed on the template,
  `hook install` wrote `${CLAUDE_PROJECT_DIR}/.agents/skills/opsbot-core/scripts/…`
  commands, and `infra install --dry-run` rendered the units. The first box stays open
  until the same command runs against `JarvusInnovations/opsbots` after merge.
- **Not exercised here**: the herdr adapter against a live agent (the fake runtime covers
  the nudge's logic) and real `systemctl` (a fake `systemctl` via `OPSBOT_SYSTEMCTL` and a
  temp `XDG_CONFIG_HOME` cover rendering, install, status and uninstall).
- `repo_sync` is validated and documented but not acted on by the core; a
  `cycle.d/begin/` script reads it, as the spec's table puts repo sync there.

## Follow-ups

- Tracked as (review, 2026-10-21): persist the digest. `check` records items as seen at
  report time, so a session that dies between the digest and `cycle end` loses the items
  for good; the source bot has the same hole. Write the digest to `logs/intake/last-digest`
  so the cold-start pack can point at it. Belongs in opsbot-core's next version.
- Tracked as (review, 2026-10-21): the lock's `pid` comes from `CLAUDE_PID`, which is not
  always set; with an empty pid an abandoned hold is only reclaimed after `lock_max_minutes`.
  Fall back to `process.ppid`.
- Tracked as: the plan that installs opsbot-core into the running bots (not yet written) —
  verify the herdr adapter and real systemd units there, ship a `cycle.d/begin/` repo-sync
  script that honours `repo_sync`, and run `npx skills add JarvusInnovations/opsbots
  --skill opsbot-core` against the merged repo to close the first Validation box.
- Tracked as: Codex and OpenCode hook targets for `hook install` (Claude Code only today);
  raise when a bot runs on another harness.
