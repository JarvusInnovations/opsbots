import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encode } from "@toon-format/toon";

const SKILL = resolve(import.meta.dir, "..", "skills", "opsbot-slack");
const LISTENER = join(SKILL, "templates/monitor.d/10-slack-listener");
const READER = join(SKILL, "templates/heartbeat.d/20-slack-events");
const SINK = join(SKILL, "templates/escalate.d/10-slack-dm");
const CLI = join(SKILL, "scripts/opsbot-slack");

// Obviously fake ids throughout.
const BOT = "U0BOT00001";
const ANN = "U0ANN00001";
const DM = "D0DM000001";
const CHAN = "C0CHAN0001";

// The real node binary, by absolute path: an asdf shim re-orders PATH and would put the
// globally installed slack-axi ahead of the stand-in. Every script under test runs with
// PATH = the stand-in's bin (which links node) + /usr/bin:/bin, and OPSBOT_SLACK_AXI naming
// the stand-in, so the real tool is unreachable and no test can touch a live workspace.
const NODE = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "opsbot-slack-test-")); dirs.push(d); return d; };

/** slack-axi prints `label[N]{cols}:` tables; build them with the same encoder it uses. */
const table = (label: string, rows: Record<string, unknown>[]) => encode({ [label]: rows });

/**
 * A stand-in slack-axi: logs every call, prints canned output per subcommand from files in
 * `dir/axi/`, and fails a subcommand when `dir/axi/fail-<sub>` exists.
 */
function standIn(dir: string, canned: Record<string, string> = {}) {
  const bin = join(dir, "bin");
  const axi = join(dir, "axi");
  mkdirSync(bin, { recursive: true });
  mkdirSync(axi, { recursive: true });
  for (const [k, v] of Object.entries(canned)) writeFileSync(join(axi, k), v);
  writeFileSync(join(bin, "slack-axi"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls.log"
sub="$1"; [ "$1 $2" = "draft send" ] && sub=send; [ "$1" = auth ] && sub=mode
if [ "$sub" = draft ]; then printf '%s' "$3" > "${dir}/drafted.txt"; fi
if [ -e "${axi}/fail-$sub" ]; then echo "error: \\"stand-in failure for $sub\\""; echo "code: SLACK_ERROR"; exit 1; fi
key="$sub"; [ "$sub" = user ] && key="user-$2"; [ "$sub" = thread ] && key="thread-$3"
if [ -f "${axi}/$key" ]; then cat "${axi}/$key"; exit 0; fi
case "$sub" in
  user) echo "error: \\"No user found for $2\\""; exit 1 ;;
  draft) printf 'draft: d_1a2b3c4d\\nworkspace: Example (T0EXAMPLE1)\\nchannel: "@ann (${DM})"\\nmode: bot\\n' ;;
  send) printf 'sent: d_1a2b3c4d\\nts: "1794400999000100"\\n' ;;
  *) echo "error: \\"no canned output for $*\\""; exit 1 ;;
