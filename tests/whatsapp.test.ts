/**
 * opsbot-whatsapp: the reader, the post command (classes, loop guard, screen, decision log), the
 * waker, the escalation sink, install and status. whatsapp-axi is a stand-in script on the tests'
 * PATH (and named by OPSBOT_WHATSAPP_AXI) that serves canned JSON in the shapes of whatsapp-axi's
 * specs and records its calls; the core and systemctl are stand-ins too. HOME and PATH point into
 * a temp dir: no daemon, no account, no network, no real tool.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SKILL = resolve(import.meta.dir, "..", "skills", "opsbot-whatsapp");
const CLI = join(SKILL, "scripts/opsbot-whatsapp");
const READER = join(SKILL, "templates/heartbeat.d/25-whatsapp-events");
const WAKER = join(SKILL, "templates/monitor.d/20-whatsapp-waker");
const SINK = join(SKILL, "templates/escalate.d/20-whatsapp-dm");
const NODE = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();

setDefaultTimeout(30000);

// Invented ids throughout.
const ACCOUNT = "examplebot";
const BOT = { id: "100000000000000@lid", lid: "100000000000000@lid", pn: "+15550100000", name: "Example bot", me: true, operator: false };
const OPER = { id: "100000000000001@lid", lid: "100000000000001@lid", pn: "+15550100001", name: "Sam", me: false, operator: true };
const ANN = { id: "100000000000002@lid", lid: "100000000000002@lid", pn: "+15550100002", name: "Ann", me: false, operator: false, contact: true };
const EXT = { id: "100000000000003@lid", lid: "100000000000003@lid", pn: "+15550100003", name: "Alex", me: false, operator: false, contact: true };
const PEER = { id: "100000000000009@lid", lid: "100000000000009@lid", pn: "+15550100009", name: "Other bot", me: false, operator: false };
const HIDDEN = { id: "100000000000007@lid", lid: "100000000000007@lid", name: "", me: false, operator: false };
const G_INT = "120363000000000001@g.us"; // the bot, an operator and a trusted number
const G_EXT = "120363000000000002@g.us"; // someone outside
const G_PEER = "120363000000000003@g.us"; // the bot, an operator and a peer
const G_HID = "120363000000000004@g.us"; // a member known only by hidden id
const G_DOWN = "120363000000000005@g.us"; // the daemon is not connected
const DM_OPER = OPER.id;
const DM_ANN = ANN.id;
const DM_EXT = EXT.id;
const MARKER = "SECRET-MARKER-7f3a"; // message text that must never leave stdout

const SETTINGS = { account: ACCOUNT, operators: [OPER.pn], escalate_chat: OPER.pn, trusted: [ANN.pn] };

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

type Answer = { code: number; out: unknown; nofile?: boolean };
const err = (code: string, message: string, extra: Record<string, unknown> = {}): Answer => ({ code: 1, out: { error: { code, message, ...extra } } });
const ok = (out: unknown): Answer => ({ code: 0, out });
/** A `doctor --account <a> --json-out` file: the given checks for the account, the rest ok, the hooks row (all). */
const doctorFile = (rows: [string, string, string][], account = ACCOUNT) => {
  const names = ["files", "service", "lingering", "binary", "daemon", "versions", "link", "state", "phone", "wake_file"];
  const given = new Map(rows.map(([c, st, d]) => [c, { status: st, detail: d }]));
  const checks = names.map((check) => ({ account, check, ...(given.get(check) ?? { status: "ok", detail: "ok" }) }));
  checks.push({ account: "(all)", check: "hooks", status: "fail", detail: "no session hook installed" }); // never this bot's
  const failed = checks.filter((c) => c.status === "fail").length;
  return { account, summary: failed ? `${failed} failed` : "all checks passed", checks };
};
const chatView = (id: string, type: "group" | "direct", participants: unknown[], name = "Chat") => ok({ chat: { id, name, type, scope: "tagged", participants } });

/** The default canned answers, by command line without --account and --json. */
function fixtures(): Record<string, Answer> {
  return {
    [`daemon status ${ACCOUNT}`]: ok({ account: ACCOUNT, service: { unit: `whatsapp-axi@${ACCOUNT}.service`, installed: true, enabled: "enabled", active: "active", sub: "running" }, daemon: { state: "connected", since: "2030-01-05T14:00:00Z", version: "0.2.0" } }),
    "settings show": ok({ settings: { scope: "tagged", dm_from: "operators", chats: { [G_PEER]: "full" }, operators: [OPER.pn], wake_file: "WAKE", read_receipts: "on-read" }, effective_retain_days: 90 }),
    doctor: ok(doctorFile([["state", "ok", "connected"]])),
    groups: ok({ groups: [{ id: G_INT, name: "Ops", scope: "tagged", members: 3 }, { id: G_PEER, name: "Bots", scope: "full", members: 3 }] }),
    [`chat view ${G_INT}`]: chatView(G_INT, "group", [BOT, OPER, ANN], "Ops"),
    [`chat view ${G_EXT}`]: chatView(G_EXT, "group", [BOT, OPER, EXT], "Mixed"),
    [`chat view ${G_PEER}`]: chatView(G_PEER, "group", [BOT, OPER, PEER], "Bots"),
    [`chat view ${G_HID}`]: chatView(G_HID, "group", [BOT, OPER, HIDDEN], "Hidden"),
    [`chat view ${G_DOWN}`]: err("NOT_CONNECTED", "The account is not connected to WhatsApp.", { state: "connecting" }),
    [`chat view ${DM_OPER}`]: chatView(DM_OPER, "direct", [OPER], "Sam"),
    [`chat view ${OPER.pn}`]: chatView(DM_OPER, "direct", [OPER], "Sam"),
    [`chat view ${DM_ANN}`]: chatView(DM_ANN, "direct", [BOT, ANN], "Ann"),
    [`chat view ${DM_EXT}`]: chatView(DM_EXT, "direct", [EXT], "Alex"),
    [`read ${G_PEER}`]: ok({ chat: { id: G_PEER, type: "group", name: "Bots" }, messages: [], more: false }),
  };
}

