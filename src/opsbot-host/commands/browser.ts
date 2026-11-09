import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseArgs } from "../../opsbot-core/args.js";
import { shell, BASHRC_BEGIN, BASHRC_END, bashrcBlock, envDFile, envDText, envValues, home, loadHost, mcpPath, readText, run } from "../host.js";
import { existsSync } from "node:fs";

const PACKAGES = ["chrome-devtools-axi", "chrome-devtools-mcp"];

/** The new .bashrc: the managed block first (above any interactive guard), the rest as it was. */
export function withBashrcBlock(text: string | null, block: string): string {
  const body = (text ?? "").split("\n");
  const b = body.indexOf(BASHRC_BEGIN);
  const e = body.indexOf(BASHRC_END);
  const rest = b >= 0 && e > b ? [...body.slice(0, b), ...body.slice(e + 1)] : body;
  while (rest.length && rest[0] === "") rest.shift();
  return `${block}\n\n${rest.join("\n")}`;
}

export function browserCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  const usage = "browser install [--dry-run]";
  if (sub !== "install") throw new AxiError(sub ? `unknown browser subcommand ${sub}` : "browser needs a subcommand", "VALIDATION_ERROR", [usage]);
  const { flags } = parseArgs(rest, { bool: ["dry-run"] }, usage);
  const dry = flags["dry-run"] === true;
  const h = loadHost();
  const changed: string[] = [];
  const kept: string[] = [];
  const ran: string[] = [];
  const would: Record<string, string> = {};

  const missing = PACKAGES.filter((p) => shell(`npm ls -g --depth=0 ${p}`).code !== 0);
  if (missing.length) {
    const c = `npm i -g ${missing.join(" ")}`;
    if (dry) ran.push(`(would run) ${c}`);
    else {
      const r = shell(c);
      if (r.code !== 0) throw new AxiError(`${c} failed: ${r.out.split("\n").find((l) => l.trim()) ?? ""}`, "CANNOT_RUN", ["Check that node and npm resolve under this user (status)"]);
      ran.push(c);
    }
  } else kept.push(...PACKAGES.map((p) => `npm ${p}`));

  const env = envValues(h);
  if (!env.CHROME_DEVTOOLS_AXI_MCP_PATH || (!dry && !existsSync(env.CHROME_DEVTOOLS_AXI_MCP_PATH))) {
    if (!dry) throw new AxiError("chrome-devtools-mcp is not where npm root -g says; the bridge needs its path", "CANNOT_RUN", ["npm i -g chrome-devtools-mcp"]);
    env.CHROME_DEVTOOLS_AXI_MCP_PATH ??= mcpPath() ?? "<npm root -g>/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js";
  }

  const writes: Array<[string, string]> = [
    [envDFile(), envDText(env)],
    [join(home(), ".bashrc"), withBashrcBlock(readText(join(home(), ".bashrc")), bashrcBlock(env))],
  ];
  for (const [p, text] of writes) {
    if (readText(p) === text) { kept.push(p); continue; }
    if (dry) { would[p] = text; continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    changed.push(p);
  }
  const settingsEnv = JSON.stringify({ env }, null, 2);
  return {
    browser: dry ? `would set up the bridge on port ${h.bridgePort}` : `bridge on port ${h.bridgePort}; headless by default`,
    ...(dry ? { would_write: would } : { changed }),
    ...(ran.length ? { [dry ? "would_run" : "ran"]: ran } : {}),
    unchanged: kept,
    repo_settings: "Merge this into the repo's .claude/settings.json and commit it in a PR a person merges (this CLI never writes it):",
    env_block: settingsEnv,
  };
}
