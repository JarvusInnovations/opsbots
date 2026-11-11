/**
 * The single source of truth for what opsbot-host is and does: the home view, `--help` and the
 * generated region of skills/opsbot-host/SKILL.md all derive from this.
 */
import type { CommandGroup, CommandRef } from "../opsbot-core/reference.js";

export const DESCRIPTION =
  "The host floor under an ops bot's loop, run as the bot's Linux user: what is installed and what is missing, the virtual desktop with VNC on the tailnet, and the headless browser bridge with its environment in every place it must be";

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    group: "Status",
    commands: [
      { usage: "status", summary: "One row per piece (lingering, session retention, node, each tool, the desktop units, the VNC password, the browser MCP, the environment in repo settings, environment.d and .bashrc): ok, missing or differs, with the command that fixes it. Exit 1 while anything is to fix." },
    ],
  },
  {
    group: "Install",
    commands: [
      { usage: "bootstrap [--dry-run] [--tools \"a b\"|none] [--node <version>] [--no-herdr]", summary: "A fresh Linux user up to a session that can start, with no root: ~/.local/bin and the asdf shims on PATH above .bashrc's interactive guard, asdf, node (the repo's pinned version, else the latest 22; a system node does not count), the GitHub CLI, the AXI tools (gh-axi, gws-axi, slack-axi, gitsheets-axi, agent-recall-axi, chrome-devtools-axi unless --tools names others), Claude Code, herdr and its agent skill (user-wide: npx skills add -g ogulcancelik/herdr --skill herdr), and the repo's skills from skills-lock.json. Installs only what is missing and prints the sign-ins only a person can do. It is scripts/bootstrap.sh, plain bash, so a machine with no node yet pipes it from the repo; for a bot's user or a person's fresh VM alike." },
      { usage: "desktop install [--dry-run]", summary: "Xvfb, Openbox and x11vnc as user units on the bot's display, VNC bound to the tailnet address only, a VNC password generated once into ~/.config/<bot>/vnc-password. Idempotent; --dry-run prints every file whole and every command." },
      { usage: "sessions keep [--dry-run]", summary: "Set cleanupPeriodDays to 36500 in the bot's user-level ~/.claude/settings.json, every other key untouched, so Claude Code stops pruning its session logs after 30 days: they are its full-resolution memory." },
      { usage: "browser install [--dry-run]", summary: "chrome-devtools-axi and chrome-devtools-mcp under the bot's node when missing; the bridge port, MCP path and DISPLAY into environment.d and above .bashrc's interactive guard; prints the .claude/settings.json env block for the operator to commit (never writes it)." },
    ],
  },
];

export function commandReferenceText(invocation: string): string {
  return COMMAND_GROUPS.map((g) => `${g.group}:\n${g.commands.map((c) => `  ${invocation} ${c.usage}\n      ${c.summary}`).join("\n")}`).join("\n\n");
}

export function commandHelp(command: string, invocation: string): string | undefined {
  const hits: CommandRef[] = COMMAND_GROUPS.flatMap((g) => g.commands).filter((c) => c.usage.split(/[ |]/)[0] === command);
  return hits.length ? `${hits.map((c) => `usage: ${invocation} ${c.usage}\n  ${c.summary}`).join("\n\n")}\n` : undefined;
}
