#!/usr/bin/env node
// The one path a bot posts to WhatsApp through, run by `opsbot-whatsapp post` and
// `opsbot-whatsapp classify`. Node 22, no dependencies.
//
//   post <chat> [--reply <id>] [--file <path>] [--dry-run] [<text> | -]
//   classify <chat>
//   screen-check                        (for `opsbot-whatsapp status`: one row on stdout)
//   status-rows                         (for `opsbot-whatsapp status`: every row that asks whatsapp-axi)
//
// post, in order: refuse bad usage; classify the destination from `whatsapp-axi chat view`
// (operator-dm, trusted, external, unknown); run the loop guard when the chat is a peer's;
// refuse a file to an external or unknown chat unless screen.files_external is true; when
// streams.whatsapp.screen names a policy for the class, hand the draft (a file's caption) to the
// bot's own screen command and post only on {"verdict": "pass"}; post through `whatsapp-axi send`
// or `send-file`; append one line to the decision log (a hash of the draft, never the draft).
// Prints one JSON object.
//
// Exit 0 posted (or would be, with --dry-run) · 1 whatsapp-axi refused or failed the send, its
// error code passed through · 2 bad usage or an unusable setting · 3 blocked: the screen, or a
// file to an outside chat · 4 the screen failed; nothing posted, the operator told once per
// outage through opsbot.d/escalate.d/ · 6 the loop guard refused it. There is no exit 5: the
// daemon holds one account, so there is no other identity to post as.
//
// Every whatsapp-axi call is `<command> … --account <account> --json-out=<file>`, the file fresh
// in a private temp directory removed on exit; stdout (the TOON view) is never read. The parsing
// of each command's answer is in one small function below (the `*Of` functions), so a change in
// whatsapp-axi's output is fixed in one place.
// OPSBOT_WHATSAPP_AXI names another whatsapp-axi binary (a pinned copy, a test double).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const EXIT = { ok: 0, whatsapp: 1, usage: 2, blocked: 3, screenFailed: 4, peerGuard: 6 };
const CHAT_RE = /^(\+\d{6,15}|\d{6,32}(-\d+)?@(g\.us|lid|s\.whatsapp\.net))$/;
const ID_RE = /^[A-Za-z0-9]{6,64}$/;
const UPGRADE = "npm install -g whatsapp-axi@latest";

const root = process.env.OPSBOT_ROOT || process.cwd();
const configPath = process.env.OPSBOT_CONFIG || join(root, "opsbot.json");

function emit(obj, code) {
  console.log(JSON.stringify(obj));
  process.exit(code);
}
function usage(msg) {
  console.error(`error: ${msg}`);
  console.error("usage: opsbot-whatsapp post <chat> [--reply <id>] [--file <path>] [--dry-run] [<text> | -]");
  console.error("       opsbot-whatsapp classify <chat>");
  process.exit(EXIT.usage);
}

let cfg;
try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch (e) {
  console.error(`error: cannot read ${configPath}: ${e.message.split("\n")[0]}`);
  process.exit(EXIT.usage);
}
const wa = (cfg.streams && cfg.streams.whatsapp) || {};
const home = (p) => (typeof p === "string" && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
const wakeCfg = typeof wa.wake_file === "string" && wa.wake_file ? wa.wake_file : `~/.cache/${cfg.name}/whatsapp-wake.jsonl`;
const wakeFile = home(wakeCfg);
const cacheFile = join(dirname(wakeFile), "whatsapp-classes.json");
const account = typeof wa.account === "string" ? wa.account : "";

/** A phone number in E.164 form (`+15550100001`), or null. Nothing else is a number. */
const phone = (v) => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\+?\d{6,15}$/.test(s) ? `+${s.replace(/^\+/, "")}` : null;
};
/** A user object's phone number, from its `pn` only: a hidden id alone is never read as a number. */
const pnOf = (u) => (u && typeof u === "object" ? phone(u.pn) : null);
const numbers = (list) => new Set((Array.isArray(list) ? list : []).map(phone).filter(Boolean));
const operators = numbers(wa.operators);
const trusted = numbers(wa.trusted);
const screenCfg = wa.screen && typeof wa.screen === "object" ? wa.screen : null;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const posInt = (v, d) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : typeof v === "string" && /^[1-9]\d*$/.test(v) ? Number(v) : d);
const cacheMs = num(screenCfg?.cache_seconds, 300) * 1000;
const timeoutMs = num(screenCfg?.timeout_seconds, 30) * 1000;
const peerTurns = posInt(wa.peer_turns, 6);
const peerPerHour = posInt(wa.peer_posts_per_hour, 20);

/**
 * The peers, each {name, user, chats}, and one problem line per entry that cannot be used. Every
 * entry with a number counts for the guard and the class, even one status calls unusable: more
 * guard, never less.
 */
