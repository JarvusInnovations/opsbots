/**
 * record status — each sheet in the repo's `.gitsheets/`, the recalls that name it, and its
 * open-row count by each recall's filter; a sheet no recall names is flagged, since nothing would
 * ever show the session one of its rows again (specs/skills/opsbot-core.md, The console, and the
 * record). Reads only: the queries write nothing in the repo.
 */
import { usageError, parseArgs } from "../args.js";
import { cliInvocation } from "../invocation.js";
import { listSheets, queryRecall, sheetConfig } from "../record.js";
import { nowMs, requireRoot } from "../repo.js";
import { loadSettings } from "../settings.js";

export const RECORD_USAGE = "record status";

export function recordCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub !== "status") throw usageError(sub ? `unknown record subcommand ${sub}` : "record needs a subcommand", RECORD_USAGE);
  parseArgs(rest, {}, RECORD_USAGE);
  const root = requireRoot();
  const { settings } = loadSettings(root);
  const recalls = settings.record.recall;
  const sheets = [...new Set([...listSheets(root), ...recalls.map((r) => r.sheet)])].sort();
  if (sheets.length === 0) {
    return {
      record: "0 sheets in .gitsheets/ and no recalls",
      help: ["Copy a starting point from the skill's templates/sheets/ to .gitsheets/, and add its recall to record.recall in opsbot.json"],
    };
  }
  const rows: Array<Record<string, unknown>> = [];
  let unnamed = 0;
  let failing = 0;
  for (const sheet of sheets) {
    const mine = recalls.filter((r) => r.sheet === sheet);
    if (mine.length === 0) {
      unnamed++;
      rows.push({ sheet, at: "none", filter: "none", open: "unknown", note: "no recall names it: nothing would show you a row again" });
      continue;
    }
    const exists = sheetConfig(root, sheet) !== null;
    for (const r of mine) {
      const q = queryRecall(root, r, nowMs(), settings.timezone);
      const filter = q.clauses.join(" ") || "(none)";
      if ("error" in q) {
        failing++;
        rows.push({ sheet, at: r.at, filter, open: "unknown", note: exists ? q.error : `missing: no .gitsheets/${sheet}.toml` });
      } else rows.push({ sheet, at: r.at, filter, open: q.rows.length, note: "" });
    }
  }
  const out: Record<string, unknown> = {
    record: `${sheets.length} sheet${sheets.length === 1 ? "" : "s"} · ${recalls.length} recall${recalls.length === 1 ? "" : "s"}${unnamed ? ` · ${unnamed} no recall names` : ""}${failing ? ` · ${failing} recall${failing === 1 ? "" : "s"} cannot run` : ""}`,
    sheets: rows,
  };
  const help: string[] = [];
  if (unnamed) help.push("Give each flagged sheet a recall in record.recall (opsbot.json), or retire the sheet");
  if (failing) help.push(`Run \`${cliInvocation()} settings validate\` for the reason in full`);
  if (help.length) out.help = help;
  return out;
}