esac
`);
  chmodSync(join(bin, "slack-axi"), 0o755);
  symlinkSync(NODE, join(bin, "node"));
  return bin;
}

/** The environment every script under test gets: only the stand-in's bin and the system's. */
const isolated = (bin: string, extra: Record<string, string> = {}) => ({
  ...process.env, PATH: `${bin}:/usr/bin:/bin`, OPSBOT_SLACK_AXI: join(bin, "slack-axi"), ...extra,
});

const calls = (dir: string) => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);

/** Run the listener's pure classify() over raw Events API events, through node. */
function classify(events: unknown[], botUser = BOT, recorded = ""): (Record<string, unknown> | null)[] {
  const r = spawnSync(NODE, ["--input-type=module", "-e", `
    const m = await import(process.env.LISTENER);
    let s = ""; for await (const c of process.stdin) s += c;
    const { events, botUser, recorded } = JSON.parse(s);
    for (const e of events) {
      const it = m.classify(e, { botUser, inMyThread: (c, t) => m.threadIsMine(recorded, c, t) });
      console.log(JSON.stringify(it));
    }`], { input: JSON.stringify({ events, botUser, recorded }), encoding: "utf8", env: { ...process.env, LISTENER } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim().split("\n").map((l) => JSON.parse(l));
}

// Raw events as Slack's Events API delivers them.
const DM_TOP = { type: "message", channel_type: "im", channel: DM, user: ANN, text: "can you check the invoice?", ts: "1794400000.000100" };
const DM_THREADED = { type: "message", channel_type: "im", channel: DM, user: ANN, text: "and the second one", ts: "1794400100.000200", thread_ts: "1794400000.000100" };
const MENTION = { type: "app_mention", channel: CHAN, user: ANN, text: `<@${BOT}> what is due this week?`, ts: "1794400200.000300" };
const THREAD_REPLY = { type: "message", channel_type: "channel", channel: CHAN, user: ANN, text: "also the report", ts: "1794400300.000400", thread_ts: "1794400200.000300" };
const REACTION = { type: "reaction_added", user: ANN, reaction: "thumbsup", item_user: BOT, item: { type: "message", channel: CHAN, ts: "1794400250.000500" } };

describe("the listener's pure parts", () => {
  test("node --check passes", () => {
    expect(spawnSync(NODE, ["--check", LISTENER]).status).toBe(0);
    expect(spawnSync(NODE, ["--check", READER]).status).toBe(0);
  });

  test("a DM, a threaded DM, an @mention, a reaction on its message and a new member become recorded lines with stable keys", () => {
    const join_ = { type: "team_join", user: { id: "U0NEW00001", real_name: "New Person" }, event_ts: "1794400400.000600" };
    const [a, b, c, d, e] = classify([DM_TOP, DM_THREADED, MENTION, REACTION, join_]);
    expect(a).toMatchObject({ key: `slack:${DM}:1794400000.000100:msg`, kind: "dm", event: "message", conv: DM, from: ANN, thread_ts: null });
    expect(a!.at).toBe(new Date(1794400000000).toISOString());
    expect(b).toMatchObject({ key: `slack:${DM}:1794400100.000200:msg`, kind: "dm", thread_ts: "1794400000.000100" });
    expect(c).toMatchObject({ key: `slack:${CHAN}:1794400200.000300:msg`, kind: "group", event: "app_mention" });
    expect(d).toMatchObject({ key: `slack:${CHAN}:1794400250.000500:thumbsup:${ANN}`, kind: "group", reaction: "thumbsup", text: ":thumbsup:" });
    expect(e).toMatchObject({ key: "slack:team_join:U0NEW00001", event: "team_join", from: "U0NEW00001", text: "joined the workspace: New Person" });
    expect(classify([DM_TOP])[0]).toEqual(a!);
  });

  test("dropped: the bot's own messages, other bots, edits, reactions on others' messages, channel chatter outside its threads", () => {
    const got = classify([
      { ...DM_TOP, user: BOT },
      { ...DM_TOP, bot_id: "B0OTHER001" },
      { ...DM_TOP, subtype: "message_changed" },
      { ...REACTION, item_user: ANN },
      { type: "message", channel_type: "channel", channel: CHAN, user: ANN, text: "unrelated", ts: "1794400500.000700" },
      THREAD_REPLY,
      { type: "channel_created", channel: { id: "C0NEW00001" } },
    ]);
    expect(got).toEqual([null, null, null, null, null, null, null]);
  });

  test("a reply in a thread it was @mentioned in is kept; one that @mentions it is left to app_mention", () => {
    const recorded = JSON.stringify(classify([MENTION])[0]) + "\n";
    const [kept, mention] = classify([THREAD_REPLY, { ...THREAD_REPLY, text: `<@${BOT}> and this` }], BOT, recorded);
    expect(kept).toMatchObject({ key: `slack:${CHAN}:1794400300.000400:msg`, kind: "group", thread_ts: "1794400200.000300" });
    expect(mention).toBeNull();
  });

  test("without bot_user no reaction is kept", () => {
    expect(classify([REACTION], "")).toEqual([null]);
  });

  test("the process refuses to start, before any network call, on a missing, open or wrong-kind token file", () => {
    const dir = tmp();
    const tf = join(dir, "app-token");
    writeFileSync(join(dir, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { slack: { app_token_file: tf, events_file: join(dir, "ev.jsonl"), bot_user: BOT } } }));
    const start = () => spawnSync(NODE, [LISTENER], { encoding: "utf8", timeout: 10000, env: { ...process.env, OPSBOT_ROOT: dir, OPSBOT_CONFIG: join(dir, "opsbot.json"), OPSBOT_SLACK_AXI: "/bin/false" } });
    expect(start().status).toBe(1);
    expect(start().stderr).toContain("no app-level token");
    writeFileSync(tf, "xapp-1-FAKE\n", { mode: 0o644 });
    chmodSync(tf, 0o644);
    expect(start().stderr).toContain("readable by others");
    writeFileSync(tf, "xoxb-FAKE\n");
    chmodSync(tf, 0o600);
    const wrong = start();
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("does not hold an app-level");
    expect(wrong.stdout + wrong.stderr).not.toContain("FAKE");
  });
});

/**
 * What the listener's handle() does per event, with the events file and the own-threads file
 * held in memory: an own root is remembered and nothing else; anything else goes through
 * classify() with the same inMyThread the process uses. Through node, no file, no network.
 */
function listen(events: unknown[], files = { events: "", roots: "" }, botUser = BOT) {
  const r = spawnSync(NODE, ["--input-type=module", "-e", `
    const m = await import(process.env.LISTENER);
    let s = ""; for await (const c of process.stdin) s += c;
    const { events, files, botUser } = JSON.parse(s);
    const kept = [];
    for (const e of events) {
      const root = m.ownRoot(e, { botUser });
      if (root) { files.roots += JSON.stringify(root) + "\\n"; continue; }
      const it = m.classify(e, { botUser, inMyThread: (c, t) => m.rootIsMine(files.roots, c, t) || m.threadIsMine(files.events, c, t) });
      if (it) { files.events += JSON.stringify(it) + "\\n"; kept.push(it); }
    }
    console.log(JSON.stringify({ kept, files }));`], { input: JSON.stringify({ events, files, botUser }), encoding: "utf8", env: { ...process.env, LISTENER } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as { kept: Record<string, unknown>[]; files: { events: string; roots: string } };
}

/** Call one of the listener's exported pure functions through node. */
function call(fn: string, args: unknown[]): unknown {
  const r = spawnSync(NODE, ["--input-type=module", "-e", `
    const m = await import(process.env.LISTENER);
    let s = ""; for await (const c of process.stdin) s += c;
    const { fn, args } = JSON.parse(s);
    console.log(JSON.stringify(m[fn](...args) ?? null));`], { input: JSON.stringify({ fn, args }), encoding: "utf8", env: { ...process.env, LISTENER } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("threads the bot started", () => {
  const ROOT = "1794400600.000800";
  const PRIV = "G0PRIV0001";
  const ownPost = { type: "message", channel_type: "group", channel: PRIV, user: BOT, bot_id: "B0BOT00001", text: "the nightly summary", ts: ROOT };
  const ownReply = { ...ownPost, text: "one more thing", ts: "1794400650.000850", thread_ts: ROOT, parent_user_id: BOT };
  const reply = { type: "message", channel_type: "group", channel: PRIV, user: ANN, text: "thanks, and the totals?", ts: "1794400700.000900", thread_ts: ROOT };

  test("a reply under the bot's own top-level post is kept, with the usual key and thread", () => {
    const { kept, files } = listen([ownPost, ownReply, reply]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ key: `slack:${PRIV}:1794400700.000900:msg`, event: "message", kind: "group", from: ANN, thread_ts: ROOT });
    // Only the top-level post is a root; the bot's own reply is neither a root nor an item.
    expect(files.roots.trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ conv: PRIV, ts: ROOT }]);
  });

  test("a reply is kept when Slack names the bot as the thread's parent author and no root was recorded", () => {
    const { kept, files } = listen([{ ...reply, parent_user_id: BOT }]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ thread_ts: ROOT, from: ANN });
    expect(files.roots).toBe("");
    // Without bot_user the field means nothing.
    expect(listen([{ ...reply, parent_user_id: BOT }], undefined, "").kept).toEqual([]);
  });

  test("a thread the bot only replied in, with no mention, still does not count", () => {
    const { kept, files } = listen([
      { ...ownReply, parent_user_id: ANN },
      { ...reply, user: "U0BEN00001", parent_user_id: ANN },
    ]);
    expect(kept).toEqual([]);
    expect(files.roots).toBe("");
  });

  test("a root in one conversation does not claim the same ts in another, nor another thread", () => {
    const { kept } = listen([
      ownPost,
      { ...reply, channel: CHAN, channel_type: "channel" },
      { ...reply, thread_ts: "1794400000.999999", parent_user_id: ANN },
    ]);
    expect(kept).toEqual([]);
  });

  test("the bot's own messages are never items, top-level or reply, even in its own thread", () => {
    const { kept } = listen([ownPost, ownReply, { ...ownReply, bot_id: undefined }]);
    expect(kept).toEqual([]);
    for (const e of [ownPost, ownReply]) expect(classify([e])).toEqual([null]);
  });

  test("ownRoot ignores people's posts, edits, replies, DMs and an unset bot_user", () => {
    const root = (e: unknown, botUser = BOT) => call("ownRoot", [e, { botUser }]);
    expect(root({ ...ownPost, user: ANN })).toBeNull();
    expect(root({ ...ownPost, subtype: "message_changed" })).toBeNull();
    expect(root(ownReply)).toBeNull();
    expect(root({ ...ownPost, channel: DM, channel_type: "im" })).toBeNull();
    expect(root(ownPost, "")).toBeNull();
    expect(root({ ...ownPost, thread_ts: ROOT })).toEqual({ conv: PRIV, ts: ROOT });
    expect(root({ ...ownPost, channel: CHAN, channel_type: "channel", subtype: "file_share" })).toEqual({ conv: CHAN, ts: ROOT });
  });

  test("the mention rule is unchanged: a reply in a thread it was @mentioned in is kept, one that @mentions it is left to app_mention", () => {
    const { kept } = listen([MENTION, THREAD_REPLY, { ...THREAD_REPLY, ts: "1794400310.000410", text: `<@${BOT}> and this` }]);
    expect(kept.map((k) => k.event)).toEqual(["app_mention", "message"]);
    expect(kept[1]).toMatchObject({ thread_ts: "1794400200.000300" });
    // And under its own post: a reply that @mentions it is still the app_mention's.
    expect(listen([ownPost, { ...reply, text: `<@${BOT}> again` }]).kept).toEqual([]);
  });

  test("the own-threads file sits beside the events file", () => {
    const s = call("settings", [{ name: "examplebot", streams: { slack: { events_file: "/var/tmp/example/events.jsonl" } } }]) as Record<string, string>;
    expect(s.ownThreadsFile).toBe("/var/tmp/example/slack-own-threads.jsonl");
  });

  test("the running listener remembers its own post on disk, keeps the reply under it, and prunes old roots", () => {
    // A preload stands in for Slack: fetch returns a socket URL, and the WebSocket delivers the
    // events one at a time, then exits. No network; HOME is the temp dir.
    const dir = tmp();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const tf = join(dir, "app-token");
    writeFileSync(tf, "xapp-1-FAKE\n", { mode: 0o600 });
    chmodSync(tf, 0o600);
    const now = Math.floor(Date.now() / 1000);
    const roots = join(dir, "slack-own-threads.jsonl");
    writeFileSync(roots, JSON.stringify({ conv: PRIV, ts: `${now - 100 * 86400}.000100`, recorded_at: "2026-01-01T00:00:00.000Z" }) + "\n");
    writeFileSync(join(repo, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { slack: { app_token_file: tf, events_file: join(dir, "slack-events.jsonl"), bot_user: BOT } } }));
    const post = { ...ownPost, ts: `${now}.000100` };
    const answer = { ...reply, ts: `${now}.000200`, thread_ts: post.ts };
    const preload = join(dir, "fake-slack.mjs");
    writeFileSync(preload, `
      const events = ${JSON.stringify([post, answer])};
      globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: "ws://stand-in" }) });
      globalThis.WebSocket = class {
        constructor() {
          setTimeout(() => {
            this.onopen();
            let i = 0;
            const next = () => {
              if (i >= events.length) { setTimeout(() => process.exit(0), 300); return; }
              this.onmessage({ data: JSON.stringify({ envelope_id: "e" + i, type: "events_api", payload: { event: events[i++] } }) });
              setTimeout(next, 150);
            };
            next();
          }, 10);
        }
        send() {}
        close() {}
      };`);
    const r = spawnSync(NODE, ["--import", preload, LISTENER], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, HOME: dir, OPSBOT_ROOT: repo, OPSBOT_CORE: "/bin/true", OPSBOT_SLACK_AXI: "/bin/true" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`own thread root ${PRIV} ${post.ts}`);
    // The 100-day-old root is gone; the new one is the only line.
    expect(readFileSync(roots, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ conv: PRIV, ts: post.ts })]);
    const recorded = readFileSync(join(dir, "slack-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recorded).toEqual([expect.objectContaining({ key: `slack:${PRIV}:${answer.ts}:msg`, from: ANN, thread_ts: post.ts })]);
  });

  test("roots older than 90 days are pruned by their ts; recent ones and their order stay", () => {
    const now = 1794400600 * 1000;
    const day = 86400;
    const line = (ts: number) => JSON.stringify({ conv: PRIV, ts: `${ts}.000100`, recorded_at: "2026-11-10T14:00:00.000Z" }) + "\n";
    const recent = line(1794400600 - 89 * day) + line(1794400600 - day) + line(1794400600);
    expect(call("pruneRoots", [recent, now])).toBe(recent);
    expect(call("pruneRoots", [line(1794400600 - 91 * day) + "not json\n" + recent, now])).toBe(recent);
    expect(call("pruneRoots", ["", now])).toBe("");
    expect(call("pruneRoots", [line(1794400600 - 11 * day), now, 10])).toBe("");
  });
});

/**
 * handle() with the identity settings: like listen(), plus the bot ids, operators and
 * escalate_dm the process passes, and the journal line for each dropped app post.
 */
function listenAs(events: unknown[], ids: Record<string, unknown>, files = { events: "", roots: "" }) {
  const r = spawnSync(NODE, ["--input-type=module", "-e", `
    const m = await import(process.env.LISTENER);
    let s = ""; for await (const c of process.stdin) s += c;
    const { events, files, ids } = JSON.parse(s);
    const kept = [], dropped = [];
    for (const e of events) {
      const root = m.ownRoot(e, ids);
      if (root) { files.roots += JSON.stringify(root) + "\\n"; continue; }
      const it = m.classify(e, { ...ids, inMyThread: (c, t) => m.rootIsMine(files.roots, c, t) || m.threadIsMine(files.events, c, t) });
      if (it) { files.events += JSON.stringify(it) + "\\n"; kept.push(it); }
      else { const d = m.droppedAppPost(e, ids); if (d) dropped.push(d); }
    }
    console.log(JSON.stringify({ kept, files, dropped }));`], { input: JSON.stringify({ events, files, ids }), encoding: "utf8", env: { ...process.env, LISTENER } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as { kept: Record<string, unknown>[]; files: { events: string; roots: string }; dropped: string[] };
}

describe("posts through an app", () => {
  // An app holding the operator's own user token posts as the operator: user is theirs, and
  // the message carries the app's bot_id and app_id. Invented ids throughout.
  const OPS = "U0OPS00001";
  const OPS_DM = "D0OPSDM001";
  const APP = { bot_id: "B0ASSIST01", app_id: "A0ASSIST01" };
  const OWN_BOT = "B0BOT00001";
  const OTHER = { bot_id: "B0OTHER001", app_id: "A0OTHER001" };
  const ids = { botUser: BOT, botIds: [OWN_BOT], operators: [OPS] };
  const ROOT = "1794401000.001000";
  const ownPost = { type: "message", channel_type: "channel", channel: CHAN, user: BOT, bot_id: OWN_BOT, text: "the weekly summary", ts: ROOT };

  test("an operator's app post in a DM is kept exactly like one they typed", () => {
    const typed = { type: "message", channel_type: "im", channel: OPS_DM, user: OPS, text: "check the queue", ts: "1794401100.001100" };
    const viaApp = { ...typed, ...APP };
    const a = listenAs([typed], ids).kept;
    const b = listenAs([viaApp], ids).kept;
    expect(b).toHaveLength(1);
    expect(b).toEqual(a);
    expect(b[0]).toMatchObject({ key: `slack:${OPS_DM}:1794401100.001100:msg`, kind: "dm", from: OPS });
  });

  test("an operator's app post replying in a mention thread is kept, an app @mention too", () => {
    const mention = { ...MENTION, user: OPS };
    const reply = { ...THREAD_REPLY, user: OPS, ...APP };
    const { kept, dropped } = listenAs([mention, reply, { ...MENTION, ts: "1794400350.000450", user: OPS, ...APP }], ids);
    expect(kept.map((k) => [k.event, k.from, k.thread_ts])).toEqual([
      ["app_mention", OPS, null], ["message", OPS, "1794400200.000300"], ["app_mention", OPS, null],
    ]);
    expect(dropped).toEqual([]);
  });

  test("an operator's app post replying under the bot's own post is kept", () => {
    const reply = { type: "message", channel_type: "channel", channel: CHAN, user: OPS, ...APP, text: "and the totals", ts: "1794401200.001200", thread_ts: ROOT };
    const { kept, files } = listenAs([ownPost, reply], ids);
    expect(files.roots.trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ conv: CHAN, ts: ROOT }]);
    expect(kept).toEqual([expect.objectContaining({ key: `slack:${CHAN}:1794401200.001200:msg`, from: OPS, thread_ts: ROOT })]);
  });

  test("anyone but the bot in escalate_dm counts as the operator, with no operators listed", () => {
    const viaApp = { type: "message", channel_type: "im", channel: OPS_DM, user: OPS, ...APP, text: "status?", ts: "1794401300.001300" };
    expect(listenAs([viaApp], { botUser: BOT, escalateDm: OPS_DM }).kept).toHaveLength(1);
    // The same post in another DM is another bot's.
    expect(listenAs([{ ...viaApp, channel: DM }], { botUser: BOT, escalateDm: OPS_DM }).kept).toEqual([]);
  });

  test("an app post as a non-operator is dropped, with one line of ids and never the text", () => {
    const ann = { ...THREAD_REPLY, ...APP, text: "secret words" };
    const recorded = JSON.stringify(classify([MENTION])[0]) + "\n";
    const { kept, dropped } = listenAs([ann, { ...DM_TOP, ...APP }], ids, { events: recorded, roots: "" });
    expect(kept).toEqual([]);
    expect(dropped).toEqual([`dropped app post ${CHAN} ${ANN} ${APP.bot_id}`, `dropped app post ${DM} ${ANN} ${APP.bot_id}`]);
    expect(dropped.join("\n")).not.toContain("secret");
  });

  test("another bot is dropped and logged: its own user, a bot_message with no user, even one claiming an operator", () => {
    const otherBot = { type: "message", channel_type: "im", channel: DM, user: "U0OTHERB01", ...OTHER, text: "hello bot", ts: "1794401400.001400" };
    const integration = { type: "message", subtype: "bot_message", channel_type: "channel", channel: CHAN, bot_id: OTHER.bot_id, text: "build passed", ts: "1794401500.001500", thread_ts: "1794400200.000300" };
    const recorded = JSON.stringify(classify([MENTION])[0]) + "\n";
    const { kept, dropped } = listenAs([otherBot, integration, { ...integration, user: OPS }], ids, { events: recorded, roots: "" });
    expect(kept).toEqual([]);
    expect(dropped).toEqual([
      `dropped app post ${DM} U0OTHERB01 ${OTHER.bot_id}`,
      `dropped app post ${CHAN} - ${OTHER.bot_id}`,
      `dropped app post ${CHAN} ${OPS} ${OTHER.bot_id}`,
    ]);
  });

  test("the bot's own posts are never items, by user and by bot id, and are not logged as drops", () => {
    const byUser = { type: "message", channel_type: "im", channel: OPS_DM, user: BOT, bot_id: OWN_BOT, text: "done", ts: "1794401600.001600" };
    const byBotId = { type: "message", subtype: "bot_message", channel_type: "im", channel: OPS_DM, bot_id: OWN_BOT, text: "done", ts: "1794401700.001700" };
    const { kept, dropped } = listenAs([byUser, byBotId, { ...byUser, bot_id: undefined }], { ...ids, escalateDm: OPS_DM });
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
    // Its own bot id with no user is its own top-level post, remembered as a root.
    expect(call("ownRoot", [{ ...ownPost, user: undefined, subtype: "bot_message" }, ids])).toEqual({ conv: CHAN, ts: ROOT });
    // A post with someone else's user is never the bot's, whatever its bot id.
    expect(call("sender", [{ ...ownPost, user: ANN }, ids])).toBe("bot");
    expect(call("sender", [{ ...ownPost, user: OPS }, ids])).toBe("operator");
    expect(call("ownRoot", [{ ...ownPost, user: OPS }, ids])).toBeNull();
  });

  test("with no operators configured nothing changes: every bot_id is dropped as before", () => {
    const evs = [{ ...DM_TOP, user: OPS, ...APP }, { ...MENTION, user: OPS, ...APP }, { ...DM_TOP, ...APP }];
    expect(classify(evs)).toEqual([null, null, null]);
    expect(listenAs(evs, { botUser: BOT }).kept).toEqual([]);
    expect(listenAs([DM_TOP, MENTION], { botUser: BOT }).kept).toEqual(classify([DM_TOP, MENTION]) as Record<string, unknown>[]);
  });

  test("settings read bot_id, operators and escalate_dm", () => {
    const s = call("settings", [{ name: "examplebot", streams: { slack: { bot_id: OWN_BOT, operators: [OPS], escalate_dm: OPS_DM } } }]) as Record<string, unknown>;
    expect(s).toMatchObject({ botId: OWN_BOT, operators: [OPS], escalateDm: OPS_DM });
    expect(call("settings", [{ name: "examplebot" }])).toMatchObject({ botId: "", operators: [], escalateDm: "" });
  });

  test("the running listener learns its bot id, keeps an operator's app post, and logs a foreign one", () => {
    const dir = tmp();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const tf = join(dir, "app-token");
    writeFileSync(tf, "xapp-1-FAKE\n", { mode: 0o600 });
    chmodSync(tf, 0o600);
    writeFileSync(join(repo, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { slack: { app_token_file: tf, events_file: join(dir, "slack-events.jsonl"), bot_user: BOT, operators: [OPS] } } }));
    const now = Math.floor(Date.now() / 1000);
    const own = { type: "message", channel_type: "im", channel: OPS_DM, user: BOT, bot_id: OWN_BOT, text: "hi", ts: `${now}.000100` };
    const ownNoUser = { type: "message", subtype: "bot_message", channel_type: "im", channel: OPS_DM, bot_id: OWN_BOT, text: "hi", ts: `${now}.000150` };
    const ops = { type: "message", channel_type: "im", channel: OPS_DM, user: OPS, ...APP, text: "please check", ts: `${now}.000200` };
    const foreign = { type: "message", channel_type: "im", channel: DM, user: ANN, ...APP, text: "private words", ts: `${now}.000300` };
    const preload = join(dir, "fake-slack.mjs");
    writeFileSync(preload, `
      const events = ${JSON.stringify([own, ownNoUser, ops, foreign])};
      globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: "ws://stand-in" }) });
      globalThis.WebSocket = class {
        constructor() {
          setTimeout(() => {
            this.onopen();
            let i = 0;
            const next = () => {
              if (i >= events.length) { setTimeout(() => process.exit(0), 300); return; }
              this.onmessage({ data: JSON.stringify({ envelope_id: "e" + i, type: "events_api", payload: { event: events[i++] } }) });
              setTimeout(next, 150);
            };
            next();
          }, 10);
        }
        send() {}
        close() {}
      };`);
    const r = spawnSync(NODE, ["--import", preload, LISTENER], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, HOME: dir, OPSBOT_ROOT: repo, OPSBOT_CORE: "/bin/true", OPSBOT_SLACK_AXI: "/bin/true" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`own bot id ${OWN_BOT}`);
    expect(r.stdout).toContain(`dropped app post ${DM} ${ANN} ${APP.bot_id}`);
    expect(r.stdout).not.toContain("private words");
    // The learned bot id makes the user-less post the bot's own: no drop line for it.
    expect(r.stdout).not.toContain(`dropped app post ${OPS_DM}`);
    const recorded = readFileSync(join(dir, "slack-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recorded).toEqual([expect.objectContaining({ key: `slack:${OPS_DM}:${ops.ts}:msg`, from: OPS, kind: "dm" })]);
  });
});

/** A bot repo with an events file recorded from the raw events above. */
function readerSetup(slack: Record<string, unknown> = {}, opts: { noEvents?: boolean } = {}) {
  const dir = tmp();
  const root = join(dir, "repo");
  mkdirSync(root);
  const events = join(dir, "slack-events.jsonl");
  const recorded = "2026-11-10T14:00:00.000Z";
  const mention = classify([MENTION])[0]!;
  const lines = [
    ...classify([DM_TOP, DM_THREADED, MENTION]),
    classify([THREAD_REPLY], BOT, JSON.stringify(mention) + "\n")[0]!,
    classify([REACTION])[0]!,
  ].map((l) => JSON.stringify({ ...l, recorded_at: recorded }));
  // One stale line: recorded well before the window, never reported.
  lines.unshift(JSON.stringify({ ...classify([{ ...DM_TOP, ts: "1700000000.000001" }])[0], recorded_at: "2023-11-14T22:13:20.000Z" }));
  if (!opts.noEvents) writeFileSync(events, lines.join("\n") + "\n");
  writeFileSync(join(root, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { slack: { events_file: events, bot_user: BOT, ...slack } } }));
  const bin = standIn(dir, {
    [`user-${ANN}`]: `workspace: Example (T0EXAMPLE1)\n${table("users", [{ id: ANN, name: "Ann Example", display_name: "ann", kind: "member" }])}\n`,
    "thread-1794400000.000100": `channel: "@ann (${DM})"\nreplies: 1\n${table("messages", [
      { time: "2026-11-10 09:00", author: "Ann Example", text: "can you check the invoice?", ts: "1794400000000100", permalink: "https://example.invalid/p1" },
      { time: "2026-11-10 09:01", author: "examplebot", text: "↳ On it, \"checking\" now, back soon", ts: "1794400050000100", permalink: "https://example.invalid/p2" },
    ])}\n`,
    "thread-1794400200.000300": `channel: "#ops (${CHAN})"\nreplies: 1\n${table("messages", [
      { time: "2026-11-10 09:03", author: "Ann Example", text: "@examplebot what is due this week?", ts: "1794400200000300", permalink: "" },
      { time: "2026-11-10 09:05", author: "Ann Example", text: "↳ also the report", ts: "1794400300000400", permalink: "" },
    ])}\n`,
  });
  const run = () => {
    const r = spawnSync(NODE, [READER], {
      cwd: root, encoding: "utf8",
      env: isolated(bin, { OPSBOT_ROOT: root, OPSBOT_CONFIG: join(root, "opsbot.json"), OPSBOT_NAME: "examplebot", OPSBOT_SINCE: "2026-11-10T13:45:00Z" }),
    });
    return { code: r.status, items: r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)), err: r.stderr };
  };
  return { dir, root, run };
}

describe("heartbeat.d/20-slack-events", () => {
  test("items carry stable keys, kind, from, text, ts and the exact reply address; a stale line is skipped", () => {
    const t = readerSetup();
    const first = t.run();
    expect(first.code).toBe(0);
    expect(first.items.map((i) => i.key)).toEqual([
      `slack:${DM}:1794400000.000100:msg`,
      `slack:${DM}:1794400100.000200:msg`,
      `slack:${CHAN}:1794400200.000300:msg`,
      `slack:${CHAN}:1794400300.000400:msg`,
      `slack:${CHAN}:1794400250.000500:thumbsup:${ANN}`,
    ]);
    expect(t.run().items).toEqual(first.items);
    const [top, threaded, mention, reply, reaction] = first.items;
    expect(top).toMatchObject({ kind: "dm", conv: DM, from: ANN, text: "can you check the invoice?", ts: "1794400000.000100", reply: `${DM} --reply 1794400000.000100` });
    expect(top.thread).toBeUndefined();
    expect(threaded.reply).toBe(`${DM} --reply 1794400000.000100`);
    expect(mention).toMatchObject({ kind: "group", event: "app_mention", reply: `${CHAN} --reply 1794400200.000300` });
    expect(reply.reply).toBe(`${CHAN} --reply 1794400200.000300`);
    expect(reaction).toMatchObject({ kind: "group", reaction: "thumbsup", reply: `${CHAN} --reply 1794400250.000500` });
  });

  test("a threaded item has the thread's context, parsed from slack-axi's table; the sender's Slack profile rides along", () => {
    const t = readerSetup();
    const threaded = t.run().items[1];
    expect(threaded.thread).toEqual({
      n: 2,
      parent: "Ann Example: can you check the invoice?",
      last_mine: 'On it, "checking" now, back soon',
      full: `slack-axi thread ${DM} 1794400000.000100`,
    });
    expect(threaded.from_slack).toEqual({ name: "Ann Example", display_name: "ann", kind: "member" });
    const userCalls = calls(t.dir).filter((c) => c.startsWith("user "));
    expect(userCalls).toEqual([`user ${ANN}`]);
  });

  test("an unresolvable sender is kept as its raw id with a note", () => {
    const t = readerSetup();
    writeFileSync(join(t.dir, "axi", "fail-user"), "");
    const it = t.run().items[0];
    expect(it.from).toBe(ANN);
    expect(it.from_slack).toBeUndefined();
    expect(it.from_note).toContain("do not guess");
  });

  test("sender_lookup unset: nothing is added", () => {
    const t = readerSetup();
    for (const it of t.run().items) expect(it.from_team).toBeUndefined();
  });

  test("sender_lookup set: it gets the sender as JSON once per sender, and its keys merge without overriding", () => {
    const t = readerSetup({ sender_lookup: "bin/team-check" });
    mkdirSync(join(t.root, "bin"));
    writeFileSync(join(t.root, "bin/team-check"), `#!/usr/bin/env bash
