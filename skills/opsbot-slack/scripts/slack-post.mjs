#!/usr/bin/env node
// The one path a bot posts to Slack through, run by `opsbot-slack post` and `opsbot-slack classify`.
// Node 22, no dependencies.
//
//   post <conv> [--reply <ts>] [--dry-run] [<markdown> | -]
//   classify <conv>
//   screen-check                       (for `opsbot-slack status`: one row on stdout)
//   identity-check                     (for `opsbot-slack status`: the posting identity's row)
//
// post, in order: refuse bad usage; classify the destination from Slack's own data
// (operator-dm, internal, external, unknown); when streams.slack.screen names a policy for that
// class, hand the draft to the bot's own screen command and post only on {"verdict": "pass"};
// check that the token slack-axi will post with is bot_user's (auth.test); post through
// `slack-axi draft` and `draft send` in bot mode; append one line to the decision log (a hash of
// the draft, never the draft). Prints one JSON object.
//
// Exit 0 posted (or would be, with --dry-run) · 1 Slack refused or failed · 2 bad usage or an
// unusable setting · 3 the screen blocked it · 4 the screen failed; nothing posted, the operator
// told once per outage through opsbot.d/escalate.d/ · 5 the posting identity is not bot_user.
//
// The destination class comes from `slack-axi audience <conv>` (slack-axi 1.6.0 or later), which
// reads conversations.info, conversations.members and users.info with slack-axi's own token. The
// bot token itself is read here for one thing only, the posting identity's auth.test (slack-axi
// prints no live user id), in slack-axi's own order; it is never printed.
// OPSBOT_SLACK_AXI names another slack-axi binary (a pinned copy, a test double).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const EXIT = { ok: 0, slack: 1, usage: 2, blocked: 3, screenFailed: 4, identity: 5 };
const CONV_RE = /^[CDG][A-Z0-9]{2,}$/;
const TS_RE = /^\d+\.\d+$/;
const SLACK_TIMEOUT_MS = 15000;
const AUDIENCE_SINCE = "1.6.0";
const UPGRADE = "npm install -g slack-axi@latest";

const root = process.env.OPSBOT_ROOT || process.cwd();
const configPath = process.env.OPSBOT_CONFIG || join(root, "opsbot.json");

function emit(obj, code) {
  console.log(JSON.stringify(obj));
  process.exit(code);
}
function usage(msg) {
  console.error(`error: ${msg}`);
  console.error("usage: opsbot-slack post <conv> [--reply <ts>] [--dry-run] [<markdown> | -]");
  console.error("       opsbot-slack classify <conv>");
  process.exit(EXIT.usage);
}

