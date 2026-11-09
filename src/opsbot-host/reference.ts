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