const STUB = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const dir = process.env.WA_STUB_DIR;
const raw = process.argv.slice(2);
const outArg = raw.find((a) => a.startsWith("--json-out="));
const out = outArg ? outArg.slice("--json-out=".length) : undefined;
const argv = raw.map((a) => (a.startsWith("--json-out=") ? "--json-out" : a));
const stdin = argv.includes("-") ? readFileSync(0, "utf8") : undefined;
appendFileSync(dir + "/calls.jsonl", JSON.stringify({ argv, ...(stdin !== undefined ? { stdin } : {}), ...(out ? { out, outDirMode: statSync(dirname(out)).mode & 0o777 } : {}) }) + "\\n");
if (argv[0] === "--version") { console.log(existsSync(dir + "/version") ? readFileSync(dir + "/version", "utf8").trim() : "0.2.0"); process.exit(0); }
const fx = JSON.parse(readFileSync(dir + "/fixtures.json", "utf8"));
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--json-out") continue;
  if (argv[i] === "--account") { i++; continue; }
  args.push(argv[i]);
}
// the TOON view on stdout, which the scripts must not read; the body goes to the --json-out file
const say = (r) => {
  if (out && !r.nofile) writeFileSync(out, JSON.stringify(r.out), { mode: 0o600 });
  console.log("view: TOON stand-in, not JSON");
  if (out && !r.nofile) console.log("wrote: " + out + " (the daemon's response)");
  process.exit(r.code);
};
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
if (args[0] === "events") {
  if (existsSync(dir + "/events-error.json")) say({ code: 1, out: JSON.parse(readFileSync(dir + "/events-error.json", "utf8")) });
  const all = existsSync(dir + "/events.json") ? JSON.parse(readFileSync(dir + "/events.json", "utf8")) : [];
  const limit = Number(flag("--limit") ?? 100);
  const after = flag("--after");
  const list = after === undefined ? all.slice(-limit) : all.filter((e) => e.seq > Number(after)).slice(0, limit);
  say({ code: 0, out: { events: list, latest_seq: all.length ? all[all.length - 1].seq : 0, ...(after !== undefined ? { after: Number(after) } : {}) } });
}
if (args[0] === "send" || args[0] === "send-file") {
  if (existsSync(dir + "/send-error.json")) say({ code: 1, out: JSON.parse(readFileSync(dir + "/send-error.json", "utf8")) });
  if (existsSync(dir + "/send-answer.json")) say({ code: 0, out: JSON.parse(readFileSync(dir + "/send-answer.json", "utf8")) });
  say({ code: 0, out: { id: "3EB0SENT0000000000001", chat: args[1], t: "2030-01-05T14:05:00Z", ...(args[0] === "send-file" ? { media: { type: "document", mime: "application/pdf", name: "report.pdf", size: 17 } } : {}) } });
}
if (args[0] === "mark-read") {
  // mark-fail holds a count: that many answers report failed 1 (HTTP 200, CLI exit 1), then they mark
  const left = existsSync(dir + "/mark-fail") ? Number(readFileSync(dir + "/mark-fail", "utf8")) : 0;
  if (left > 0) { writeFileSync(dir + "/mark-fail", String(left - 1)); say({ code: 1, out: { chat: args[1].split("/")[0], marked: 0, already_marked: 0, failed: 1, reason: "not connected", read_receipts: "on-read" } }); }
  say({ code: 0, out: { chat: args[1].split("/")[0], marked: 1, already_marked: 0, failed: 0, read_receipts: "on-read" } });
}
const key = args[0] === "read" ? args.slice(0, 2).join(" ") : args.join(" ");
if (fx[key]) say(fx[key]);
if (args[0] === "message" && args[1] === "view") say({ code: 1, out: { error: { code: "NOT_FOUND", message: "No such message." } } });
say({ code: 2, out: { error: { code: "VALIDATION_ERROR", message: "no canned answer for " + key } } });
`;

/** A throwaway bot repo with the stand-ins; whatsapp settings merged over SETTINGS. */
function bot(whatsapp: Record<string, unknown> = {}, opts: { fixtures?: Record<string, Answer>; escalate?: boolean; noWakeFiles?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-whatsapp-test-"));
  dirs.push(dir);
  const root = join(dir, "bot");
  mkdirSync(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  const wake = join(dir, "cache", "whatsapp-wake.jsonl");
  const settings = { name: "examplebot", mark: "🧪", streams: { whatsapp: { wake_file: wake, ...SETTINGS, ...whatsapp } }, ...(opts.noWakeFiles ? {} : { wake: { files: [wake] } }) };
  writeFileSync(join(root, "opsbot.json"), JSON.stringify(settings, null, 2));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "screen"), SCREEN);
  chmodSync(join(root, "bin", "screen"), 0o755);
  mkdirSync(join(root, "policy"));
  writeFileSync(join(root, "policy", "trusted.md"), "- no personal information\n");
  writeFileSync(join(root, "policy", "external.md"), "- no prices\n");
  if (opts.escalate !== false) {
    mkdirSync(join(root, "opsbot.d", "escalate.d"), { recursive: true });
    writeFileSync(join(root, "opsbot.d", "escalate.d", "10-test"), `#!/usr/bin/env bash\n[ -e "${dir}/escalate-fail" ] && exit 1\n{ cat; echo "---"; } >> "${dir}/escalations.log"\n`);
    chmodSync(join(root, "opsbot.d", "escalate.d", "10-test"), 0o755);
  }
  const bin = join(dir, "pathbin");
  mkdirSync(bin);
  writeFileSync(join(bin, "whatsapp-axi"), STUB);
  chmodSync(join(bin, "whatsapp-axi"), 0o755);
  writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\nif [ -e "${dir}/unit-active" ]; then echo active; else echo inactive; exit 3; fi\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  symlinkSync(NODE, join(bin, "node"));
  const fx = { ...fixtures(), ...(opts.fixtures ?? {}) };
  // the account's wake_file is this bot's unless a test says otherwise
  const s = fx["settings show"] as { out: { settings?: { wake_file?: string } } };
  if (s?.out?.settings?.wake_file === "WAKE") s.out.settings.wake_file = wake;
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify(fx));
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: dir, OPSBOT_WHATSAPP_AXI: join(bin, "whatsapp-axi"), WA_STUB_DIR: dir, TEST_DIR: dir,
    OPSBOT_ROOT: root,
  };
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
  const runCli = (args: string[], o: { input?: string; env?: Record<string, string> } = {}) => {
    const r = spawnSync("bash", [CLI, ...args], { cwd: root, encoding: "utf8", input: o.input ?? "", env: { ...env, ...(o.env ?? {}) }, timeout: 30000 });
    let json: Record<string, any> = {};
    try { json = JSON.parse(r.stdout.trim().split("\n").pop() || "{}"); } catch { json = {}; }
    return { code: r.status, out: r.stdout, err: r.stderr, json };
  };
  const reader = (o: { env?: Record<string, string> } = {}) => {
    const r = spawnSync(NODE, [READER], { cwd: root, encoding: "utf8", env: { ...env, ...(o.env ?? {}) }, timeout: 30000 });
    return { code: r.status, out: r.stdout, err: r.stderr, items: r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  };
  return {
    dir, root, env, wake, run: runCli, reader,
    setEvents: (evs: unknown[]) => writeFileSync(join(dir, "events.json"), JSON.stringify(evs)),
    setFixture: (k: string, v: Answer) => {
      const cur = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8"));
      cur[k] = v;
      writeFileSync(join(dir, "fixtures.json"), JSON.stringify(cur));
    },
    calls: () => lines(join(dir, "calls.jsonl")).map((l) => { const { out: _o, outDirMode: _m, ...c } = JSON.parse(l); return c; }) as { argv: string[]; stdin?: string }[],
    outs: () => lines(join(dir, "calls.jsonl")).map((l) => JSON.parse(l)).filter((c) => c.out) as { argv: string[]; out: string; outDirMode: number }[],
    log: () => lines(join(root, "logs/whatsapp-posts.jsonl")).map((l) => JSON.parse(l)),
    screens: () => lines(join(dir, "screen-calls.jsonl")).map((l) => JSON.parse(l)),
    escalations: () => (existsSync(join(dir, "escalations.log")) ? readFileSync(join(dir, "escalations.log"), "utf8").split("---\n").filter((s) => s.trim()) : []),
    mode: (m: string) => writeFileSync(join(dir, "screen-mode"), m),
    cursor: () => (existsSync(join(dir, "cache", "whatsapp-cursor")) ? readFileSync(join(dir, "cache", "whatsapp-cursor"), "utf8").trim() : null),
  };
}

