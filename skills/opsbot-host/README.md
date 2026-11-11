# Set up a fresh Linux machine for agent work

One script takes a new Linux user, on a VM or a dev box, to the point where a Claude Code
session can start. It needs no root, and it does not sign in to anything.

## Run it

Log in as the user who will do the work (not root), then paste:

```bash
curl -fsSL https://raw.githubusercontent.com/JarvusInnovations/opsbots/main/skills/opsbot-host/scripts/bootstrap.sh | bash
```

To see what it would do without changing anything:

```bash
curl -fsSL https://raw.githubusercontent.com/JarvusInnovations/opsbots/main/skills/opsbot-host/scripts/bootstrap.sh | bash -s -- --dry-run
```

It takes a minute or two. When it finishes, open a new shell (or run `source ~/.bashrc`) so
the new tools are on your `PATH`.

## What it installs

Each step is skipped when the piece is already there, so it is safe to run again.

| Step | What it does |
| --- | --- |
| PATH | Adds `~/.local/bin` and the asdf shims to the top of `~/.bashrc` |
| [asdf](https://asdf-vm.com) | Downloads the latest release into `~/.local/bin`. It manages tool versions per user |
| node | Installs through asdf: the latest 22, or the version pinned in the current repo's `.tool-versions` |
| GitHub CLI | Installs `gh` through asdf, unless the machine already has it |
| AXI tools | `npm install -g` for `gh-axi`, `gws-axi`, `slack-axi`, `gitsheets-axi`, `agent-recall-axi` and `chrome-devtools-axi`: command-line tools agents use for GitHub, Google Workspace, Slack, structured repo data, session history and driving a browser |
| [Claude Code](https://code.claude.com/docs) | Runs Anthropic's installer |
| Session history hook | `agent-recall-axi hook install --scope user`: every Claude Code session starts with the user's past sessions in reach, and gets a resume pack after a compaction |
| [herdr](https://herdr.dev) | Runs its installer. A terminal multiplexer for agent sessions |
| herdr skill | `npx skills add -g ogulcancelik/herdr --skill herdr`: teaches agents to drive herdr, installed for the user so every project has it |
| Skills | In a repo with a `skills-lock.json`, restores any skill that is missing |

It prints one line per step: `ok` (already there), `added` (installed now), or `would`
(under `--dry-run`).

## After it finishes

The script lists the sign-ins it leaves to you. Do the ones you need:

```bash
claude              # sign in once, then /exit
gh auth login
gws-axi auth setup  # only if you will read Google Workspace
slack-axi auth      # only if you will read or post to Slack
```

## Options

Options go after `bash -s --` when piping, or straight after the script's name when you run a
local copy.

| Option | Effect |
| --- | --- |
| `--dry-run` | Print every step and its commands; change nothing |
| `--tools "a b"` | Install these npm packages instead of the default six. `--tools none` installs none |
| `--node <version>` | Install this node version |
| `--no-herdr` | Skip herdr and its skill |

Example: only the GitHub and session-history tools, no herdr.

```bash
curl -fsSL https://raw.githubusercontent.com/JarvusInnovations/opsbots/main/skills/opsbot-host/scripts/bootstrap.sh | bash -s -- --tools "gh-axi agent-recall-axi" --no-herdr
```

## What to know before you run it

- **Read it first if you like.** It is one short bash file:
  [`scripts/bootstrap.sh`](scripts/bootstrap.sh).
- **It runs two other installers.** The Claude Code and herdr steps each download that
  project's own install script and run it, the way their documentation says to.
- **It needs `curl`, `git` and `tar`.** Most images have them. If one is missing the script
  stops and says so; installing it needs root: `sudo apt install -y curl git tar`.
- **It refuses to run as root.** Everything goes under your home directory.
- **The browser tool needs Chrome.** `chrome-devtools-axi` drives a Chrome or Chromium that
  is already installed. If the machine has none, installing one needs root, for example
  `sudo apt install -y chromium`.
- **A node that came with the system is ignored.** Global installs under it need root, and
  the tools need node 20 or later.
- **If a step fails,** the script stops and prints the command it was running. Fix the cause
  and run it again; it continues from that step.
- **To undo it:** remove the block it added at the top of `~/.bashrc`, and delete
  `~/.asdf`, `~/.local/bin/asdf`, `~/.local/bin/claude`, `~/.local/share/claude`,
  `~/.local/bin/herdr`, and `~/.agents/skills/herdr` with its link in `~/.claude/skills/`;
  `agent-recall-axi hook uninstall` removes its hook from `~/.claude/settings.json`.

## For an ops bot's host

This directory is also the `opsbot-host` skill. After the bootstrap, the skill's CLI sets up
what a bot's user needs beyond the basics: keeping session logs, a virtual desktop with VNC on
the tailnet, and a headless browser. See [`SKILL.md`](SKILL.md).
