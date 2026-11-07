/**
 * The bot's own session log (Claude Code's .jsonl), read for the cold-start pack. Three
 * layers with different standing: the operator's messages (verbatim; the highest-authority
 * record of intent), the last tool calls with their results (data), and the bot's last
 * statements (its own claims, to be checked against the record). Nothing here is
 * summarized by a model; the pack is what the model reads.
 */
import { existsSync, readFileSync } from "node:fs";

export interface Ev { type: string; subtype?: string; timestamp: string; content: unknown }
interface Part { type: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown }

export const COMPACTION_MARK = "This session is being continued from a previous conversation";
const MIDTURN_MARK = "The user sent a new message while you were working:";

export function readEvents(path: string): Ev[] {
  if (!existsSync(path)) return [];
  const out: Ev[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && typeof v.type === "string") {
        const e: Ev = { type: v.type, timestamp: String(v.timestamp ?? ""), content: v.message?.content };
        if (typeof v.subtype === "string") e.subtype = v.subtype;
        out.push(e);
      }
    } catch { /* not an event line */ }
  }
  return out;
}

const parts = (c: unknown): Part[] => (Array.isArray(c) ? (c as Part[]) : []);
const partText = (c: unknown): string => (typeof c === "string" ? c : parts(c).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("\n"));

/** Index of the last compaction summary, or -1. */
export function lastCompaction(evs: Ev[]): number {
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]!;
    if (e.type === "user" && typeof e.content === "string" && e.content.startsWith(COMPACTION_MARK)) return i;
  }
  return -1;
}

const NOISE = [/^<command-/, /^<local-command/, /hook success/, /^<bash-input>/, /^\[Request interrupted/];

/** The operator's own words since `from`, verbatim: turn-initial messages and mid-turn ones. */
export function humanMessages(evs: Ev[], from = 0): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const e of evs.slice(Math.max(0, from))) {
    if (e.type !== "user") continue;
    if (typeof e.content === "string") {
      const t = e.content.trim();
      if (!t || t.startsWith(COMPACTION_MARK) || NOISE.some((r) => r.test(t))) continue;
      out.push({ at: e.timestamp, text: t });
      continue;
    }
    for (const p of parts(e.content)) {
      if (p.type !== "text" || !p.text) continue;
      const i = p.text.indexOf(MIDTURN_MARK);
      if (i >= 0) {
        const t = p.text.slice(i + MIDTURN_MARK.length).split(/\n\s*This is how Claude Code surfaces/)[0]!.trim();
        if (t) out.push({ at: e.timestamp, text: t });
      }
    }
  }
  return out;
}

/** The last `n` tool calls with the head of their results, oldest first. */
export function toolCalls(evs: Ev[], n: number, from = 0): { at: string; name: string; input: string; result: string }[] {
  const results = new Map<string, string>();
  for (const e of evs.slice(Math.max(0, from))) for (const p of parts(e.content)) if (p.type === "tool_result" && p.tool_use_id) results.set(p.tool_use_id, partText(p.content));
  const calls: { at: string; name: string; input: string; result: string }[] = [];
  for (const e of evs.slice(Math.max(0, from))) {
    if (e.type !== "assistant") continue;
    for (const p of parts(e.content)) {
      if (p.type !== "tool_use") continue;
      const inp = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {};
      const head = String(inp.command ?? inp.file_path ?? inp.prompt ?? inp.message ?? JSON.stringify(inp)).replace(/\s+/g, " ");
      calls.push({ at: e.timestamp, name: p.name ?? "?", input: head, result: (results.get(p.id ?? "") ?? "(no result recorded)").replace(/\s+/g, " ") });
    }
  }
  return calls.slice(-n);
}

/** The bot's last `n` statements, oldest first: its own claims. */
export function assistantStatements(evs: Ev[], n: number, from = 0): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const e of evs.slice(Math.max(0, from))) {
    if (e.type !== "assistant") continue;
    for (const p of parts(e.content)) if (p.type === "text" && p.text && p.text.trim()) out.push({ at: e.timestamp, text: p.text.trim() });
  }
  return out.slice(-n);
}