let cfg;
try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch (e) {
  console.error(`error: cannot read ${configPath}: ${e.message.split("\n")[0]}`);
  process.exit(EXIT.usage);
}
const slack = (cfg.streams && cfg.streams.slack) || {};
const home = (p) => (p && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
const eventsFile = home(slack.events_file || `~/.cache/${cfg.name}/slack-events.jsonl`);
const cacheFile = join(dirname(eventsFile), "slack-classes.json");
const teamArgs = slack.team ? ["--team", String(slack.team)] : [];
const operators = new Set(Array.isArray(slack.operators) ? slack.operators.map(String) : []);
const screenCfg = slack.screen && typeof slack.screen === "object" ? slack.screen : null;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const cacheMs = num(screenCfg?.cache_seconds, 300) * 1000;
const maxMembers = Math.floor(num(screenCfg?.max_members, 100));
const timeoutMs = num(screenCfg?.timeout_seconds, 30) * 1000;

/** A repo path resolved inside the repo; null when it points outside. */
function inRepo(p) {
  if (typeof p !== "string" || !p || isAbsolute(p)) return null;
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

// ------------------------------------------------------------------------------- the post token

/**
 * The one place the kit reads slack-axi's token: the token slack-axi will post with, in its own
 * order (SLACK_AXI_TOKEN, then the workspace `team` names, then its default, then its only one),
 * for the posting identity's auth.test. No slack-axi command prints the live token's user id.
 * Never printed.
 */
function postToken() {
  if (process.env.SLACK_AXI_TOKEN) return process.env.SLACK_AXI_TOKEN;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = process.env.SLACK_AXI_CONFIG_DIR || join(xdg && xdg.length ? xdg : join(homedir(), ".config"), "slack-axi");
  let team = slack.team ? String(slack.team) : undefined;
  if (!team) {
    try { team = JSON.parse(readFileSync(join(base, "config.json"), "utf8")).default_team; } catch { team = undefined; }
  }
  if (!team) {
    let ids = [];
    try { ids = readdirSync(join(base, "workspaces")).filter((d) => existsSync(join(base, "workspaces", d, "token.json"))); } catch { ids = []; }
    if (ids.length === 1) team = ids[0];
  }
  if (!team) throw new Error("no slack-axi workspace to read the bot token from");
  let t;
  try { t = JSON.parse(readFileSync(join(base, "workspaces", team, "token.json"), "utf8")).token; } catch { t = undefined; }
  if (!t) throw new Error(`slack-axi holds no token for ${team}`);
  return t;
}

let token;
/** Slack's auth.test with the post token: the posting identity's only Web API call. */
async function authTest() {
  if (token === undefined) token = postToken();
  let res;
  try {
    res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`auth.test: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
  }
  let body;
  try { body = await res.json(); } catch { throw new Error(`auth.test: HTTP ${res.status}, not JSON`); }
  if (!body || body.ok !== true) throw new Error(`auth.test: ${(body && body.error) || `HTTP ${res.status}`}`);
  return body;
}

// ------------------------------------------------------------------------------- the posting identity

/**
 * Who the post token is, from auth.test: {user, name, team, cached}. A match with bot_user is
 * cached for cache_seconds under a hash of the token, so a changed token is asked again at once.
 * Throws when no token resolves or auth.test fails.
 */
async function identity() {
  if (token === undefined) token = postToken();
  const key = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const cache = loadCache();
  const c = cache.identity;
  if (c && c.token === key && fresh(c) && c.user === String(slack.bot_user || "")) return { user: c.user, name: c.name, team: c.team, cached: true };
  const a = await authTest();
  if (typeof a.user_id !== "string" || !a.user_id) throw new Error("auth.test gave no user_id");
  const me = { user: a.user_id, name: typeof a.user === "string" ? a.user : "", team: typeof a.team_id === "string" ? a.team_id : "" };
  if (slack.bot_user && me.user === String(slack.bot_user)) {
    cache.identity = { token: key, ...me, at: new Date().toISOString() };
    saveCache(cache);
  }
  return { ...me, cached: false };
}

/** null when the post may go out as bot_user (or bot_user is unset), else {error, identity?}. */
async function identityRefusal() {
  if (!slack.bot_user) return null;
  let me;
  try { me = await identity(); } catch (e) {
    return { error: `could not confirm the posting identity: ${e.message}; nothing posted` };
  }
  if (me.user === String(slack.bot_user)) return null;
  return {
    error: `slack-axi would post as ${me.user}${me.name ? ` (${me.name})` : ""}, not as bot_user ${slack.bot_user}; nothing posted (slack-axi auth login --token xoxb-... with the bot's token, or set streams.slack.team)`,
    identity: { user: me.user, name: me.name },
  };
}

// ------------------------------------------------------------------------------- classification

function loadCache() {
  try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    return { convs: c.convs || {}, team: c.team, ...(c.identity ? { identity: c.identity } : {}) };
  } catch { return { convs: {}, team: undefined }; }
}
function saveCache(c) {
  const now = Date.now();
  for (const [k, v] of Object.entries(c.convs)) if (!v || now - Date.parse(v.at) >= cacheMs) delete c.convs[k];
  if (c.identity && !(now - Date.parse(c.identity.at) < cacheMs)) delete c.identity;
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, cacheFile);
  } catch { /* a cache that cannot be written costs lookups, nothing else */ }
}
const fresh = (v) => v && Date.now() - Date.parse(v.at) < cacheMs;