// The screen stand-in: logs exactly what it got on stdin, then does what screen-mode says.
const SCREEN = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const dir = process.env.TEST_DIR;
const input = readFileSync(0, "utf8");
appendFileSync(dir + "/screen-calls.jsonl", input + "\\n");
const mode = existsSync(dir + "/screen-mode") ? readFileSync(dir + "/screen-mode", "utf8").trim() : "pass";
if (mode === "pass") console.log(JSON.stringify({ verdict: "pass" }));
else if (mode === "block") console.log(JSON.stringify({ verdict: "block", passage: "the rate is 180 an hour", reason: "prices are not said outside" }));
else if (mode === "garbage") console.log("looks fine to me");
else { console.error("model gateway refused the key"); process.exit(1); }
`;
const SCREEN_ALL = { screen: { command: "bin/screen", policy: { trusted: ["policy/trusted.md"], external: ["policy/trusted.md", "policy/external.md"] } } };

// ----------------------------------------------------------------------------------- events

const T = (n: number) => `2030-01-05T14:${String(n).padStart(2, "0")}:00Z`;
const msg = (seq: number, chat: { id: string; type: string; name: string }, id: string, from: unknown, text: string, extra: Record<string, unknown> = {}) =>
  ({ seq, t: T(seq % 60), kind: "message", account: ACCOUNT, chat, message: { id, from, text, kept_by: chat.type === "group" ? "mention" : "dm", mentions_me: chat.type === "group", ...extra } });
const reaction = (seq: number, chat: { id: string; type: string; name: string }, target: string, from: unknown, emoji: string) => ({ seq, t: T(seq % 60), kind: "reaction", account: ACCOUNT, chat, target, from, emoji });
const state = (seq: number, s: string, reason = "") => ({ seq, t: T(seq % 60), kind: "state", account: ACCOUNT, state: s, reason });
const C_INT = { id: G_INT, type: "group", name: "Ops" };
const C_EXT = { id: G_EXT, type: "group", name: "Mixed" };
const C_PEER = { id: G_PEER, type: "group", name: "Bots" };
const C_DM = { id: DM_OPER, type: "direct", name: "Sam" };

test("node --check passes for every node script of the skill", () => {
  for (const f of [join(SKILL, "scripts/whatsapp-post.mjs"), READER, WAKER]) expect(spawnSync(NODE, ["--check", f]).status).toBe(0);
  expect(spawnSync("bash", ["-n", CLI]).status).toBe(0);
  expect(spawnSync("bash", ["-n", SINK]).status).toBe(0);
});

describe("heartbeat.d/25-whatsapp-events", () => {
  const sample = () => [
    msg(1, C_INT, "3EB0AAAA0000000001", OPER, "@Example can you check this?", {
      reply_to: { id: "3EB0AAAA0000000000", from: ANN, text: "the report is attached", kept: true },
      media: { type: "document", mime: "application/pdf", name: "report.pdf", size: 48213 },
    }),
    msg(2, C_INT, "3EB0AAAA0000000002", BOT, "on it"),
    { seq: 3, t: T(3), kind: "edit", account: ACCOUNT, chat: C_INT, message: { id: "3EB0AAAA0000000001", from: OPER, text: "edited" }, edited: true },
    { seq: 4, t: T(4), kind: "revoke", account: ACCOUNT, chat: C_INT, message: { id: "3EB0AAAA0000000001", from: OPER } },
    reaction(5, C_INT, "3EB0AAAA0000000002", OPER, "👍"),
    reaction(6, C_INT, "3EB0AAAA0000000001", ANN, "❤️"), // on someone else's message: not an item
    reaction(7, C_DM, "3EB0OLD00000000001", OPER, "🙏"), // on an older own message, looked up
    msg(8, C_DM, "3EB0AAAA0000000008", { ...EXT, id: DM_OPER, name: "" , pn: OPER.pn, operator: true }, "and the second one"),
    state(9, "connected"),
    { seq: 10, t: T(10), kind: "chat_rekeyed", account: ACCOUNT, old: "15550100001@s.whatsapp.net", new: DM_OPER },
  ];

  test("one item per kept message and per reaction on the bot's own message, with every field", () => {
    const b = bot({}, { fixtures: { [`message view ${DM_OPER}/3EB0OLD00000000001`]: ok({ chat: C_DM, message: { id: "3EB0OLD00000000001", from: BOT, text: "earlier" } }) } });
    b.setEvents(sample());
    const r = b.reader();
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.items).toEqual([
      {
        key: `whatsapp:${G_INT}:3EB0AAAA0000000001:msg`, at: T(1), chat: G_INT, chat_name: "Ops", kind: "group",
        from: "Sam", from_operator: true, text: "@Example can you check this?", id: "3EB0AAAA0000000001", kept_by: "mention",
        reply_to: { id: "3EB0AAAA0000000000", from: ANN, text: "the report is attached" },
        media: { type: "document", mime: "application/pdf", name: "report.pdf", size: 48213 },
        reply: `${G_INT} --reply 3EB0AAAA0000000001`,
      },
      {
        key: `whatsapp:${G_INT}:3EB0AAAA0000000002:👍:${OPER.id}`, at: T(5), chat: G_INT, chat_name: "Ops", kind: "group",
        from: "Sam", from_operator: true, text: "", id: "3EB0AAAA0000000002", reaction: "👍", reply: `${G_INT} --reply 3EB0AAAA0000000002`,
      },
      {
        key: `whatsapp:${DM_OPER}:3EB0OLD00000000001:🙏:${OPER.id}`, at: T(7), chat: DM_OPER, chat_name: "Sam", kind: "dm",
        from: "Sam", from_operator: true, text: "", id: "3EB0OLD00000000001", reaction: "🙏", reply: `${DM_OPER} --reply 3EB0OLD00000000001`,
      },
      {
        key: `whatsapp:${DM_OPER}:3EB0AAAA0000000008:msg`, at: T(8), chat: DM_OPER, chat_name: "Sam", kind: "dm",
        from: OPER.pn, from_operator: true, text: "and the second one", id: "3EB0AAAA0000000008", kept_by: "dm", reply: `${DM_OPER} --reply 3EB0AAAA0000000008`,
      },
    ]);
    // the reaction on someone else's message was looked up and dropped (not_found is not a failure)
    expect(b.calls().filter((c) => c.argv[0] === "message").map((c) => c.argv[2])).toEqual([`${G_INT}/3EB0AAAA0000000001`, `${DM_OPER}/3EB0OLD00000000001`]);
    expect(b.cursor()).toBe("10");
  });

  test("a stopped account fails the input after the items, with one line naming the state", () => {
    const b = bot();
    b.setEvents([state(1, "connected"), msg(2, C_DM, "3EB0AAAA0000000002", OPER, "hello"), state(3, "logged_out", "removed on the phone")]);
    const r = b.reader();
    expect(r.code).toBe(1);
    expect(r.items.map((i) => i.id)).toEqual(["3EB0AAAA0000000002"]);
    expect(r.err.trim().split("\n")).toHaveLength(1);
    expect(r.err).toContain("is logged_out (removed on the phone)");
    // connecting is not a failure, and a later connected clears an earlier stop
    b.setEvents([state(1, "logged_out"), state(2, "connecting"), state(3, "connected")]);
    expect(b.reader().code).toBe(0);
  });

  test("the daemon not running, or whatsapp-axi failing, is exit 1 and leaves the cursor", () => {
    const b = bot();
    b.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", OPER, "hi")]);
    expect(b.reader().code).toBe(0);
    expect(b.cursor()).toBe("1");
    writeFileSync(join(b.dir, "events-error.json"), JSON.stringify({ error: { code: "DAEMON_NOT_RUNNING", message: "The daemon is not running." } }));
    b.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", OPER, "hi"), msg(2, C_DM, "3EB0AAAA0000000002", OPER, "again")]);
    const r = b.reader();
    expect(r.code).toBe(1);
    expect(r.err).toContain(`daemon for ${ACCOUNT} is not running (whatsapp-axi daemon start ${ACCOUNT})`);
    expect(b.cursor()).toBe("1");
  });

  test("the cursor advances, the overlap re-reads, and a missing cursor starts from the most recent events", () => {
    const b = bot({ lookback: 2 });
    const evs = Array.from({ length: 6 }, (_, i) => msg(i + 1, C_DM, `3EB0AAAA000000000${i + 1}`, OPER, `m${i + 1}`));
    b.setEvents(evs);
    const first = b.reader();
    expect(first.items.map((i) => i.id)).toEqual(["3EB0AAAA0000000005", "3EB0AAAA0000000006"]); // the last `lookback`
    expect(b.calls()[0]?.argv).toEqual(["events", "--limit", "2", "--account", ACCOUNT, "--json-out"]);
    expect(b.cursor()).toBe("6");
    b.setEvents([...evs, msg(7, C_DM, "3EB0AAAA0000000007", OPER, "m7")]);
    const second = b.reader();
    expect(b.calls().pop()?.argv).toEqual(["events", "--after", "4", "--limit", "500", "--account", ACCOUNT, "--json-out"]);
    expect(second.items.map((i) => i.id)).toEqual(["3EB0AAAA0000000005", "3EB0AAAA0000000006", "3EB0AAAA0000000007"]); // overlap; the core's seen keys drop repeats
    expect(b.cursor()).toBe("7");
    // a peek reads and leaves the cursor
    b.setEvents([...evs, msg(7, C_DM, "3EB0AAAA0000000007", OPER, "m7"), msg(8, C_DM, "3EB0AAAA0000000008", OPER, "m8")]);
    expect(b.reader({ env: { OPSBOT_PEEK: "1" } }).items.map((i) => i.id)).toContain("3EB0AAAA0000000008");
    expect(b.cursor()).toBe("7");
  });

  test("a long backlog is read page by page", () => {
    const b = bot({ lookback: 0 });
    writeFileSync(join(b.dir, "cache-seed"), "");
    mkdirSync(join(b.dir, "cache"), { recursive: true });
    writeFileSync(join(b.dir, "cache", "whatsapp-cursor"), "0\n");
    b.setEvents(Array.from({ length: 1203 }, (_, i) => msg(i + 1, C_DM, `3EB0B${String(i + 1).padStart(13, "0")}`, OPER, "x")));
    const r = b.reader();
    expect(r.err).toBe("");
    expect(r.items).toHaveLength(1203);
    expect(b.calls().map((c) => c.argv[2])).toEqual(["0", "500", "1000"]);
    expect(b.cursor()).toBe("1203");
  });

  test("no message text reaches the cursor or any file the reader writes", () => {
    const b = bot();
    b.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", OPER, `look ${MARKER}`)]);
    const r = b.reader();
    expect(r.out).toContain(MARKER);
    for (const f of readdirSync(join(b.dir, "cache"))) expect(readFileSync(join(b.dir, "cache", f), "utf8")).not.toContain(MARKER);
  });

  test("a non-operator's item carries from_operator false and gate_word_void; a trusted one from_trusted; an unknown number is not trusted", () => {
    const b = bot();
    b.setEvents([
      msg(1, C_INT, "3EB0AAAA0000000001", ANN, "trusted"),
      msg(2, C_INT, "3EB0AAAA0000000002", EXT, "a stranger"),
      msg(3, C_INT, "3EB0AAAA0000000003", { ...HIDDEN, name: "Kim" }, "no known number"),
      msg(4, C_INT, "3EB0AAAA0000000004", OPER, "the operator"),
    ]);
    const [t, x, h, o] = b.reader().items;
    expect(t).toMatchObject({ from_operator: false, from_trusted: true, gate_word_void: "not an operator" });
    expect(x).toMatchObject({ from_operator: false, gate_word_void: "not an operator" });
    expect(x.from_trusted).toBeUndefined();
    expect(h).toMatchObject({ from: "Kim", from_operator: false, gate_word_void: "not an operator" });
    expect(h.from_trusted).toBeUndefined();
    expect(o.gate_word_void).toBeUndefined();
    expect(o.from_trusted).toBeUndefined();
  });

  test("listen_to trusted keeps operators and trusted numbers, drops anyone else", () => {
    const b = bot({ listen_to: "trusted", peers: [{ name: "otherbot", user: PEER.pn, chats: [G_PEER] }] });
    b.setEvents([
      msg(1, C_INT, "3EB0AAAA0000000001", ANN, "trusted"),
      msg(2, C_EXT, "3EB0AAAA0000000002", EXT, "a stranger"),
      msg(3, C_INT, "3EB0AAAA0000000003", HIDDEN, "no known number"),
      msg(4, C_INT, "3EB0AAAA0000000004", OPER, "the operator"),
      msg(5, C_PEER, "3EB0AAAA0000000005", PEER, "the peer"),
    ]);
    expect(b.reader().items.map((i) => i.id)).toEqual(["3EB0AAAA0000000001", "3EB0AAAA0000000004", "3EB0AAAA0000000005"]);
  });

  test("listen_to operators drops a non-operator's item and keeps a peer's in its chat only", () => {
    const peers = [{ name: "otherbot", user: PEER.pn, chats: [G_PEER] }];
    const b = bot({ listen_to: "operators", peers });
    b.setEvents([
      msg(1, C_INT, "3EB0AAAA0000000001", ANN, "from a trusted non-operator"),
      msg(2, C_INT, "3EB0AAAA0000000002", OPER, "from the operator"),
      msg(3, C_PEER, "3EB0AAAA0000000003", PEER, "from the peer, in its chat"),
      msg(4, C_INT, "3EB0AAAA0000000004", PEER, "from the peer, elsewhere"),
      msg(5, C_EXT, "3EB0AAAA0000000005", { ...OPER, operator: false }, "operator by the setting's number"),
    ]);
    const r = b.reader();
    expect(r.code).toBe(0);
    expect(r.items.map((i) => i.id)).toEqual(["3EB0AAAA0000000002", "3EB0AAAA0000000003", "3EB0AAAA0000000005"]);
    const peerItem = r.items[1];
    expect(peerItem).toMatchObject({ from_peer: "otherbot", gate_word_void: "from a peer bot", from_operator: false });
    expect(peerItem.from_trusted).toBeUndefined();
    expect(peerItem.peer_note).toContain("never the operator's word");
    // with listen_to anyone the non-operator is an item, and the peer is still heard only in its chat
    const any = bot({ peers });
    any.setEvents([msg(1, C_INT, "3EB0AAAA0000000001", ANN, "x"), msg(2, C_INT, "3EB0AAAA0000000002", PEER, "y")]);
    expect(any.reader().items.map((i) => i.id)).toEqual(["3EB0AAAA0000000001"]);
  });
});

// ----------------------------------------------------------------------------------- classify

describe("classify: the destination from WhatsApp's participant list", () => {
  test("each class as the table says", () => {
    const b = bot({ peers: [{ name: "otherbot", user: PEER.pn, chats: [G_PEER] }] });
    const cls = (chat: string) => { const r = b.run(["classify", chat]); expect(r.code).toBe(0); return r.json; };
    expect(cls(DM_OPER)).toMatchObject({ chat: DM_OPER, class: "operator-dm", why: `a direct chat with the operator ${OPER.pn}`, cached: false });
    expect(cls(OPER.pn)).toMatchObject({ class: "operator-dm" });
    expect(cls(DM_ANN)).toMatchObject({ class: "trusted", why: `a direct chat with the trusted number ${ANN.pn}` });
    expect(cls(DM_EXT)).toMatchObject({ class: "external", why: `a direct chat with ${EXT.pn}, not an operator or trusted` });
    expect(cls(G_INT)).toMatchObject({ class: "trusted", why: "all 2 other participants are operators, trusted or peers" });
    expect(cls(G_PEER)).toMatchObject({ class: "trusted" });
    expect(cls(G_EXT)).toMatchObject({ class: "external", why: `${EXT.pn} is not an operator, trusted or a peer` });
    expect(cls(G_HID)).toMatchObject({ class: "unknown", why: `${HIDDEN.id} has no known phone number` });
    expect(cls(G_DOWN)).toMatchObject({ class: "unknown", why: "lookup failed: the daemon is not connected (connecting)" });
    expect(cls("120363000000000099@g.us")).toMatchObject({ class: "unknown" });
    expect(b.calls().find((c) => c.argv[0] === "chat")?.argv).toEqual(["chat", "view", DM_OPER, "--account", ACCOUNT, "--json-out"]);
  });

  test("an address-book contact is not trusted; a peer outside the peers list is an ordinary person", () => {
    const b = bot({ trusted: [] });
    expect(b.run(["classify", DM_ANN]).json.class).toBe("external"); // ANN is a contact, not trusted
    expect(b.run(["classify", G_PEER]).json.class).toBe("external"); // no peers set
  });

  test("a class is cached for cache_seconds; unknown is never cached", () => {
    const b = bot();
    expect(b.run(["classify", G_INT]).json.cached).toBe(false);
    expect(b.run(["classify", G_INT]).json).toMatchObject({ class: "trusted", cached: true });
    expect(b.calls().filter((c) => c.argv[0] === "chat")).toHaveLength(1);
    b.run(["classify", G_HID]);
    b.run(["classify", G_DOWN]);
    expect(b.run(["classify", G_HID]).json.cached).toBe(false);
    expect(b.run(["classify", G_DOWN]).json.cached).toBe(false);
    const cache = JSON.parse(readFileSync(join(b.dir, "cache", "whatsapp-classes.json"), "utf8"));
    expect(Object.keys(cache.chats)).toEqual([G_INT]);
    const off = bot({ screen: { cache_seconds: 0.001 } });
    off.run(["classify", G_INT]);
    spawnSync("sleep", ["0.05"]);
    expect(off.run(["classify", G_INT]).json.cached).toBe(false);
  });

  test("bad usage is exit 2", () => {
    const b = bot();
    expect(b.run(["classify"]).code).toBe(2);
    expect(b.run(["classify", "not-a-chat"]).code).toBe(2);
    expect(bot({ account: "" }).run(["classify", G_INT]).code).toBe(2);
  });
});

// ----------------------------------------------------------------------------------- post

describe("opsbot-whatsapp post", () => {
  /** The send calls, each --id value checked (32 uppercase hex) and written as "ID". */
  const sends = (b: ReturnType<typeof bot>) => b.calls().filter((c) => c.argv[0] === "send" || c.argv[0] === "send-file").map((c) => {
    const i = c.argv.indexOf("--id");
    expect(c.argv[i + 1]).toMatch(/^[0-9A-F]{32}$/);
    return { ...c, argv: c.argv.map((a, j) => (j === i + 1 ? "ID" : a)) };
  });

  test("exit 0: posted through whatsapp-axi send, the text on stdin, the reply as a ref, one decision line", () => {
    const b = bot();
    const r = b.run(["post", G_INT, "--reply", "3EB0AAAA0000000001", `on it ${MARKER}`]);
    expect(r.code).toBe(0);
    const sendId = b.calls().find((c) => c.argv[0] === "send")!.argv[6];
    expect(r.json).toEqual({ posted: true, chat: G_INT, class: "trusted", why: "all 2 other participants are operators, trusted or peers", id: "3EB0SENT0000000000001", send_id: sendId, screen: "skipped" });
    expect(sends(b)).toEqual([{ argv: ["send", G_INT, "-", "--reply", `${G_INT}/3EB0AAAA0000000001`, "--id", "ID", "--account", ACCOUNT, "--json-out"], stdin: `on it ${MARKER}` }]);
    const [line] = b.log();
    expect(Object.keys(line).sort()).toEqual(["at", "chat", "class", "draft_sha256", "id", "posted", "reply_to", "screen", "send_id", "why"]);
    expect(line).toMatchObject({ chat: G_INT, reply_to: "3EB0AAAA0000000001", posted: true, id: "3EB0SENT0000000000001" });
    expect(readFileSync(join(b.root, "logs/whatsapp-posts.jsonl"), "utf8")).not.toContain(MARKER);
    expect(readFileSync(join(b.dir, "cache", "whatsapp-classes.json"), "utf8")).not.toContain(MARKER);
  });

  test("the text from stdin with -; a reader's reply column works whole", () => {
    const b = bot();
    expect(b.run(["post", ...`${DM_OPER} --reply 3EB0AAAA0000000008`.split(" "), "-"], { input: "from stdin" }).code).toBe(0);
    expect(sends(b)[0]?.stdin).toBe("from stdin");
  });

  test("exit 2: no chat, a bad chat, an empty text with no file, a bad reply id, two texts, a missing file", () => {
    const b = bot();
    expect(b.run(["post"]).code).toBe(2);
    expect(b.run(["post", "general", "x"]).code).toBe(2);
    expect(b.run(["post", G_INT, "  "]).code).toBe(2);
    expect(b.run(["post", G_INT], { input: "" }).code).toBe(2);
    expect(b.run(["post", G_INT, "--reply", "not an id", "x"]).code).toBe(2);
    expect(b.run(["post", G_INT, "a", "b"]).code).toBe(2);
    expect(b.run(["post", G_INT, "--file", "nope.pdf"]).code).toBe(2);
    expect(sends(b)).toEqual([]);
  });

  test("exit 1: whatsapp-axi refusing the send passes its error code through", () => {
    const b = bot();
    for (const code of ["FIRST_CONTACT", "RATE_LIMITED", "DUPLICATE_TEXT", "NOT_CONNECTED", "UPSTREAM_ERROR", "INTERNAL_ERROR"]) {
      writeFileSync(join(b.dir, "send-error.json"), JSON.stringify({ error: { code, message: `stand-in ${code}`, ...(code === "RATE_LIMITED" ? { retry_after_seconds: 40 } : {}) } }));
      const r = b.run(["post", DM_OPER, "hello"]);
      expect(r.code).toBe(1);
      expect(r.json).toMatchObject({ posted: false, code, error: `whatsapp-axi send: stand-in ${code}` });
      if (code === "RATE_LIMITED") expect(r.json.retry_after_seconds).toBe(40);
      expect(b.log().pop()).toMatchObject({ posted: false, code });
    }
    // never sends with --first-contact
    expect(sends(b).every((c) => !c.argv.includes("--first-contact"))).toBe(true);
  });

  describe("the idempotent send", () => {
    test("each attempt gets its own 32-hex send id, passed as --id and logged as send_id", () => {
      const b = bot();
      b.run(["post", DM_OPER, "one"]);
      b.run(["post", DM_OPER, "two"]);
      const ids = b.calls().filter((c) => c.argv[0] === "send").map((c) => c.argv[c.argv.indexOf("--id") + 1]);
      expect(ids).toHaveLength(2);
      for (const id of ids) expect(id).toMatch(/^[0-9A-F]{32}$/);
      expect(ids[0]).not.toBe(ids[1]);
      expect(b.log().map((l) => l.send_id)).toEqual(ids);
    });

    test("OUTCOME_UNKNOWN: posted \"unknown\", exit 1, the error names the id, and the exact --retry-id command", () => {
      const b = bot();
      writeFileSync(join(b.dir, "send-error.json"), JSON.stringify({ error: { code: "OUTCOME_UNKNOWN", message: "The send timed out; it may have gone out.", id: "FFFF0000FFFF0000" } }));
      const r = b.run(["post", G_INT, "--reply", "3EB0AAAA0000000001", `it's ${MARKER}`]);
      expect(r.code).toBe(1);
      const id = b.calls().find((c) => c.argv[0] === "send")!.argv.at(-4)!;
      expect(id).toMatch(/^[0-9A-F]{32}$/);
      expect(r.json).toMatchObject({ posted: "unknown", code: "OUTCOME_UNKNOWN", send_id: id });
      expect(r.json.error).toContain(id);
      expect(r.json.retry).toBe(`opsbot-whatsapp post ${G_INT} --reply 3EB0AAAA0000000001 --retry-id ${id} 'it'\\''s ${MARKER}'`);
      const line = b.log().pop();
      expect(line).toMatchObject({ posted: "unknown", code: "OUTCOME_UNKNOWN", send_id: id });
      expect(readFileSync(join(b.root, "logs/whatsapp-posts.jsonl"), "utf8")).not.toContain(MARKER);
      // from stdin, the retry says - and to send the same text again
      const s = b.run(["post", DM_OPER, "-"], { input: "x" });
      expect(s.json.retry).toMatch(new RegExp(`^opsbot-whatsapp post ${DM_OPER.replace(/[.@]/g, "\\$&")} --retry-id [0-9A-F]{32} -$`));
      expect(s.json.next).toContain("same text on stdin");
    });

    test("--retry-id passes that id through; already_sent answers posted true, replayed true, the warning kept", () => {
      const b = bot();
      writeFileSync(join(b.dir, "send-answer.json"), JSON.stringify({ id: "3EB0SENT0000000000001", chat: DM_OPER, t: "2030-01-05T14:05:00Z", already_sent: true, warning: "already sent at 2030-01-05T14:05:00Z; nothing sent now" }));
      const r = b.run(["post", DM_OPER, "--retry-id", "ABCDEF0123456789ABCDEF0123456789", "hello"]);
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ posted: true, replayed: true, id: "3EB0SENT0000000000001", send_id: "ABCDEF0123456789ABCDEF0123456789", warning: "already sent at 2030-01-05T14:05:00Z; nothing sent now" });
      const call = b.calls().find((c) => c.argv[0] === "send")!;
      expect(call.argv.slice(call.argv.indexOf("--id"), call.argv.indexOf("--id") + 2)).toEqual(["--id", "ABCDEF0123456789ABCDEF0123456789"]);
      expect(b.log().pop()).toMatchObject({ posted: true, replayed: true, retry: true, send_id: "ABCDEF0123456789ABCDEF0123456789" });
      // a bad id is usage, nothing sent
      expect(b.run(["post", DM_OPER, "--retry-id", "abc123", "x"]).code).toBe(2);
      expect(b.run(["post", DM_OPER, "--retry-id"]).code).toBe(2);
      expect(b.calls().filter((c) => c.argv[0] === "send")).toHaveLength(1);
    });
  });

  test("--dry-run classifies and screens, sends nothing, logs the attempt", () => {
    const b = bot(SCREEN_ALL);
    const r = b.run(["post", G_EXT, "--dry-run", "hello"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ posted: false, dry_run: true, would_post: true, class: "external", screen: "pass" });
    expect(sends(b)).toEqual([]);
    expect(b.screens()).toHaveLength(1);
    expect(b.log()[0]).toMatchObject({ dry_run: true, posted: false, screen: "pass" });
  });

  describe("the screen", () => {
    test("operator-dm is never screened; a class with no policy is not screened", () => {
      const b = bot({ screen: { command: "bin/screen", policy: { external: ["policy/external.md"] } } });
      expect(b.run(["post", DM_OPER, "x"]).json.screen).toBe("skipped");
      expect(b.run(["post", G_INT, "x"]).json.screen).toBe("skipped");
      expect(b.screens()).toEqual([]);
    });

    test("pass posts; the screen gets exactly {draft, destination_class, policy}", () => {
      const b = bot(SCREEN_ALL);
      const r = b.run(["post", G_EXT, "the plan is ready"]);
      expect(r.code).toBe(0);
      expect(r.json.screen).toBe("pass");
      expect(b.screens()).toEqual([{ draft: "the plan is ready", destination_class: "external", policy: "- no personal information\n\n- no prices" }]);
      expect(b.run(["post", G_HID, "x"]).json).toMatchObject({ class: "unknown", screen: "pass" });
      expect(b.screens().pop().destination_class).toBe("unknown"); // screened with the external policy
    });

    test("exit 3: blocked, with the passage and reason; the log has the reason, never the passage or the draft", () => {
      const b = bot(SCREEN_ALL);
      b.mode("block");
      const r = b.run(["post", G_EXT, `the rate is 180 an hour ${MARKER}`]);
      expect(r.code).toBe(3);
      expect(r.json).toMatchObject({ posted: false, screen: "block", passage: "the rate is 180 an hour", reason: "prices are not said outside" });
      expect(sends(b)).toEqual([]);
      const raw = readFileSync(join(b.root, "logs/whatsapp-posts.jsonl"), "utf8");
      expect(raw).not.toContain(MARKER);
      expect(raw).not.toContain("180 an hour");
      expect(b.log()[0]).toMatchObject({ screen: "block", reason: "prices are not said outside", posted: false });
    });

    test("exit 4: the screen failed; the operator is told once per outage, and again after it answered", () => {
      const b = bot(SCREEN_ALL);
      b.mode("fail");
      const r = b.run(["post", G_EXT, "x"]);
      expect(r.code).toBe(4);
      expect(r.json).toMatchObject({ posted: false, screen: "error", error: "exit 1: model gateway refused the key", operator: "the operator was told" });
      expect(b.escalations()).toHaveLength(1);
      expect(b.escalations()[0]).toContain("🧪 examplebot could not screen a WhatsApp reply to a external chat");
      expect(existsSync(join(b.root, ".git", "opsbot-whatsapp-screen"))).toBe(true);
      b.mode("garbage");
      expect(b.run(["post", G_EXT, "x"]).json.operator).toBe("the operator was already told about this outage");
      expect(b.escalations()).toHaveLength(1);
      b.mode("pass");
      expect(b.run(["post", G_EXT, "x"]).code).toBe(0);
      expect(existsSync(join(b.root, ".git", "opsbot-whatsapp-screen"))).toBe(false);
      b.mode("fail");
      b.run(["post", G_EXT, "x"]);
      expect(b.escalations()).toHaveLength(2);
      expect(sends(b)).toHaveLength(1);
    });

    test("when no escalation script succeeds the marker is not kept", () => {
      const b = bot(SCREEN_ALL);
      b.mode("fail");
      writeFileSync(join(b.dir, "escalate-fail"), "");
      expect(b.run(["post", G_EXT, "x"]).json.operator).toBe("could not tell the operator: every escalation script failed");
      expect(existsSync(join(b.root, ".git", "opsbot-whatsapp-screen"))).toBe(false);
    });

    test("exit 2: a screen setting it cannot use", () => {
      const s = bot({ screen: { command: "bin/screen", policy: { internal: ["policy/trusted.md"] } } });
      expect(s.run(["post", G_INT, "x"]).json.screen).toBe("skipped"); // Slack's key screens nothing here
      const b = bot({ screen: { command: "/usr/bin/true", policy: { external: ["policy/external.md"] } } });
      const r = b.run(["post", G_EXT, "x"]);
      expect(r.code).toBe(2);
      expect(r.json.error).toContain("must be a path inside the repo");
      const m = bot({ screen: { command: "bin/screen", policy: { external: ["policy/nope.md"] } } });
      expect(m.run(["post", G_EXT, "x"]).json.error).toBe("screen policy file missing: policy/nope.md");
    });
  });

  describe("files", () => {
    test("a file goes through send-file with its caption screened, the file itself not; the log has its name and size", () => {
      const b = bot({ ...SCREEN_ALL });
      writeFileSync(join(b.root, "report.pdf"), "%PDF-1.4 stand-in");
      const r = b.run(["post", G_INT, "--file", "report.pdf", "the report"]);
      expect(r.code).toBe(0);
      expect(sends(b)[0]?.argv).toEqual(["send-file", G_INT, join(b.root, "report.pdf"), "--caption", "the report", "--id", "ID", "--account", ACCOUNT, "--json-out"]);
      expect(b.screens()).toEqual([{ draft: "the report", destination_class: "trusted", policy: "- no personal information" }]);
      expect(b.log()[0].file).toEqual({ name: "report.pdf", size: 17 });
      // no caption: nothing to screen, and stdin is not read
      expect(b.run(["post", G_INT, "--file", "report.pdf"]).code).toBe(0);
      expect(sends(b)[1]?.argv).toEqual(["send-file", G_INT, join(b.root, "report.pdf"), "--id", "ID", "--account", ACCOUNT, "--json-out"]);
      expect(b.screens()).toHaveLength(1);
    });

    test("exit 3: a file to an external or unknown chat is refused unless screen.files_external is true", () => {
      const b = bot();
      writeFileSync(join(b.root, "report.pdf"), "x");
      for (const chat of [G_EXT, G_HID]) {
        const r = b.run(["post", chat, "--file", "report.pdf", "here"]);
        expect(r.code).toBe(3);
        expect(r.json).toMatchObject({ posted: false, screen: "block" });
        expect(r.json.reason).toContain("files_external is not true");
      }
      expect(sends(b)).toEqual([]);
      const allowed = bot({ screen: { files_external: true } });
      writeFileSync(join(allowed.root, "report.pdf"), "x");
      expect(allowed.run(["post", G_EXT, "--file", "report.pdf", "here"]).code).toBe(0);
      expect(b.run(["post", DM_OPER, "--file", "report.pdf"]).code).toBe(0);
    });
  });

  describe("the loop guard", () => {
    const PEERS = { peers: [{ name: "otherbot", user: PEER.pn, chats: [G_PEER] }] };
    const k = (from: unknown, i: number, extra: Record<string, unknown> = {}) => ({ id: `3EB0LOOP00000000${String(i).padStart(2, "0")}`, from, text: `turn ${i}`, ...extra });
    const readOf = (msgs: unknown[]) => ok({ chat: C_PEER, messages: msgs, more: false });
    const turns = (n: number, start = 0) => Array.from({ length: n }, (_, i) => k(i % 2 ? BOT : PEER, start + i));

    test("refuses at peer_turns between bots with no person between; a person resets the count", () => {
      const b = bot(PEERS, { fixtures: { [`read ${G_PEER}`]: readOf([k(OPER, 0), ...turns(6, 1)]) } });
      const r = b.run(["post", G_PEER, "--reply", "3EB0LOOP0000000006", "again"]);
      expect(r.code).toBe(6);
      expect(r.json).toMatchObject({ posted: false, peer_guard: "turns", peer: "otherbot", error: "6 turns between bots with no person; ask the operator" });
      expect(sends(b)).toEqual([]);
      expect(b.log()[0]).toMatchObject({ peer_guard: "turns", posted: false, peer: "otherbot" });
      expect(b.calls().find((c) => c.argv[0] === "read")?.argv).toEqual(["read", G_PEER, "--limit", "50", "--account", ACCOUNT, "--json-out"]);
      b.setFixture(`read ${G_PEER}`, readOf([...turns(5, 1), k(ANN, 7), ...turns(5, 8)]));
      expect(b.run(["post", G_PEER, "fine"]).code).toBe(0);
      expect(b.log().pop()).toMatchObject({ posted: true, peer: "otherbot" });
      // own messages alone are not a loop
      b.setFixture(`read ${G_PEER}`, readOf(Array.from({ length: 8 }, (_, i) => k(BOT, i))));
      expect(b.run(["post", G_PEER, "a reminder"]).code).toBe(0);
    });

    test("a draft that mentions an operator gets through once per run", () => {
      const b = bot(PEERS, { fixtures: { [`read ${G_PEER}`]: readOf(turns(6)) } });
      expect(b.run(["post", G_PEER, "stuck"]).code).toBe(6);
      const ask = b.run(["post", G_PEER, `@${OPER.pn.slice(1)} we disagree; can you decide?`]);
      expect(ask.code).toBe(0);
      expect(ask.json.peer).toBe("otherbot");
      // the bot's ask is now in the run: a second ask is refused, and says why
      b.setFixture(`read ${G_PEER}`, readOf([...turns(6), k(BOT, 7, { text: `@${OPER.pn.slice(1)} can you decide?` }), k(PEER, 8)]));
      const again = b.run(["post", G_PEER, `@${OPER.pn.slice(1)} still waiting`]);
      expect(again.code).toBe(6);
      expect(again.json.next).toContain("already asked the operator");
      // an ask carried in the mention list counts too
      b.setFixture(`read ${G_PEER}`, readOf([...turns(6), k(BOT, 7, { text: "can you decide?", mentions: [OPER] })]));
      expect(b.run(["post", G_PEER, `@${OPER.pn.slice(1)} again`]).code).toBe(6);
    });

    test("refuses at peer_posts_per_hour posts to the chat in the last hour, counted from post_log", () => {
      const b = bot({ ...PEERS, peer_posts_per_hour: 2 });
      expect(b.run(["post", G_PEER, "one"]).code).toBe(0);
      expect(b.run(["post", G_PEER, "two"]).code).toBe(0);
      const r = b.run(["post", G_PEER, "three"]);
      expect(r.code).toBe(6);
      expect(r.json).toMatchObject({ peer_guard: "hourly", error: `2 posts to ${G_PEER} in the last hour; ask the operator` });
      // an old post does not count
      const old = bot({ ...PEERS, peer_posts_per_hour: 1 });
      mkdirSync(join(old.root, "logs"));
      writeFileSync(join(old.root, "logs/whatsapp-posts.jsonl"), JSON.stringify({ at: "2020-01-01T00:00:00Z", chat: G_PEER, posted: true }) + "\n");
      expect(old.run(["post", G_PEER, "x"]).code).toBe(0);
    });

    test("refuses when the chat cannot be read; a chat no peer is listed for is not guarded", () => {
      const b = bot(PEERS, { fixtures: { [`read ${G_PEER}`]: err("NOT_FOUND", "No such chat.") } });
      const r = b.run(["post", G_PEER, "x"]);
      expect(r.code).toBe(6);
      expect(r.json.peer_guard).toBe("unreadable");
      expect(r.json.error).toContain("NOT_FOUND");
      expect(b.run(["post", G_INT, "x"]).code).toBe(0);
      expect(b.calls().filter((c) => c.argv[0] === "read")).toHaveLength(1);
    });
  });
});

