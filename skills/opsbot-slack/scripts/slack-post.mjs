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
// The bot token is slack-axi's own (SLACK_AXI_TOKEN, else slack-axi's store, in slack-axi's
// order); it is read here to call conversations.info, conversations.members, users.info and
// auth.test, and never printed.
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

// ------------------------------------------------------------------------------- Slack Web API

/**
 * The token slack-axi will post with, in slack-axi's own order: SLACK_AXI_TOKEN, then the
 * workspace `team` names (passed to it as --team), then its default, then its only one.
 */
function slackToken() {
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
  let token;
  try { token = JSON.parse(readFileSync(join(base, "workspaces", team, "token.json"), "utf8")).token; } catch { token = undefined; }
  if (!token) throw new Error(`slack-axi holds no token for ${team}`);
  return token;
}

let token;
async function api(method, params = {}) {
  if (token === undefined) token = slackToken();
  let res;
  try {
    res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`${method}: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
  }
  let body;
  try { body = await res.json(); } catch { throw new Error(`${method}: HTTP ${res.status}, not JSON`); }
  if (!body || body.ok !== true) throw new Error(`${method}: ${(body && body.error) || `HTTP ${res.status}`}`);
  return body;
}

// ------------------------------------------------------------------------------- the posting identity

/**
 * Who the post token is, from auth.test: {user, name, team, cached}. A match with bot_user is
 * cached for cache_seconds under a hash of the token, so a changed token is asked again at once.
 * Throws when no token resolves or auth.test fails.
 */
async function identity() {
  if (token === undefined) token = slackToken();
  const key = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const cache = loadCache();
  const c = cache.identity;
  if (c && c.token === key && fresh(c) && c.user === String(slack.bot_user || "")) return { user: c.user, name: c.name, team: c.team, cached: true };
  const a = await api("auth.test");
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
    return { convs: c.convs || {}, users: c.users || {}, team: c.team, ...(c.identity ? { identity: c.identity } : {}) };
  } catch { return { convs: {}, users: {}, team: undefined }; }
}
function saveCache(c) {
  const now = Date.now();
  for (const m of [c.convs, c.users]) for (const [k, v] of Object.entries(m)) if (!v || now - Date.parse(v.at) >= cacheMs) delete m[k];
  if (c.identity && !(now - Date.parse(c.identity.at) < cacheMs)) delete c.identity;
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, cacheFile);
  } catch { /* a cache that cannot be written costs lookups, nothing else */ }
}
const fresh = (v) => v && Date.now() - Date.parse(v.at) < cacheMs;

/** Whether a user is a full member of the bot's workspace, from users.info. */
async function member(cache, team, id) {
  if (fresh(cache.users[id])) return cache.users[id];
  const u = (await api("users.info", { user: id })).user;
  if (!u || typeof u.team_id !== "string") throw new Error(`users.info gave no team for ${id}`);
  let why = "";
  if (u.deleted === true) why = "deactivated";
  else if (u.is_ultra_restricted === true) why = "a single-channel guest";
  else if (u.is_restricted === true) why = "a guest";
  else if (u.is_stranger === true || u.team_id !== team) why = "from another organization";
  const row = { full: why === "", why, at: new Date().toISOString() };
  cache.users[id] = row;
  return row;
}

/** {class, why, cached}. A failed lookup is `unknown` and is never cached. */
async function classify(conv) {
  const cache = loadCache();
  if (fresh(cache.convs[conv])) return { class: cache.convs[conv].class, why: cache.convs[conv].why, cached: true };
  let result;
  try {
    result = await decide(conv, cache);
  } catch (e) {
    return { class: "unknown", why: `lookup failed: ${e.message}`, cached: false };
  }
  cache.convs[conv] = { ...result, at: new Date().toISOString() };
  saveCache(cache);
  return { ...result, cached: false };
}

async function decide(conv, cache) {
  const team = (await api("auth.test")).team_id;
  if (typeof team !== "string" || !team) throw new Error("auth.test gave no team_id");
  if (cache.team !== team) { cache.users = {}; cache.convs = {}; cache.team = team; }
  const info = (await api("conversations.info", { channel: conv, include_num_members: "true" })).channel;
  if (!info || typeof info !== "object") throw new Error("conversations.info gave no channel");

  if (info.is_im === true) {
    const other = info.user;
    if (typeof other !== "string" || !other) throw new Error("conversations.info gave no user for the DM");
    if (operators.has(other) || (slack.escalate_dm && conv === String(slack.escalate_dm))) return { class: "operator-dm", why: `a DM with the operator ${other}` };
    const m = await member(cache, team, other);
    return m.full ? { class: "internal", why: `a DM with ${other}, a full member` } : { class: "external", why: `a DM with ${other}, ${m.why}` };
  }

  for (const flag of ["is_ext_shared", "is_org_shared", "is_pending_ext_shared", "is_shared"]) {
    if (info[flag] === true) return { class: "external", why: `${flag} is true` };
  }
  if (typeof info.num_members === "number" && info.num_members > maxMembers) {
    return { class: "external", why: `${info.num_members} members, over max_members ${maxMembers}; not all checked` };
  }

  const ids = [];
  let cursor = "";
  do {
    const page = await api("conversations.members", { channel: conv, limit: "200", ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.members)) throw new Error("conversations.members gave no members");
    ids.push(...page.members);
    if (ids.length > maxMembers) return { class: "external", why: `over max_members ${maxMembers} members; not all checked` };
    cursor = (page.response_metadata && page.response_metadata.next_cursor) || "";
  } while (cursor);
  if (ids.length === 0) throw new Error("conversations.members listed no one");

  for (let i = 0; i < ids.length; i += 10) {
    const rows = await Promise.all(ids.slice(i, i + 10).map((id) => member(cache, team, id).then((m) => ({ id, m }))));
    const odd = rows.find((r) => !r.m.full);
    if (odd) return { class: "external", why: `${odd.id} is ${odd.m.why}` };
  }
  return { class: "internal", why: `not shared; all ${ids.length} members are full members` };
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
