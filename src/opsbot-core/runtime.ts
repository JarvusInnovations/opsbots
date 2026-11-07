/**
 * The runtime adapter: how the core finds the bot's session and prompts it.
 * The session must be addressable (a named agent in a multiplexer) for the
 * nudge to work. One setting picks the adapter; the first is herdr.
 *
 * OPSBOT_RUNTIME_FAKE=<file> replaces the adapter with a file-backed fake for
 * tests: the file holds {"status": "...", "pane": "...", "error": {code,
 * message}?, "prompt_error": {code, message}?}, and each prompt is appended
 * to <file>.prompts.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./repo.js";
import type { Settings } from "./settings.js";

export type AgentStatus = "idle" | "done" | "working" | "blocked" | "unknown";

/** `log` is the agent's own session log when the runtime can name it (herdr gives the session id
 * and cwd; Claude Code keeps the log under ~/.claude/projects/<cwd slug>/<id>.jsonl). */
export type Found = { ok: true; status: AgentStatus; pane: string; log?: string } | { ok: false; code: string; message: string };
export type Prompted = { ok: true } | { ok: false; code: string; message: string };

export interface RuntimeAdapter {
  name: string;
  get(agent: string): Found;
  prompt(agent: string, text: string): Prompted;
}

function normStatus(s: unknown): AgentStatus {
  return s === "idle" || s === "done" || s === "working" || s === "blocked" ? s : "unknown";
}

/** "<code>: <message>" from herdr's error JSON ({"error":{code,message}}), or the output's first line. */
function herdrError(out: string): { code: string; message: string } {
  for (const line of out.split("\n")) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && v.error && typeof v.error === "object") {
        return { code: String(v.error.code ?? "error"), message: String(v.error.message ?? "") };
      }
    } catch {
      // not JSON
    }
  }
  return { code: "error", message: (out.split("\n").find((l) => l.trim()) ?? "no output").trim() };
}

/** Pick the bot's pane from `herdr agent list`: by name first, else the one agent whose cwd is the
 * bot's root. The name herdr shows can be lost or overwritten (a pane renamed, a session restarted),
 * while the cwd is the checkout, so the cwd is the stable key. Exported for tests. */
export function pickAgent(agents: unknown, agent: string, root: string): { pane: string; status: unknown; by: "name" | "cwd"; log?: string } | null {
  if (!Array.isArray(agents)) return null;
  const rows = agents.filter((a) => a && typeof a === "object") as Record<string, unknown>[];
  const hit = (row: Record<string, unknown>, by: "name" | "cwd") => {
    const out: { pane: string; status: unknown; by: "name" | "cwd"; log?: string } = { pane: String(row.pane_id ?? "?"), status: row.agent_status, by };
    const log = sessionLogPath(row);
    if (log) out.log = log;
    return out;
  };
  const byName = rows.find((a) => a.name === agent);
  if (byName) return hit(byName, "name");
  const norm = (p: unknown) => String(p ?? "").replace(/\/+$/, "");
  const byCwd = rows.filter((a) => norm(a.cwd) === norm(root));
  if (byCwd.length === 1) return hit(byCwd[0]!, "cwd");
  return null;
}

/** Claude Code's project slug: every character outside [A-Za-z0-9] becomes a dash. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** ~/.claude/projects/<slug>/<session id>.jsonl from a herdr agent row, when it names a session id. */
export function sessionLogPath(row: Record<string, unknown>): string | null {
  const sess = row.agent_session as Record<string, unknown> | undefined;
  const id = sess && sess.kind === "id" && typeof sess.value === "string" ? sess.value : null;
  const cwd = typeof row.cwd === "string" ? row.cwd : null;
  if (!id || !cwd || !/^[A-Za-z0-9-]+$/.test(id)) return null;
  return join(homedir(), ".claude", "projects", projectSlug(cwd), `${id}.jsonl`);
}

function herdrResolve(agent: string): { ok: true; pane: string; status: AgentStatus; by: "name" | "cwd"; log?: string } | { ok: false; code: string; message: string } {
  const r = run("herdr", ["agent", "list"]);
  if (r.code === 127) return { ok: false, code: "no_runtime", message: "herdr is not installed" };
  if (r.code !== 0) return { ok: false, ...herdrError(`${r.stderr}\n${r.stdout}`) };
  let list: unknown;
  try { list = JSON.parse(r.stdout)?.result?.agents; } catch { list = undefined; }
  const root = process.env.OPSBOT_ROOT || process.cwd();
  const hit = pickAgent(list, agent, root);
  if (!hit) return { ok: false, code: "agent_not_found", message: `no herdr agent named ${agent} and no single agent running in ${root}` };
  return { ok: true, pane: hit.pane, status: normStatus(hit.status), by: hit.by, ...(hit.log ? { log: hit.log } : {}) };
}

export const herdrAdapter: RuntimeAdapter = {
  name: "herdr",
  get(agent) {
    const h = herdrResolve(agent);
    if (!h.ok) return h;
    return { ok: true, status: h.status, pane: h.pane, ...(h.log ? { log: h.log } : {}) };
  },
  prompt(agent, text) {
    const h = herdrResolve(agent);
    if (!h.ok) return h;
    // prompt the pane, not the name: the name can be stale while the pane is the running session
    const target = h.pane;
    // herdr sends the text and Enter as one submission, refuses a blocked agent
    // before sending, and with --wait fails unless the agent is seen working or
    // blocked in time
    const r = run("herdr", ["agent", "prompt", target, text, "--wait", "--until", "working", "--until", "blocked", "--timeout", "15000"]);
    if (r.code === 127) return { ok: false, code: "no_runtime", message: "herdr is not installed" };
    if (r.code === 0) return { ok: true };
    return { ok: false, ...herdrError(`${r.stderr}\n${r.stdout}`) };
  },
};

function fakeAdapter(file: string): RuntimeAdapter {
  const state = () => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  };
  return {
    name: "fake",
    get() {
      const s = state();
      const e = s.error as { code?: string; message?: string } | undefined;
      if (e) return { ok: false, code: String(e.code ?? "error"), message: String(e.message ?? "") };
      const log = typeof s.session_log === "string" ? s.session_log : undefined;
      return { ok: true, status: normStatus(s.status), pane: String(s.pane ?? "p1"), ...(log ? { log } : {}) };
    },
    prompt(_agent, text) {
      const e = state().prompt_error as { code?: string; message?: string } | undefined;
      if (e) return { ok: false, code: String(e.code ?? "error"), message: String(e.message ?? "") };
      appendFileSync(`${file}.prompts`, `${JSON.stringify(text)}\n`);
      return { ok: true };
    },
  };
}

export function runtimeFor(s: Settings): RuntimeAdapter {
  const fake = process.env.OPSBOT_RUNTIME_FAKE;
  if (fake) return fakeAdapter(fake);
  switch (s.runtime.adapter) {
    case "herdr":
    default:
      return herdrAdapter;
  }
}