function peerList(raw) {
  const peers = [], problems = [];
  const seen = new Set();
  (Array.isArray(raw) ? raw : raw === undefined ? [] : [null]).forEach((p, i) => {
    const label = p && typeof p.name === "string" && p.name ? p.name : `peer ${i + 1}`;
    if (!p || typeof p !== "object") { problems.push(`${label}: not an object`); return; }
    const user = phone(p.user);
    if (!user) { problems.push(`${label}: user must be a phone number in E.164 form`); return; }
    const chats = Array.isArray(p.chats) ? p.chats.map(String) : [];
    peers.push({ name: label, user, chats });
    if (!(typeof p.name === "string" && p.name)) problems.push(`${label}: no name`);
    else if (seen.has(p.name)) problems.push(`${label}: the name is used twice`);
    seen.add(p.name);
    if (operators.has(user)) problems.push(`${label}: ${user} is an operator; a peer is never the operator`);
    if (trusted.has(user)) problems.push(`${label}: ${user} is also in trusted`);
    if (!chats.length) problems.push(`${label}: no chats; a peer is heard only in the groups listed for it`);
    for (const c of chats) if (!/@g\.us$/.test(c)) problems.push(`${label}: ${c} is not a group id (…@g.us)`);
  });
  return { peers, problems };
}
const { peers, problems: peerProblems } = peerList(wa.peers);
const peerUsers = new Set(peers.map((p) => p.user));