cat >> "${t.dir}/lookup-stdin.log"; echo >> "${t.dir}/lookup-stdin.log"
echo '{"from_team": true, "from": "overridden?"}'
`);
    chmodSync(join(t.root, "bin/team-check"), 0o755);
    const r = t.run();
    expect(r.code).toBe(0);
    for (const it of r.items) { expect(it.from_team).toBe(true); expect(it.from).toBe(ANN); }
    const stdin = readFileSync(join(t.dir, "lookup-stdin.log"), "utf8").trim().split("\n");
    expect(stdin).toHaveLength(1);
    expect(JSON.parse(stdin[0]!)).toEqual({ id: ANN, name: "Ann Example", display_name: "ann", kind: "member" });
  });

  test("a failing sender_lookup prints every item and fails the input; a path outside the repo is refused", () => {
    const t = readerSetup({ sender_lookup: "bin/team-check" });
    mkdirSync(join(t.root, "bin"));
    writeFileSync(join(t.root, "bin/team-check"), "#!/usr/bin/env bash\necho 'directory unreachable' >&2; exit 3\n");
    chmodSync(join(t.root, "bin/team-check"), 0o755);
    const r = t.run();
    expect(r.code).toBe(1);
    expect(r.items).toHaveLength(5);
    expect(r.err).toContain("directory unreachable");
    const out = readerSetup({ sender_lookup: "../elsewhere" }).run();
    expect(out.code).toBe(1);
    expect(out.err).toContain("inside the repo");
  });

  test("no events file: non-zero, with the reason", () => {
    const r = readerSetup({}, { noEvents: true }).run();
    expect(r.code).toBe(1);
    expect(r.items).toEqual([]);
    expect(r.err).toContain("no Slack events file");
  });
});

describe("escalate.d/10-slack-dm", () => {
  function sink(slack: Record<string, unknown>, message: string, mode = "mode:\n  workspace: Example (T0EXAMPLE1)\n  mode: bot\n  source: derived from the token (bot)\n") {
    const dir = tmp();
    writeFileSync(join(dir, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { slack } }));
    const bin = standIn(dir, { mode });
    const run = () => spawnSync("bash", [SINK], {
      input: message, encoding: "utf8",
      env: isolated(bin, { OPSBOT_CONFIG: join(dir, "opsbot.json"), OPSBOT_MARK: "🧪" }),
    });
    return { dir, run };
  }

  test("the message is drafted once to escalate_dm with the mark, and sent once", () => {
    const t = sink({ escalate_dm: DM }, "the loop has been quiet for 70 minutes");
    const r = t.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`sent to ${DM}`);
    const c = calls(t.dir);
    expect(c.filter((l) => l.startsWith("draft send"))).toEqual(["draft send d_1a2b3c4d"]);
    expect(c.filter((l) => l.startsWith(`draft ${DM}`))).toHaveLength(1);
    expect(readFileSync(join(t.dir, "drafted.txt"), "utf8")).toBe("🧪 the loop has been quiet for 70 minutes");
  });

  test("a message that already opens with the mark (the core's own) gets no second one", () => {
    const t = sink({ escalate_dm: DM }, "🧪 examplebot has logged no cycle for 70 minutes\nlast cycle 14:00Z");
    expect(t.run().status).toBe(0);
    expect(readFileSync(join(t.dir, "drafted.txt"), "utf8")).toBe("🧪 examplebot has logged no cycle for 70 minutes\nlast cycle 14:00Z");
  });

  test("non-zero, nothing sent: escalate_dm unset, an empty message, not in bot mode, a failed draft, a failed send", () => {
    const unset = sink({}, "x");
    expect(unset.run().status).toBe(1);
    expect(calls(unset.dir)).toEqual([]);
    const empty = sink({ escalate_dm: DM }, "  \n");
    expect(empty.run().status).toBe(1);
    const human = sink({ escalate_dm: DM }, "x", "mode:\n  workspace: Example (T0EXAMPLE1)\n  mode: human\n");
    const h = human.run();
    expect(h.status).toBe(1);
    expect(h.stderr).toContain("bot mode");
    expect(calls(human.dir).some((l) => l.startsWith("draft"))).toBe(false);
    const draft = sink({ escalate_dm: DM }, "x");
    writeFileSync(join(draft.dir, "axi", "fail-draft"), "");
    expect(draft.run().status).toBe(1);
    expect(calls(draft.dir).some((l) => l.startsWith("draft send"))).toBe(false);
    const send = sink({ escalate_dm: DM }, "x");
    writeFileSync(join(send.dir, "axi", "fail-send"), "");
    const s = send.run();
    expect(s.status).toBe(1);
    expect(s.stderr).toContain("stand-in failure for send");
  });
});

/**
 * A slack-axi store holding a fake bot token under HOME, and a fetch stub preloaded into every
 * node process that answers auth.test as `user`: what the status identity row reads.
 */
function fakeIdentity(home: string, env: Record<string, string>, user: string) {
  const store = join(home, ".config", "slack-axi");
  mkdirSync(join(store, "workspaces", "T0EXAMPLE1"), { recursive: true });
  writeFileSync(join(store, "workspaces", "T0EXAMPLE1", "token.json"), JSON.stringify({ token: "xoxb-fake-status-0000", team_id: "T0EXAMPLE1" }));
  const preload = join(home, "fake-auth.mjs");
  writeFileSync(preload, `globalThis.fetch = async (url) => {
    if (!String(url).endsWith("/auth.test")) throw new Error("the stub only answers auth.test");
    return { status: 200, json: async () => ({ ok: true, team_id: "T0EXAMPLE1", user_id: ${JSON.stringify(user)}, user: "examplebot" }) };
  };\n`);
  env.NODE_OPTIONS = `--import ${preload}`;
}

describe("scripts/opsbot-slack", () => {
  function botRepo() {
    const home = tmp();
    const root = join(home, "bot");
    mkdirSync(root);
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "opsbot.json"), JSON.stringify({ name: "examplebot" }, null, 2));
    const bin = standIn(home, { mode: "mode:\n  workspace: Example (T0EXAMPLE1)\n  mode: bot\n", "--version": "1.6.0\n", audience: "usage: slack-axi audience <channel> [flags]\n" });
    writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${home}/systemctl.log"\nif [ -e "${home}/unit-active" ]; then echo active; else echo inactive; exit 3; fi\n`);
    chmodSync(join(bin, "systemctl"), 0o755);
    const env: Record<string, string> = { HOME: home };
    const cli = (...args: string[]) => {
      const r = spawnSync("bash", [CLI, ...args], { cwd: root, encoding: "utf8", env: isolated(bin, env) });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    return { home, root, cli, env };
  }

  test("install --dry-run writes nothing; install writes the three scripts, executable; a second install changes nothing", () => {
    const b = botRepo();
    const dry = b.cli("install", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would write  opsbot.d/monitor.d/10-slack-listener");
    expect(existsSync(join(b.root, "opsbot.d"))).toBe(false);
    const first = b.cli("install");
    expect(first.code).toBe(0);
    for (const p of ["monitor.d/10-slack-listener", "heartbeat.d/20-slack-events", "escalate.d/10-slack-dm"]) {
      const f = join(b.root, "opsbot.d", p);
      expect(readFileSync(f, "utf8")).toBe(readFileSync(join(SKILL, "templates", p), "utf8"));
      expect(statSync(f).mode & 0o111).not.toBe(0);
      expect(first.out).toContain(`wrote        opsbot.d/${p}`);
    }
    expect(first.out).toContain('"events_file": "~/.cache/examplebot/slack-events.jsonl"');
    expect(first.out).toContain('"wake": { "files": ["~/.cache/examplebot/slack-events.jsonl"] }');
    expect(first.out).toContain(join(SKILL, "templates", "manifest.yaml"));
    expect(readFileSync(join(b.root, "opsbot.json"), "utf8")).toBe(JSON.stringify({ name: "examplebot" }, null, 2));
    const second = b.cli("install");
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("wrote");
    expect(second.out.match(/already current/g)).toHaveLength(3);
  });

  test("a changed script is left without --force and replaced with it", () => {
    const b = botRepo();
    b.cli("install");
    const f = join(b.root, "opsbot.d/heartbeat.d/20-slack-events");
    writeFileSync(f, "#!/bin/sh\n# local change\n");
    expect(b.cli("install").out).toContain("left         opsbot.d/heartbeat.d/20-slack-events (differs");
    expect(readFileSync(f, "utf8")).toContain("local change");
    expect(b.cli("install", "--force").out).toContain("replaced     opsbot.d/heartbeat.d/20-slack-events");
    expect(readFileSync(f, "utf8")).toBe(readFileSync(join(SKILL, "templates/heartbeat.d/20-slack-events"), "utf8"));
  });

  test("status: a missing token and a bare install are rows to fix (exit 1); everything in place is all ok (exit 0); the token is never printed", () => {
    const b = botRepo();
    b.cli("install");
    const bare = b.cli("status");
    expect(bare.code).toBe(1);
    expect(bare.out).toMatch(/^missing\s+app-token\s+~\/\.config\/examplebot\/slack-app-token/m);
    expect(bare.out).toMatch(/^ok\s+slack-axi\s+signed in, bot mode/m);
    expect(bare.out).toMatch(/^ok\s+monitor\.d\/10-slack-listener/m);
    expect(bare.out).toMatch(/^missing\s+streams\.slack/m);
    expect(bare.out).toMatch(/^missing\s+wake\.files/m);
    expect(bare.out).toMatch(/^missing\s+listener\s+opsbot-examplebot-monitor-10-slack-listener\.service inactive/m);

    const secret = "xapp-1-FAKE-0000-notarealtoken";
    mkdirSync(join(b.home, ".config/examplebot"), { recursive: true });
    const tf = join(b.home, ".config/examplebot/slack-app-token");
    writeFileSync(tf, secret + "\n");
    chmodSync(tf, 0o644);
    expect(b.cli("status").out).toMatch(/^differs\s+app-token\s+.*mode 644/m);
    chmodSync(tf, 0o600);
    writeFileSync(join(b.root, "opsbot.json"), JSON.stringify({
      name: "examplebot",
      streams: { slack: { bot_user: BOT, escalate_dm: DM } },
      wake: { files: ["~/.cache/examplebot/slack-events.jsonl"] },
    }));
    writeFileSync(join(b.home, "unit-active"), "");
    // The posting identity row (bot_user is set): a stored bot token and a stubbed auth.test.
    fakeIdentity(b.home, b.env, BOT);
    const all = b.cli("status");
    expect(all.out).toMatch(/^ok\s+app-token\s+~\/\.config\/examplebot\/slack-app-token \(600, xapp-\)/m);
    expect(all.out).toContain("status: all 10 ok");
    expect(all.code).toBe(0);
    expect(all.out + all.err).not.toContain("FAKE");
    expect(readFileSync(join(b.home, "systemctl.log"), "utf8")).toContain("--user is-active opsbot-examplebot-monitor-10-slack-listener.service");
  });

  test("status: a user-mode slack-axi and a token that is not xapp- are differs", () => {
    const b = botRepo();
    writeFileSync(join(b.home, "axi", "mode"), "mode:\n  workspace: Example (T0EXAMPLE1)\n  mode: human\n");
    mkdirSync(join(b.home, ".config/examplebot"), { recursive: true });
    writeFileSync(join(b.home, ".config/examplebot/slack-app-token"), "xoxb-wrong-kind\n", { mode: 0o600 });
    const r = b.cli("status");
    expect(r.out).toMatch(/^differs\s+slack-axi\s+signed in, but not in bot mode/m);
    expect(r.out).toMatch(/^differs\s+app-token\s+.*does not hold an app-level/m);
    expect(r.out).not.toContain("wrong-kind");
  });

  test("unknown flags and commands are refused with exit 2; outside a bot repo is exit 2", () => {
    const b = botRepo();
    expect(b.cli("install", "--yes").code).toBe(2);
    expect(b.cli("status", "--verbose").code).toBe(2);
    expect(b.cli("frobnicate").code).toBe(2);
    expect(b.cli().code).toBe(2);
    expect(b.cli("--help").code).toBe(0);
    rmSync(join(b.root, "opsbot.json"));
    expect(b.cli("status").code).toBe(2);
  });
});

