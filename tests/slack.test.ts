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

describe("scripts/opsbot-slack", () => {
  function botRepo() {
    const home = tmp();
    const root = join(home, "bot");
    mkdirSync(root);
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "opsbot.json"), JSON.stringify({ name: "examplebot" }, null, 2));
    const bin = standIn(home, { mode: "mode:\n  workspace: Example (T0EXAMPLE1)\n  mode: bot\n" });
    writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${home}/systemctl.log"\nif [ -e "${home}/unit-active" ]; then echo active; else echo inactive; exit 3; fi\n`);
    chmodSync(join(bin, "systemctl"), 0o755);
    const cli = (...args: string[]) => {
      const r = spawnSync("bash", [CLI, ...args], { cwd: root, encoding: "utf8", env: isolated(bin, { HOME: home }) });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    return { home, root, cli };
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
    const all = b.cli("status");
    expect(all.out).toMatch(/^ok\s+app-token\s+~\/\.config\/examplebot\/slack-app-token \(600, xapp-\)/m);
    expect(all.out).toContain("status: all 8 ok");
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