/** A repo path resolved inside the repo; null when it points outside. */
function inRepo(p) {
  if (typeof p !== "string" || !p || isAbsolute(p)) return null;
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

// ------------------------------------------------------------------------------- whatsapp-axi

/** The private directory this run's --json-out files go in (0700), removed when the process exits. */
let outDir;
let outN = 0;
function jsonOutPath() {
  if (!outDir) {
    outDir = mkdtempSync(join(tmpdir(), "opsbot-whatsapp-"));
    chmodSync(outDir, 0o700);
    process.on("exit", () => { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return join(outDir, `${++outN}.json`);
}

/**
 * The one helper that runs whatsapp-axi: `<args> [--account <account>] --json-out=<fresh file>`,
 * stdout ignored (it is the TOON view), the daemon's response body read from the file and the file
 * removed. {json} on success; {error: {code, message, ...}, json?} on failure: the daemon's error
 * from the file, or, with no parseable file, the exit code as the reason. Never logs the file.
 * `withAccount: false` for `daemon status <name>`, which takes the name as an argument.
 */
function axi(args, { input, withAccount = true, timeout = 30000 } = {}) {
  const file = jsonOutPath();
  const argv = [...args, ...(withAccount ? ["--account", account] : []), `--json-out=${file}`];
  const r = spawnSync(process.env.OPSBOT_WHATSAPP_AXI || "whatsapp-axi", argv, { encoding: "utf8", timeout, input: input ?? "", maxBuffer: 16 << 20 });
  let json;
  try { json = JSON.parse(readFileSync(file, "utf8")); } catch { json = undefined; }
  rmSync(file, { force: true });
  if (r.error) {
    const code = r.error.code === "ENOENT" ? "not_installed" : r.error.code === "ETIMEDOUT" ? "timeout" : "spawn_failed";
    return { error: { code, message: code === "not_installed" ? "whatsapp-axi is not on PATH" : code === "timeout" ? `timed out after ${timeout / 1000} s` : r.error.message.split("\n")[0] } };
  }
  if (json && typeof json === "object" && json.error && typeof json.error === "object") {
    return { error: { ...json.error, code: String(json.error.code || "error"), message: String(json.error.message || "no message") } };
  }
  if (r.status !== 0) return { error: { code: `exit_${r.status ?? r.signal}`, message: `exit ${r.status ?? r.signal}${r.status === 2 ? " (usage)" : ""}` }, json };
  if (json === undefined) return { error: { code: "no_json_out", message: `whatsapp-axi ${args.slice(0, 2).join(" ")} wrote no --json-out file` } };
  return { json };
}
const axiError = (cmd, e) => `whatsapp-axi ${cmd}: ${e.code}: ${e.message}`;

// The parsing of each command's --json-out answer, the daemon's response body. Each throws when
// what it needs is not there.

/** `chat view`: {chat: {id, name, type, scope, participants: [{id, pn?, name, me, operator, contact?}]}}. */
function chatOf(j) {
  const c = j && typeof j === "object" ? j.chat : undefined;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("chat view printed no chat");
  if (!Array.isArray(c.participants)) throw new Error("chat view printed no participants list");
  return c;
}
/** `read`: {chat, messages: [message], more}. Oldest first. */
function messagesOf(j) {
  const m = j && Array.isArray(j.messages) ? j.messages : null;
  if (!m) throw new Error("read printed no messages list");
  return m;
}
/** `send` and `send-file`: {id, chat, t} (send-file adds media). */
const sentIdOf = (j) => (j && typeof j.id === "string" ? j.id : null);
/** `settings show`: {settings: {scope, dm_from, chats, operators, wake_file, read_receipts, …}, effective_retain_days}. */
function settingsOf(j) {
  const s = j && typeof j === "object" ? j.settings : undefined;
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("settings show printed no settings");
  return s;
}
/** `groups`: {groups: [{id, name, scope, override, members, discarded}]}. */
function groupsOf(j) {
  const g = j && j.groups;
  if (!Array.isArray(g)) throw new Error("groups printed no list");
  return g.filter((x) => x && typeof x.id === "string");
}
/** `daemon status <name>`: {service: {unit, installed, enabled, active, …}, daemon: {state, since, reason, version}, help}. */
function daemonOf(j) {
  if (!j || typeof j !== "object") throw new Error("daemon status printed nothing");
  const s = j.service && typeof j.service === "object" ? j.service : {};
  const d = j.daemon && typeof j.daemon === "object" ? j.daemon : {};
  return { installed: s.installed, active: typeof s.active === "string" ? s.active : undefined, state: typeof d.state === "string" ? d.state : undefined, reason: typeof d.reason === "string" ? d.reason : "" };
}
/** `doctor --account <name>`: {doctor: [{account, check, result, detail}], …}. Whether the account exists. */
const doctorHasAccount = (j) => !(j && Array.isArray(j.doctor) && j.doctor.some((r) => r && r.check === "files" && r.detail === "no such account"));
/** `doctor --account <name>`: the first failing row, with its fix when `help` names one. */
function doctorFirstFailure(j) {
  const rows = j && Array.isArray(j.doctor) ? j.doctor : [];
  const bad = rows.find((r) => r && r.result === "fail") || rows.find((r) => r && r.result === "warn");
  if (!bad) return null;
  const help = j && Array.isArray(j.help) ? j.help.find((h) => typeof h === "string" && h.includes(` ${bad.check}: `)) : undefined;
  return `${bad.check}: ${bad.detail || bad.result}${help ? `; ${help.slice(help.indexOf(`${bad.check}: `) + bad.check.length + 2)}` : ""}`;
}
/** `--version` prints the bare version on stdout. */
const versionOf = (out) => (String(out || "").match(/\d+\.\d+\.\d+[^\s]*/) || [])[0] || null;

// ------------------------------------------------------------------------------- classification

function loadCache() {
  try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    return { chats: c.chats && typeof c.chats === "object" ? c.chats : {} };
  } catch { return { chats: {} }; }
}
function saveCache(c) {
  const now = Date.now();
  for (const [k, v] of Object.entries(c.chats)) if (!v || !(now - Date.parse(v.at) < cacheMs) || v.class === "unknown") delete c.chats[k];
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, cacheFile);
  } catch { /* a cache that cannot be written costs lookups, nothing else */ }
}
const fresh = (v) => v && Date.now() - Date.parse(v.at) < cacheMs;

/** {class, why, cached, participants?}. `unknown` (a failed lookup, a member with no number) is never cached. */
function classify(chat) {
  const cache = loadCache();
  const hit = cache.chats[chat];
  if (fresh(hit) && hit.class !== "unknown") return { class: hit.class, why: hit.why, cached: true };
  let result;
  try { result = decide(chat); } catch (e) {
    return { class: "unknown", why: `lookup failed: ${e.message}`, cached: false };
  }
  if (result.class !== "unknown") {
    cache.chats[chat] = { class: result.class, why: result.why, at: new Date().toISOString() };
    saveCache(cache);
  }
  return { class: result.class, why: result.why, cached: false };
}

/**
 * The class from WhatsApp's participant list at this moment. In the trusted circle means an
 * operator, a trusted number or a listed peer, by phone number; being a contact counts for nothing, and a participant
 * known only by its hidden id is never assumed inside.
 */
function decide(chat) {
  const r = axi(["chat", "view", chat]);
  if (r.error) {
    if (r.error.code === "not_connected") throw new Error(`the daemon is not connected${r.error.state ? ` (${r.error.state})` : ""}`);
    throw new Error(axiError("chat view", r.error));
  }
  const view = chatOf(r.json);
  const all = view.participants.filter((p) => p && typeof p === "object");
  if (!all.length) throw new Error("chat view listed no participants");
  const group = view.type === "group" || /@g\.us$/.test(String(view.id || chat));
  const others = all.filter((p) => p.me !== true);
  const hidden = others.find((p) => !pnOf(p));
  if (hidden) return { class: "unknown", why: `${hidden.id || "a participant"} has no known phone number` };
  if (!group) {
    if (others.length !== 1) throw new Error(`a direct chat with ${others.length} other participants`);
    const pn = pnOf(others[0]);
    if (operators.has(pn)) return { class: "operator-dm", why: `a direct chat with the operator ${pn}` };
    if (trusted.has(pn)) return { class: "trusted", why: `a direct chat with the trusted number ${pn}` };
    return { class: "external", why: `a direct chat with ${pn}, not an operator or trusted` };
  }
  for (const p of others) {
    const pn = pnOf(p);
    if (!operators.has(pn) && !trusted.has(pn) && !peerUsers.has(pn)) return { class: "external", why: `${pn} is not an operator, trusted or a peer` };
  }
  return { class: "trusted", why: `all ${others.length} other participants are operators, trusted or peers` };
}

// ------------------------------------------------------------------------------- the loop guard

const digits = (pn) => pn.replace(/^\+/, "");
const mentionsIn = (text, set) => [...set].some((pn) => new RegExp(`@\\+?${digits(pn)}(?!\\d)`).test(String(text || "")));
/** Whether a kept message mentions an operator: its mention list, or `@<number>` in its text. */
const messageAsks = (m) => (Array.isArray(m.mentions) && m.mentions.some((u) => operators.has(pnOf(u)))) || mentionsIn(m.text, operators);

/** Who wrote one kept message: "s" the bot ("sa" when it mentions an operator), "p:<name>" a peer, "h" anyone else. Never the text. */
function senderKind(m) {
  const from = m && m.from && typeof m.from === "object" ? m.from : {};
  if (from.me === true) return messageAsks(m) ? "sa" : "s";
  const pn = pnOf(from);
  const peer = pn ? peers.find((p) => p.user === pn) : undefined;
  return peer ? `p:${peer.name}` : "h";
}

/** This bot's posts to this chat in the last hour, from the decision log. */
function postsLastHour(chat) {
  const p = inRepo(wa.post_log || "logs/whatsapp-posts.jsonl");
  if (!p) return 0;
  let text = "";
  try { text = readFileSync(p, "utf8"); } catch { return 0; }
  const since = Date.now() - 3600000;
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"posted":true')) continue;
    try { const l = JSON.parse(line); if (l.chat === chat && l.posted === true && Date.parse(l.at) > since) n++; } catch { /* skip */ }
  }
  return n;
}