/** {class, why, cached}. A failed lookup is `unknown` and is never cached. */
async function classify(conv) {
  const cache = loadCache();
  if (fresh(cache.convs[conv])) return { class: cache.convs[conv].class, why: cache.convs[conv].why, cached: true };
  let result;
  try {
    result = decide(conv, cache);
  } catch (e) {
    return { class: "unknown", why: `lookup failed: ${e.message}`, cached: false };
  }
  cache.convs[conv] = { ...result, at: new Date().toISOString() };
  saveCache(cache);
  return { ...result, cached: false };
}

/** One TOON scalar: a quoted string with backslash escapes, true, false, null, a number, or bare text. */
function toonValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new Error(`unterminated string: ${v.slice(0, 40)}`);
    let out = "";
    for (let i = 1; i < v.length - 1; i++) {
      const c = v[i];
      if (c === "\\" && i + 1 < v.length - 1) {
        const n = v[++i];
        out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
      } else out += c;
    }
    return out;
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** One row of a TOON table: comma-separated cells, a quoted cell may hold commas. */
function toonCells(line) {
  const cells = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === "\\" && i + 1 < line.length) { cur += c + line[++i]; continue; }
    if (c === '"') quoted = !quoted;
    if (c === "," && !quoted) { cells.push(toonValue(cur)); cur = ""; continue; }
    cur += c;
  }
  cells.push(toonValue(cur));
  return cells;
}

/**
 * The parts of `slack-axi audience` output the classifier reads: the workspace's team id, the
 * `conversation` and `audience` blocks as objects, and the `non_full_members` rows. Strict: a
 * block or field it needs that is missing is an error, never a default.
 */
function parseAudience(out) {
  const lines = String(out).split("\n");
  const blocks = {};
  let rows = [];
  let team;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith(" ")) continue;
    const ws = line.match(/^workspace:\s*(.*)$/);
    if (ws) { const m = String(toonValue(ws[1])).match(/\(([A-Z0-9]+)\)\s*$/); team = m ? m[1] : undefined; continue; }
    const head = line.match(/^(conversation|audience):\s*$/);
    if (head) {
      const obj = {};
      while (i + 1 < lines.length && lines[i + 1].startsWith("  ")) {
        const kv = lines[++i].trim().match(/^([A-Za-z_]+):\s?(.*)$/);
        if (!kv) throw new Error(`unreadable line in ${head[1]}: ${lines[i].trim().slice(0, 60)}`);
        obj[kv[1]] = toonValue(kv[2]);
      }
      blocks[head[1]] = obj;
      continue;
    }
    const table = line.match(/^non_full_members\[\d+\]\{([^}]*)\}:\s*$/);
    if (table) {
      const cols = table[1].split(",");
      while (i + 1 < lines.length && lines[i + 1].startsWith("  ")) {
        const cells = toonCells(lines[++i].trim());
        const r = {};
        cols.forEach((c, k) => { r[c] = cells[k] ?? ""; });
        rows.push(r);
      }
    }
  }
  const c = blocks.conversation, a = blocks.audience;
  if (!c) throw new Error("slack-axi audience printed no conversation block");
  if (!a) throw new Error("slack-axi audience printed no audience block");
  if (typeof c.kind !== "string") throw new Error("slack-axi audience gave no conversation kind");
  for (const k of ["full", "guests", "external", "other_workspace", "deactivated", "bots", "unresolved"]) {
    if (typeof a[k] !== "number") throw new Error(`slack-axi audience gave no ${k} count`);
  }
  if (typeof a.truncated !== "boolean") throw new Error("slack-axi audience gave no truncated flag");
  const checked = String(a.members_checked ?? "").match(/^(\d+) of /);
  if (!checked) throw new Error("slack-axi audience gave no members_checked");
  return { team, conversation: c, audience: { ...a, checked: Number(checked[1]) }, nonFull: rows };
}

/** Today's wording for why a member is not a full member, from audience's `why` column. */
function memberWhy(why) {
  const w = String(why || "");
  if (w === "single-channel guest") return "a single-channel guest";
  if (w === "multi-channel guest") return "a guest";
  if (w === "deactivated") return "deactivated";
  if (w.startsWith("other organization") || w === "stranger" || w.startsWith("same org, other workspace")) return "from another organization";
  return w;
}

