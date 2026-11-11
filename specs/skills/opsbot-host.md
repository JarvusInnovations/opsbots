# Skill: opsbot-host

The floor the loop stands on: everything a bot's Linux user needs before `opsbot-core start`
can run, as one CLI the operator runs as that user. Core is the loop; this is the host. It
never needs root and never logs into an account.

## Installs

```
skills/opsbot-host/
  SKILL.md                  when to run it, the root steps that come first, the command reference
  scripts/opsbot-host       bash shim (executable)
  scripts/opsbot-host.mjs   committed self-contained bundle
  scripts/bootstrap.sh      plain bash; runs before node exists; also `opsbot-host bootstrap`
```

## Before it runs (root's three steps, in the skill's README section)

```sh
sudo useradd --create-home --shell /bin/bash <bot>
sudo loginctl enable-linger <bot>          # user services and timers run while logged out
echo '<operator> ALL=(<bot>) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/<bot>-operator
```

Then the operator works as the bot (`sudo -u <bot> -i`), clones the bot's repo, and runs this
CLI from the checkout.

## Settings (`opsbot.json` → `host`)

| Key | Meaning | Default |
| --- | --- | --- |
| `display` | the Xvfb display number | `100 + uid % 100` |
| `vnc_port` | x11vnc's port, bound to the host's tailnet address only | `5900 + uid % 100` |
| `bridge_port` | `CHROME_DEVTOOLS_AXI_PORT`, the headless browser bridge | `9300 + uid % 100` |
| `resolution` | the virtual screen | `1920x1080x24` |

Derived from the uid so two bots on one host differ without configuration; a bot set up
before this skill pins its existing numbers here. `opsbot-core settings validate` accepts
`host` as an object and does not look inside, as with `streams`.

## Commands

| Command | Does | Exit |
| --- | --- | --- |
| *(none)* | home: the bot, its effective numbers and where each came from, a one-line status count | 0 |
| `status` | one row per piece: lingering, session retention, node, each tool, the three desktop units (present, matching the render, active), the VNC password, the browser packages and MCP path, the environment in each of its three places; `ok` · `missing` · `differs` with the command that fixes it | 0 all ok · 1 something to fix |
| `bootstrap [--dry-run] [--tools "a b"\|none] [--node <version>] [--no-herdr]` | runs `scripts/bootstrap.sh`: a fresh Linux user up to a session that can start. In order, each only when missing: the PATH block at the top of `~/.bashrc`; asdf (the latest release binary into `~/.local/bin`); node (the flag, else the repo's `.tool-versions`, else the latest 22; a system node does not count); the GitHub CLI; the npm tools (`gh-axi`, `gws-axi`, `slack-axi`, `gitsheets-axi`, `agent-recall-axi`, `chrome-devtools-axi` by default; the last drives a Chrome already on the machine); Claude Code and herdr from their own installers; `agent-recall-axi`'s SessionStart hook at user scope, when that tool is in the set (`agent-recall-axi hook install --scope user --agent claude`), so every session on the machine starts with the user's session history in reach; the herdr agent skill for the user (`npx skills add -g ogulcancelik/herdr --skill herdr`: that one skill, not the others in its repository); the repo's skills when `skills-lock.json` names one that is missing. Prints one row per piece (`ok`, `added`, `would`) and, last, the sign-ins only a person can do | 0 · 1 a step failed (a rerun continues) · 2 bad flag, run as root, or `curl`/`git`/`tar` missing |
| `desktop install [--dry-run]` | writes the three user units (Xvfb, Openbox, x11vnc bound to the tailnet address), generates a VNC password into `~/.config/<bot>/vnc-password` (0600) and `~/.vnc/passwd` once and never again, reloads and enables them | 0 · 1 |
| `sessions keep [--dry-run]` | sets `cleanupPeriodDays` to 36500 in the bot's user-level `~/.claude/settings.json`, every other key untouched, so Claude Code stops pruning its session logs after its 30-day default; refuses a file that is not a JSON object | 0 · 2 |
| `browser install [--dry-run]` | installs `chrome-devtools-axi` and `chrome-devtools-mcp` under the bot's node when missing, writes the browser and display environment to `~/.config/environment.d/` and above the interactive guard in `~/.bashrc`, and prints the `.claude/settings.json` `env` block for the operator to commit | 0 · 1 |

## Rules

- Bootstrap is a shell script, not part of the bundle's logic, because a fresh machine has no
  node to run the bundle with. The repo is public, so the script can be piped from `main`; the
  CLI command runs the same file. It is for any user who will do agent work on the machine,
  not only a bot's: nothing in it reads `opsbot.json`.
- Bootstrap never signs in to an account and never asks for root. What needs either is printed.

- Idempotent: a file whose content already matches is not rewritten, a password that exists is
  never regenerated, a package that is installed is not reinstalled; every command prints what
  it changed and what it left.
- `--dry-run` prints every file it would write, whole, and every command it would run, and
  changes nothing.
- The repo's `.claude/settings.json` is the permission surface: this CLI never writes it. It
  prints the `env` block; the operator commits it in a PR a person merges. `status` checks it,
  because that block is the only place that reaches the loop however it was launched.
- The environment goes in three places, each for its own reader: the repo settings for Claude
  sessions, `environment.d` for systemd units, `.bashrc` above the interactive guard for
  non-interactive shells. A value in one place and not the others is `differs`.
- Session logs are the bot's full-resolution memory (the cold-start pack and agent-recall-axi
  read them), so a bot keeps them as long as its operator does; pruning is `missing`, not a
  preference.
- Probes run in the bot's own interactive shell (`bash -ic`), because that is what the
  operator's `sudo -u <bot> -i` session and an agent's Bash tool see; asdf shims are usually
  set in `.bashrc`.
- `environment.d` is read as systemd reads it, every `*.conf` in lexical order; a value set in
  any of them counts.
- VNC listens on the tailnet address only, never `0.0.0.0`; `desktop install` refuses when no
  tailnet address is found.

## Principles

**Inherited:**
- [A bot cannot grant itself anything](../permissions.md) — the settings file stays the
  operator's; the CLI prints, never writes, the block that reaches the loop.