/**
 * The loop guard. null when the chat is no peer's. Otherwise {peer} to post with, or {refuse} with
 * {peer_guard, error, next, peer}. Only kept messages are counted: all the bot can see.
 */
function peerGuard(chat, text) {
  const listed = peers.filter((p) => p.chats.includes(chat));
  if (!listed.length) return null;
  const peer = listed.map((p) => p.name).join(",");
  const r = axi(["read", chat, "--limit", String(Math.min(500, Math.max(50, peerTurns * 4)))]);
  let msgs;
  try {
    if (r.error) throw new Error(axiError("read", r.error));
    msgs = messagesOf(r.json);
  } catch (e) {
    return { refuse: { peer_guard: "unreadable", peer, error: `could not read the chat to count turns between bots: ${e.message}; nothing posted`, next: "try again shortly, or ask the operator" } };
  }
  const senders = msgs.map(senderKind);
  const asks = mentionsIn(text, operators);
  let run = 0, peerInRun = false, askedInRun = false;
  for (let i = senders.length - 1; i >= 0; i--) {
    const k = senders[i];
    if (k === "h") break;
    run++;
    if (k.startsWith("p:")) peerInRun = true;
    if (k === "sa") askedInRun = true;
  }
  if (peerInRun && run >= peerTurns && !(asks && !askedInRun)) {
    return { refuse: {
      peer_guard: "turns", peer,
      error: `${run} turns between bots with no person; ask the operator`,
      next: askedInRun ? "you already asked the operator in this chat; wait for a person to answer there" : "post once here with an @mention of an operator's number, or wait for a person to answer",
    } };
  }
  const n = postsLastHour(chat);
  if (n >= peerPerHour) return { refuse: { peer_guard: "hourly", peer, error: `${n} posts to ${chat} in the last hour; ask the operator`, next: "wait, or ask the operator" } };
  return { peer };
}

// ------------------------------------------------------------------------------- the screen

/** The policy text for a class, or null when the class is not screened. Throws on a bad setting. */
function screenFor(cls) {
  if (!screenCfg || cls === "operator-dm") return null;
  const lists = screenCfg.policy && typeof screenCfg.policy === "object" ? screenCfg.policy : {};
  const list = cls === "trusted" ? lists.trusted : lists.external;
  if (!Array.isArray(list) || list.length === 0) return null;
  const command = inRepo(screenCfg.command);
  if (!command) throw new Error(`streams.whatsapp.screen.command must be a path inside the repo: ${screenCfg.command ?? "(unset)"}`);
  try { accessSync(command, constants.X_OK); if (!statSync(command).isFile()) throw new Error(); } catch {
    throw new Error(`streams.whatsapp.screen.command is not an executable file: ${screenCfg.command}`);
  }
  const texts = list.map((p) => {
    const abs = inRepo(p);
    if (!abs) throw new Error(`a screen policy path must be inside the repo: ${p}`);
    try { return readFileSync(abs, "utf8").trim(); } catch { throw new Error(`screen policy file missing: ${p}`); }
  });
  return { command, policy: texts.join("\n\n") };
}

/** Run the bot's screen: {verdict, passage?, reason?} or {error}. */
function runScreen(command, request) {
  const r = spawnSync(command, [], { cwd: root, input: JSON.stringify(request), encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 });
  if (r.error) return { error: r.error.code === "ETIMEDOUT" ? `timed out after ${timeoutMs / 1000} s` : r.error.message.split("\n")[0] };
  if (r.status !== 0) return { error: `exit ${r.status ?? r.signal}: ${String(r.stderr || "").trim().split("\n")[0] || "no message"}` };
  let v;
  try { v = JSON.parse(String(r.stdout).trim()); } catch { return { error: "the output was not JSON" }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "the output was not a JSON object" };
  if (v.verdict === "pass") return { verdict: "pass" };
  if (v.verdict === "block") return { verdict: "block", passage: String(v.passage ?? ""), reason: String(v.reason ?? "") };
  return { error: `unknown verdict: ${JSON.stringify(v.verdict ?? null)}` };
}

function gitPath(name) {
  const r = spawnSync("git", ["rev-parse", "--git-path", name], { cwd: root, encoding: "utf8" });
  const p = r.status === 0 ? r.stdout.trim() : join(".git", name);
  return resolve(root, p);
}

