/**
 * cold-start — what the bot reads first after a start, a resume, a clear or a
 * compaction. Prints the reground pack, in order:
 *
 *   1. the rule card (settings.rule_card at HEAD), whole
 *   2. one section per opsbot.d/wake.d/ script, in order, each capped to its
 *      share of the byte budget ("… N more lines")
 *   3. the cycle log's last 48 hours: counts, longest gap, last degraded, outages
 *   4. memory before this point is untrusted; open the source before saying
 *
 * --write also writes the pack to ~/.cache/<bot>/reground.md and sets
 * reground.pending, which `gate check` holds until the pack is read whole.
 * Never fails a start: a part it cannot read says so in its place.
 *
 * gate check — the PreToolUse body. Exit 0 when nothing is pending, or when
 * this call is a Read of the pack with no offset, limit or pages (which
 * clears the flag); otherwise prints the deny reason and exits 2.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, setExit, usageError } from "../args.js";
import { baseEnv, configSnapshot, discover, runScript } from "../lifecycle.js";
import { findRoot, firstLine, iso, nowIso, nowMs, parseIso, showHead } from "../repo.js";
import { SETTINGS_FILE, parseSettingsText, trySettings, withDefaults, type Settings } from "../settings.js";
import { CHECK_OUTCOMES, CYCLE_OUTCOMES, outages, readCycleLog } from "../state.js";

/** The pack's byte budget; the rule card is exempt and always whole. */
export const PACK_BUDGET = 9500;
const MIN_SECTION = 300;
const DAY2 = 48 * 3600_000;
const MAX_OUTAGES = 5;

export function cacheDir(name: string): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, name);
}

export function packPaths(name: string): { pack: string; pending: string } {
  const dir = cacheDir(name);
  return { pack: join(dir, "reground.md"), pending: join(dir, "reground.pending") };
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Keep whole lines within `limit` bytes, then say how many were left out. */
export function capSection(text: string, limit: number): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (bytes(lines.join("\n")) <= limit) return lines.join("\n");
  const kept: string[] = [];
  let used = 0;
  const tailRoom = 40;
  for (const l of lines) {
    const b = bytes(l) + 1;
    if (used + b > limit - tailRoom) break;
    kept.push(l);
    used += b;
  }
  if (kept.length === 0 && lines.length > 0) {
    // one line longer than the share: cut it
    kept.push(Buffer.from(lines[0]!, "utf8").subarray(0, Math.max(0, limit - tailRoom)).toString("utf8").replace(/�$/, ""));
  }
  const more = lines.length - kept.length;
  return `${kept.join("\n")}\n… ${more} more line${more === 1 ? "" : "s"}`;
}

function logSummary(root: string, now: number): string[] {
  const all = readCycleLog(root).filter((l) => {
    const t = parseIso(l.at);
    return t !== null && t >= now - DAY2;
  });
  const checks = all.filter((l) => CHECK_OUTCOMES.includes(l.outcome));
  const out: string[] = [];
  if (checks.length === 0) out.push("no cycles in the last 48 hours");
  else {
    const count = (o: string) => checks.filter((c) => c.outcome === o).length;
    const items = checks.reduce((a, c) => a + Number(c.new ?? 0), 0);
    out.push(
      `cycles ${checks.length} · nothing new ${count("nothing-new")} · new ${count("new")} · degraded ${count("degraded")} · items ${items}`,
    );
    const times = all
      .filter((l) => CYCLE_OUTCOMES.includes(l.outcome))
      .map((l) => parseIso(l.at)!)
      .sort((a, b) => a - b);
    let gap = 0;
    let from = 0;
    for (let i = 1; i < times.length; i++) {
      if (times[i]! - times[i - 1]! > gap) {
        gap = times[i]! - times[i - 1]!;
        from = times[i - 1]!;
      }
    }
    if (times.length > 1) out.push(`longest gap ${Math.floor(gap / 60_000)} min, from ${iso(from)}`);
    const last = checks[checks.length - 1]!;
    out.push(`last cycle ${last.at} · ${last.outcome}`);
    const lastDeg = [...checks].reverse().find((c) => c.outcome === "degraded");
    if (lastDeg) {
      const f = Array.isArray(lastDeg.failed) ? (lastDeg.failed as Array<{ input?: string }>).map((x) => x.input).join(", ") : "";
      out.push(`last degraded ${lastDeg.at}: ${f}`);
    }
  }
  const recent = outages(root).filter((o) => {
    const t = parseIso(o.at);
    return (t !== null && t >= now - DAY2) || o.ended === null;
  });
  if (recent.length === 0) out.push("outages: none recorded");
  else {
    out.push(`outages: ${recent.length}`);
    const shown = recent.slice(-MAX_OUTAGES);
    if (recent.length > shown.length) out.push(`  … ${recent.length - shown.length} earlier: outage list`);
    for (const o of shown) {
      out.push(`  ${o.kind} from ${o.started} to ${o.ended ?? "OPEN"}${o.note ? `: ${o.note}` : ""}`.slice(0, 200));
    }
  }
  return out;
}

