---
status: done
done: 2026-11-09
pr: 32
depends: []
specs:
  - specs/architecture.md
  - specs/skills/opsbot-host.md
---

# `opsbot-host`: the per-user host bootstrap as a skill

## Scope

Everything that was done by hand to stand up the second kit bot's Linux user, as an AXI
skill a new bot's operator runs once: toolchain, tools, runtime, virtual desktop, browser,
and a status check that says what is missing. Core stays the loop; this is the floor the
loop stands on. The architecture names this as the "starter" skill.

Commands (one `host` CLI in the skill's `scripts/`):

- `host bootstrap` — asdf with the pinned node, the AXI tools the bot's `opsbot.json`
  streams imply (`gws-axi`, `slack-axi`, `gitsheets-axi`, `gh-axi`), Claude Code, herdr,
  `npx skills` for the repo's `skills-lock.json`. Idempotent; prints what it changed.
- `host desktop install|status|uninstall` — Xvfb, Openbox and x11vnc as user services on
  a display and VNC port derived from the bot's uid (so two bots on one host never
  collide), VNC bound to the host's tailnet address only, password generated into
  `~/.config/<bot>/vnc-password`, `DISPLAY` set in `environment.d` and the shell.
- `host browser install|status` — `chrome-devtools-axi` and `chrome-devtools-mcp` global
  under the bot's node, `CHROME_DEVTOOLS_AXI_PORT` derived from the uid, the MCP path
  pinned in the environment (the bridge fails to start without it), a headless and a headed
  smoke test.
- `host status` — one table: each piece present or missing, with the command that fixes it.

## Not in scope

Creating the Linux user, sudo rules, lingering: root's job, documented in the skill's
README as the three commands the operator runs first. Logging into accounts (Claude,
gws-axi, slack-axi, gh): the operator's, by hand, because those are the bot's credentials.

## The recipe this replaces (2026-11-07, second bot)

- Desktop: `Xvfb :<display> -screen 0 1920x1080x24 -dpi 96 -ac -nolisten tcp`; Openbox with
  `DISPLAY` set; `x11vnc -display :<display> -forever -shared -listen <tailnet ip> -rfbport
  <port> -rfbportv6 -1 -rfbauth ~/.vnc/passwd`; three user units, `PartOf=xvfb.service`.
  First bot used display 100 and port 5901; the second 101 and 5902.
- Browser: `npm i -g chrome-devtools-axi chrome-devtools-mcp`; `CHROME_DEVTOOLS_AXI_PORT`
  per bot (9224 is the default and will collide); `CHROME_DEVTOOLS_AXI_MCP_PATH` set to
  `$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`,
  without which the bridge exits 1 before ready; headed sessions need a named
  `CHROME_DEVTOOLS_AXI_SESSION` plus `CHROME_DEVTOOLS_AXI_HEADED=1` and `DISPLAY`.
- Environment: the one place that reliably reaches the loop is the repo's `.claude/settings.json`
  `env` block, because Claude Code sets it on every session however the session was launched.
  `~/.config/environment.d/*.conf` covers systemd units and `.bashrc` covers shells, but the
  second bot's live session had neither (its `.bashrc` exports sat below the interactive guard),
  so a browser call would have reached the default bridge on 9224, which on a shared host is
  another user's browser. `host browser install` writes all three; `host status` checks the
  settings env first.
- An exported `CHROME_DEVTOOLS_AXI_PORT` forces every session onto one bridge, so a headed named
  session needs its own port (`CHROME_DEVTOOLS_AXI_PORT=<base+1>`); the smoke tests use both.

## Validation

- [x] `status` on the second bot, from a checkout pinning its numbers, reads all 24 rows ok with
      the probes in its interactive shell; with probes outside it, it had reported node 18 and
      every AXI tool missing (the reason the probes run in `bash -ic`).
- [x] `sessions keep` set retention on both existing bots, keeping every other key of their
      user settings.
- [x] `desktop install --dry-run` and `browser install --dry-run` print every file and command
      and write nothing; numbers derive from the uid and `host` pins them; no tailnet address is
      a refusal (tests).
- [x] 114 tests pass; both bundles and SKILL.md files `--check` clean.

`bootstrap` (toolchain and AXI tools) and two-bots-no-collision on a fresh host moved to
`plans/opsbot-host-bootstrap.md`.

## Notes

- 2026-11-07: planned on the operator's question whether the desktop and browser setup
  should be a skill. It should, and it is the "starter" skill the architecture already
  lists. Not started.
- 2026-11-07 (later): the second bot's browser verified headless on its own port and headed on
  the virtual desktop; the env findings above came from that check.
- 2026-11-09: Chris: "begin building the opsbot-host skill". First increment: spec, `status`, `desktop install`, `browser install`; `bootstrap` follows.
- 2026-11-09: Chris: disable session pruning on the bots as part of this skill (`sessions keep`); applied to both bots the same day.