/**
 * The running listener with Slack, slack-axi and the core all stubbed: a preload stands in for
 * fetch and the WebSocket and delivers `events` one at a time, then waits `settleMs` and exits;
 * slack-axi is a script that logs its calls and, for `download`, writes a file into --out (or
 * fails for an id starting F0FAIL); the core logs every nudge and says it woke. HOME is the
 * temp dir. Returns what each stub saw.
 */
function runListener(slack: Record<string, unknown>, events: unknown[], opts: { settleMs?: number; setup?: (repo: string, dir: string) => void } = {}) {
  const dir = tmp();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const tf = join(dir, "app-token");
  writeFileSync(tf, "xapp-1-FAKE\n", { mode: 0o600 });
  chmodSync(tf, 0o600);
  writeFileSync(join(repo, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { slack: { app_token_file: tf, events_file: join(dir, "slack-events.jsonl"), bot_user: BOT, ...slack } } }));
  const axi = join(dir, "slack-axi");
  writeFileSync(axi, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/axi.log"
if [ "$1" = download ]; then
  case "$2" in F0FAIL*) echo 'error: "stand-in failure for download"'; exit 1 ;; esac
  out="$4"; mkdir -p "$out"
  [ -e "${dir}/download-big" ] && head -c 4096 /dev/zero > "$out/stand-in-name" && exit 0
  printf 'bytes of %s' "$2" > "$out/stand-in-name"
