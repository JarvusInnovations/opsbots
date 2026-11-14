/**
 * `opsbot-slack post` and `classify`: the destination class from Slack's data, the screen, the
 * told-once escalation, the decision log. Slack's Web API is a fetch stub preloaded into every
 * node process (NODE_OPTIONS), slack-axi is a stand-in script, the screen is a tiny script in the
 * bot's repo, and HOME, XDG_CONFIG_HOME and PATH point into a temp dir: nothing reaches a real
 * workspace, a model, the real home directory or a real tool.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SKILL = resolve(import.meta.dir, "..", "skills", "opsbot-slack");
const CLI = join(SKILL, "scripts/opsbot-slack");
const NODE = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();

// Obviously fake ids throughout.
const TEAM = "T0TEAM0001";
const BOT = "U0BOT00001";
const ANN = "U0ANN00001";
const OPER = "U0OPER0001";
const GUEST = "U0GUEST001";
const EXT = "U0EXT00001";
const GONE = "U0GONE0001";
const ESC = "D0ESC00001"; // escalate_dm
const DMOP = "D0DMOP0001"; // a DM with an operator named in `operators`
const DMANN = "D0DMANN001"; // a DM with a full member who is not an operator
const DMGUEST = "D0DMGST001";
const CHAN = "C0CHAN0001"; // internal, members over two pages
const CONNECT = "C0CONN0001";
const GUESTS = "C0GUES0001";
const BIG = "C0BIG00001"; // num_members over the bound
const BIGPAGES = "C0BIGP0001"; // no num_members; the bound is found while paging
const MPIM = "G0MPIM0001";
const MISSING = "C0MISS0001"; // conversations.info fails
const BADUSER = "C0BADU0001"; // a member's users.info fails
const DOWN = "C0DOWN0001"; // the network fails
const TS = "1794400000.000100";

const user = (id: string, extra: Record<string, unknown> = {}) => ({ ok: true, user: { id, team_id: TEAM, ...extra } });
const chan = (id: string, extra: Record<string, unknown> = {}) => ({ ok: true, channel: { id, is_channel: true, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false, ...extra } });
const members = (ids: string[], next = "") => ({ ok: true, members: ids, response_metadata: { next_cursor: next } });
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);

const FIXTURE: Record<string, unknown> = {
  "auth.test": { ok: true, team_id: TEAM, user_id: BOT },
  [`users.info:${BOT}`]: user(BOT, { is_bot: true }),
  [`users.info:${ANN}`]: user(ANN),
  [`users.info:${OPER}`]: user(OPER),
  [`users.info:${GUEST}`]: user(GUEST, { is_restricted: true }),
  [`users.info:${EXT}`]: user(EXT, { team_id: "T0OTHER001", is_stranger: true }),
  [`users.info:${GONE}`]: user(GONE, { deleted: true }),
  [`conversations.info:${ESC}`]: { ok: true, channel: { id: ESC, is_im: true, user: ANN } },
  [`conversations.info:${DMOP}`]: { ok: true, channel: { id: DMOP, is_im: true, user: OPER } },
  [`conversations.info:${DMANN}`]: { ok: true, channel: { id: DMANN, is_im: true, user: ANN } },
  [`conversations.info:${DMGUEST}`]: { ok: true, channel: { id: DMGUEST, is_im: true, user: GUEST } },
  [`conversations.info:${CHAN}`]: chan(CHAN, { num_members: 2 }),
  [`conversations.members:${CHAN}:`]: members([BOT], "page2"),
  [`conversations.members:${CHAN}:page2`]: members([ANN]),
  [`conversations.info:${CONNECT}`]: chan(CONNECT, { is_shared: true, is_ext_shared: true }),
  [`conversations.info:${GUESTS}`]: chan(GUESTS),
  [`conversations.members:${GUESTS}:`]: members([BOT, ANN, GUEST]),
  [`conversations.info:${BIG}`]: chan(BIG, { num_members: 5000 }),
  [`conversations.info:${BIGPAGES}`]: chan(BIGPAGES),
  [`conversations.members:${BIGPAGES}:`]: members(many("U0P1", 60), "p2"),
  [`conversations.members:${BIGPAGES}:p2`]: members(many("U0P2", 60), "p3"),
  [`conversations.members:${BIGPAGES}:p3`]: members(many("U0P3", 60)),
  [`conversations.info:${MPIM}`]: { ok: true, channel: { id: MPIM, is_mpim: true, is_private: true } },
  [`conversations.members:${MPIM}:`]: members([BOT, ANN, EXT]),
  [`conversations.info:${BADUSER}`]: chan(BADUSER),
  [`conversations.members:${BADUSER}:`]: members([BOT, "U0NOSUCH01"]),
  [`conversations.info:${DOWN}`]: "network",
};

// Each test spawns bash, node and git several times; the timeout cases wait a second each.
setDefaultTimeout(30000);

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

const PRELOAD = `
import { appendFileSync, readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync(process.env.FAKE_SLACK, "utf8"));
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://slack.com/api/")) throw new Error("the stub only answers Slack: " + u);
  const method = u.slice("https://slack.com/api/".length);
  const p = Object.fromEntries(new URLSearchParams(init.body));
  appendFileSync(process.env.FAKE_SLACK_LOG, JSON.stringify({ method, p, auth: init.headers.Authorization }) + "\\n");
  const key = method === "conversations.info" ? method + ":" + p.channel
    : method === "conversations.members" ? method + ":" + p.channel + ":" + (p.cursor || "")
    : method === "users.info" ? method + ":" + p.user : method;
  const v = fx[key];
  if (v === "network") throw new Error("network down");
  return { status: 200, json: async () => v ?? { ok: false, error: "not_in_fixture" } };
};
`;

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
else if (mode === "maybe") console.log(JSON.stringify({ verdict: "maybe" }));
else if (mode === "sleep") setTimeout(() => console.log(JSON.stringify({ verdict: "pass" })), 5000);
else { console.error("model gateway refused the key"); process.exit(1); }
`;

function bot(slack: Record<string, unknown> = {}, opts: { fixture?: Record<string, unknown>; escalate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-slack-post-test-"));
  dirs.push(dir);
  const root = join(dir, "bot");
  mkdirSync(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "opsbot.json"), JSON.stringify({
    name: "examplebot", mark: "🧪",
    streams: { slack: { bot_user: BOT, escalate_dm: ESC, events_file: join(dir, "cache", "slack-events.jsonl"), ...slack } },
  }, null, 2));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "screen"), SCREEN);
  chmodSync(join(root, "bin", "screen"), 0o755);
  mkdirSync(join(root, "policy"));
  writeFileSync(join(root, "policy", "internal.md"), "- no personal information\n");
  writeFileSync(join(root, "policy", "external.md"), "- no prices\n");
  if (opts.escalate !== false) {
    mkdirSync(join(root, "opsbot.d", "escalate.d"), { recursive: true });
    writeFileSync(join(root, "opsbot.d", "escalate.d", "10-test"), `#!/usr/bin/env bash\n[ -e "${dir}/escalate-fail" ] && exit 1\n{ cat; echo "---"; } >> "${dir}/escalations.log"\n`);
    chmodSync(join(root, "opsbot.d", "escalate.d", "10-test"), 0o755);
  }
  // the slack-axi stand-in
  const bin = join(dir, "pathbin");
  mkdirSync(bin);
  writeFileSync(join(bin, "slack-axi"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/axi-calls.log"
case "$1 $2" in
  "auth mode") if [ -e "${dir}/human-mode" ]; then printf 'mode:\\n  mode: human\\n'; else printf 'mode:\\n  workspace: Example (${TEAM})\\n  mode: bot\\n'; fi ;;
  "draft send") if [ -e "${dir}/fail-send" ]; then echo 'error: "stand-in failure for send"'; exit 1; fi; printf 'sent: d_1a2b3c4d\\nts: "1794400999.000100"\\n' ;;
  draft*) printf 'draft: d_1a2b3c4d\\nmode: bot\\n' ;;
  *) echo "error: no canned output for $*"; exit 1 ;;
esac
`);
  chmodSync(join(bin, "slack-axi"), 0o755);
  symlinkSync(NODE, join(bin, "node"));
  const preload = join(dir, "fake-slack.mjs");
  writeFileSync(preload, PRELOAD);
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(opts.fixture ?? FIXTURE));
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"),
    OPSBOT_SLACK_AXI: join(bin, "slack-axi"), SLACK_AXI_TOKEN: "xoxb-fake-test-token",
    NODE_OPTIONS: `--import ${preload}`, FAKE_SLACK: join(dir, "fixture.json"), FAKE_SLACK_LOG: join(dir, "slack-api.log"), TEST_DIR: dir,
  };
  const run = (args: string[], o: { input?: string; env?: Record<string, string> } = {}) => {
    const r = spawnSync("bash", [CLI, ...args], { cwd: root, encoding: "utf8", input: o.input ?? "", env: { ...env, ...(o.env ?? {}) }, timeout: 30000 });
    let json: Record<string, any> = {};
    try { json = JSON.parse(r.stdout.trim().split("\n").pop() || "{}"); } catch { json = {}; }
    return { code: r.status, out: r.stdout, err: r.stderr, json };
  };
  const lines = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean) : []);
  return {
    dir, root, env, run,
    api: () => lines("slack-api.log").map((l) => JSON.parse(l)),
    axi: () => lines("axi-calls.log"),
    screens: () => lines("screen-calls.jsonl").map((l) => JSON.parse(l)),
    escalations: () => (existsSync(join(dir, "escalations.log")) ? readFileSync(join(dir, "escalations.log"), "utf8").split("---\n").filter((s) => s.trim()) : []),
    log: () => (existsSync(join(root, "logs/slack-posts.jsonl")) ? readFileSync(join(root, "logs/slack-posts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    mode: (m: string) => writeFileSync(join(dir, "screen-mode"), m),
  };
}

const SCREEN_ALL = { screen: { command: "bin/screen", policy: { internal: ["policy/internal.md"], external: ["policy/internal.md", "policy/external.md"] } } };
const posted = (b: ReturnType<typeof bot>) => b.axi().filter((l) => l.startsWith("draft send"));

test("node --check passes for the post script and the reference screen (which no test runs)", () => {
  expect(spawnSync(NODE, ["--check", join(SKILL, "scripts/slack-post.mjs")]).status).toBe(0);
  expect(spawnSync(NODE, ["--check", join(SKILL, "templates/screen/screen")]).status).toBe(0);
});

describe("classify: the destination from Slack's own data", () => {
  test("each class from fixtures, with the reason", () => {
    const b = bot({ operators: [OPER] });
    const cls = (conv: string) => { const r = b.run(["classify", conv]); expect(r.code).toBe(0); return r.json; };
    expect(cls(DMOP)).toMatchObject({ class: "operator-dm", why: `a DM with the operator ${OPER}` });
    expect(cls(ESC)).toMatchObject({ class: "operator-dm" });
    expect(cls(DMANN)).toMatchObject({ class: "internal", why: `a DM with ${ANN}, a full member` });
    expect(cls(DMGUEST)).toMatchObject({ class: "external", why: `a DM with ${GUEST}, a guest` });
    expect(cls(CHAN)).toMatchObject({ class: "internal", why: "not shared; all 2 members are full members" });
    expect(cls(CONNECT)).toMatchObject({ class: "external", why: "is_ext_shared is true" });
    expect(cls(GUESTS)).toMatchObject({ class: "external", why: `${GUEST} is a guest` });
    expect(cls(MPIM)).toMatchObject({ class: "external", why: `${EXT} is from another organization` });
    expect(cls(MISSING)).toMatchObject({ class: "unknown", why: "lookup failed: conversations.info: not_in_fixture" });
    expect(cls(BADUSER)).toMatchObject({ class: "unknown" });
    expect(cls(DOWN)).toMatchObject({ class: "unknown", why: "lookup failed: conversations.info: network down" });
  });

  test("a DM with a non-operator who is not in operators is internal; with no operators set, only escalate_dm is operator-dm", () => {
    const b = bot();
    expect(b.run(["classify", DMOP]).json.class).toBe("internal");
    expect(b.run(["classify", ESC]).json.class).toBe("operator-dm");
  });

  test("members are paged to the last cursor; every member is looked up", () => {
    const b = bot();
    b.run(["classify", CHAN]);
    const calls = b.api();
    expect(calls.filter((c) => c.method === "conversations.members").map((c) => c.p.cursor ?? "")).toEqual(["", "page2"]);
    expect(calls.filter((c) => c.method === "users.info").map((c) => c.p.user).sort()).toEqual([ANN, BOT].sort());
    expect(calls.find((c) => c.method === "conversations.info")!.p).toEqual({ channel: CHAN, include_num_members: "true" });
  });

  test("a large channel is external without listing everyone: by num_members, or once paging passes the bound", () => {
    const b = bot();
    expect(b.run(["classify", BIG]).json).toMatchObject({ class: "external", why: "5000 members, over max_members 100; not all checked" });
    expect(b.api().some((c) => c.method === "conversations.members" || c.method === "users.info")).toBe(false);
    expect(b.run(["classify", BIGPAGES]).json).toMatchObject({ class: "external", why: "over max_members 100 members; not all checked" });
    expect(b.api().filter((c) => c.method === "conversations.members").map((c) => c.p.cursor ?? "")).toEqual(["", "p2"]);
    expect(b.api().some((c) => c.method === "users.info")).toBe(false);
    const raised = bot({ screen: { max_members: 1000 } });
    expect(raised.run(["classify", BIGPAGES]).json.class).toBe("unknown"); // 180 members, none in the fixture: not established
  });

  test("a class is cached for cache_seconds; unknown is never cached", () => {
    const b = bot();
    expect(b.run(["classify", CHAN]).json.cached).toBe(false);
    const n = b.api().length;
    expect(b.run(["classify", CHAN]).json).toMatchObject({ class: "internal", cached: true });
    expect(b.api().length).toBe(n);
    b.run(["classify", MISSING]);
    const m = b.api().length;
    expect(b.run(["classify", MISSING]).json.cached).toBe(false);
    expect(b.api().length).toBeGreaterThan(m);
    const cache = JSON.parse(readFileSync(join(b.dir, "cache", "slack-classes.json"), "utf8"));
    expect(Object.keys(cache.convs)).toEqual([CHAN]);
    const off = bot({ screen: { cache_seconds: 0.001 } });
    off.run(["classify", CHAN]);
    const k = off.api().length;
    spawnSync("sleep", ["0.05"]);
    expect(off.run(["classify", CHAN]).json.cached).toBe(false);
    expect(off.api().length).toBeGreaterThan(k);
  });

  test("the bot token comes from slack-axi's own store when SLACK_AXI_TOKEN is unset, and is never printed", () => {
    const b = bot();
    const store = join(b.dir, "config", "slack-axi");
    mkdirSync(join(store, "workspaces", TEAM), { recursive: true });
    writeFileSync(join(store, "config.json"), JSON.stringify({ default_team: TEAM }));
    writeFileSync(join(store, "workspaces", TEAM, "token.json"), JSON.stringify({ token: "xoxb-stored-fake-0000", team_id: TEAM }));
    const r = b.run(["classify", CHAN], { env: { SLACK_AXI_TOKEN: "" } });
    expect(r.json.class).toBe("internal");
    expect(new Set(b.api().map((c) => c.auth))).toEqual(new Set(["Bearer xoxb-stored-fake-0000"]));
    expect(r.out + r.err).not.toContain("xoxb-");
    const none = bot();
    expect(none.run(["classify", CHAN], { env: { SLACK_AXI_TOKEN: "" } }).json).toMatchObject({ class: "unknown", why: "lookup failed: no slack-axi workspace to read the bot token from" });
    expect(none.api()).toEqual([]);
  });
});

describe("post without a screen: posting as before, the class logged", () => {
  test("posts once through slack-axi at the reply address; the class and a hash are logged, never the text", () => {
    const b = bot();
    const r = b.run(["post", CHAN, "--reply", TS, "the report is attached"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ posted: true, conv: CHAN, ts: "1794400999.000100", class: "internal", screen: "skipped" });
    expect(b.axi()).toEqual(["auth mode", `draft ${CHAN} --reply ${TS} the report is attached`, "draft send d_1a2b3c4d"]);
    expect(b.screens()).toEqual([]);
    const [line] = b.log();
    expect(line).toMatchObject({ conv: CHAN, reply_to: TS, class: "internal", screen: "skipped", posted: true, ts: "1794400999.000100" });
    expect(line.draft_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(b.root, "logs/slack-posts.jsonl"), "utf8")).not.toContain("report is attached");
  });

  test("a failed lookup does not stop the post; the text can come on stdin", () => {
    const b = bot();
    const r = b.run(["post", MISSING, "-"], { input: "from stdin\nsecond line" });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ posted: true, class: "unknown", screen: "skipped" });
    expect(posted(b)).toHaveLength(1);
  });

  test("bad usage posts nothing and asks Slack nothing: exit 2", () => {
    const b = bot();
    expect(b.run(["post"]).code).toBe(2);
    expect(b.run(["post", "general", "x"]).code).toBe(2);
    expect(b.run(["post", CHAN, "--reply", "yesterday", "x"]).code).toBe(2);
    expect(b.run(["post", CHAN, "  \n"]).code).toBe(2);
    expect(b.run(["post", CHAN, "one", "two"]).code).toBe(2);
    expect(b.run(["post", CHAN, "--loud", "x"]).code).toBe(2);
    expect(b.axi()).toEqual([]);
    expect(b.api()).toEqual([]);
    rmSync(join(b.root, "opsbot.json"));
    expect(b.run(["post", CHAN, "x"]).code).toBe(2);
  });

  test("slack-axi in human mode, or a failed send: exit 1, logged as not posted", () => {
    const b = bot();
    writeFileSync(join(b.dir, "human-mode"), "");
    const r = b.run(["post", CHAN, "x"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("bot mode");
    expect(b.axi()).toEqual(["auth mode"]);
    rmSync(join(b.dir, "human-mode"));
    writeFileSync(join(b.dir, "fail-send"), "");
    const s = b.run(["post", CHAN, "x"]);
    expect(s.code).toBe(1);
    expect(s.json.error).toContain("stand-in failure for send");
    expect(b.log().map((l) => l.posted)).toEqual([false, false]);
  });
});

describe("post with a screen", () => {
  test("the screen gets exactly the draft, the class and the policy files joined in order; pass posts", () => {
    const b = bot(SCREEN_ALL);
    const r = b.run(["post", GUESTS, "--reply", TS, "draft for the channel"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ posted: true, class: "external", screen: "pass" });
    expect(b.screens()).toEqual([{ draft: "draft for the channel", destination_class: "external", policy: "- no personal information\n\n- no prices" }]);
    expect(posted(b)).toHaveLength(1);
    const i = bot(SCREEN_ALL);
    i.run(["post", CHAN, "x"]);
    expect(i.screens()).toEqual([{ draft: "x", destination_class: "internal", policy: "- no personal information" }]);
  });

  test("operator-dm never calls the screen, by operators or by escalate_dm", () => {
    const b = bot({ ...SCREEN_ALL, operators: [OPER] });
    b.mode("error");
    expect(b.run(["post", DMOP, "x"]).json).toMatchObject({ posted: true, class: "operator-dm", screen: "skipped" });
    expect(b.run(["post", ESC, "y"]).json).toMatchObject({ posted: true, class: "operator-dm", screen: "skipped" });
    expect(b.screens()).toEqual([]);
    expect(b.escalations()).toEqual([]);
  });

  test("a class with no policy list is not screened: only external named, an internal DM posts unscreened", () => {
    const b = bot({ screen: { command: "bin/screen", policy: { external: ["policy/internal.md", "policy/external.md"] } } });
    expect(b.run(["post", DMANN, "x"]).json).toMatchObject({ posted: true, class: "internal", screen: "skipped" });
    expect(b.screens()).toEqual([]);
  });

  test("unknown is screened with the external policy, as unknown", () => {
    const b = bot(SCREEN_ALL);
    b.run(["post", MISSING, "x"]);
    expect(b.screens()).toEqual([{ draft: "x", destination_class: "unknown", policy: "- no personal information\n\n- no prices" }]);
  });

  test("a blocked draft is never posted: exit 3 with the passage and the reason; the log has the reason, not the passage", () => {
    const b = bot(SCREEN_ALL);
    b.mode("block");
    const r = b.run(["post", CONNECT, "--reply", TS, "sure, the rate is 180 an hour"]);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ posted: false, class: "external", screen: "block", passage: "the rate is 180 an hour", reason: "prices are not said outside" });
    expect(b.axi()).toEqual([]);
    expect(b.log()).toEqual([expect.objectContaining({ class: "external", screen: "block", reason: "prices are not said outside", posted: false })]);
    expect(readFileSync(join(b.root, "logs/slack-posts.jsonl"), "utf8")).not.toContain("180");
    expect(b.escalations()).toEqual([]);
  });

  for (const [mode, error] of [["error", "exit 1: model gateway refused the key"], ["garbage", "the output was not JSON"], ["maybe", 'unknown verdict: "maybe"'], ["sleep", "timed out after 1 s"]] as const) {
    test(`a screen that fails (${mode}) posts nothing: exit 4, the operator told once per outage`, () => {
      const b = bot({ screen: { ...SCREEN_ALL.screen, timeout_seconds: 1 } });
      b.mode(mode);
      const first = b.run(["post", CONNECT, "x"]);
      expect(first.code).toBe(4);
      expect(first.json).toMatchObject({ posted: false, class: "external", screen: "error", error, operator: "the operator was told" });
      const second = b.run(["post", GUESTS, "y"]);
      expect(second.code).toBe(4);
      expect(second.json.operator).toBe("the operator was already told about this outage");
      expect(b.axi()).toEqual([]);
      const told = b.escalations();
      expect(told).toHaveLength(1);
      expect(told[0]).toStartWith("🧪 examplebot could not screen a reply to a external conversation");
      expect(told[0]).toContain(error);
      expect(told[0]).not.toContain("x\n");
      expect(b.log().map((l) => [l.screen, l.posted])).toEqual([["error", false], ["error", false]]);
    });
  }

  test("a verdict ends the outage: the next failure tells the operator again", () => {
    const b = bot(SCREEN_ALL);
    b.mode("error");
    b.run(["post", CONNECT, "x"]);
    expect(existsSync(join(b.root, ".git", "opsbot-slack-screen"))).toBe(true);
    b.mode("block");
    expect(b.run(["post", CONNECT, "x"]).code).toBe(3);
    expect(existsSync(join(b.root, ".git", "opsbot-slack-screen"))).toBe(false);
    b.mode("error");
    b.run(["post", CONNECT, "x"]);
    expect(b.escalations()).toHaveLength(2);
  });

  test("when no escalation script succeeds the marker is not kept, so the next failure tries again", () => {
    const b = bot(SCREEN_ALL);
    b.mode("error");
    writeFileSync(join(b.dir, "escalate-fail"), "");
    expect(b.run(["post", CONNECT, "x"]).json.operator).toBe("could not tell the operator: every escalation script failed");
    expect(existsSync(join(b.root, ".git", "opsbot-slack-screen"))).toBe(false);
    rmSync(join(b.dir, "escalate-fail"));
    expect(b.run(["post", CONNECT, "x"]).json.operator).toBe("the operator was told");
    const none = bot(SCREEN_ALL, { escalate: false });
    none.mode("error");
    expect(none.run(["post", CONNECT, "x"]).json.operator).toBe("could not tell the operator: no script in opsbot.d/escalate.d/");
  });

  test("an unusable screen setting posts nothing for a screened class: exit 2", () => {
    const outside = bot({ screen: { command: "/bin/true", policy: { external: ["policy/external.md"] } } });
    const r = outside.run(["post", CONNECT, "x"]);
    expect(r.code).toBe(2);
    expect(r.json.error).toContain("must be a path inside the repo");
    expect(outside.axi()).toEqual([]);
    const missing = bot({ screen: { command: "bin/screen", policy: { external: ["policy/nope.md"] } } });
    expect(missing.run(["post", CONNECT, "x"]).code).toBe(2);
    expect(missing.screens()).toEqual([]);
    // the operator's DM is never screened, so a broken setting does not stop it
    expect(missing.run(["post", ESC, "x"]).code).toBe(0);
  });

  test("--dry-run classifies and screens, and posts nothing", () => {
    const b = bot(SCREEN_ALL);
    const r = b.run(["post", CONNECT, "--dry-run", "x"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ posted: false, dry_run: true, would_post: true, class: "external", screen: "pass" });
    expect(b.screens()).toHaveLength(1);
    expect(b.axi()).toEqual([]);
    expect(b.log()).toEqual([expect.objectContaining({ dry_run: true, posted: false })]);
  });
});

describe("status: the screen row", () => {
  test("absent screen adds no row; a usable one is ok; a broken one is differs", () => {
    const b = bot(SCREEN_ALL);
    expect(b.run(["status"]).out).toMatch(/^ok\s+screen\s+bin\/screen; screens internal and external/m);
    const broken = bot({ screen: { command: "bin/nope", policy: { external: ["policy/gone.md"] } } });
    const out = broken.run(["status"]).out;
    expect(out).toMatch(/^differs\s+screen\s+command is not an executable file: bin\/nope; policy file missing: policy\/gone\.md/m);
    expect(bot().run(["status"]).out).not.toMatch(/\bscreen\b/);
  });
});

describe("the posting identity", () => {
  const someone = { ...FIXTURE, "auth.test": { ok: true, team_id: TEAM, user_id: ANN, user: "ann" } };
  const authCalls = (b: ReturnType<typeof bot>) => b.api().filter((c) => c.method === "auth.test");

  test("a token that is not bot_user's refuses the post: exit 5, nothing sent, logged", () => {
    const b = bot({}, { fixture: someone });
    const r = b.run(["post", CHAN, "--reply", TS, "hello"]);
    expect(r.code).toBe(5);
    expect(r.json).toMatchObject({ posted: false, conv: CHAN, identity: { user: ANN, name: "ann" } });
    expect(r.json.error).toContain(`slack-axi would post as ${ANN} (ann), not as bot_user ${BOT}`);
    expect(b.axi()).toEqual([]);
    expect(b.log()).toEqual([expect.objectContaining({ posted: false, error: r.json.error })]);
    expect(r.out + r.err).not.toContain("xoxb-fake");
  });

  test("an auth.test that fails refuses too", () => {
    const b = bot({}, { fixture: { ...FIXTURE, "auth.test": { ok: false, error: "invalid_auth" } } });
    const r = b.run(["post", ESC, "hello"]);
    expect(r.code).toBe(5);
    expect(r.json.error).toBe("could not confirm the posting identity: auth.test: invalid_auth; nothing posted");
    expect(b.axi()).toEqual([]);
  });

  test("a match posts, and is cached under the token: a changed token is asked again", () => {
    const b = bot();
    expect(b.run(["post", ESC, "one"]).code).toBe(0);
    const first = authCalls(b).length;
    expect(b.run(["post", ESC, "two"]).code).toBe(0);
    expect(authCalls(b).length).toBe(first); // class and identity both cached
    const cache = JSON.parse(readFileSync(join(b.dir, "cache", "slack-classes.json"), "utf8"));
    expect(cache.identity).toMatchObject({ user: BOT, team: TEAM });
    expect(cache.identity.token).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(cache)).not.toContain("xoxb-");
    expect(b.run(["post", ESC, "three"], { env: { SLACK_AXI_TOKEN: "xoxb-another-fake-token" } }).code).toBe(0);
    expect(authCalls(b).length).toBe(first + 1);
    expect(authCalls(b).at(-1)!.auth).toBe("Bearer xoxb-another-fake-token");
  });

  test("a mismatch is never cached: the next post asks again", () => {
    const b = bot({}, { fixture: someone });
    b.run(["post", ESC, "x"]);
    const n = authCalls(b).length;
    expect(b.run(["post", ESC, "x"]).code).toBe(5);
    expect(authCalls(b).length).toBe(n + 1);
  });

  test("with bot_user unset nothing is checked; --dry-run does not check", () => {
    const b = bot({ bot_user: undefined }, { fixture: someone });
    expect(b.run(["post", ESC, "x"]).code).toBe(0);
    const d = bot({}, { fixture: someone });
    expect(d.run(["post", ESC, "--dry-run", "x"]).json).toMatchObject({ dry_run: true, would_post: true });
  });

  test("the token is resolved in slack-axi's order: team, then default, then the only one", () => {
    const b = bot({ team: "T0SECOND01" });
    const store = join(b.dir, "config", "slack-axi");
    for (const [team, tok] of [[TEAM, "xoxb-default-fake"], ["T0SECOND01", "xoxb-second-fake"]]) {
      mkdirSync(join(store, "workspaces", team!), { recursive: true });
      writeFileSync(join(store, "workspaces", team!, "token.json"), JSON.stringify({ token: tok, team_id: team }));
    }
    writeFileSync(join(store, "config.json"), JSON.stringify({ default_team: TEAM }));
    b.run(["post", ESC, "x"], { env: { SLACK_AXI_TOKEN: "", SLACK_AXI_TEAM: TEAM } });
    expect(new Set(authCalls(b).map((c) => c.auth))).toEqual(new Set(["Bearer xoxb-second-fake"]));
  });

  test("status: the identity row is ok on a match, differs on a mismatch, missing without a token", () => {
    expect(bot().run(["status"]).out).toMatch(new RegExp(`^ok\\s+identity\\s+posts as ${BOT}, bot_user`, "m"));
    expect(bot({}, { fixture: someone }).run(["status"]).out).toMatch(new RegExp(`^differs\\s+identity\\s+posts as ${ANN} \\(ann\\), not bot_user ${BOT}`, "m"));
    const none = bot().run(["status"], { env: { SLACK_AXI_TOKEN: "" } });
    expect(none.out).toMatch(/^missing\s+identity\s+no posting identity: no slack-axi workspace to read the bot token from/m);
    expect(none.out + none.err).not.toContain("xoxb-fake");
  });
});