/** Run `slack-axi audience` and turn a failure into one clear line. */
function readAudience(conv) {
  const r = axi(["audience", conv, "--max-members", String(maxMembers), ...teamArgs]);
  if (r.error) throw new Error(`slack-axi audience: ${r.error.code === "ETIMEDOUT" ? "timed out" : r.error.message.split("\n")[0]}`);
  const err = firstError(r.out);
  if (/unknown command/i.test(err)) throw new Error(`slack-axi has no audience command; it needs ${AUDIENCE_SINCE} or later (${UPGRADE})`);
  if (r.code !== 0 || err) throw new Error(err || `slack-axi audience exited ${r.code}`);
  return parseAudience(r.out);
}

/**
 * The class from slack-axi's audience report. Bots of the bot's own workspace count as full
 * members (as users.info always had them); a member of another workspace, even in the same
 * Enterprise org, is from another organization; a truncated list is over max_members.
 */
function decide(conv, cache) {
  const { team, conversation: info, audience: a, nonFull } = readAudience(conv);
  if (!team) throw new Error("slack-axi audience printed no workspace id");
  if (cache.team !== team) { cache.convs = {}; cache.team = team; }

  if (info.kind === "im") {
    const other = info.user;
    if (typeof other !== "string" || !other) throw new Error("slack-axi audience gave no user for the DM");
    if (operators.has(other) || (slack.escalate_dm && conv === String(slack.escalate_dm))) return { class: "operator-dm", why: `a DM with the operator ${other}` };
  }

  for (const flag of ["is_ext_shared", "is_org_shared", "is_pending_ext_shared", "is_shared"]) {
    if (info[flag] === true) return { class: "external", why: `${flag} is true` };
  }
  if (a.truncated) {
    return typeof info.num_members === "number" && info.num_members > maxMembers
      ? { class: "external", why: `${info.num_members} members, over max_members ${maxMembers}; not all checked` }
      : { class: "external", why: `over max_members ${maxMembers} members; not all checked` };
  }
  if (a.unresolved > 0) {
    const u = nonFull.find((r) => String(r.why || "").startsWith("unresolved"));
    throw new Error(`a member could not be read${u ? `: ${u.id} ${u.why}` : ""}`);
  }
  if (a.checked === 0) throw new Error("slack-axi audience listed no one");

  const odd = a.guests + a.external + a.other_workspace + a.deactivated;
  if (info.kind === "im") {
    const row = nonFull.find((r) => r.id === info.user && r.why !== "bot");
    if (odd > 0 && row) return { class: "external", why: `a DM with ${info.user}, ${memberWhy(row.why)}` };
    if (odd > 0) return { class: "external", why: `a DM with ${info.user}, and someone in it is not a full member` };
    return { class: "internal", why: `a DM with ${info.user}, a full member` };
  }
  if (odd > 0) {
    const row = nonFull.find((r) => r.why !== "bot");
    return { class: "external", why: row ? `${row.id} is ${memberWhy(row.why)}` : `${odd} members are not full members` };
  }
  return { class: "internal", why: `not shared; all ${a.checked} members are full members` };
}

// ------------------------------------------------------------------------------- the screen