fi
exit 0
`);
  chmodSync(axi, 0o755);
  const core = join(dir, "core");
  writeFileSync(core, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/core.log"\necho "woke: stand-in"\n`);
  chmodSync(core, 0o755);
  opts.setup?.(repo, dir);
  const preload = join(dir, "fake-slack.mjs");
  writeFileSync(preload, `
    const events = ${JSON.stringify(events)};
    globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: "ws://stand-in" }) });
    globalThis.WebSocket = class {
      constructor() {
        setTimeout(() => {
          this.onopen();
          let i = 0;
          const next = () => {
            if (i >= events.length) { setTimeout(() => process.exit(0), ${opts.settleMs ?? 1500}); return; }
            this.onmessage({ data: JSON.stringify({ envelope_id: "e" + i, type: "events_api", payload: { event: events[i++] } }) });
            setTimeout(next, 150);
          };
          next();
        }, 10);
      }
      send() {}
      close() {}
    };`);
  const r = spawnSync(NODE, ["--import", preload, LISTENER], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, HOME: dir, OPSBOT_ROOT: repo, OPSBOT_CORE: core, OPSBOT_SLACK_AXI: axi },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean) : []);
  return {
    dir, repo, code: r.status, out: r.stdout, err: r.stderr,
    recorded: read("slack-events.jsonl").map((l) => JSON.parse(l)),
    axi: read("axi.log"),
    nudges: read("core.log"),
    read,
  };
}

