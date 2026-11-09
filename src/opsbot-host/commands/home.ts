import { cliInvocation } from "../invocation.js";
import { DESCRIPTION } from "../reference.js";
import { loadHost } from "../host.js";
import { statusRows } from "./status.js";

export function homeCommand(): Record<string, unknown> {
  const h = loadHost();
  const rows = statusRows(h);
  const bad = rows.filter((r) => r.state !== "ok").length;
  const cli = cliInvocation();
  return {
    bin: cli,
    description: DESCRIPTION,
    host: { bot: h.bot, uid: h.uid, display: `:${h.display} (${h.source.display})`, vnc_port: `${h.vncPort} (${h.source.vnc_port})`, bridge_port: `${h.bridgePort} (${h.source.bridge_port})` },
    status: bad ? `${bad} of ${rows.length} to fix` : `all ${rows.length} ok`,
    help: [`Run \`${cli} status\` for each piece and its fix`, `Run \`${cli} desktop install --dry-run\` or \`${cli} browser install --dry-run\` to see what would change`],
  };
}
