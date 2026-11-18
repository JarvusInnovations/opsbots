#!/usr/bin/env node
// google-push.mjs: the opsbot-google skill's one library, Node 22, no dependencies. OAuth with the
// skill's own grant, Pub/Sub pull, and the sources. Today one source, Gmail; the Meet source is
// added beside it (SOURCES below) without changing the rest.
//
//   node google-push.mjs listen gmail       the Gmail listener (monitor.d/30-gmail-push runs this)
//   node google-push.mjs heartbeat gmail    the Gmail push's health (heartbeat.d/15-gmail-push)
//   node google-push.mjs login --source gmail|meet|both --client <file> [--paste]
//   node google-push.mjs ensure [--source …] [--dry-run]
//   node google-push.mjs status-rows [--source …]   one TSV row per check: state, piece, detail, fix
//
// Settings are streams.gmail_push in opsbot.json (OPSBOT_CONFIG, else <OPSBOT_ROOT>/opsbot.json).
// Nothing here has a default naming a project, an address or a zone.
//
// What reaches a file or a log: the account, history ids, counts, problem kinds and HTTP
// statuses. Never a sender, a subject, a snippet, a thread id or a message id: the grant
// (gmail.metadata) cannot read a body, and what it can read is used only to count.
//
// Test-only environment (never set on a running bot): OPSBOT_GOOGLE_AUTH_URL, OPSBOT_GOOGLE_TOKEN_URL,
// OPSBOT_GOOGLE_GMAIL_URL and OPSBOT_GOOGLE_PUBSUB_URL point the endpoints at a stand-in;
// OPSBOT_GOOGLE_BACKOFF_MS (5000) is the first retry delay (doubling to 60 times it);
// OPSBOT_GOOGLE_SIGNIN_RETRY_MS (1 800 000) the wait between tries while the sign-in problem stands.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ endpoints and scopes

