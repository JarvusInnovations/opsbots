/**
 * bootstrap — a fresh Linux user up to a session that can start, with no root.
 *
 * The work is `scripts/bootstrap.sh`, plain bash, because it has to run before node exists:
 * a fresh machine pipes it from the repo, and this command is the same script for a machine
 * that already has the skill (a rerun, a `--dry-run`, a second user). One implementation.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError } from "axi-sdk-js";
import { setExit } from "../../opsbot-core/args.js";

export const RAW_URL = "https://raw.githubusercontent.com/JarvusInnovations/opsbots/main/skills/opsbot-host/scripts/bootstrap.sh";

/** The script beside the bundle (installed skill) or in the repo's skill directory (source run). */
export function bootstrapScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OPSBOT_HOST_BOOTSTRAP,
    join(here, "bootstrap.sh"),
    join(here, "..", "..", "..", "skills", "opsbot-host", "scripts", "bootstrap.sh"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function bootstrapCommand(args: string[]): string {
  const script = bootstrapScript();
  if (!script) throw new AxiError("bootstrap.sh is not beside this CLI", "CANNOT_RUN", [`Run it from the repo: curl -fsSL ${RAW_URL} | bash`]);
  // the script validates its own flags and prints its own rows; its output is this command's output
  const r = spawnSync("bash", [script, ...args], { stdio: "inherit", timeout: 3_600_000 });
  setExit(r.error ? 1 : (r.status ?? 1));
  return "";
}
