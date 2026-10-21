---
status: planned
depends: []
specs:
  - specs/skills/opsbot-core.md
  - specs/architecture.md
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

- [ ] `npx skills add JarvusInnovations/opsbots --skill opsbot-core` into an empty repo yields a runnable `scripts/opsbot-core` with no install step
- [ ] `opsbot-core` with no args prints the home view; `--version` answers under the fast-path floor
- [ ] `settings validate` rejects an unknown key and a cadence over the cap
- [ ] `hooks list` shows scripts from `opsbot.d/*` in lexical order and skips non-executables
- [ ] `check` with a fixture stream returns 0 / 10 / 20 / 2 in the four cases and never writes "nothing new" when any input failed
- [ ] `cycle end` refuses a future watermark, a backwards move, and no-check-since-lock
- [ ] `cycle begin` refuses on a live lock and takes over an abandoned one with an outage recorded
- [ ] `next-delay` reproduces the support-desk bot's table for its hours and the kit defaults otherwise
- [ ] `cold-start --write` + `gate check` deny until the pack is read whole, allow after
- [ ] `infra install` renders units whose intervals come from `opsbot.json` and `infra status` shows them
- [ ] `bun run check` (both `--check` builds) and tests pass in CI
- [ ] No instance names anywhere in the skill

## Risks / unknowns

- `axi-sdk-js` quirks (flags-before-command, `.mjs` hook no-op) — follow the recipe's gotchas.
- The herdr runtime adapter cannot be exercised in CI; fake runtime covers the logic, herdr is verified on install into a bot.
- Byte-compatibility of the cycle log may conflict with generalizing field names; prefer compatibility and alias.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