// ----------------------------------------------------------------------------------- waker

describe("monitor.d/20-whatsapp-waker", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Wait for a condition, at most `ms`: a loaded machine runs the stand-ins slowly. */
  const until = async (ok: () => boolean, ms = 10000) => { for (const t = Date.now(); !ok() && Date.now() - t < ms; ) await sleep(50); };
  /** Wait until the waker has opened the wake file (its start line), then a beat. */
  const ready = async (w: { out: () => string }) => { for (let i = 0; i < 200 && !w.out().includes("waking for"); i++) await sleep(25); await sleep(100); };
  /** Start the waker with a fast tick; the core stand-in logs each call (a `wake backstop` run), waits `delayS`, prints `notes` on stderr and `says`. */
  function startWaker(b: ReturnType<typeof bot>, opts: { says?: string; notes?: string; delayS?: number } = {}) {
    const core = join(b.dir, "core");
    writeFileSync(core, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${b.dir}/core.log"\nprintf 'tick=%s root=%s\\n' "$OPSBOT_WAKE_TICK_MS" "$OPSBOT_ROOT" >> "${b.dir}/core-env.log"\n${opts.notes ? `echo -e ${JSON.stringify(opts.notes)} >&2\n` : ""}${opts.delayS ? `sleep ${opts.delayS}\n` : ""}echo -e ${JSON.stringify(opts.says ?? "backstop: nudged after 0s")}\n`);
    chmodSync(core, 0o755);
    const child = spawn(NODE, [WAKER], { cwd: b.root, env: { ...b.env, OPSBOT_CORE: core, OPSBOT_WHATSAPP_TICK_MS: "50" } });
    let out = "", errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    return {
      wakeLine: (seq: number, kind = "message") => appendFileSync(b.wake, JSON.stringify({ account: ACCOUNT, seq, kind }) + "\n"),
      seen: (key: string) => { mkdirSync(join(b.root, "logs/intake"), { recursive: true }); appendFileSync(join(b.root, "logs/intake/seen"), key + "\n"); },
      nudges: () => (existsSync(join(b.dir, "core.log")) ? readFileSync(join(b.dir, "core.log"), "utf8").trim().split("\n").filter(Boolean) : []),
      coreEnv: () => (existsSync(join(b.dir, "core-env.log")) ? readFileSync(join(b.dir, "core-env.log"), "utf8").trim().split("\n").filter(Boolean) : []),
      marks: () => b.calls().filter((c) => c.argv[0] === "mark-read").map((c) => c.argv[1]),
      out: () => out, err: () => errOut, exited,
      stop: async () => { child.kill("SIGTERM"); await exited; },
    };
  }

  test("runs the backstop per wake line, marks read only after the key is seen, never for a dropped event, logs no text", async () => {
    const b = bot({ listen_to: "operators", wake_grace_seconds: 0 });
    mkdirSync(join(b.dir, "cache"), { recursive: true });
    writeFileSync(b.wake, JSON.stringify({ account: ACCOUNT, seq: 99, kind: "message" }) + "\n"); // before start: not replayed
    b.setEvents([
      msg(1, C_DM, "3EB0AAAA0000000001", OPER, `operator ${MARKER}`),
      msg(2, C_INT, "3EB0AAAA0000000002", ANN, `non-operator ${MARKER}`),
      reaction(3, C_INT, "3EB0AAAA0000000009", OPER, "👍"),
    ]);
    const w = startWaker(b);
    await ready(w);
    w.wakeLine(1); w.wakeLine(2); w.wakeLine(3, "reaction");
    await sleep(800);
    // one pending wake at a time: lines that join a wake in flight do not start another
    expect(w.nudges().length).toBeGreaterThanOrEqual(1);
    for (const n of w.nudges()) expect(n).toMatch(/^wake backstop --key whatsapp:\S+ --at \S+ --grace 0 --reason whatsapp$/);
    expect(w.marks()).toEqual([]); // nothing seen yet
    const resolves = b.calls().filter((c) => c.argv[0] === "events").map((c) => c.argv.slice(0, 5)).sort((x, y) => Number(x[2]) - Number(y[2]));
    expect(resolves).toEqual([["events", "--after", "0", "--limit", "1"], ["events", "--after", "1", "--limit", "1"], ["events", "--after", "2", "--limit", "1"]]);
    w.seen(`whatsapp:${G_INT}:3EB0AAAA0000000002:msg`); // a dropped event's key, should it appear anyway
    w.seen(`whatsapp:${DM_OPER}:3EB0AAAA0000000001:msg`);
    await sleep(500);
    expect(w.marks()).toEqual([`${DM_OPER}/3EB0AAAA0000000001`]);
    await w.stop();
    expect(w.out()).toContain(`read: whatsapp:${DM_OPER}:3EB0AAAA0000000001:msg`);
    expect(w.out()).toContain("dropped by the reader, not marked");
    expect(w.out()).not.toContain(MARKER);
    expect(w.err()).not.toContain(MARKER);
  });

  test("mark-read: read only when failed is 0; else `mark failed: <reason>`, retried at the next seen-check, at most three times", async () => {
    const b = bot({ wake_grace_seconds: 0 });
    b.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", OPER, `x ${MARKER}`)]);
    writeFileSync(join(b.dir, "mark-fail"), "2"); // fails twice, then marks
    const w = startWaker(b);
    await ready(w);
    w.wakeLine(1);
    w.seen(`whatsapp:${DM_OPER}:3EB0AAAA0000000001:msg`);
    await until(() => w.out().includes("read: whatsapp:"));
    expect(w.marks()).toHaveLength(3);
    expect(w.out().match(/mark failed: not connected/g)).toHaveLength(2);
    expect(w.out()).toContain(`read: whatsapp:${DM_OPER}:3EB0AAAA0000000001:msg`);
    await w.stop();

    const c = bot({ wake_grace_seconds: 0 });
    c.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", OPER, "x")]);
    writeFileSync(join(c.dir, "mark-fail"), "99"); // never marks
    const v = startWaker(c);
    await ready(v);
    v.wakeLine(1);
    v.seen(`whatsapp:${DM_OPER}:3EB0AAAA0000000001:msg`);
    await until(() => v.out().includes("gave up marking"));
    await sleep(300);
    expect(v.marks()).toHaveLength(4); // the first try and three retries
    expect(v.out()).not.toMatch(/^\S+ read:/m);
    expect(v.out()).toContain("gave up marking after 3 retries");
    expect(v.out()).not.toContain(MARKER);
    await v.stop();
  });

  test("mark_read off and own messages mark nothing, even once seen", async () => {
    const b = bot({ mark_read: "off", wake_grace_seconds: 0 });
    b.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", OPER, "x")]);
    const w = startWaker(b);
    await ready(w);
    w.wakeLine(1);
    await sleep(300);
    w.seen(`whatsapp:${DM_OPER}:3EB0AAAA0000000001:msg`);
    await sleep(600);
    expect(w.nudges()).toHaveLength(1);
    expect(w.marks()).toEqual([]);
    expect(w.out()).toContain("mark_read off");
    await w.stop();

    const own = bot({ wake_grace_seconds: 0 });
    own.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", BOT, "mine")]);
    const o = startWaker(own);
    await ready(o);
    o.wakeLine(1);
    o.seen(`whatsapp:${DM_OPER}:3EB0AAAA0000000001:msg`);
    await sleep(600);
    expect(o.marks()).toEqual([]);
    expect(o.out()).toContain("own message, not marked");
    await o.stop();
  });

  // The routine itself (grace, a newer check, a running cycle, asleep, the nudge loop) is the
  // core's `wake backstop`, tested in backstop.test.ts. Here: the waker runs it with the right
  // arguments, one at a time, and logs what it says.
  const KEY1 = `whatsapp:${DM_OPER}:3EB0AAAA0000000001:msg`;
  const one = (whatsapp: Record<string, unknown>) => { const b = bot(whatsapp); b.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", OPER, "x"), msg(2, C_DM, "3EB0AAAA0000000002", OPER, "y"), msg(3, C_DM, "3EB0AAAA0000000003", OPER, "z")]); return b; };

  test("a wake line runs `wake backstop` with its key, time, grace and reason, in the repo, and its line is logged", async () => {
    const b = one({ wake_grace_seconds: 10 });
    const w = startWaker(b, { says: "backstop: woken by monitor" });
    await ready(w);
    const t0 = Date.now();
    w.wakeLine(1);
    await until(() => w.out().includes("woken by monitor"));
    await w.stop();
    expect(w.nudges()).toHaveLength(1);
    const argv = w.nudges()[0]!.split(" ");
    expect(argv.slice(0, 4)).toEqual(["wake", "backstop", "--key", KEY1]);
    expect(Math.abs(Date.parse(argv[5]!) - t0)).toBeLessThan(5000);
    expect(argv.slice(6)).toEqual(["--grace", "10", "--reason", "whatsapp"]);
    expect(w.coreEnv()).toEqual([`tick=50 root=${b.root}`]);
    expect(w.out().match(/woken by monitor/g)).toHaveLength(1);
  });

  test("its notes and its line reach the journal; `gave up` is a ! line naming the key", async () => {
    const b = one({ wake_grace_seconds: 0 });
    const w = startWaker(b, { notes: "nudge pending: nothing · examplebot is working (mid-turn since 15:00Z)", says: "backstop: gave up" });
    await ready(w);
    w.wakeLine(1);
    await until(() => w.out().includes("wake gave up"));
    await w.stop();
    expect(w.out()).toContain("nudge pending: nothing · examplebot is working (mid-turn since 15:00Z)");
    expect(w.out()).toContain(`! wake gave up for ${KEY1}`);
  });

  test("a line with no event behind it still gets a wake, under a key no check records", async () => {
    const b = one({ wake_grace_seconds: 0 });
    const w = startWaker(b);
    await ready(w);
    w.wakeLine(9);
    await until(() => w.out().includes("nudged after"));
    await w.stop();
    expect(w.nudges()).toHaveLength(1);
    expect(w.nudges()[0]).toContain("--key whatsapp:seq:9 ");
  });

  test("a burst of three wake lines: one backstop at a time; the lines that joined it start no second one when it nudged", async () => {
    const b = one({ wake_grace_seconds: 10 });
    const w = startWaker(b, { delayS: 1 });
    await ready(w);
    w.wakeLine(1); w.wakeLine(2); w.wakeLine(3);
    await until(() => w.out().includes("nudged after"));
    await sleep(1500);
    await w.stop();
    expect(w.nudges()).toHaveLength(1);
    expect(w.out().match(/nudged after/g)).toHaveLength(1);
  });

  test("a burst answered by the monitor: one more backstop, for the newest line that joined", async () => {
    const b = one({ wake_grace_seconds: 10 });
    const w = startWaker(b, { delayS: 1, says: "backstop: woken by monitor" });
    await ready(w);
    w.wakeLine(1);
    await sleep(200);
    w.wakeLine(2); w.wakeLine(3);
    await until(() => (w.out().match(/woken by monitor/g) || []).length >= 2);
    await sleep(300);
    await w.stop();
    expect(w.nudges()).toHaveLength(2);
    // lines 2 and 3 resolve concurrently: the one added last is the newest
    expect(w.nudges()[0]).toContain(`--key ${KEY1} `);
    expect(w.nudges()[1]).toMatch(/--key whatsapp:\S+:3EB0AAAA000000000[23]:msg /);
  });

  test("the read receipt waits for the seen key, whatever the backstop said", async () => {
    const b = one({ wake_grace_seconds: 0 });
    const w = startWaker(b, { says: "backstop: nudged after 0s" });
    await ready(w);
    w.wakeLine(1);
    await until(() => w.out().includes("nudged after"));
    await sleep(300);
    expect(w.marks()).toEqual([]);
    w.seen(KEY1);
    await until(() => w.marks().length > 0);
    expect(w.marks()).toEqual([`${DM_OPER}/3EB0AAAA0000000001`]);
    await w.stop();
  });

  test("exits non-zero when the wake file cannot be read", async () => {
    const b = bot();
    mkdirSync(b.wake, { recursive: true }); // a directory where the file should be
    const w = startWaker(b);
    expect(await w.exited).toBe(1);
    expect(w.err()).toContain("cannot open the wake file");
    const gone = bot();
    const g = startWaker(gone);
    await ready(g);
    expect(statSync(gone.wake).mode & 0o777).toBe(0o600); // created on start
    rmSync(gone.wake);
    expect(await g.exited).toBe(1);
    expect(g.err()).toContain("cannot read the wake file");
  });
});

// ----------------------------------------------------------------------------------- the sink

describe("escalate.d/20-whatsapp-dm", () => {
  const sink = (b: ReturnType<typeof bot>, input: string, env: Record<string, string> = {}) =>
    spawnSync("bash", [SINK], { cwd: b.root, encoding: "utf8", input, env: { ...b.env, OPSBOT_CONFIG: join(b.root, "opsbot.json"), ...env } });

  test("sends the message once, opening with the mark, to escalate_chat, the text on stdin", () => {
    const b = bot();
    const r = sink(b, "the loop has stopped", { OPSBOT_MARK: "🧪" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`sent to ${OPER.pn}`);
    expect(b.calls()).toEqual([{ argv: ["send", OPER.pn, "-", "--account", ACCOUNT, "--json-out"], stdin: "🧪 the loop has stopped" }]);
    sink(b, "🧪 already marked", { OPSBOT_MARK: "🧪" });
    expect(b.calls()[1]?.stdin).toBe("🧪 already marked");
  });

  test("exit 1 with one line when it cannot send, or when a setting or the message is missing", () => {
    const b = bot();
    writeFileSync(join(b.dir, "send-error.json"), JSON.stringify({ error: { code: "NOT_CONNECTED", message: "The account is not connected to WhatsApp." } }));
    const r = sink(b, "x");
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("whatsapp-axi send failed: NOT_CONNECTED: The account is not connected to WhatsApp.");
    expect(sink(bot({ escalate_chat: "" }), "x").status).toBe(1);
    expect(sink(bot({ account: "" }), "x").status).toBe(1);
    const e = sink(bot(), "   ");
    expect(e.status).toBe(1);
    expect(e.stderr).toContain("empty message");
  });
});

describe("--json-out files", () => {
  test("every call names a fresh file in a private directory, and none is left behind", () => {
    const b = bot({ ...SCREEN_ALL, peers: [{ name: "otherbot", user: PEER.pn, chats: [G_PEER] }] });
    b.setEvents([msg(1, C_DM, "3EB0AAAA0000000001", OPER, MARKER), reaction(2, C_INT, "3EB0AAAA0000000009", OPER, "👍")]);
    b.reader();
    b.run(["post", G_PEER, "x"]);
    b.run(["status"]);
    spawnSync("bash", [SINK], { cwd: b.root, encoding: "utf8", input: "x", env: { ...b.env, OPSBOT_CONFIG: join(b.root, "opsbot.json") } });
    const withOut = b.outs();
    expect(withOut.length).toBeGreaterThan(8);
    expect(b.calls().filter((c) => !c.argv.includes("--json-out")).map((c) => c.argv[0])).toEqual(["--version"]);
    for (const c of withOut) {
      expect(c.outDirMode).toBe(0o700);
      expect(existsSync(c.out)).toBe(false);
      expect(existsSync(resolve(c.out, ".."))).toBe(false);
    }
    expect(new Set(withOut.map((c) => c.out)).size).toBe(withOut.length);
  });
});

// ----------------------------------------------------------------------------------- install, status

describe("scripts/opsbot-whatsapp install and status", () => {
  const PIECES = ["monitor.d/20-whatsapp-waker", "heartbeat.d/25-whatsapp-events", "escalate.d/20-whatsapp-dm"];

  test("install --dry-run writes nothing; install copies the three scripts and prints the settings, never writing opsbot.json", () => {
    const b = bot({}, { escalate: false });
    const before = readFileSync(join(b.root, "opsbot.json"), "utf8");
    const dry = b.run(["install", "--dry-run"]);
    expect(dry.code).toBe(0);
    for (const p of PIECES) expect(dry.out).toContain(`would write  opsbot.d/${p}`);
    expect(existsSync(join(b.root, "opsbot.d"))).toBe(false);
    const first = b.run(["install"]);
    expect(first.code).toBe(0);
    for (const p of PIECES) {
      const f = join(b.root, "opsbot.d", p);
      expect(readFileSync(f, "utf8")).toBe(readFileSync(join(SKILL, "templates", p), "utf8"));
      expect(statSync(f).mode & 0o111).not.toBe(0);
    }
    expect(first.out).toContain('"whatsapp": {');
    expect(first.out).toContain(`"account": "${ACCOUNT}"`);
    expect(first.out).toContain(`"wake": { "files": [{ "file": "${b.wake}", "inputs": ["25-whatsapp-events"] }] }`);
    expect(first.out).toContain(`whatsapp-axi settings set wake_file ${b.wake} --account ${ACCOUNT}`);
    expect(readFileSync(join(b.root, "opsbot.json"), "utf8")).toBe(before);
    expect(b.calls()).toEqual([]); // install asks nothing of whatsapp-axi and changes nothing there
    writeFileSync(join(b.root, "opsbot.d", PIECES[0]!), "changed\n");
    expect(b.run(["install"]).out).toContain("differs from the template; --force replaces it");
    expect(b.run(["install", "--force"]).out).toContain(`replaced     opsbot.d/${PIECES[0]}`);
    expect(b.run(["install", "--bogus"]).code).toBe(2);
  });

  test("install with nothing set prints the default wake file", () => {
    const b = bot({ account: undefined, wake_file: undefined }, { escalate: false });
    const out = b.run(["install", "--dry-run"]).out;
    expect(out).toContain('"wake_file": "~/.cache/examplebot/whatsapp-wake.jsonl"');
    expect(out).toContain(`whatsapp-axi settings set wake_file ${b.dir}/.cache/examplebot/whatsapp-wake.jsonl --account <account>`);
  });

  test("status: every row ok against the stub, including the scope rows", () => {
    const b = bot({ ...SCREEN_ALL, peers: [{ name: "otherbot", user: PEER.pn, chats: [G_PEER] }] }, { escalate: false });
    b.run(["install"]);
    writeFileSync(join(b.dir, "unit-active"), "");
    const r = b.run(["status"]);
    const rows = r.out.trim().split("\n");
    const pieces = rows.filter((l) => /^(ok|missing|differs) /.test(l)).map((l) => l.split(/\s+/)[1]);
    expect(pieces).toEqual(["streams.whatsapp", "wake.files", "whatsapp-axi", "account", "daemon", "wake_file", "operators", "read_receipts", "scope", "scope", "escalate_chat", "screen", "peers", "peer-chats", ...PIECES, "waker"]);
    expect(r.out).toContain("account tagged; direct messages from operators");
    expect(r.out).toContain(`${G_PEER} full`);
    expect(r.out).toContain(`opsbot-examplebot-monitor-20-whatsapp-waker.service active`);
    expect(r.out.trim().split("\n").pop()).toBe(`status: all ${pieces.length} ok`);
    expect(r.code).toBe(0);
    // status only reads: no send, no settings set, no scope or operators change
    expect(b.calls().map((c) => c.argv.slice(0, 2).join(" ")).filter((a) => !/^(--version|doctor|daemon status|settings show|chat view|groups)/.test(a))).toEqual([]);
  });

  test("status: each problem is a row with its fix", () => {
    const b = bot({ operators: [OPER.pn, "+15550100005"], escalate_chat: DM_EXT, wake_grace_seconds: -5, peers: [{ name: "otherbot", user: PEER.pn, chats: ["120363000000000077@g.us"] }] }, {
      escalate: false, noWakeFiles: true,
      fixtures: {
        [`daemon status ${ACCOUNT}`]: ok({ account: ACCOUNT, service: { unit: `whatsapp-axi@${ACCOUNT}.service`, installed: true, enabled: "enabled", active: "active", sub: "running" }, daemon: { state: "logged_out", reason: "removed on the phone", version: "0.2.0", since: "2030-01-05T14:00:00Z" } }),
        doctor: { code: 1, out: doctorFile([["state", "fail", "logged_out since 2030-01-05"], ["phone", "skipped", "not linked"]]) },
        "settings show": ok({ settings: { scope: "full", dm_from: "anyone", chats: {}, operators: [OPER.pn, "100000000000008@lid"], wake_file: "/elsewhere/wake.jsonl", read_receipts: "off" } }),
      },
    });
    const r = b.run(["status"]);
    expect(r.code).toBe(1);
    const row = (piece: string) => r.out.split("\n").find((l) => l.split(/\s+/)[1] === piece) || "";
    const fixOf = (piece: string) => { const ls = r.out.split("\n"); const i = ls.findIndex((l) => l.split(/\s+/)[1] === piece); return ls[i + 1] || ""; };
    expect(row("wake.files")).toMatch(/^missing/);
    expect(row("daemon")).toMatch(/^differs .*logged_out \(removed on the phone\), not connected; doctor: state: logged_out since 2030-01-05$/);
    expect(row("doctor:state")).toMatch(/^differs\s+doctor:state\s+logged_out since 2030-01-05$/);
    expect(fixOf("doctor:state")).toContain(`fix: run \`whatsapp-axi doctor --account ${ACCOUNT}\``);
    expect(r.out).not.toMatch(/doctor:(phone|hooks)/); // skipped rows and the (all) hooks row are not this bot's
    expect(fixOf("operators")).toContain(`whatsapp-axi operators add +15550100005 --confirm --account ${ACCOUNT}`);
    expect(row("wake_file")).toMatch(/^differs .*\/elsewhere\/wake.jsonl/);
    expect(fixOf("wake_file")).toContain(`whatsapp-axi settings set wake_file ${b.wake} --account ${ACCOUNT}`);
    expect(row("operators")).toContain("not the account's: +15550100005");
    expect(row("operators")).toContain("by hidden id: 100000000000008@lid");
    expect(row("read_receipts")).toMatch(/^differs\s+read_receipts\s+off, not on-read/);
    expect(row("scope")).toMatch(/^ok .*account full; direct messages from anyone/);
    expect(row("escalate_chat")).toMatch(/^differs .*is external/);
    expect(row("peer-chats")).toMatch(/^differs .*not a member of 120363000000000077@g.us/);
    for (const p of PIECES) expect(row(p)).toMatch(/^missing/);
    expect(row("waker")).toMatch(/^missing/);
    expect(row("wake_grace_seconds")).toMatch(/^differs\s+wake_grace_seconds\s+-5 is not a whole number/);
  });

  test("status: whatsapp-axi missing, too old, or the account absent stops the rows that need it", () => {
    const old = bot({}, { escalate: false, fixtures: { doctor: { code: 2, out: null, nofile: true } } });
    writeFileSync(join(old.dir, "version"), "0.1.0");
    const o = old.run(["status"]);
    expect(o.code).toBe(1);
    expect(o.out).toMatch(/missing\s+whatsapp-axi\s+0\.1\.0 wrote no --json-out file for doctor \(exit 2 \(usage\)\): too old for these scripts, which need a whatsapp-axi build with specs\/conventions\.md/);
    // a build from before specs/conventions.md wrote {doctor: […], result}: no checks list is too old too
    const prior = bot({}, { escalate: false, fixtures: { doctor: ok({ doctor: [{ account: ACCOUNT, check: "state", result: "ok", detail: "connected" }], result: "all checks passed" }) } });
    expect(prior.run(["status"]).out).toMatch(/missing\s+whatsapp-axi\s+0\.2\.0 wrote a doctor file with no checks list: too old/);
    expect(o.out).not.toMatch(/^\S+\s+account\s/m);
    const none = bot({ account: "otheracct" }, { escalate: false, fixtures: { doctor: { code: 1, out: { account: "otheracct", summary: "1 failed", checks: [{ account: "otheracct", check: "files", status: "fail", detail: "no such account" }, ...["service", "daemon", "state"].map((check) => ({ account: "otheracct", check, status: "skipped", detail: "no such account" }))] } } } });
    const n = none.run(["status"]);
    expect(n.out).toMatch(/missing\s+account\s+no account otheracct/);
    expect(n.out).toContain("whatsapp-axi account add otheracct");
    const gone = bot({}, { escalate: false });
    rmSync(join(gone.dir, "pathbin", "whatsapp-axi"));
    const g = gone.run(["status"], { env: { OPSBOT_WHATSAPP_AXI: "" } });
    expect(g.out).toMatch(/missing\s+whatsapp-axi\s+not on PATH/);
  });

  test("bad usage and no bot repo are exit 2", () => {
    const b = bot();
    expect(b.run([]).code).toBe(2);
    expect(b.run(["nope"]).code).toBe(2);
    expect(b.run(["status", "--x"]).code).toBe(2);
    rmSync(join(b.root, "opsbot.json"));
    expect(b.run(["status"]).code).toBe(2);
  });
});