describe("owner-only listening (listen_to)", () => {
  const OPS = "U0OPS00001";
  const OPS_DM = "D0OPSDM001";
  const ids = { botUser: BOT, operators: [OPS], escalateDm: OPS_DM, listenTo: "operators" };
  const mention = classify([MENTION])[0]!;
  const items = (from: string) => [
    classify([{ ...DM_TOP, user: from }])[0],
    classify([{ ...MENTION, user: from }])[0],
    classify([{ ...THREAD_REPLY, user: from }], BOT, JSON.stringify(mention) + "\n")[0],
    classify([{ ...REACTION, user: from }])[0],
  ];

  test("unset or anyone keeps everyone, as before", () => {
    for (const it of [...items(ANN), classify([{ type: "team_join", user: { id: "U0NEW00001" } }])[0]]) {
      expect(call("heard", [it, { operators: [OPS] }])).toBe(true);
      expect(call("heard", [it, { ...ids, listenTo: "anyone" }])).toBe(true);
    }
    expect(call("settings", [{ name: "examplebot" }])).toMatchObject({ listenTo: "anyone" });
    expect(call("settings", [{ name: "examplebot", streams: { slack: { listen_to: "nobody" } } }])).toMatchObject({ listenTo: "anyone" });
  });

  test("operators: an operator's DM, mention, reply and reaction are kept; anyone's in escalate_dm too", () => {
    for (const it of items(OPS)) expect(call("heard", [it, ids])).toBe(true);
    const inEsc = classify([{ ...DM_TOP, channel: OPS_DM }])[0];
    const reactionInEsc = classify([{ ...REACTION, item: { ...REACTION.item, channel: OPS_DM } }])[0];
    expect(call("heard", [inEsc, { ...ids, operators: [] }])).toBe(true);
    expect(call("heard", [reactionInEsc, { ...ids, operators: [] }])).toBe(true);
  });

  test("operators: a non-operator's DM, mention, kept reply, reaction and a team_join are dropped with one line of ids", () => {
    const join_ = classify([{ type: "team_join", user: { id: "U0NEW00001", real_name: "New Person" }, event_ts: "1794400400.000600" }])[0];
    const all = [...items(ANN), join_];
    for (const it of all) expect(call("heard", [it, ids])).toBe(false);
    expect(all.map((it) => call("droppedNonOperator", [it]))).toEqual([
      `dropped non-operator ${DM} ${ANN} dm`,
      `dropped non-operator ${CHAN} ${ANN} mention`,
      `dropped non-operator ${CHAN} ${ANN} reply`,
      `dropped non-operator ${CHAN} ${ANN} reaction`,
      "dropped non-operator - U0NEW00001 team_join",
    ]);
    // No operators and no escalate_dm: nothing is heard.
    expect(call("heard", [items(OPS)[0], { listenTo: "operators" }])).toBe(false);
  });

  test("the running listener drops a non-operator's DM silently and still receipts an operator's", () => {
    const now = Math.floor(Date.now() / 1000);
    const stranger = { ...DM_TOP, text: "private words", ts: `${now}.000100` };
    const owner = { ...DM_TOP, channel: OPS_DM, user: OPS, ts: `${now}.000200` };
    const r = runListener({ listen_to: "operators", operators: [OPS] }, [stranger, owner]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`dropped non-operator ${DM} ${ANN} dm`);
    expect(r.out).not.toContain("private words");
    expect(r.recorded.map((l) => l.key)).toEqual([`slack:${OPS_DM}:${owner.ts}:msg`]);
    expect(r.axi.filter((l) => l.includes(stranger.ts))).toEqual([]);
    expect(r.axi).toContain(`react ${OPS_DM} ${owner.ts} :eyes:`);
    expect(r.nudges).toHaveLength(1);
  });

  test("operators with no operators and no escalate_dm is said at start", () => {
    const r = runListener({ listen_to: "operators" }, [], { settleMs: 100 });
    expect(r.out).toContain("every event will be dropped");
  });
});