/** The policy text for a class, or null when the class is not screened. Throws on a bad setting. */
function screenFor(cls) {
  if (!screenCfg || cls === "operator-dm") return null;
  const lists = screenCfg.policy && typeof screenCfg.policy === "object" ? screenCfg.policy : {};
  const list = cls === "internal" ? lists.internal : lists.external;
  if (!Array.isArray(list) || list.length === 0) return null;
  const command = inRepo(screenCfg.command);
  if (!command) throw new Error(`streams.slack.screen.command must be a path inside the repo: ${screenCfg.command ?? "(unset)"}`);
  try { accessSync(command, constants.X_OK); if (!statSync(command).isFile()) throw new Error(); } catch {
    throw new Error(`streams.slack.screen.command is not an executable file: ${screenCfg.command}`);
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
  const marker = gitPath("opsbot-slack-screen");
  if (existsSync(marker)) return "the operator was already told about this outage";
  const mark = cfg.mark ? `${cfg.mark} ` : "";
  const message = `${mark}${cfg.name || "The bot"} could not screen a reply to a ${cls} conversation, so it was not posted: ${error}.\nReplies that need the screen wait until it answers again. This is said once until it does.`;
  const results = tellOperator(message);
  if (results.some((r) => r.ok)) {
    try { writeFileSync(marker, `${new Date().toISOString()}\n`); } catch { /* told, but may tell again */ }
    return "the operator was told";
  }
  return results.length ? "could not tell the operator: every escalation script failed" : "could not tell the operator: no script in opsbot.d/escalate.d/";
}
function screenAnswered() {
  const marker = gitPath("opsbot-slack-screen");
  if (existsSync(marker)) rmSync(marker, { force: true });
}

// ------------------------------------------------------------------------------- posting

function axi(args) {
  const r = spawnSync(process.env.OPSBOT_SLACK_AXI || "slack-axi", args, { encoding: "utf8", timeout: 30000 });
  return { code: r.status ?? 1, out: `${r.stdout || ""}${r.stderr || ""}`, error: r.error };
}
const firstError = (out) => (out.split("\n").find((l) => l.startsWith("error:")) || "").replace(/^error:\s*/, "").replace(/^"|"$/g, "");

/** Post through slack-axi in bot mode: {ts} or {error}. */
function postToSlack(conv, reply, text) {
  const mode = axi(["auth", "mode", ...teamArgs]);
  if (mode.code !== 0 || !/^\s*mode: bot\s*$/m.test(mode.out)) return { error: "slack-axi is not signed in in bot mode; the bot posts in its own name only (slack-axi auth login --token xoxb-...)" };
  const draft = axi(["draft", conv, ...(reply ? ["--reply", reply] : []), text, ...teamArgs]);
  const id = (draft.out.match(/^draft: (d_[0-9a-f]+)/m) || [])[1];
  if (draft.code !== 0 || !id) return { error: `slack-axi draft failed: ${firstError(draft.out) || `exit ${draft.code}, no draft id`}` };
  const send = axi(["draft", "send", id]);
  if (send.code !== 0 || /^error:/m.test(send.out)) return { error: `slack-axi draft send failed: ${firstError(send.out) || `exit ${send.code}`}` };
  return { ts: ((send.out.match(/^ts: "?([0-9.]+)"?/m) || [])[1]) || null };
}

function logDecision(line) {
  const p = inRepo(slack.post_log || "logs/slack-posts.jsonl");
  if (!p) { console.error(`warning: streams.slack.post_log must be inside the repo: ${slack.post_log}; nothing logged`); return; }
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(line)}\n`);
  } catch (e) { console.error(`warning: could not write ${p}: ${e.message.split("\n")[0]}`); }
}

// ------------------------------------------------------------------------------- commands

async function cmdPost(args) {
  let reply, dry = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--reply") { reply = args[++i]; if (reply === undefined) usage("--reply needs a ts"); }
    else if (a === "--dry-run") dry = true;
    else if (a === "-h" || a === "--help") usage("help");
    else if (a.startsWith("--")) usage(`unknown flag for post: ${a}`);
    else pos.push(a);
  }
  const [conv, given, extra] = pos;
  if (!conv || !CONV_RE.test(conv)) usage(`not a conversation id: ${conv ?? "(none)"}`);
  if (reply !== undefined && !TS_RE.test(reply)) usage(`not a Slack ts: ${reply}`);
  if (extra !== undefined) usage("one text only; quote it, or pass - and send it on stdin");
  const text = given === undefined || given === "-" ? readFileSync(0, "utf8") : given;
  if (!text.trim()) usage("empty text; nothing posted");

  const c = await classify(conv);
  const base = { at: new Date().toISOString(), conv, ...(reply ? { reply_to: reply } : {}), class: c.class, why: c.why, draft_sha256: createHash("sha256").update(text).digest("hex"), ...(dry ? { dry_run: true } : {}) };

  let screen;
  try { screen = screenFor(c.class); } catch (e) {
    logDecision({ ...base, screen: "error", error: e.message, posted: false });
    emit({ posted: false, conv, class: c.class, why: c.why, screen: "error", error: e.message }, EXIT.usage);
  }

  let verdict = "skipped";
  if (screen) {
    const v = runScreen(screen.command, { draft: text, destination_class: c.class, policy: screen.policy });
    if (v.error) {
      const told = screenOutage(c.class, v.error);
      logDecision({ ...base, screen: "error", error: v.error, posted: false });
      emit({ posted: false, conv, class: c.class, why: c.why, screen: "error", error: v.error, operator: told }, EXIT.screenFailed);
    }
    screenAnswered();
    if (v.verdict === "block") {
      logDecision({ ...base, screen: "block", reason: v.reason, posted: false });
      emit({ posted: false, conv, class: c.class, why: c.why, screen: "block", passage: v.passage, reason: v.reason, next: "rewrite it without the passage, or take it to the operator" }, EXIT.blocked);
    }
    verdict = "pass";
  }

  if (dry) {
    logDecision({ ...base, screen: verdict, posted: false });
    emit({ posted: false, dry_run: true, would_post: true, conv, class: c.class, why: c.why, screen: verdict }, EXIT.ok);
  }
  const refusal = await identityRefusal();
  if (refusal) {
    logDecision({ ...base, screen: verdict, error: refusal.error, posted: false });
    emit({ posted: false, conv, class: c.class, why: c.why, screen: verdict, ...refusal }, EXIT.identity);
  }
  const sent = postToSlack(conv, reply, text);
  if (sent.error) {
    logDecision({ ...base, screen: verdict, error: sent.error, posted: false });
    emit({ posted: false, conv, class: c.class, why: c.why, screen: verdict, error: sent.error }, EXIT.slack);
  }
  logDecision({ ...base, screen: verdict, posted: true, ...(sent.ts ? { ts: sent.ts } : {}) });
  emit({ posted: true, conv, ...(sent.ts ? { ts: sent.ts } : {}), class: c.class, why: c.why, screen: verdict }, EXIT.ok);
}

async function cmdClassify(args) {
  if (args.length !== 1 || !CONV_RE.test(args[0])) usage(`classify takes one conversation id`);
  const c = await classify(args[0]);
  emit({ conv: args[0], class: c.class, why: c.why, cached: c.cached }, EXIT.ok);
}

/** One status row for the screen setting: `ok <detail>` (exit 0) or `differs <detail>` (exit 1). */
function cmdScreenCheck() {
  const problems = [];
  const lists = screenCfg?.policy && typeof screenCfg.policy === "object" ? screenCfg.policy : {};
  const command = inRepo(screenCfg?.command);
  if (!command) problems.push(`command must be a path inside the repo: ${screenCfg?.command ?? "(unset)"}`);
  else {
    try { accessSync(command, constants.X_OK); if (!statSync(command).isFile()) throw new Error(); } catch { problems.push(`command is not an executable file: ${screenCfg.command}`); }
  }
  const named = [];
  for (const cls of ["internal", "external"]) {
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
  if (problems.length) { console.log(`differs ${problems.join("; ")}`); process.exit(1); }
  console.log(`ok ${screenCfg.command}; screens ${named.length ? named.join(" and ") : "nothing (no policy listed)"}`);
  process.exit(0);
}

/** One status row for the posting identity: `ok`, `differs` or `missing <detail>`. */
async function cmdIdentityCheck() {
  let me;
  try { me = await identity(); } catch (e) {
    console.log(`missing no posting identity: ${e.message}`);
    process.exit(1);
  }
  const who = `${me.user}${me.name ? ` (${me.name})` : ""}`;
  if (me.user === String(slack.bot_user || "")) { console.log(`ok posts as ${who}, bot_user`); process.exit(0); }
  console.log(`differs posts as ${who}, not bot_user ${slack.bot_user || "(unset)"}`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "post") await cmdPost(rest);
else if (cmd === "classify") await cmdClassify(rest);
else if (cmd === "screen-check") cmdScreenCheck();
else if (cmd === "identity-check") await cmdIdentityCheck();
else usage(`unknown command: ${cmd ?? "(none)"}`);