/** Every executable in opsbot.d/escalate.d/, the message on stdin, as the core runs them. */
function tellOperator(message) {
  const dir = join(root, "opsbot.d", "escalate.d");
  let names = [];
  try { names = readdirSync(dir).filter((n) => !n.startsWith(".")).sort(); } catch { names = []; }
  const results = [];
  for (const n of names) {
    const p = join(dir, n);
    try { if (!statSync(p).isFile()) continue; accessSync(p, constants.X_OK); } catch { continue; }
    const r = spawnSync(p, [], {
      cwd: root, input: `${message}\n`, encoding: "utf8", timeout: 300000,
      env: { ...process.env, OPSBOT_ROOT: root, OPSBOT_CONFIG: configPath, OPSBOT_NAME: String(cfg.name || ""), OPSBOT_MARK: String(cfg.mark || ""), OPSBOT_HOOK: "escalate" },
    });
    results.push({ script: n, ok: r.status === 0 });
  }
  return results;
}

/** Tell the operator once per outage; the marker holds the outage's start. */
function screenOutage(cls, error) {
  const marker = gitPath("opsbot-whatsapp-screen");
  if (existsSync(marker)) return "the operator was already told about this outage";
  const mark = cfg.mark ? `${cfg.mark} ` : "";
  const message = `${mark}${cfg.name || "The bot"} could not screen a WhatsApp reply to a ${cls} chat, so it was not posted: ${error}.\nReplies that need the screen wait until it answers again. This is said once until it does.`;
  const results = tellOperator(message);
  if (results.some((r) => r.ok)) {
    try { writeFileSync(marker, `${new Date().toISOString()}\n`); } catch { /* told, but may tell again */ }
    return "the operator was told";
  }
  return results.length ? "could not tell the operator: every escalation script failed" : "could not tell the operator: no script in opsbot.d/escalate.d/";
}
function screenAnswered() {
  const marker = gitPath("opsbot-whatsapp-screen");
  if (existsSync(marker)) rmSync(marker, { force: true });
}

// ------------------------------------------------------------------------------- posting

/** Post through whatsapp-axi: {id} or {error, code, retry_after_seconds?}. The text goes on stdin, never in argv. */
function send(chat, reply, text, file) {
  const ref = reply ? ["--reply", `${chat}/${reply}`] : [];
  const r = file
    ? axi(["send-file", chat, file.path, ...(text.trim() ? ["--caption", text] : []), ...ref])
    : axi(["send", chat, "-", ...ref], { input: text });
  if (r.error) {
    const { code, message, retry_after_seconds: retry } = r.error;
    return { error: `whatsapp-axi ${file ? "send-file" : "send"}: ${message}`, code, ...(retry ? { retry_after_seconds: retry } : {}) };
  }
  return { id: sentIdOf(r.json) };
}