describe("the intercept", () => {
  const root = "/srv/examplebot";
  const rules = (raw: unknown) => call("interceptRules", [raw, root]) as { rules: any[]; problems: string[] };

  test("rules: defaults, a repo path or an absolute one, and a problem line for each unusable rule", () => {
    const ok = rules([{ prefix: "+ ", command: ["bin/capture", "--x"] }, { prefix: "!", command: ["/usr/local/bin/note"], kinds: ["mention", "reply"], timeout_seconds: 5 }]);
    expect(ok.problems).toEqual([]);
    expect(ok.rules).toEqual([
      { n: 1, prefix: "+ ", argv: [`${root}/bin/capture`, "--x"], kinds: ["dm"], timeoutMs: 30000 },
      { n: 2, prefix: "!", argv: ["/usr/local/bin/note"], kinds: ["mention", "reply"], timeoutMs: 5000 },
    ]);
    const bad = rules([{ command: ["bin/x"] }, { prefix: "+", command: "bin/x --y" }, { prefix: "+", command: ["../outside"] }, { prefix: "+", command: ["bin/x"], kinds: ["reaction"] }, { prefix: "+", command: ["bin/x"], timeout_seconds: 0 }]);
    expect(bad.rules).toEqual([]);
    expect(bad.problems).toEqual([
      "rule 1: prefix must be a non-empty string",
      "rule 2: command must be a non-empty list of strings",
      "rule 3: command must be a path inside the repo or absolute: ../outside",
      "rule 4: kinds must be a list of dm, mention, reply",
      "rule 5: timeout_seconds must be a positive number",
    ]);
    expect(rules({ prefix: "+" }).problems).toEqual(["intercept must be a list of rules"]);
    expect(rules(undefined)).toEqual({ rules: [], problems: [] });
  });

  test("matching: leading whitespace trimmed, a leading mention stripped, exact case-sensitive prefix, first rule wins, kinds respected", () => {
    const { rules: rs } = rules([{ prefix: "+ ", command: ["bin/a"], kinds: ["dm", "mention"] }, { prefix: "+", command: ["bin/b"], kinds: ["dm"] }, { prefix: "todo:", command: ["bin/c"], kinds: ["reply"] }]);
    const match = (it: unknown) => call("matchIntercept", [it, rs, BOT]) as { rule: { n: number }; text: string } | null;
    const dm = (text: string) => classify([{ ...DM_TOP, text }])[0];
    expect(match(dm("  \n+ buy milk"))).toMatchObject({ rule: { n: 1 }, text: "buy milk" });
    expect(match(dm("+buy milk"))).toMatchObject({ rule: { n: 2 }, text: "buy milk" });
    expect(match(dm("buy milk +"))).toBeNull();
    expect(match(classify([{ ...MENTION, text: `<@${BOT}>   + call the vendor` }])[0])).toMatchObject({ rule: { n: 1 }, text: "call the vendor" });
    const recorded = JSON.stringify(classify([MENTION])[0]) + "\n";
    expect(match(classify([{ ...THREAD_REPLY, text: "todo: the report" }], BOT, recorded)[0])).toMatchObject({ rule: { n: 3 }, text: " the report" });
    expect(match(classify([{ ...THREAD_REPLY, text: "TODO: the report" }], BOT, recorded)[0])).toBeNull();
    expect(match(classify([{ ...THREAD_REPLY, text: "+ x" }], BOT, recorded)[0])).toBeNull(); // no rule takes replies with +
    expect(match({ ...classify([REACTION])[0], text: "+ " })).toBeNull();
  });

  test("success: the command gets the message as JSON, nothing is recorded, its own reaction, no receipt, no wake", () => {
    const now = Math.floor(Date.now() / 1000);
    const ev = { ...DM_TOP, text: " + buy oat milk", ts: `${now}.000100` };
    const r = runListener({ intercept: [{ prefix: "+ ", command: ["bin/capture"] }] }, [ev], {
      setup: (repo, dir) => {
        mkdirSync(join(repo, "bin"));
        writeFileSync(join(repo, "bin/capture"), `#!/usr/bin/env bash\ncat >> "${dir}/capture.log"; echo >> "${dir}/capture.log"\necho "printed to stdout, ignored"\n`);
        chmodSync(join(repo, "bin/capture"), 0o755);
      },
    });
    expect(r.code).toBe(0);
    expect(r.read("capture.log").map((l) => JSON.parse(l))).toEqual([{ text: "buy oat milk", conv: DM, ts: ev.ts, thread_ts: null, user: ANN, files: [] }]);
    expect(r.recorded).toEqual([]);
    expect(r.axi).toEqual([`react ${DM} ${ev.ts} :white_check_mark:`]);
    expect(r.nudges).toEqual([]);
    expect(r.out).toContain(`intercepted ${DM} ${ev.ts} ${ANN} rule 1`);
    expect(r.out).not.toContain("oat milk");
  });

  test("failure: a non-zero exit and a timeout record the message, marked, with the failure reaction, the receipt and a wake", () => {
    const now = Math.floor(Date.now() / 1000);
    const a = { ...DM_TOP, text: "+ this one fails", ts: `${now}.000100` };
    const b = { ...DM_TOP, text: "! this one hangs", ts: `${now}.000200` };
    const r = runListener({
      intercept: [{ prefix: "+ ", command: ["bin/fail"] }, { prefix: "! ", command: ["bin/hang"], timeout_seconds: 1 }],
      intercept_emoji: "inbox_tray", intercept_failed_emoji: "x",
    }, [a, b], {
      settleMs: 2500,
      setup: (repo) => {
        mkdirSync(join(repo, "bin"));
        writeFileSync(join(repo, "bin/fail"), "#!/usr/bin/env bash\ncat >/dev/null; echo 'secret echo' >&2; exit 3\n");
        writeFileSync(join(repo, "bin/hang"), "#!/usr/bin/env bash\nsleep 10\n");
        chmodSync(join(repo, "bin/fail"), 0o755);
        chmodSync(join(repo, "bin/hang"), 0o755);
      },
    });
    expect(r.code).toBe(0);
    const byTs = Object.fromEntries(r.recorded.map((l) => [l.ts, l]));
    expect(byTs[a.ts]).toMatchObject({ key: `slack:${DM}:${a.ts}:msg`, text: "+ this one fails", intercept: "failed: exit 3" });
    expect(byTs[b.ts]).toMatchObject({ intercept: "failed: timed out after 1 s" });
    for (const ts of [a.ts, b.ts]) {
      const reacts = r.axi.filter((l) => l.includes(ts));
      expect(reacts).toEqual([`react ${DM} ${ts} :x:`, `react ${DM} ${ts} :eyes:`]);
    }
    expect(r.nudges).toHaveLength(2);
    expect(r.out).toContain(`intercept failed ${DM} ${a.ts} ${ANN} rule 1: exit 3`);
    expect(r.out).not.toContain("secret echo");
  });

  test("a command that cannot start fails like any other; a bad rule is logged at start and never matches", () => {
    const now = Math.floor(Date.now() / 1000);
    const ev = { ...DM_TOP, text: "+ x", ts: `${now}.000100` };
    const r = runListener({ intercept: [{ prefix: "+ ", command: ["../escape"] }, { prefix: "+ ", command: ["bin/missing"] }] }, [ev]);
    expect(r.out).toContain("intercept rule 1: command must be a path inside the repo or absolute: ../escape");
    expect(r.recorded).toEqual([expect.objectContaining({ ts: ev.ts, intercept: "failed: ENOENT" })]);
  });
});

