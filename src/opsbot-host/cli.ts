import { AxiError, runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { cliInvocation } from "./invocation.js";
import { DESCRIPTION, commandHelp, commandReferenceText } from "./reference.js";
import { VERSION } from "./version.js";
import { homeCommand } from "./commands/home.js";
import { statusCommand } from "./commands/status.js";
import { desktopCommand } from "./commands/desktop.js";
import { browserCommand } from "./commands/browser.js";
import { sessionsCommand } from "./commands/sessions.js";
import { bootstrapCommand } from "./commands/bootstrap.js";
import { parseArgs } from "../opsbot-core/args.js";

const CLI = cliInvocation();

const TOP_HELP = `usage: ${CLI} <command> [subcommand] [flags]
       ${CLI}            # no args: home (the bot's numbers, a status count)

${commandReferenceText(CLI)}

Run as the bot's Linux user, from its repo checkout. Root's steps (the user, lingering, the
operator's sudo rule) come first; SKILL.md lists them.
flags: --help on any command, -v/--version
`;

const COMMANDS: Record<string, AxiCliCommand<undefined>> = {
  status: (a) => { parseArgs(a, {}, "status"); return statusCommand(); },
  bootstrap: (a) => bootstrapCommand(a),
  desktop: (a) => desktopCommand(a),
  browser: (a) => browserCommand(a),
  sessions: (a) => sessionsCommand(a),
  update: () => {
    throw new AxiError("opsbot-host ships inside a skill, not on npm", "VALIDATION_ERROR", [
      "Update the skill: npx skills add JarvusInnovations/opsbots --skill opsbot-host",
    ]);
  },
};

function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const code = error.code === "VALIDATION_ERROR" || error.code === "CANNOT_RUN" ? 2 : 1;
    const help = error.suggestions ?? [];
    return { output: `${encode(help.length ? { error: error.message, code: error.code, help } : { error: error.message, code: error.code })}\n`, exitCode: code };
  }
  return { output: `${encode({ error: error instanceof Error ? error.message : String(error), code: "UNKNOWN" })}\n`, exitCode: 1 };
}

export async function main(argv?: string[]): Promise<void> {
  await runAxiCli<undefined>({
    description: DESCRIPTION,
    version: VERSION,
    ...(argv ? { argv } : {}),
    topLevelHelp: TOP_HELP,
    home: () => homeCommand(),
    commands: COMMANDS,
    getCommandHelp: (command) => commandHelp(command, CLI),
    formatError,
  });
}
