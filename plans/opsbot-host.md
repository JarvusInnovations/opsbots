---
status: planned
depends: []
specs:
  - specs/architecture.md
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
- Environment for systemd-launched sessions goes in `~/.config/environment.d/*.conf`, for
  shells in `.bashrc`; both, or herdr and the terminal disagree.

## Validation

- [ ] On a fresh user, `host bootstrap && host desktop install && host browser install`
      brings up a bot whose `cold-start` runs and whose headless and headed smoke tests pass.
- [ ] `host status` on the two existing bots reports nothing missing.
- [ ] Two bots on one host get different displays, VNC ports and bridge ports with no
      configuration.

## Notes

- 2026-11-07: planned on the operator's question whether the desktop and browser setup
  should be a skill. It should, and it is the "starter" skill the architecture already
  lists. Not started.
