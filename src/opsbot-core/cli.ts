import { AxiError, runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { cliInvocation } from "./invocation.js";
import { DESCRIPTION, commandHelp, commandReferenceText } from "./reference.js";
import { VERSION } from "./version.js";
import { homeCommand } from "./commands/home.js";
import { checkCommand } from "./commands/check.js";
import { cycleCommand } from "./commands/cycle.js";
import { coldStartCommand, gateCommand } from "./commands/coldstart.js";
import { outageCommand } from "./commands/outage.js";
import { watchdogCommand, nudgeCommand } from "./commands/liveness.js";
import { infraCommand } from "./commands/infra.js";
import { hookCommand } from "./commands/hook.js";
import { hooksCommand, lockCommand, logCommand, nextDelayCommand, settingsCommand } from "./commands/simple.js";

const CLI = cliInvocation();

const TOP_HELP = `usage: ${CLI} <command> [subcommand] [args] [flags]
       ${CLI}            # no args: home (last cycle, lock, next wake)

${commandReferenceText(CLI)}

flags: --help on any command, -v/--version
env:   OPSBOT_ROOT (the bot's repo; default: the git top level of the working directory)
`;

const COMMANDS: Record<string, AxiCliCommand<undefined>> = {
  check: (a) => checkCommand(a),
  cycle: (a) => cycleCommand(a),
  "next-delay": (a) => nextDelayCommand(a),
  "cold-start": (a) => coldStartCommand(a),
  gate: (a) => gateCommand(a),
  lock: (a) => lockCommand(a),
  outage: (a) => outageCommand(a),
  watchdog: (a) => watchdogCommand(a),
  nudge: (a) => nudgeCommand(a),
  infra: (a) => infraCommand(a),
  hook: (a) => hookCommand(a),
  hooks: (a) => hooksCommand(a),
  log: (a) => logCommand(a),
  settings: (a) => settingsCommand(a),
  // shadows the SDK's npm self-update: this CLI ships inside a skill
  update: () => {
    throw new AxiError("opsbot-core ships inside a skill, not on npm", "VALIDATION_ERROR", [
      "Update the skill: npx skills add JarvusInnovations/opsbots --skill opsbot-core",
    ]);
  },
};

function renderError(message: string, code: string, help: string[] = []): string {
  return encode(help.length ? { error: message, code, help } : { error: message, code });
}

function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const code = error.code === "VALIDATION_ERROR" || error.code === "CANNOT_RUN" ? 2 : 1;
    return { output: `${renderError(error.message, error.code, error.suggestions)}\n`, exitCode: code };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { output: `${renderError(message, "UNKNOWN")}\n`, exitCode: 1 };
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