function logDecision(line) {
  const p = inRepo(wa.post_log || "logs/whatsapp-posts.jsonl");
  if (!p) { console.error(`warning: streams.whatsapp.post_log must be inside the repo: ${wa.post_log}; nothing logged`); return; }
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(line)}\n`);
  } catch (e) { console.error(`warning: could not write ${p}: ${e.message.split("\n")[0]}`); }
}

// ------------------------------------------------------------------------------- commands

function needAccount() {
  if (!account) usage("streams.whatsapp.account is not set in opsbot.json (the whatsapp-axi account name)");
}

function cmdPost(args) {
  let reply, filePath, dry = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--reply") { reply = args[++i]; if (reply === undefined) usage("--reply needs a message id"); }
    else if (a === "--file") { filePath = args[++i]; if (filePath === undefined) usage("--file needs a path"); }
    else if (a === "--dry-run") dry = true;
    else if (a === "-h" || a === "--help") usage("help");
    else if (a.startsWith("--")) usage(`unknown flag for post: ${a}`);
    else pos.push(a);
  }
  const [chat, given, extra] = pos;
  if (!chat || !CHAT_RE.test(chat)) usage(`not a chat id: ${chat ?? "(none)"}`);
  if (reply !== undefined && !ID_RE.test(reply)) usage(`not a WhatsApp message id: ${reply}`);
  if (extra !== undefined) usage("one text only; quote it, or pass - and send it on stdin");
  let file;
  if (filePath !== undefined) {
    const abs = resolve(process.cwd(), filePath);
    let st;
    try { st = statSync(abs); } catch { usage(`no such file: ${filePath}`); }
    if (!st.isFile()) usage(`not a regular file: ${filePath}`);
    file = { path: abs, name: basename(abs), size: st.size };
  }
  const text = given === "-" || (given === undefined && !file) ? readFileSync(0, "utf8") : given ?? "";
  if (!file && !text.trim()) usage("empty text; nothing posted");
  needAccount();

  const c = classify(chat);
  const base = {
    at: new Date().toISOString(), chat, ...(reply ? { reply_to: reply } : {}), class: c.class, why: c.why,
    draft_sha256: createHash("sha256").update(text).digest("hex"), ...(file ? { file: { name: file.name, size: file.size } } : {}), ...(dry ? { dry_run: true } : {}),
  };
  const out = { chat, class: c.class, why: c.why };

  const guard = peerGuard(chat, text);
  if (guard && guard.refuse) {
    const g = guard.refuse;
    logDecision({ ...base, screen: "skipped", peer: g.peer, peer_guard: g.peer_guard, error: g.error, posted: false });
    emit({ posted: false, ...out, screen: "skipped", ...g }, EXIT.peerGuard);
  }
  if (guard) base.peer = guard.peer;

  if (file && (c.class === "external" || c.class === "unknown") && screenCfg?.files_external !== true) {
    const reason = `a file to an ${c.class} chat; streams.whatsapp.screen.files_external is not true`;
    logDecision({ ...base, screen: "block", reason, posted: false });
    emit({ posted: false, ...out, screen: "block", reason, next: "send the text without the file, or ask the operator" }, EXIT.blocked);
  }

  let screen;
  try { screen = text.trim() ? screenFor(c.class) : null; } catch (e) {
    logDecision({ ...base, screen: "error", error: e.message, posted: false });
    emit({ posted: false, ...out, screen: "error", error: e.message }, EXIT.usage);
  }

  let verdict = "skipped";
  if (screen) {
    const v = runScreen(screen.command, { draft: text, destination_class: c.class, policy: screen.policy });
    if (v.error) {
      const told = screenOutage(c.class, v.error);
      logDecision({ ...base, screen: "error", error: v.error, posted: false });
      emit({ posted: false, ...out, screen: "error", error: v.error, operator: told }, EXIT.screenFailed);
    }
    screenAnswered();
    if (v.verdict === "block") {
      logDecision({ ...base, screen: "block", reason: v.reason, posted: false });
      emit({ posted: false, ...out, screen: "block", passage: v.passage, reason: v.reason, next: "rewrite it without the passage, or take it to the operator" }, EXIT.blocked);
    }
    verdict = "pass";
  }

  if (dry) {
    logDecision({ ...base, screen: verdict, posted: false });
    emit({ posted: false, dry_run: true, would_post: true, ...out, screen: verdict, ...(guard ? { peer: guard.peer } : {}) }, EXIT.ok);
  }
  const sent = send(chat, reply, text, file);
  if (sent.error) {
    logDecision({ ...base, screen: verdict, error: sent.error, code: sent.code, posted: false });
    emit({ posted: false, ...out, screen: verdict, error: sent.error, code: sent.code, ...(sent.retry_after_seconds ? { retry_after_seconds: sent.retry_after_seconds } : {}) }, EXIT.whatsapp);
  }
  logDecision({ ...base, screen: verdict, posted: true, ...(sent.id ? { id: sent.id } : {}) });
  emit({ posted: true, ...out, ...(sent.id ? { id: sent.id } : {}), screen: verdict, ...(guard ? { peer: guard.peer } : {}) }, EXIT.ok);
}

function cmdClassify(args) {
  if (args.length !== 1 || !CHAT_RE.test(args[0])) usage("classify takes one chat id");
  needAccount();
  const c = classify(args[0]);
  emit({ chat: args[0], class: c.class, why: c.why, cached: c.cached }, EXIT.ok);
}

/** The screen setting's problems, or [] when usable; and the classes it screens. */
function screenProblems() {
  const problems = [];
  const lists = screenCfg?.policy && typeof screenCfg.policy === "object" ? screenCfg.policy : {};
  const command = inRepo(screenCfg?.command);
  if (!command) problems.push(`command must be a path inside the repo: ${screenCfg?.command ?? "(unset)"}`);
  else {
    try { accessSync(command, constants.X_OK); if (!statSync(command).isFile()) throw new Error(); } catch { problems.push(`command is not an executable file: ${screenCfg.command}`); }
  }
  const named = [];
  if (lists.internal !== undefined) problems.push("policy.internal is Slack's class; WhatsApp's is policy.trusted");
  for (const cls of ["trusted", "external"]) {
    const list = lists[cls];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { problems.push(`policy.${cls} must be a list of paths`); continue; }
    if (list.length) named.push(cls);
    for (const p of list) {
      const abs = inRepo(p);
      if (!abs) problems.push(`policy path outside the repo: ${p}`);
      else if (!existsSync(abs)) problems.push(`policy file missing: ${p}`);
    }
  }
  return { problems, named };
}

/** One status row for the screen setting: `ok <detail>` (exit 0) or `differs <detail>` (exit 1). */
function cmdScreenCheck() {
  const { problems, named } = screenProblems();
  if (problems.length) { console.log(`differs ${problems.join("; ")}`); process.exit(1); }
  console.log(`ok ${screenCfg.command}; screens ${named.length ? named.join(" and ") : "nothing (no policy listed)"}${screenCfg.files_external === true ? "; files to outside chats allowed" : ""}`);
  process.exit(0);
}

/**
 * Every status row that asks whatsapp-axi or reads streams.whatsapp, one per line:
 * `<ok|missing|differs>\t<piece>\t<detail>\t<fix>`. The scripts and the waker's unit are
 * opsbot-whatsapp's own rows.
 */
function cmdStatusRows() {
  const rows = [];
  const row = (state, piece, detail, fix = "") => rows.push([state, piece, detail, fix].map((s) => String(s).replace(/[\t\n]/g, " ")).join("\t"));
  const acctFlag = account ? ` --account ${account}` : "";
  const wakeAbs = wakeFile;

  // streams.whatsapp itself
  if (!cfg.streams || !cfg.streams.whatsapp) {
    row("missing", "streams.whatsapp", "no streams.whatsapp in opsbot.json", "opsbot-whatsapp install prints the block to merge");
  } else {
    const absent = [];
    if (!account) absent.push("account");
    if (!operators.size) absent.push("operators");
    const badOps = (Array.isArray(wa.operators) ? wa.operators : []).filter((o) => !phone(o));
    if (absent.length) row("differs", "streams.whatsapp", `missing ${absent.join(" and ")}`, `set streams.whatsapp.${absent[0]} in opsbot.json`);
    else if (badOps.length) row("differs", "streams.whatsapp", `operators not in E.164 form: ${badOps.join(", ")}`, "write each operator as +<country code><number>");
    else row("ok", "streams.whatsapp", `account ${account}, ${operators.size} operator${operators.size === 1 ? "" : "s"}`);
    const lt = wa.listen_to;
    if (lt !== undefined && lt !== "anyone" && lt !== "trusted" && lt !== "operators") row("differs", "listen_to", `${JSON.stringify(lt)} is not "anyone", "trusted" or "operators"`, "set streams.whatsapp.listen_to to anyone, trusted or operators");
    const badTrusted = (Array.isArray(wa.trusted) ? wa.trusted : []).filter((o) => !phone(o));
    if (wa.trusted !== undefined && (!Array.isArray(wa.trusted) || badTrusted.length)) row("differs", "trusted", `trusted must be a list of numbers in E.164 form${badTrusted.length ? `: ${badTrusted.join(", ")}` : ""}`, "write each trusted person as +<country code><number>");
    const mr = wa.mark_read;
    if (mr !== undefined && mr !== "seen" && mr !== "off") row("differs", "mark_read", `${JSON.stringify(mr)} is neither "seen" nor "off"`, "set streams.whatsapp.mark_read to seen or off");
  }

  // wake.files names the wake file
  const wakeFiles = cfg.wake && Array.isArray(cfg.wake.files) ? cfg.wake.files.map(String) : [];
  if (wakeFiles.some((f) => home(f) === wakeAbs)) row("ok", "wake.files", `names ${wakeCfg}`);
  else row("missing", "wake.files", `does not name ${wakeCfg}`, `add "${wakeCfg}" to wake.files in opsbot.json`);

  // whatsapp-axi present, and new enough to write --json-out (doctor does, and says whether the account exists)
  const vr = spawnSync(process.env.OPSBOT_WHATSAPP_AXI || "whatsapp-axi", ["--version"], { encoding: "utf8", timeout: 10000 });
  if (vr.error) {
    row("missing", "whatsapp-axi", vr.error.code === "ENOENT" ? "not on PATH" : `could not run it: ${vr.error.message.split("\n")[0]}`, UPGRADE);
    finish(rows);
  }
  const version = versionOf(vr.stdout) || "(no version)";
  if (!account) { row("ok", "whatsapp-axi", version); finish(rows); }
  const doc = axi(["doctor"]);
  if (!doc.json || doc.json.error) {
    row("missing", "whatsapp-axi", `${version} wrote no --json-out file for doctor${doc.error ? ` (${doc.error.message})` : ""}: too old for these scripts`, UPGRADE);
    finish(rows);
  }
  row("ok", "whatsapp-axi", `${version}, with --json-out`);

  // the account exists
  if (!doctorHasAccount(doc.json)) {
    row("missing", "account", `no account ${account}`, `whatsapp-axi account add ${account}`);
    finish(rows);
  }
  row("ok", "account", account);

  // the daemon: installed, running, connected
  const d = axi(["daemon", "status", account], { withAccount: false });
  let running = false;
  if (d.error) row("missing", "daemon", `could not read its status: ${d.error.message}`, `whatsapp-axi daemon status ${account}`);
  else {
    const ds = daemonOf(d.json);
    const doctor = () => {
      const f = doctorFirstFailure(doc.json);
      return f ? `; doctor: ${f}` : `; run whatsapp-axi doctor${acctFlag}`;
    };
    if (ds.installed === false) row("missing", "daemon", "not installed as a service", `whatsapp-axi daemon install ${account}`);
    else if (ds.state === "connected") { running = true; row("ok", "daemon", `installed, ${ds.active || "running"}, connected`); }
    else if (!ds.state || ds.state === "not running" || ds.active === "inactive" || ds.active === "failed") {
      row("missing", "daemon", `not running (${ds.active || ds.state || "unknown"})${doctor()}`, `whatsapp-axi daemon start ${account}`);
    } else {
      running = true;
      row("differs", "daemon", `${ds.state}${ds.reason ? ` (${ds.reason})` : ""}, not connected${doctor()}`, `whatsapp-axi doctor${acctFlag}`);
    }
  }

  // the account's settings: wake_file, operators, read_receipts, scopes
  let s = null;
  const sr = axi(["settings", "show"]);
  try { if (sr.error) throw new Error(sr.error.message); s = settingsOf(sr.json); } catch (e) {
    row("missing", "settings", `could not read the account's settings: ${e.message}`, running ? `whatsapp-axi settings show${acctFlag}` : `whatsapp-axi daemon start ${account}`);
  }
  if (s) {
    const setWake = `whatsapp-axi settings set wake_file ${wakeAbs}${acctFlag}`;
    if (typeof s.wake_file !== "string" || !s.wake_file) row("missing", "wake_file", "the account has no wake_file", setWake);
    else if (home(s.wake_file) !== wakeAbs) row("differs", "wake_file", `the account's is ${s.wake_file}, the setting is ${wakeCfg}`, setWake);
    else row("ok", "wake_file", s.wake_file);

    const theirs = Array.isArray(s.operators) ? s.operators.map(String) : [];
    const theirNums = new Set(theirs.map(phone).filter(Boolean));
    const notNumbers = theirs.filter((o) => !phone(o));
    const missingOps = [...operators].filter((o) => !theirNums.has(o));
    const extraOps = [...theirNums].filter((o) => !operators.has(o));
    if (!missingOps.length && !extraOps.length && !notNumbers.length) row("ok", "operators", `the account's operators are ${theirs.length ? theirs.join(", ") : "none"}`);
    else {
      const parts = [];
      if (missingOps.length) parts.push(`not the account's: ${missingOps.join(", ")}`);
      if (extraOps.length) parts.push(`the account's, not in the setting: ${extraOps.join(", ")}`);
      if (notNumbers.length) parts.push(`the account's, by hidden id: ${notNumbers.join(", ")}`);
      row("differs", "operators", parts.join("; "), missingOps.length ? `whatsapp-axi operators add ${missingOps[0]}${acctFlag}   (the operator decides)` : "make streams.whatsapp.operators and whatsapp-axi operators list name the same numbers");
    }

    if ((wa.mark_read ?? "seen") === "seen") {
      if (s.read_receipts === "on-read") row("ok", "read_receipts", "on-read: blue ticks once the session has the item");
      else row("differs", "read_receipts", `${s.read_receipts ?? "unset"}, not on-read: the ticks would not mean the session has the item`, `whatsapp-axi settings set read_receipts on-read${acctFlag}, or set streams.whatsapp.mark_read to off`);
    }

    row("ok", "scope", `account ${s.scope ?? "tagged"}; direct messages from ${s.dm_from ?? "operators"}`);
    const chats = s.chats && typeof s.chats === "object" ? s.chats : {};
    for (const [chat, scope] of Object.entries(chats)) row("ok", "scope", `${chat} ${scope}`);
  }

  // the escalation chat: set, and an operator's direct chat
  if (!wa.escalate_chat) row("missing", "escalate_chat", "streams.whatsapp.escalate_chat is not set", "set it to an operator's number, the direct chat with them");
  else if (!CHAT_RE.test(String(wa.escalate_chat))) row("differs", "escalate_chat", `${wa.escalate_chat} is not a chat id`, "set it to an operator's number");
  else {
    const c = classify(String(wa.escalate_chat));
    if (c.class === "operator-dm") row("ok", "escalate_chat", `${wa.escalate_chat}: ${c.why}`);
    else row(c.class === "unknown" ? "missing" : "differs", "escalate_chat", `${wa.escalate_chat} is ${c.class}: ${c.why}`, "set it to an operator's direct chat");
  }

  // the screen, only when set
  if (screenCfg) {
    const { problems, named } = screenProblems();
    if (problems.length) row("differs", "screen", problems.join("; "), "fix streams.whatsapp.screen in opsbot.json, or the files it names");
    else row("ok", "screen", `${screenCfg.command}; screens ${named.length ? named.join(" and ") : "nothing (no policy listed)"}`);
  }

  // peers, only when set: each usable, and the bot a member of each listed chat
  if (wa.peers !== undefined && !(Array.isArray(wa.peers) && wa.peers.length === 0)) {
    if (peerProblems.length) row("differs", "peers", peerProblems.join("; "), "fix streams.whatsapp.peers in opsbot.json");
    else row("ok", "peers", peers.map((p) => `${p.name} (${p.user})`).join(", "));
    const want = [...new Set(peers.flatMap((p) => p.chats).filter((c) => /@g\.us$/.test(c)))];
    if (want.length) {
      const g = axi(["groups"]);
      let ids = null;
      try { if (g.error) throw new Error(g.error.message); ids = new Set(groupsOf(g.json).map((x) => x.id)); } catch (e) {
        row("missing", "peer-chats", `could not list the account's groups: ${e.message}`, running ? `whatsapp-axi groups${acctFlag}` : `whatsapp-axi daemon start ${account}`);
      }
      if (ids) {
        const outside = want.filter((c) => !ids.has(c));
        if (outside.length) row("differs", "peer-chats", `not a member of ${outside.join(", ")}`, "add the bot's number to each group, or drop the group from streams.whatsapp.peers");
        else row("ok", "peer-chats", `a member of ${want.join(", ")}`);
      }
    }
  }
  finish(rows);
}
function finish(rows) {
  if (rows.length) console.log(rows.join("\n"));
  process.exit(0);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "post") cmdPost(rest);
else if (cmd === "classify") cmdClassify(rest);
else if (cmd === "screen-check") cmdScreenCheck();
else if (cmd === "status-rows") cmdStatusRows();
else usage(`unknown command: ${cmd ?? "(none)"}`);