/**
 * Whether the log's last turn has ended. Claude Code writes a `system/turn_duration` entry when a
 * turn ends; one after the last assistant entry means the model is idle, whatever else is still
 * running in the background (a subagent, a monitor). No assistant entry at all is idle too.
 */
export function turnEnded(evs: Ev[]): { ended: true; at: string | null } | { ended: false; since: string } {
  let last = -1;
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i]!.type === "assistant") { last = i; break; }
  if (last < 0) return { ended: true, at: null };
  for (let i = evs.length - 1; i > last; i--) {
    const e = evs[i]!;
    if (e.type === "system" && e.subtype === "turn_duration") return { ended: true, at: e.timestamp || null };
  }
  return { ended: false, since: evs[last]!.timestamp };
}

/**
 * The last Monitor the session armed on `file`: when, its deadline, and whether the log already
 * shows it ending (its event delivered, its expiry, its stop). `ended` is read from later user-side
 * text that names the monitor's description together with an ending word.
 */
export function lastMonitorCall(evs: Ev[], file: string): { at: string; timeoutMs: number; description: string; ended: boolean } | null {
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]!;
    if (e.type !== "assistant") continue;
    for (const p of parts(e.content)) {
      if (p.type !== "tool_use" || p.name !== "Monitor") continue;
      const inp = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {};
      const cmd = String(inp.command ?? "");
      if (!cmd.includes(file)) continue;
      const description = String(inp.description ?? "");
      const timeoutMs = typeof inp.timeout_ms === "number" ? inp.timeout_ms : 300_000;
      let ended = false;
      if (description) {
        for (let j = i + 1; j < evs.length && !ended; j++) {
          const u = evs[j]!;
          if (u.type !== "user") continue;
          const t = partText(u.content);
          if (t.includes(description) && /\b(exited|expired|stopped|event|timed out|killed)\b/i.test(t)) ended = true;
        }
      }
      return { at: e.timestamp, timeoutMs, description, ended };
    }
  }
  return null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const hhmm = (ts: string) => (ts.length >= 16 ? ts.slice(11, 16) + "Z" : ts);

/**
 * The pack section. Operator messages first and whole (clipped only past `perMessage`
 * chars), then the last tool calls as data, then the bot's last statements flagged as
 * claims; `since` is the last compaction when there is one, else the whole log.
 */
export function sessionLogSection(path: string, opts: { calls?: number; statements?: number; perMessage?: number } = {}): string | null {
  const evs = readEvents(path);
  if (evs.length === 0) return null;
  const from = Math.max(0, lastCompaction(evs));
  const scope = from > 0 ? "since the last compaction" : "this session";
  const human = humanMessages(evs, from + 1);
  const calls = toolCalls(evs, opts.calls ?? 12, from + 1);
  const said = assistantStatements(evs, opts.statements ?? 3, from + 1);
  const pm = opts.perMessage ?? 700;
  const lines: string[] = [];
  lines.push(`From your own session log (${scope}; ${path}). Three layers, different standing:`);
  lines.push(`• The operator's words, verbatim: the highest authority here. ${human.length === 0 ? "(none in this window)" : ""}`);
  for (const h of human) lines.push(`  ${hhmm(h.at)} » ${clip(h.text.replace(/\n+/g, " ⏎ "), pm)}`);
  lines.push(`• Your last ${calls.length} tool calls, as data (what ran, what came back):`);
  for (const c of calls) lines.push(`  ${hhmm(c.at)} ${c.name} ${clip(c.input, 110)} → ${clip(c.result, 110)}`);
  lines.push(`• Your last statements, as your own claims (check them against the record and the results above):`);
  for (const s of said) lines.push(`  ${hhmm(s.at)} “${clip(s.text.replace(/\n+/g, " ⏎ "), 240)}”`);
  return lines.join("\n");
}