describe("files", () => {
  const PNG = { id: "F0PNG00001", name: "../../evil.png", mimetype: "image/png", size: 10 };

  test("file metadata is recorded on a message whatever the settings; a message without files has none", () => {
    const [withFiles, without] = classify([{ ...DM_TOP, subtype: "file_share", files: [{ ...PNG, url_private_download: "https://files.example.invalid/x", filetype: "png" }, { id: "F0CONN0001", mode: "file_access", file_access: "check_file_info" }] }, DM_TOP]);
    expect(withFiles!.files).toEqual([PNG, { id: "F0CONN0001", file_access: "check_file_info" }]);
    expect(without).not.toHaveProperty("files");
  });

  test("names are made safe, types and sizes decided before any download", () => {
    expect(["../../evil.png", "a\\b\\c.txt", "..", ".hidden", "ok name.pdf", "x\u0000y\n.png", ""].map((n) => call("safeFileName", [n, "F0ID000001"]))).toEqual(["evil.png", "c.txt", "F0ID000001", "hidden", "ok name.pdf", "xy.png", "F0ID000001"]);
    const item = { conv: DM, ts: "1794400000.000100" };
    const skip = (f: unknown, cfg = {}) => call("fileSkip", [f, item, cfg]);
    expect(skip(PNG)).toBeNull();
    expect(skip({ ...PNG, mimetype: "application/zip" })).toBe("type application/zip not allowed");
    expect(skip({ ...PNG, size: 26214401 })).toBe("26214401 bytes, over max_bytes 26214400");
    expect(skip({ ...PNG, size: 11 }, { maxBytes: 10 })).toBe("11 bytes, over max_bytes 10");
    expect(skip({ id: "F0CONN0001", file_access: "check_file_info" })).toBe("no type or size in the event");
    expect(skip({ ...PNG, id: "../x" })).toBe("unsafe file id");
    expect(call("fileSkip", [PNG, { conv: "../D0", ts: "1" }, {}])).toBe("unsafe conversation or ts");
    expect(call("allowedType", ["TEXT/plain", ["text/*"]])).toBe(true);
    expect(call("allowedType", ["application/pdf", ["application/pdf"]])).toBe(true);
    expect(call("allowedType", ["application/pdfx", ["application/pdf"]])).toBe(false);
  });

  test("save on: an allowed file is saved under its safe name inside dir; oversize, wrong type, failed and Slack Connect files are skipped", () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = `${now}.000100`;
    const ev = {
      ...DM_TOP, subtype: "file_share", ts, files: [
        PNG,
        { id: "F0BIG00001", name: "huge.png", mimetype: "image/png", size: 30000000 },
        { id: "F0ZIP00001", name: "a.zip", mimetype: "application/zip", size: 10 },
        { id: "F0FAIL0001", name: "gone.pdf", mimetype: "application/pdf", size: 10 },
        { id: "F0CONN0001", file_access: "check_file_info" },
      ],
    };
    const r = runListener({ files: { save: true } }, [ev]);
    expect(r.code).toBe(0);
    const [line] = r.recorded;
    const saved = join(r.repo, ".scratch/slack-files", DM, ts, "evil.png");
    expect(line.files).toEqual([
      { ...PNG, path: saved },
      { id: "F0BIG00001", name: "huge.png", mimetype: "image/png", size: 30000000, skipped: "30000000 bytes, over max_bytes 26214400" },
      { id: "F0ZIP00001", name: "a.zip", mimetype: "application/zip", size: 10, skipped: "type application/zip not allowed" },
      { id: "F0FAIL0001", name: "gone.pdf", mimetype: "application/pdf", size: 10, skipped: "download failed: stand-in failure for download" },
      { id: "F0CONN0001", file_access: "check_file_info", skipped: "no type or size in the event" },
    ]);
    expect(readFileSync(saved, "utf8")).toBe("bytes of F0PNG00001");
    // Only the two allowed files were asked for; nothing else was written next to them.
    expect(r.axi.filter((l) => l.startsWith("download")).map((l) => l.split(" ")[1])).toEqual(["F0PNG00001", "F0FAIL0001"]);
    expect(spawnSync("ls", ["-A", join(r.repo, ".scratch/slack-files", DM, ts)], { encoding: "utf8" }).stdout.trim()).toBe("evil.png");
    expect(existsSync(join(r.dir, "evil.png"))).toBe(false);
    // The receipt still lands, after the downloads.
    expect(r.axi[r.axi.length - 1]).toBe(`react ${DM} ${ts} :eyes:`);
  });

  test("a download larger than max_bytes is deleted and skipped; a taken name gets the id in front", () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = `${now}.000100`;
    const r = runListener({ files: { save: true, dir: "/dev/null/nowhere", max_bytes: 100 } }, [{ ...DM_TOP, ts, files: [PNG] }]);
    expect(r.recorded[0].files[0].skipped).toMatch(/^save failed: /);
    const big = runListener({ files: { save: true, max_bytes: 100 } }, [{ ...DM_TOP, ts, files: [PNG] }], { setup: (_repo, dir) => writeFileSync(join(dir, "download-big"), "") });
    expect(big.recorded[0].files[0]).toMatchObject({ skipped: "4096 bytes, over max_bytes 100" });
    expect(spawnSync("ls", ["-A", join(big.repo, ".scratch/slack-files", DM, ts)], { encoding: "utf8" }).stdout.trim()).toBe("");
    const taken = runListener({ files: { save: true } }, [{ ...DM_TOP, ts, files: [PNG] }], {
      setup: (repo) => { mkdirSync(join(repo, ".scratch/slack-files", DM, ts), { recursive: true }); writeFileSync(join(repo, ".scratch/slack-files", DM, ts, "evil.png"), "older"); },
    });
    expect(taken.recorded[0].files[0].path).toBe(join(taken.repo, ".scratch/slack-files", DM, ts, "F0PNG00001-evil.png"));
  });

  test("a link out of dir is never followed", () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = `${now}.000100`;
    const r = runListener({ files: { save: true } }, [{ ...DM_TOP, ts, files: [PNG] }], {
      setup: (repo, dir) => { mkdirSync(join(repo, ".scratch/slack-files"), { recursive: true }); mkdirSync(join(dir, "elsewhere")); symlinkSync(join(dir, "elsewhere"), join(repo, ".scratch/slack-files", DM)); },
    });
    expect(r.recorded[0].files[0]).toMatchObject({ skipped: "outside the files dir" });
    expect(r.axi.some((l) => l.startsWith("download"))).toBe(false);
  });

  test("save off: metadata only, no download", () => {
    const now = Math.floor(Date.now() / 1000);
    const r = runListener({}, [{ ...DM_TOP, ts: `${now}.000100`, files: [PNG] }]);
    expect(r.recorded[0].files).toEqual([PNG]);
    expect(r.axi.some((l) => l.startsWith("download"))).toBe(false);
  });

  test("with an intercept, the command gets the saved files", () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = `${now}.000100`;
    const r = runListener({ files: { save: true }, intercept: [{ prefix: "+ ", command: ["bin/capture"] }] }, [{ ...DM_TOP, text: "+ receipt", ts, files: [PNG] }], {
      setup: (repo, dir) => {
        mkdirSync(join(repo, "bin"));
        writeFileSync(join(repo, "bin/capture"), `#!/usr/bin/env bash\ncat > "${dir}/capture.json"\n`);
        chmodSync(join(repo, "bin/capture"), 0o755);
      },
    });
    const got = JSON.parse(readFileSync(join(r.dir, "capture.json"), "utf8"));
    expect(got).toMatchObject({ text: "receipt", files: [{ ...PNG, path: join(r.repo, ".scratch/slack-files", DM, ts, "evil.png") }] });
    expect(r.recorded).toEqual([]);
  });

  test("the reader passes files and intercept through", () => {
    const t = readerSetup();
    const ev = join(t.dir, "slack-events.jsonl");
    const line = { ...classify([{ ...DM_TOP, ts: "1794400900.000900", files: [PNG] }])[0], intercept: "failed: exit 3", recorded_at: "2026-11-10T14:00:00.000Z" };
    (line as any).files[0].path = "/srv/examplebot/.scratch/slack-files/x.png";
    writeFileSync(ev, readFileSync(ev, "utf8") + JSON.stringify(line) + "\n");
    const it = t.run().items.find((i) => i.ts === "1794400900.000900");
    expect(it).toMatchObject({ files: [{ ...PNG, path: "/srv/examplebot/.scratch/slack-files/x.png" }], intercept: "failed: exit 3" });
    expect(t.run().items[0]).not.toHaveProperty("files");
  });
});

describe("status: listen_to, intercept and files rows", () => {
  function repoWith(slack: Record<string, unknown>) {
    const home = tmp();
    const root = join(home, "bot");
    mkdirSync(root);
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { slack } }));
    const bin = standIn(home, { mode: "mode:\n  workspace: Example (T0EXAMPLE1)\n  mode: bot\n" });
    const r = spawnSync("bash", [CLI, "status"], { cwd: root, encoding: "utf8", env: isolated(bin, { HOME: home }) });
    return { root, out: r.stdout, code: r.status };
  }

  test("none set: no rows", () => {
    const r = repoWith({ escalate_dm: DM });
    expect(r.out).not.toMatch(/^\S+\s+(listen_to|intercept|files)\s/m);
  });

  test("listen_to operators with no operators and no escalate_dm, or an unknown value, is differs; with one it is ok", () => {
    expect(repoWith({ listen_to: "operators" }).out).toMatch(/^differs\s+listen_to\s+operators, but neither operators nor escalate_dm is set/m);
    expect(repoWith({ listen_to: "owner" }).out).toMatch(/^differs\s+listen_to\s+"owner" is neither/m);
    const ok = repoWith({ listen_to: "operators", operators: ["U0OPS00001"], escalate_dm: DM });
    expect(ok.out).toMatch(new RegExp(`^ok\\s+listen_to\\s+operators: U0OPS00001, and anyone in ${DM}`, "m"));
  });

  test("intercept: usable rules are ok and say who can trigger them; a missing command is differs", () => {
    const r = repoWith({ intercept: [{ prefix: "+ ", command: ["/bin/true"] }], files: { save: true, types: ["image/*"] } });
    expect(r.out).toMatch(/^ok\s+intercept\s+1 rule; anyone who can message the bot can trigger them/m);
    expect(r.out).toMatch(/^ok\s+files\s+saving image\/\* up to 26214400 bytes to \.scratch\/slack-files/m);
    const bad = repoWith({ listen_to: "operators", operators: ["U0OPS00001"], intercept: [{ prefix: "+ ", command: ["bin/nope"] }], files: { max_bytes: -1 } });
    expect(bad.out).toMatch(/^differs\s+intercept\s+rule 1: command is not an executable file: .*bin\/nope/m);
    expect(bad.out).toMatch(/^differs\s+files\s+max_bytes must be a positive number/m);
    expect(bad.code).toBe(1);
  });
});

describe("templates/manifest.yaml", () => {
  const m = Bun.YAML.parse(readFileSync(join(SKILL, "templates/manifest.yaml"), "utf8")) as any;

  test("parses, has Socket Mode on, and asks for no email scope", () => {
    expect(m.settings.socket_mode_enabled).toBe(true);
    const scopes: string[] = m.oauth_config.scopes.bot;
    expect(scopes).not.toContain("users:read.email");
    for (const s of ["app_mentions:read", "chat:write", "im:history", "reactions:write", "users:read"]) expect(scopes).toContain(s);
    expect(m.settings.event_subscriptions.bot_events).toEqual(["app_mention", "message.im", "message.channels", "message.groups", "message.mpim", "reaction_added", "team_join"]);
  });

  test("every scope line carries a comment saying why", () => {
    const lines = readFileSync(join(SKILL, "templates/manifest.yaml"), "utf8").split("\n").filter((l) => /^\s+- [a-z_.:]+/.test(l));
    for (const l of lines) expect(l).toContain("#");
  });
});