const base = (env, def) => (process.env[env] || def).replace(/\/+$/, "");
export const endpoints = () => ({
  auth: base("OPSBOT_GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
  token: base("OPSBOT_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
  gmail: base("OPSBOT_GOOGLE_GMAIL_URL", "https://gmail.googleapis.com"),
  pubsub: base("OPSBOT_GOOGLE_PUBSUB_URL", "https://pubsub.googleapis.com"),
});

const G = "https://www.googleapis.com/auth/";
/** Exactly what each source's grant asks for. */
export const SCOPES = {
  gmail: [`${G}gmail.metadata`, `${G}pubsub`],
  meet: [`${G}meetings.space.readonly`, `${G}drive.metadata.readonly`, `${G}pubsub`],
};
/** The sources this build can run. Meet is its own plan. */
export const SOURCES = ["gmail"];
export const NOT_YET = { meet: "meet: not yet available" };
const short = (s) => s.replace(G, "");

const envMs = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : def; };
const iso = (ms = Date.now()) => new Date(ms).toISOString();

// ------------------------------------------------------------------ settings

const home = (p) => (typeof p === "string" && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

export function loadConfig() {
  const root = process.env.OPSBOT_ROOT || process.cwd();
  const file = process.env.OPSBOT_CONFIG || join(root, "opsbot.json");
  return { root, cfg: JSON.parse(readFileSync(file, "utf8")) };
}

/**
 * streams.gmail_push with its defaults. `missing` lists required keys that are absent; `bad`
 * lists values that cannot be used (the listener refuses to start on either). Pure.
 */
export function gmailSettings(cfg) {
  const raw = (cfg && cfg.streams && cfg.streams.gmail_push) || {};
  const name = cfg && typeof cfg.name === "string" ? cfg.name : "";
  const str = (k) => (typeof raw[k] === "string" && raw[k].trim() ? raw[k].trim() : "");
  const bad = [];
  const num = (k, def) => {
    if (raw[k] === undefined) return def;
    if (typeof raw[k] === "number" && Number.isFinite(raw[k]) && raw[k] >= 0) return raw[k];
    bad.push(`${k} ${JSON.stringify(raw[k])} is not a number, 0 or more`);
    return def;
  };
  const missing = ["account", "project", "topic", "subscription"].filter((k) => !str(k));
  const project = str("project");
  const full = (v, kind) => (!v ? "" : v.startsWith("projects/") ? v : project ? `projects/${project}/${kind}/${v}` : "");
  let labels = ["INBOX"];
  if (raw.labels !== undefined) {
    if (Array.isArray(raw.labels) && raw.labels.length && raw.labels.every((l) => typeof l === "string" && l)) labels = raw.labels;
    else bad.push(`labels ${JSON.stringify(raw.labels)} is not a list of label ids`);
  }
  const grace = raw.wake_grace_seconds === undefined ? 20 : Number.isInteger(raw.wake_grace_seconds) && raw.wake_grace_seconds >= 0 ? raw.wake_grace_seconds : (bad.push(`wake_grace_seconds ${JSON.stringify(raw.wake_grace_seconds)} is not a whole number of seconds`), 20);
  const path = (k, def) => home(str(k) || def);
  return {
    present: !!(cfg && cfg.streams && cfg.streams.gmail_push),
    enabled: raw.enabled === true,
    name,
    account: str("account"),
    project,
    topic: full(str("topic"), "topics"),
    subscription: full(str("subscription"), "subscriptions"),
    tokenFile: path("token_file", `~/.config/${name}/google-push-token.json`),
    wakeFile: path("wake_file", `~/.cache/${name}/gmail-push.jsonl`),
    stateFile: path("state_file", `~/.cache/${name}/gmail-push-state.json`),
    wakeFileSetting: str("wake_file") || `~/.cache/${name}/gmail-push.jsonl`,
    graceS: grace,
    problemAfterMs: num("problem_after_minutes", 5) * 60_000,
    staleMs: num("stale_minutes", 15) * 60_000,
    labels,
    renewMs: num("renew_hours", 24) * 3_600_000,
    renewBeforeMs: num("renew_before_hours", 24) * 3_600_000,
    missing,
    bad,
  };
}

// ------------------------------------------------------------------ private files

/** mkdir -p with 0700 for every directory it creates. */
function privateDir(dir) {
  const made = [];
  let d = dir;
  while (!existsSync(d)) { made.unshift(d); d = dirname(d); }
  for (const m of made) { mkdirSync(m, { mode: 0o700 }); chmodSync(m, 0o700); }
}

/** Write a file whole, 0600: a temporary file beside it, then a rename. Throws on failure. */
export function writePrivate(file, text) {
  privateDir(dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Append one line, creating the file 0600. Throws on failure. */
export function appendPrivate(file, line) {
  privateDir(dirname(file));
  const fresh = !existsSync(file);
  appendFileSync(file, line, { mode: 0o600 });
  if (fresh) chmodSync(file, 0o600);
}

export function readState(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

// ------------------------------------------------------------------ errors and HTTP

/** kind: "sign-in" (the grant: run login) or "http" / "net" (anything else). */
export class GoogleError extends Error {
  constructor(kind, message, status = 0) { super(message); this.kind = kind; this.status = status; }
}
const signIn = (m) => new GoogleError("sign-in", m);

/** One JSON call. 401, and a 403 that names a scope, are sign-in; never a body in the message. */
export async function call(method, url, token, body, timeoutMs = 60_000) {
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new GoogleError("net", e && e.name === "TimeoutError" ? "timed out" : (e && e.cause && e.cause.code) || "network error");
  }
  const text = await r.text().catch(() => "");
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  const status = j && j.error && typeof j.error === "object" && typeof j.error.status === "string" ? ` ${j.error.status}` : "";
  if (r.status === 401) throw signIn(`HTTP 401${status}: the grant was refused`);
  if (r.status === 403 && /scope/i.test(text)) throw signIn(`HTTP 403${status}: the grant lacks a scope`);
  if (!r.ok) throw new GoogleError("http", `HTTP ${r.status}${status}`, r.status);
  return j;
}

// ------------------------------------------------------------------ the credential

/** The token file, checked: present, 0600, JSON with a refresh token and every scope. */
export function readToken(file, scopes) {
  let st;
  try { st = statSync(file); } catch { throw signIn("no token file"); }
  if ((st.mode & 0o077) !== 0) throw signIn("the token file is readable by others");
  let t;
  try { t = JSON.parse(readFileSync(file, "utf8")); } catch { throw signIn("the token file is not JSON"); }
  if (!t || !t.refresh_token || !t.client_id) throw signIn("the token file has no refresh token or client id");
  const have = String(t.scope || "").split(/\s+/);
  const lack = scopes.filter((s) => !have.includes(s));
  if (lack.length) throw signIn(`the grant lacks ${lack.map(short).join(", ")}`);
  return t;
}

/**
 * A usable access token: the stored one while it has a minute left, else a refresh. With
 * `persist` the refreshed token is written back in place (0600); status passes false and keeps
 * it in memory. invalid_grant, and any 400/401 from the token endpoint, is sign-in.
 */
export async function accessToken(file, scopes, { persist = true } = {}) {
  const t = readToken(file, scopes);
  if (t.access_token && Number(t.expires_at) - 60_000 > Date.now()) return t.access_token;
  const form = new URLSearchParams({ client_id: t.client_id, refresh_token: t.refresh_token, grant_type: "refresh_token" });
  if (t.client_secret) form.set("client_secret", t.client_secret);
  let r;
  try {
    r = await fetch(endpoints().token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(30_000) });
  } catch (e) { throw new GoogleError("net", `token refresh: ${(e && e.cause && e.cause.code) || "network error"}`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "invalid_grant" || j.error === "unauthorized_client" || j.error === "invalid_client" || r.status === 401) throw signIn(`token refresh refused: ${j.error || `HTTP ${r.status}`}`);
    throw new GoogleError("http", `token refresh: HTTP ${r.status}`, r.status);
  }
  if (!j.access_token) throw new GoogleError("http", "token refresh: no access token in the answer");
  const next = { ...t, access_token: j.access_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  if (j.scope) next.scope = j.scope;
  if (j.refresh_token) next.refresh_token = j.refresh_token;
  const have = String(next.scope || "").split(/\s+/);
  const lack = scopes.filter((s) => !have.includes(s));
  if (lack.length) throw signIn(`the grant lacks ${lack.map(short).join(", ")}`);
  if (persist) writePrivate(file, JSON.stringify(next, null, 2) + "\n");
  return next.access_token;
}

// ------------------------------------------------------------------ Pub/Sub

export async function pull(token, subscription, { max = 50, immediate = false } = {}) {
  const j = await call("POST", `${endpoints().pubsub}/v1/${subscription}:pull`, token, { maxMessages: max, ...(immediate ? { returnImmediately: true } : {}) }, 120_000);
  return Array.isArray(j.receivedMessages) ? j.receivedMessages : [];
}
export const acknowledge = (token, subscription, ackIds) => call("POST", `${endpoints().pubsub}/v1/${subscription}:acknowledge`, token, { ackIds });
/** Hand messages straight back (deadline 0): they are redelivered at once. */
export const release = (token, subscription, ackIds) => call("POST", `${endpoints().pubsub}/v1/${subscription}:modifyAckDeadline`, token, { ackIds, ackDeadlineSeconds: 0 });

/** A Gmail notification's data: {emailAddress, historyId}, or null. */
export function decodeNotification(m) {
  try {
    const d = JSON.parse(Buffer.from(String(m && m.message && m.message.data), "base64").toString("utf8"));
    if (!d || typeof d.emailAddress !== "string" || !/^\d+$/.test(String(d.historyId))) return null;
    return { emailAddress: d.emailAddress, historyId: String(d.historyId) };
  } catch { return null; }
}

// ------------------------------------------------------------------ Gmail

const big = (v) => BigInt(String(v));
const maxBig = (a, b) => (a === null ? b : b === null ? a : a > b ? a : b);

export async function gmailWatch(token, s) {
  return call("POST", `${endpoints().gmail}/gmail/v1/users/me/watch`, token, { topicName: s.topic, labelIds: s.labels, labelFilterBehavior: "include" });
}

/** Whether a message with these labels counts: one of the watched labels, neither SENT nor DRAFT. Pure. */
export const counts = (labelIds, watched) => Array.isArray(labelIds) && labelIds.some((l) => watched.includes(l)) && !labelIds.includes("SENT") && !labelIds.includes("DRAFT");

/**
 * The mailbox history since `cursor`, paged: {count, lastId, historyId}. `count` is messages
 * newly added that count; `lastId` the newest history record that counted one (the line's key);
 * `historyId` the newest id seen (the next cursor). A record with no labels is looked up with
 * messages.get?format=minimal; a 404 there is a message gone since, skipped. A 404 on the list
 * itself is thrown with status 404 (the cursor is gone).
 */
export async function gmailHistory(token, cursor, watched) {
  const g = endpoints().gmail;
  let count = 0;
  let lastId = null;
  let hid = big(cursor);
  const seen = new Set();
  let page = "";
  do {
    const q = new URLSearchParams({ startHistoryId: String(cursor), historyTypes: "messageAdded", maxResults: "500" });
    if (page) q.set("pageToken", page);
    const j = await call("GET", `${g}/gmail/v1/users/me/history?${q}`, token);
    for (const rec of Array.isArray(j.history) ? j.history : []) {
      for (const added of Array.isArray(rec && rec.messagesAdded) ? rec.messagesAdded : []) {
        const m = added && added.message;
        if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
        seen.add(m.id);
        let labels = m.labelIds;
        if (!Array.isArray(labels)) {
          try {
            labels = (await call("GET", `${g}/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=minimal`, token)).labelIds;
          } catch (e) {
            if (e.status === 404) continue;
            throw e;
          }
        }
        if (counts(labels, watched)) { count++; if (rec.id !== undefined) lastId = maxBig(lastId, big(rec.id)); }
      }
      if (rec && rec.id !== undefined) hid = maxBig(hid, big(rec.id));
    }
    if (j.historyId !== undefined) hid = maxBig(hid, big(j.historyId));
    page = typeof j.nextPageToken === "string" ? j.nextPageToken : "";
  } while (page);
  return { count, lastId: lastId === null ? null : String(lastId), historyId: String(hid) };
}

// ------------------------------------------------------------------ the backstop
// The wake routine is the core's (`opsbot-core wake backstop`); this only runs it. The same block
// is in every kit listener (opsbot-slack, opsbot-whatsapp, this); keep them in step.

/**
 * One pending wake at a time. The first `add(key, reason)` runs `<core> wake backstop` detached;
 * events that arrive while it is pending join it. When it ends `woken by monitor` and events
 * joined, one more runs for the newest of them. Its notes and its line go to the journal.
 */
export function makeBackstop({ core, root, graceS, log, env = process.env }) {
  let pending = false;
  let joined = null;
  function start(ev) {
    pending = true;
    joined = null;
    const args = ["wake", "backstop", "--key", ev.key, "--at", new Date(ev.at).toISOString(), "--grace", String(graceS), "--reason", ev.reason];
    let out = "", err = "", ended = false;
    const end = (code, why) => {
      if (ended) return;
      ended = true;
      const m = /^backstop: "?(.*?)"?$/m.exec(out);
      const said = m ? m[1] : "";
      if (said === "gave up") log("!", "wake gave up for", ev.key);
      else if (said) log(said);
      else log("!", "wake backstop:", why || out.trim().split("\n")[0] || `exit ${code}`);
      pending = false;
      const next = joined;
      joined = null;
      if (next && said === "woken by monitor") start(next);
    };
    let child;
    try {
      child = spawn(core, args, { cwd: root, env: { ...env, OPSBOT_ROOT: root }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { end(null, e.code || e.message); return; }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      err += d;
      for (let i = err.indexOf("\n"); i >= 0; i = err.indexOf("\n")) {
        const l = err.slice(0, i).trim();
        err = err.slice(i + 1);
        if (l) log(l);
      }
    });
    child.on("error", (e) => end(null, e.code === "ENOENT" ? `${core} not found` : e.code || e.message));
    child.on("close", (code) => end(code));
  }
  return {
    add(key, reason) {
      const ev = { key, reason, at: Date.now() };
      if (pending) { joined = ev; return; }
      start(ev);
    },
  };
}

// ------------------------------------------------------------------ the Gmail listener

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logger = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * The listener. Watch (at start, when due, or with no cursor); pull; per batch: read the history
 * since the cursor and count; write the wake line, then the state (temporary file, rename),
 * then acknowledge, then the backstop. Problems by kind, raised once after
 * problem_after_minutes (sign-in at once), kept in the state file, cleared by the next success.
 */
export async function runGmail({ cfg, root, log = logger }) {
  const s = gmailSettings(cfg);
  if (!s.enabled) {
    log("streams.gmail_push.enabled is not true: the Gmail listener does nothing");
    await new Promise(() => {}); // idle, so the always-restarting unit does not loop
  }
  if (s.missing.length || s.bad.length) {
    for (const k of s.missing) console.error(`streams.gmail_push.${k} is required and not set in opsbot.json; the listener does not start`);
    for (const b of s.bad) console.error(`streams.gmail_push.${b}; the listener does not start`);
    process.exit(1);
  }
  const scopes = SCOPES.gmail;
  const core = process.env.OPSBOT_CORE || join(root, ".agents/skills/opsbot-core/scripts/opsbot-core");
  const backstop = makeBackstop({ core, root, graceS: s.graceS, log });
  const BACKOFF = envMs("OPSBOT_GOOGLE_BACKOFF_MS", 5000);
  const SIGNIN_RETRY = envMs("OPSBOT_GOOGLE_SIGNIN_RETRY_MS", 1_800_000);
  const account = s.account;

  const loaded = readState(s.stateFile);
  const state = loaded && typeof loaded === "object" ? loaded : {};
  if (!state.problems || typeof state.problems !== "object") state.problems = {};
  // the write problem is never on disk: a disk that refused a write is not asked to hold it
  const memory = {};
  let lastPullSaved = 0;

  try { appendPrivate(s.wakeFile, ""); } catch (e) { log("!", "cannot create the wake file:", e.code || "error"); }
  log(`gmail push for ${cfg.name}: ${account} on ${s.subscription}, labels ${s.labels.join(",")}; wake file ${s.wakeFile}`);

  /** Persist the state; false (and the write problem) when it could not. */
  const save = () => {
    try { writePrivate(s.stateFile, JSON.stringify(state, null, 2) + "\n"); clear("write"); return true; }
    catch (e) { fail("write", `state file: ${e.code || "error"}`); return false; }
  };
  const wake = (line) => appendPrivate(s.wakeFile, JSON.stringify(line) + "\n");
  const store = (kind) => (kind === "write" ? memory : state.problems);

  function fail(kind, detail) {
    const now = Date.now();
    const box = store(kind);
    const p = box[kind] || (box[kind] = { since: iso(now), raised: false });
    p.detail = detail;
    p.last = iso(now);
    if (!p.raised && (kind === "sign-in" || now - Date.parse(p.since) >= s.problemAfterMs)) {
      try {
        wake({ key: `gmail:problem:${kind}:${p.since}`, type: "problem", kind, recorded_at: iso(now) });
        p.raised = true;
        log("!", `problem raised: ${kind} since ${p.since}: ${detail}`);
      } catch (e) {
        log("!", `could not record the ${kind} problem: wake file: ${e.code || "error"}`);
        if (kind !== "write") fail("write", `wake file: ${e.code || "error"}`);
      }
    } else log("!", `${kind}: ${detail}`);
    if (kind !== "write") save();
  }
  function clear(kind) {
    const box = store(kind);
    if (!box[kind]) return;
    delete box[kind];
    log(`problem cleared: ${kind}`);
    if (kind !== "write") save();
  }

  /** Run `fn` as operation `kind`: its failure is that kind, or sign-in. */
  const op = async (kind, fn) => {
    try { return await fn(); } catch (e) { e.op = e.kind === "sign-in" ? "sign-in" : kind; throw e; }
  };
  /** The access token, a refresh failing as sign-in or as the operation that needed it. */
  const token = (kind) => op(kind, () => accessToken(s.tokenFile, scopes));
  let baselineTried = false;

  const watchDue = () => {
    const w = state.watch;
    if (!w || !w.renewed_at || (state.cursor == null && !baselineTried)) return true;
    const now = Date.now();
    return now - Date.parse(w.renewed_at) >= s.renewMs || Date.parse(w.expiration) - now <= s.renewBeforeMs;
  };

  async function renewWatch() {
    baselineTried = true;
    const t = await token("watch");
    const j = await op("watch", () => gmailWatch(t, s));
    const exp = Number(j.expiration);
    state.watch = { expiration: Number.isFinite(exp) ? iso(exp) : null, renewed_at: iso() };
    const lines = [];
    if (state.cursor == null && /^\d+$/.test(String(j.historyId))) {
      lines.push({ key: `gmail:${account}:${j.historyId}`, type: "baseline", account, count: 0, recorded_at: iso() });
    }
    for (const l of lines) wakeOrFail(l);
    if (lines.length) state.cursor = String(j.historyId);
    save();
    clear("watch"); clear("sign-in");
    log(`watch renewed on ${s.topic}; expires ${state.watch.expiration || "unknown"}${lines.length ? `; baseline at ${state.cursor}` : ""}`);
  }
  const wakeOrFail = (l) => { try { wake(l); return true; } catch (e) { fail("write", `wake file: ${e.code || "error"}`); return false; } };

  async function handle(t, msgs) {
    const notes = msgs.map(decodeNotification);
    const mine = notes.filter((n) => n && n.emailAddress.toLowerCase() === account.toLowerCase());
    const ackIds = msgs.map((m) => m.ackId).filter(Boolean);
    const lines = [];
    let cursor = state.cursor;
    let resync = false;
    if (mine.length) {
      const newest = mine.reduce((a, n) => maxBig(a, big(n.historyId)), null);
      if (cursor == null) {
        cursor = String(newest);
        lines.push({ key: `gmail:${account}:${cursor}`, type: "baseline", account, count: 0, recorded_at: iso() });
      } else {
        try {
          const h = await op("history", () => gmailHistory(t, cursor, s.labels));
          clear("history");
          if (h.count > 0) lines.push({ key: `gmail:${account}:${h.lastId || h.historyId}`, type: "inbox", account, count: h.count, recorded_at: iso() });
          cursor = String(maxBig(big(cursor), big(h.historyId)));
        } catch (e) {
          if (e.status !== 404) throw e;
          // Google no longer has the cursor: start again from the newest notification
          resync = true;
          cursor = String(newest);
          lines.push({ key: `gmail:${account}:${cursor}`, type: "resync", account, count: 0, recorded_at: iso() });
        }
      }
    }
    // recorded, then state, then acknowledged: a failure here acknowledges nothing (a redelivery
    // repeats a key already written, which the reader treats as one)
    for (const l of lines) if (!wakeOrFail(l)) return;
    const before = { cursor: state.cursor, resync_at: state.resync_at };
    state.cursor = cursor;
    if (resync) state.resync_at = iso();
    state.last_pull = iso();
    if (!save()) { state.cursor = before.cursor; state.resync_at = before.resync_at; return; }
    lastPullSaved = Date.now();
    if (ackIds.length) await op("pull", () => acknowledge(t, s.subscription, ackIds));
    for (const l of lines) {
      log(`recorded ${l.type} ${l.key}${l.type === "inbox" ? ` (${l.count})` : ""}`);
      if (l.type === "inbox" || l.type === "resync") backstop.add(l.key, "gmail");
    }
    if (!lines.length && msgs.length) log(`${msgs.length} notification(s), nothing new in ${s.labels.join(",")}`);
  }

  let backoff = BACKOFF;
  for (;;) {
    try {
      if (watchDue()) await renewWatch();
      const t = await token("pull");
      const msgs = await op("pull", () => pull(t, s.subscription));
      clear("pull"); clear("sign-in");
      if (msgs.length) await handle(t, msgs);
      else {
        state.last_pull = iso();
        if (Date.now() - lastPullSaved >= Math.min(60_000, s.staleMs / 3)) { if (save()) lastPullSaved = Date.now(); }
      }
      if (memory.write) { await sleep(backoff); backoff = Math.min(backoff * 2, BACKOFF * 60); }
      else backoff = BACKOFF;
    } catch (e) {
      const kind = e.op || (e.kind === "sign-in" ? "sign-in" : "pull");
      fail(kind, e.message || String(e));
      if (kind === "sign-in") { log(`sign-in: retrying in ${Math.round(SIGNIN_RETRY / 60000)} min; fix: opsbot-google login --source gmail --client <client.json>`); await sleep(SIGNIN_RETRY); }
      else { await sleep(backoff); backoff = Math.min(backoff * 2, BACKOFF * 60); }
    }
  }
}

// ------------------------------------------------------------------ the Gmail heartbeat

/**
 * heartbeat.d/15-gmail-push: no items. Reasons it fails (exit 1), from the state file alone:
 * no state; a problem stands; no watch, or a lapsed one; no pull within stale_minutes; a resync
 * since the watermark. Reads only, so it is the same under OPSBOT_PEEK=1.
 */
export function gmailHealth(cfg, env = process.env, now = Date.now()) {
  const s = gmailSettings(cfg);
  if (!s.enabled) return [];
  const why = [];
  if (s.missing.length) why.push(`streams.gmail_push is missing ${s.missing.join(", ")}`);
  const st = readState(s.stateFile);
  if (!st) return [...why, `no state at ${s.stateFile}: the Gmail listener has not run (opsbot-core infra install; journalctl --user -u opsbot-${s.name}-monitor-30-gmail-push)`];
  for (const [kind, p] of Object.entries(st.problems || {})) if (p && p.raised) why.push(`the ${kind} problem stands since ${p.since}: ${p.detail || "no detail"}${kind === "sign-in" ? " (opsbot-google login --source gmail --client <client.json>)" : ""}`);
  const exp = st.watch && Date.parse(st.watch.expiration);
  if (!st.watch) why.push("no Gmail watch on record (opsbot-google ensure)");
  else if (!Number.isFinite(exp) || exp <= now) why.push(`the Gmail watch lapsed at ${st.watch.expiration || "an unknown time"} (opsbot-google ensure)`);
  const last = st.last_pull && Date.parse(st.last_pull);
  if (!last) why.push("no pull on record");
  else if (now - last > s.staleMs) why.push(`no pull since ${st.last_pull}, more than ${s.staleMs / 60000} min`);
  const mark = Date.parse(env.OPSBOT_WATERMARK || env.OPSBOT_SINCE || "");
  if (st.resync_at && (!Number.isFinite(mark) || Date.parse(st.resync_at) > mark)) why.push(`the history cursor was lost and resynchronized at ${st.resync_at}: read the mailbox back further than usual`);
  return why;
}

// ------------------------------------------------------------------ login

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The Desktop-app client file: {installed: {client_id, client_secret}}. */
export function readClient(file) {
  let j;
  try { j = JSON.parse(readFileSync(file, "utf8")); } catch { return { error: `cannot read the client file ${file}` }; }
  const c = j && (j.installed || j.web || j);
  if (!c || typeof c.client_id !== "string") return { error: "the client file has no client_id (download the Desktop app client's JSON)" };
  return { client_id: c.client_id, client_secret: typeof c.client_secret === "string" ? c.client_secret : "" };
}

function parseFlags(args, spec) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (name && spec.bool.includes(name)) flags[name] = true;
    else if (name && spec.value.includes(name) && i + 1 < args.length) flags[name] = args[++i];
    else return { error: `unknown or incomplete argument ${a}` };
  }
  return { flags };
}

/** --source: gmail (default), meet, both. Returns {run: [sources this build runs], notes: [lines]}. */
export function sources(v) {
  const want = v === undefined ? ["gmail"] : v === "both" ? ["gmail", "meet"] : v === "gmail" || v === "meet" ? [v] : null;
  if (!want) return null;
  return { run: want.filter((x) => SOURCES.includes(x)), notes: want.filter((x) => !SOURCES.includes(x)).map((x) => NOT_YET[x]) };
}

async function login(args) {
  const p = parseFlags(args, { bool: ["paste"], value: ["source", "client"] });
  if (p.error) { console.error(`error: ${p.error}`); return 2; }
  const src = sources(p.flags.source);
  if (!src) { console.error("error: --source is gmail, meet or both"); return 2; }
  if (!p.flags.client) { console.error("error: --client <the OAuth client's JSON file> is required"); return 2; }
  for (const n of src.notes) console.log(n);
  if (!src.run.length) return 1;
  const client = readClient(p.flags.client);
  if (client.error) { console.error(`error: ${client.error}`); return 1; }
  const { cfg } = loadConfig();
  const s = gmailSettings(cfg);
  const scopes = [...new Set(src.run.flatMap((x) => SCOPES[x]))];
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(16).toString("hex");

  let server = null;
  let port;
  let got;
  if (p.flags.paste) port = 49152 + (randomBytes(2).readUInt16BE(0) % 16000);
  else {
    let resolveGot;
    got = new Promise((r) => (resolveGot = r));
    server = createServer((req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (!u.searchParams.has("code") && !u.searchParams.has("error")) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("opsbot-google: signed in. You can close this tab.\n");
      resolveGot(u);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  }
  const redirect = `http://127.0.0.1:${port}`;
  const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: scopes.join(" "), code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent", login_hint: s.account || "" });
  if (!s.account) q.delete("login_hint");
  console.log(`Open this URL in a browser signed in as ${s.account || "the bot's Google account"}, and allow:`);
  console.log(`  ${endpoints().auth}?${q}`);
  console.log(`Scopes asked: ${scopes.map(short).join(", ")}`);
  let url;
  if (p.flags.paste) {
    console.log("The browser then fails to load a 127.0.0.1 page. Paste that page's whole address here:");
    const rl = createInterface({ input: process.stdin });
    const line = await new Promise((r) => { rl.once("line", r); rl.once("close", () => r("")); });
    rl.close();
    try { url = new URL(line.trim()); } catch { console.error("error: that is not a URL"); return 1; }
  } else {
    console.log(`Waiting for the redirect on ${redirect} …`);
    url = await got;
    server.close();
  }
  if (url.searchParams.get("error")) { console.error(`error: consent refused: ${url.searchParams.get("error")}`); return 1; }
  if (url.searchParams.get("state") !== state) { console.error("error: the redirect's state does not match this sign-in; run login again"); return 1; }
  const code = url.searchParams.get("code");
  if (!code) { console.error("error: the redirect carries no code"); return 1; }
  const form = new URLSearchParams({ code, client_id: client.client_id, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier });
  if (client.client_secret) form.set("client_secret", client.client_secret);
  let j, r;
  try {
    r = await fetch(endpoints().token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(30_000) });
    j = await r.json().catch(() => ({}));
  } catch (e) { console.error(`error: the token exchange failed: ${(e && e.cause && e.cause.code) || "network error"}`); return 1; }
  if (!r.ok) { console.error(`error: the token exchange was refused: ${j.error || `HTTP ${r.status}`}`); return 1; }
  if (!j.refresh_token) { console.error("error: Google sent no refresh token; remove the app's access in the account's security settings and run login again"); return 1; }
  const granted = String(j.scope || "").split(/\s+/);
  const lack = scopes.filter((x) => !granted.includes(x));
  if (lack.length) { console.error(`error: the consent did not grant ${lack.map(short).join(", ")}; run login again and allow every box`); return 1; }
  const token = { client_id: client.client_id, client_secret: client.client_secret, refresh_token: j.refresh_token, access_token: j.access_token || "", expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000, scope: j.scope };
  try { writePrivate(s.tokenFile, JSON.stringify(token, null, 2) + "\n"); } catch (e) { console.error(`error: cannot write ${s.tokenFile}: ${e.code || "error"}`); return 1; }
  console.log(`signed in: ${s.tokenFile} (0600) holds a grant for ${scopes.map(short).join(", ")}`);
  console.log("next: opsbot-google ensure, then opsbot-core infra install");
  return 0;
}

// ------------------------------------------------------------------ ensure

async function ensure(args) {
  const p = parseFlags(args, { bool: ["dry-run"], value: ["source"] });
  if (p.error) { console.error(`error: ${p.error}`); return 2; }
  const src = sources(p.flags.source);
  if (!src) { console.error("error: --source is gmail, meet or both"); return 2; }
  for (const n of src.notes) console.log(n);
  if (!src.run.length) return 1;
  const { cfg } = loadConfig();
  const s = gmailSettings(cfg);
  if (s.missing.length || s.bad.length) { console.error(`error: streams.gmail_push: ${[...s.missing.map((k) => `${k} is not set`), ...s.bad].join("; ")}`); return 1; }
  if (p.flags["dry-run"]) { console.log(`would watch ${s.account} on ${s.topic} for ${s.labels.join(",")}`); return 0; }
  try {
    const t = await accessToken(s.tokenFile, SCOPES.gmail);
    const j = await gmailWatch(t, s);
    const exp = Number(j.expiration);
    const st = readState(s.stateFile) || {};
    st.watch = { expiration: Number.isFinite(exp) ? iso(exp) : null, renewed_at: iso() };
    writePrivate(s.stateFile, JSON.stringify(st, null, 2) + "\n");
    console.log(`gmail: watch on ${s.topic} for ${s.labels.join(",")}; expires ${st.watch.expiration}`);
    return 0;
  } catch (e) {
    console.error(`error: gmail watch: ${e.message}${e.kind === "sign-in" ? "; fix: opsbot-google login --source gmail --client <client.json>" : ""}`);
    return 1;
  }
}

// ------------------------------------------------------------------ status rows

/** One TSV row per check; status only reads (a refreshed token stays in memory). */
async function statusRows(args) {
  const p = parseFlags(args, { bool: [], value: ["source"] });
  const src = p.error ? null : sources(p.flags.source);
  if (!src) { console.error("error: --source is gmail, meet or both"); return 2; }
  const rows = [];
  const row = (state, piece, detail, fix = "") => rows.push([state, piece, detail, fix].join("\t"));
  const { cfg } = loadConfig();
  for (const n of src.notes) row("ok", n.split(":")[0], "not yet available in this build");
  if (src.run.includes("gmail")) {
    const s = gmailSettings(cfg);
    const now = Date.now();
    if (!s.present) row("missing", "streams.gmail_push", "not in opsbot.json", "opsbot-google install prints the block to merge");
    else if (s.missing.length) row("missing", "streams.gmail_push", `required: ${s.missing.join(", ")}`, "set them in opsbot.json (no defaults)");
    else if (s.bad.length) row("differs", "streams.gmail_push", s.bad.join("; "), "fix the values in opsbot.json");
    else if (!s.enabled) row("differs", "streams.gmail_push", "enabled is not true: the listener and its heartbeat do nothing", 'set "enabled": true');
    else row("ok", "streams.gmail_push", `${s.account}; ${s.subscription}; labels ${s.labels.join(",")}`);

    let token = null;
    try {
      readToken(s.tokenFile, SCOPES.gmail);
      row("ok", "token", `${s.tokenFile} 0600; ${SCOPES.gmail.map(short).join(", ")}`);
    } catch (e) {
      const st = existsSync(s.tokenFile) ? (/readable by others/.test(e.message) ? "differs" : "differs") : "missing";
      row(st, "token", `${s.tokenFile}: ${e.message}`, /readable/.test(e.message) ? `chmod 600 ${s.tokenFile}` : "opsbot-google login --source gmail --client <client.json>");
    }
    if (s.subscription && existsSync(s.tokenFile)) {
      try {
        token = await accessToken(s.tokenFile, SCOPES.gmail, { persist: false });
        const got = await pull(token, s.subscription, { max: 1, immediate: true });
        if (got.length) await release(token, s.subscription, got.map((m) => m.ackId)).catch(() => {});
        row("ok", "subscription", `${s.subscription} answers a pull`);
      } catch (e) {
        if (e.kind === "sign-in") row("differs", "subscription", `cannot check: ${e.message}`, "opsbot-google login --source gmail --client <client.json>");
        else row("missing", "subscription", `${s.subscription}: ${e.message}`, "create the topic, its publisher grant, the subscription and the subscriber grant (templates/infra/, or the README's list)");
      }
    } else row("missing", "subscription", "cannot check without the settings and the token", "fix the rows above");

    const st = readState(s.stateFile);
    const exp = st && st.watch && Date.parse(st.watch.expiration);
    if (!st || !st.watch) row("missing", "watch", "none on record", "opsbot-google ensure (the listener also makes one at start)");
    else if (!Number.isFinite(exp) || exp <= now) row("differs", "watch", `lapsed at ${st.watch.expiration}`, "opsbot-google ensure");
    else row("ok", "watch", `renewed ${st.watch.renewed_at}; expires ${st.watch.expiration}`);
    const last = st && st.last_pull && Date.parse(st.last_pull);
    if (!last) row("missing", "last pull", "none on record", `opsbot-core infra install; journalctl --user -u opsbot-${s.name}-monitor-30-gmail-push`);
    else if (now - last > s.staleMs) row("differs", "last pull", `${st.last_pull}, more than ${s.staleMs / 60000} min ago`, `journalctl --user -u opsbot-${s.name}-monitor-30-gmail-push`);
    else row("ok", "last pull", st.last_pull);
    const standing = Object.entries((st && st.problems) || {}).filter(([, p]) => p && p.raised);
    if (standing.length) for (const [kind, p] of standing) row("differs", "problem", `${kind} since ${p.since}: ${p.detail || ""}`, kind === "sign-in" ? "opsbot-google login --source gmail --client <client.json>" : `journalctl --user -u opsbot-${s.name}-monitor-30-gmail-push`);
    else row("ok", "problems", "none standing");

    const entries = (cfg.wake && Array.isArray(cfg.wake.files) ? cfg.wake.files : [])
      .map((e) => (typeof e === "string" ? { file: e, inputs: [] } : e && typeof e === "object" && typeof e.file === "string" ? { file: e.file, inputs: Array.isArray(e.inputs) ? e.inputs : [] } : null))
      .filter(Boolean);
    const named = entries.find((e) => home(e.file) === s.wakeFile);
    const want = `{"file": "${s.wakeFileSetting}", "inputs": ["15-gmail-push", "<the bot's inbox reader>"]}`;
    if (named && named.inputs.includes("15-gmail-push")) row("ok", "wake.files", `names ${s.wakeFileSetting} with inputs ${named.inputs.join(", ")}`);
    else if (named) row("differs", "wake.files", `names ${s.wakeFileSetting} without 15-gmail-push in its inputs`, `make the entry ${want}`);
    else row("missing", "wake.files", `does not name ${s.wakeFileSetting}`, `add ${want} to wake.files in opsbot.json`);
  }
  if (rows.length) console.log(rows.join("\n"));
  return 0;
}

// ------------------------------------------------------------------ dispatch

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "listen": {
      if (rest[0] !== "gmail") { console.error(`error: listen ${rest[0] || ""}: ${rest[0] === "meet" ? NOT_YET.meet : "the source is gmail"}`); return 2; }
      const { cfg, root } = loadConfig();
      for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
      await runGmail({ cfg, root: resolve(root) });
      return 0;
    }
    case "heartbeat": {
      if (rest[0] !== "gmail") { console.error("error: heartbeat gmail"); return 2; }
      const { cfg } = loadConfig();
      const why = gmailHealth(cfg);
      if (why.length) { console.error(why.join("\n")); return 1; }
      return 0;
    }
    case "login": return login(rest);
    case "ensure": return ensure(rest);
    case "status-rows": return statusRows(rest);
    default:
      console.error(`error: unknown command ${cmd || ""} (listen, heartbeat, login, ensure, status-rows)`);
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`error: ${e && e.message ? e.message : e}`); process.exit(1); });
}