export function buildPack(root: string, s: Settings, settingsText: string | null): string {
  const now = nowMs();
  const head = `═══ Cold start, ${nowIso()}. Read all of this before acting. Until you have, what you remember is untrusted.\n`;

  let card: string;
  if (!s.rule_card) card = "═══ 1. The rule card\n(no rule_card is set in opsbot.json: say so to the operator)";
  else {
    const text = showHead(root, s.rule_card);
    card =
      text === null
        ? `═══ 1. The rule card (${s.rule_card})\n(the rule card is not committed at HEAD: say so to the operator)`
        : `═══ 1. The rule card (${s.rule_card})\n${text.replace(/\n+$/, "")}`;
  }

  const scripts = discover(root, "wake").scripts;
  const summaryNo = 2 + scripts.length;
  const summary = `═══ ${summaryNo}. The cycle log, last 48 hours\n${logSummary(root, now).join("\n")}`;
  const foot = "═══ Memory before this point is untrusted: open the source before saying anything about what a record holds, what was decided, or what was sent.";

  const fixed = bytes(head) + bytes(card) + bytes(summary) + bytes(foot) + 8 + scripts.length * 2;
  const room = Math.max(0, PACK_BUDGET - fixed);
  const sections: string[] = [];
  if (scripts.length) {
    const configPath = settingsText !== null ? configSnapshot(root, settingsText) : join(root, SETTINGS_FILE);
    let remaining = room;
    scripts.forEach((sc, i) => {
      const title = `═══ ${i + 2}. ${sc.name.replace(/^\d+[-_]/, "")}`;
      const share = Math.max(MIN_SECTION, Math.floor(remaining / (scripts.length - i)) - bytes(title) - 1);
      const r = runScript(sc, root, baseEnv(root, s, configPath, "wake"));
      let body = r.stdout.trim();
      if (r.code !== 0) {
        body = `(wake.d/${sc.name} failed, exit ${r.code}: ${firstLine(r.stderr) || "no message"})${body ? `\n${body}` : ""}`;
      }
      if (!body) body = "(nothing)";
      const capped = capSection(body, share);
      const section = `${title}\n${capped}`;
      remaining -= bytes(section) + 2;
      sections.push(section);
    });
  }
  return [head, card, ...sections, summary, foot].join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function coldStartCommand(args: string[]): string {
  const { flags } = parseArgs(args, { bool: ["write"] }, "cold-start [--write]");
  setExit(0);
  const root = findRoot();
  if (!root) return "cold-start: not inside a git checkout, so there is no pack to read.";
  const text = showHead(root, SETTINGS_FILE);
  let s: Settings | null = null;
  if (text !== null) {
    const { raw, problems } = parseSettingsText(text, SETTINGS_FILE);
    if (raw && problems.length === 0) s = withDefaults(raw);
  }
  s ??= trySettings(root);
  if (!s) {
    return `cold-start: ${SETTINGS_FILE} is missing or invalid at HEAD, so the pack cannot be built. Say so to the operator, and run \`settings validate\`.`;
  }
  const pack = buildPack(root, s, text);
  if (!flags.write) return pack.replace(/\n$/, "");
  const { pack: packFile, pending } = packPaths(s.name);
  mkdirSync(cacheDir(s.name), { recursive: true });
  writeFileSync(packFile, pack);
  writeFileSync(pending, `${nowIso()}\n`);
  return [
    `═══ READ THE WHOLE PACK BEFORE ANYTHING ELSE: Read ${packFile} now, whole (no offset or limit).`,
    "═══ Every other tool is refused until you do (gate check). This hook output may be cut short; the file is not.",
    "",
    pack.replace(/\n$/, ""),
  ].join("\n");
}

// ------------------------------------------------------------- gate check

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function gateCommand(args: string[]): Promise<Record<string, unknown> | string> {
  const [sub, ...rest] = args;
  if (sub !== "check") {
    throw usageError(sub ? `unknown gate subcommand ${sub}` : "gate needs a subcommand", "gate check");
  }
  parseArgs(rest, {}, "gate check");
  setExit(0);
  const root = findRoot();
  if (!root) return { gate: "open (not inside a git checkout)" };
  const s = trySettings(root);
  if (!s) return { gate: "open (no settings)" };
  const { pack, pending } = packPaths(s.name);
  if (!existsSync(pending)) return { gate: "open" };
  let packSize = 0;
  try {
    packSize = statSync(pack).size;
  } catch {
    packSize = 0;
  }
  if (packSize === 0) {
    // no pack to read: never lock the session
    rmSync(pending, { force: true });
    return { gate: "open (no pack to read; flag cleared)" };
  }
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    input = {};
  }
  const tool = String(input.tool_name ?? "");
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const path = typeof ti.file_path === "string" ? ti.file_path : "";
  const partial = ti.offset !== undefined || ti.limit !== undefined || ti.pages !== undefined;
  if (tool === "Read" && path && resolve(path) === resolve(pack) && !partial) {
    rmSync(pending, { force: true });
    return { gate: "open (pack read whole; flag cleared)" };
  }
  const reason = `Reground first: Read ${pack} whole (no offset or limit) before any other tool. The hook output you saw may have been cut short; the file holds the rule card, what is owed and the live state.`;
  process.stderr.write(`${reason}\n`);
  setExit(2);
  return { gate: "denied", reason };
}

