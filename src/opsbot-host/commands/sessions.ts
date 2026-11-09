import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseArgs } from "../../opsbot-core/args.js";
import { RETENTION_DAYS, readText, userClaudeSettings } from "../host.js";

/** The user-level settings with cleanupPeriodDays set, every other key untouched. */
export function withRetention(text: string | null): { next: string; current: unknown } {
  let obj: Record<string, unknown> = {};
  if (text && text.trim()) {
    try { obj = JSON.parse(text); } catch { throw new AxiError("~/.claude/settings.json is not valid JSON; nothing written", "CANNOT_RUN", ["Fix the file by hand, then rerun"]); }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new AxiError("~/.claude/settings.json is not a JSON object; nothing written", "CANNOT_RUN", []);
  }
  const current = obj.cleanupPeriodDays;
  return { next: `${JSON.stringify({ ...obj, cleanupPeriodDays: RETENTION_DAYS }, null, 2)}\n`, current };
}

export function sessionsCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  const usage = "sessions keep [--dry-run]";
  if (sub !== "keep") throw new AxiError(sub ? `unknown sessions subcommand ${sub}` : "sessions needs a subcommand", "VALIDATION_ERROR", [usage]);
  const { flags } = parseArgs(rest, { bool: ["dry-run"] }, usage);
  const p = userClaudeSettings();
  const text = readText(p);
  const { next, current } = withRetention(text);
  if (current === RETENTION_DAYS) return { sessions: `kept: cleanupPeriodDays is already ${RETENTION_DAYS}`, file: p };
  if (flags["dry-run"] === true) return { sessions: `would set cleanupPeriodDays ${String(current ?? "unset (30-day default)")} → ${RETENTION_DAYS}`, file: p };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, next);
  return { sessions: `cleanupPeriodDays ${String(current ?? "unset")} → ${RETENTION_DAYS}: session logs are no longer pruned`, file: p };
}
