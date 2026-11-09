---
name: opsbot-host
description: >-
  Set up and check the Linux user an ops bot runs as: what is installed and what is missing
  (lingering, node, Claude Code, herdr, the AXI tools), the virtual desktop with VNC bound to
  the tailnet, and the headless browser bridge with its port, MCP path and DISPLAY in every
  place they must be (repo settings, environment.d, .bashrc). Use when standing up a new bot's
  host user, moving a bot to another machine, when a bot's browser or desktop will not start,
  when `chrome-devtools-axi` reaches the wrong browser, or when asked what a bot's host is
  missing. Triggers: "set up the bot's user", "bootstrap the host", "VNC for the bot", "headed
  browser for the bot", "host status", "opsbot-host".
---

# opsbot-host

The floor under the loop. `opsbot-core` runs the bot's cycles; this skill makes sure the Linux
user it runs as has everything the cycles reach for, and says plainly what is missing.

Run it **as the bot's user, from the bot's repo checkout** (`sudo -u <bot> -i`, then `cd` to
the checkout). The repo's `opsbot.json` names the bot and may pin its numbers under `host`.

## Before it runs: root's steps

The CLI never needs root. Three steps come first, run once by someone with sudo:

```sh
sudo useradd --create-home --shell /bin/bash <bot>
sudo loginctl enable-linger <bot>          # user services and timers run while logged out
echo '<operator> ALL=(<bot>) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/<bot>-operator
```

The desktop also needs the packages: `sudo apt install xvfb openbox x11vnc`. Logging the bot
into its accounts (Claude, Google, Slack, GitHub) is the operator's, by hand: those are the
bot's credentials, and no command here touches them.

## The numbers

Each bot gets its own display, VNC port and browser bridge port, so two bots on one host
never collide. They come from `opsbot.json`:

```json
"host": { "display": 101, "vnc_port": 5902, "bridge_port": 9226 }
```

Absent keys derive from the uid (`100 + uid % 100`, `5900 + …`, `9300 + …`). A bot set up by
hand before this skill pins what it already uses, so `status` compares against reality.

## How to use it

1. `scripts/opsbot-host status` first. Every row is `ok`, `missing` or `differs`, and each
   fix is a command. Exit 1 means something is to fix.
2. `desktop install --dry-run`, read what it would write, then `desktop install`.
3. `browser install --dry-run`, then `browser install`. It prints the `.claude/settings.json`
   `env` block: that file is the bot's permission surface, so this CLI never writes it. The
   operator merges the block and commits it in a PR. It matters most of the three places:
   it is the only one that reaches the loop however the session was launched, and without it
   a browser call from the bot reaches the default bridge, which on a shared host is someone
   else's browser.
4. `status` again until it says all ok.

Everything is idempotent. A password that exists is never regenerated (it lives in
`~/.config/<bot>/vnc-password`, mode 0600); a file that already matches is left alone.

## Command reference

<!-- BEGIN GENERATED: command-reference -->

### Status

- `scripts/opsbot-host status` — One row per piece (lingering, session retention, node, each tool, the desktop units, the VNC password, the browser MCP, the environment in repo settings, environment.d and .bashrc): ok, missing or differs, with the command that fixes it. Exit 1 while anything is to fix.

### Install

- `scripts/opsbot-host desktop install [--dry-run]` — Xvfb, Openbox and x11vnc as user units on the bot's display, VNC bound to the tailnet address only, a VNC password generated once into ~/.config/<bot>/vnc-password. Idempotent; --dry-run prints every file whole and every command.
- `scripts/opsbot-host sessions keep [--dry-run]` — Set cleanupPeriodDays to 36500 in the bot's user-level ~/.claude/settings.json, every other key untouched, so Claude Code stops pruning its session logs after 30 days: they are its full-resolution memory.
- `scripts/opsbot-host browser install [--dry-run]` — chrome-devtools-axi and chrome-devtools-mcp under the bot's node when missing; the bridge port, MCP path and DISPLAY into environment.d and above .bashrc's interactive guard; prints the .claude/settings.json env block for the operator to commit (never writes it).

<!-- END GENERATED: command-reference -->
