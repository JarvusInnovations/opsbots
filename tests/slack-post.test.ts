/**
 * `opsbot-slack post` and `classify`: the destination class from `slack-axi audience`, the
 * screen, the told-once escalation, the posting identity, the decision log. slack-axi is a
 * stand-in script that prints canned `audience` reports (built with the TOON encoder slack-axi
 * itself uses), Slack's auth.test is a fetch stub preloaded into every node process
 * (NODE_OPTIONS), the screen is a tiny script in the bot's repo, and HOME, XDG_CONFIG_HOME and
 * PATH point into a temp dir: nothing reaches a real workspace, a model, the real home directory
 * or a real tool.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encode } from "@toon-format/toon";

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

/**
 * One `slack-axi audience` report, as slack-axi 1.6.0 prints it: the workspace header, the
 * conversation block, the audience summary, the non-full members (or the definitive empty line).
 * `members` are [id, category, why]; counts are derived from them, so they always add up.
 */
type Member = [string, "full" | "guest" | "external" | "other_workspace" | "deactivated" | "bot" | "unresolved", string];
function report(conversation: Record<string, unknown>, members: Member[], opts: { truncated?: boolean; total?: number | string } = {}) {
  const count = (c: string) => members.filter((m) => m[1] === c).length;
  const total = opts.total ?? members.length;
  const nonFull = members.filter((m) => m[1] !== "full");
  const flags = conversation.kind === "im" ? {} : { is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false };
  return [
    encode({ workspace: `Example (${TEAM})` }),
    encode({ conversation: { is_member: true, ...flags, ...conversation } }),
    encode({ audience: { members_checked: `${members.length} of ${total}`, truncated: opts.truncated ?? false, full: count("full"), guests: count("guest"), external: count("external"), other_workspace: count("other_workspace"), deactivated: count("deactivated"), bots: count("bot"), unresolved: count("unresolved") } }),
    nonFull.length
      ? encode({ non_full_members: nonFull.map(([id, , why]) => ({ id, name: `Name of ${id}`, why })) })
      : encode({ non_full_members: "0 (every checked member is a full member of this workspace)" }),
  ].join("\n") + "\n";
}
const many = (prefix: string, n: number): Member[] => Array.from({ length: n }, (_, i) => [`${prefix}${String(i).padStart(4, "0")}`, "full", ""]);
const bot_: Member = [BOT, "bot", "bot"];
const im = (id: string, other: string, extra: Member[] = []) => report({ id, name: `@${other}`, kind: "im", user: other }, [bot_, [other, "full", ""], ...extra]);
const fail = (msg: string) => `error: "${msg}"\ncode: SLACK_ERROR\n`;

// slack-axi audience output per conversation; `<conv>@<max>` wins when --max-members is <max>.
const AUDIENCE: Record<string, string> = {
  [ESC]: im(ESC, ANN),
  [DMOP]: im(DMOP, OPER),
  [DMANN]: im(DMANN, ANN),
  [DMGUEST]: report({ id: DMGUEST, name: "@guest", kind: "im", user: GUEST }, [bot_, [GUEST, "guest", "multi-channel guest"]]),
  [CHAN]: report({ id: CHAN, name: "#ops", kind: "channel", num_members: 2 }, [bot_, [ANN, "full", ""]]),
  [CONNECT]: report({ id: CONNECT, name: "#shared", kind: "channel", is_shared: true, is_ext_shared: true }, [bot_, [EXT, "external", "other organization (team T0OTHER001)"]]),
  [GUESTS]: report({ id: GUESTS, name: "#guests", kind: "channel" }, [bot_, [ANN, "full", ""], [GUEST, "guest", "multi-channel guest"]]),
  [BIG]: report({ id: BIG, name: "#all", kind: "channel", num_members: 5000 }, many("U0B", 100), { truncated: true, total: 5000 }),
  [BIGPAGES]: report({ id: BIGPAGES, name: "#many", kind: "channel" }, many("U0P", 100), { truncated: true, total: "more than 100" }),
  [`${BIGPAGES}@1000`]: report({ id: BIGPAGES, name: "#many", kind: "channel" }, many("U0P", 180).map(([id]) => [id, "unresolved", "unresolved (user_not_found)"] as Member)),
  [MPIM]: report({ id: MPIM, name: "ann, ext", kind: "mpim" }, [bot_, [ANN, "full", ""], [EXT, "external", "other organization (team T0OTHER001)"]]),
  [MISSING]: fail("conversations.info: not_in_fixture"),
  [BADUSER]: report({ id: BADUSER, name: "#bad", kind: "channel" }, [bot_, ["U0NOSUCH01", "unresolved", "unresolved (user_not_found)"]]),
  [DOWN]: fail("conversations.info: network down"),
};

// The Web API answers only auth.test now: the posting identity.
const FIXTURE: Record<string, unknown> = {
  "auth.test": { ok: true, team_id: TEAM, user_id: BOT },
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
  const v = fx[method];
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

function bot(slack: Record<string, unknown> = {}, opts: { fixture?: Record<string, unknown>; audience?: Record<string, string>; escalate?: boolean } = {}) {
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
  // the slack-axi stand-in; an `old-axi` file in the temp dir makes it a 1.4 without audience
  const bin = join(dir, "pathbin");
  mkdirSync(bin);
  const aud = join(dir, "audience");
  mkdirSync(aud);
  for (const [k, v] of Object.entries(opts.audience ?? AUDIENCE)) writeFileSync(join(aud, k), v);
  writeFileSync(join(bin, "slack-axi"), `#!/usr/bin/env bash
# audience and --version are reads, logged apart so the post path's calls stay as they were
case "$1" in audience|--version) printf '%s\\n' "$*" >> "${dir}/audience-calls.log" ;; *) printf '%s\\n' "$*" >> "${dir}/axi-calls.log" ;; esac
if [ "$1" = --version ]; then if [ -e "${dir}/old-axi" ]; then echo 1.4.1; else echo 1.6.0; fi; exit 0; fi
if [ "$1" = audience ]; then
  if [ -e "${dir}/old-axi" ]; then printf 'error: "Unknown command: audience"\\ncode: VALIDATION_ERROR\\n'; exit 1; fi
  if [ "$2" = --help ]; then echo "usage: slack-axi audience <channel> [flags]"; exit 0; fi
  f="${aud}/$2@$4"; [ -f "$f" ] || f="${aud}/$2"
  if [ -f "$f" ]; then cat "$f"; grep -q '^error:' "$f" && exit 1; exit 0; fi
  echo 'error: "no canned audience"'; exit 1
fi
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
    audience: () => lines("audience-calls.log"),
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

  test("slack-axi audience is asked once, with max_members as its bound and the team when set", () => {
    const b = bot();
    b.run(["classify", CHAN]);
    expect(b.audience()).toEqual([`audience ${CHAN} --max-members 100`]);
    expect(b.api()).toEqual([]);
    const t = bot({ team: TEAM, screen: { max_members: 7 } });
    t.run(["classify", CHAN]);
    expect(t.audience()).toEqual([`audience ${CHAN} --max-members 7 --team ${TEAM}`]);
  });

  test("a large channel is external without listing everyone: by num_members, or once paging passes the bound", () => {
    const b = bot();
    expect(b.run(["classify", BIG]).json).toMatchObject({ class: "external", why: "5000 members, over max_members 100; not all checked" });
    expect(b.run(["classify", BIGPAGES]).json).toMatchObject({ class: "external", why: "over max_members 100 members; not all checked" });
    const raised = bot({ screen: { max_members: 1000 } });
    expect(raised.run(["classify", BIGPAGES]).json.class).toBe("unknown"); // 180 members, none resolved: not established
  });

  test("a class is cached for cache_seconds; unknown is never cached", () => {
    const b = bot();
    expect(b.run(["classify", CHAN]).json.cached).toBe(false);
    const n = b.audience().length;
    expect(b.run(["classify", CHAN]).json).toMatchObject({ class: "internal", cached: true });
    expect(b.audience().length).toBe(n);
    b.run(["classify", MISSING]);
    const m = b.audience().length;
    expect(b.run(["classify", MISSING]).json.cached).toBe(false);
    expect(b.audience().length).toBeGreaterThan(m);
    const cache = JSON.parse(readFileSync(join(b.dir, "cache", "slack-classes.json"), "utf8"));
    expect(Object.keys(cache.convs)).toEqual([CHAN]);
    expect(cache.team).toBe(TEAM);
    const off = bot({ screen: { cache_seconds: 0.001 } });
    off.run(["classify", CHAN]);
    const k = off.audience().length;
    spawnSync("sleep", ["0.05"]);
    expect(off.run(["classify", CHAN]).json.cached).toBe(false);
    expect(off.audience().length).toBeGreaterThan(k);
  });

  test("classify reads no token itself; the post's identity check reads slack-axi's store when SLACK_AXI_TOKEN is unset, and never prints it", () => {
    const b = bot();
    const store = join(b.dir, "config", "slack-axi");
    mkdirSync(join(store, "workspaces", TEAM), { recursive: true });
    writeFileSync(join(store, "config.json"), JSON.stringify({ default_team: TEAM }));
    writeFileSync(join(store, "workspaces", TEAM, "token.json"), JSON.stringify({ token: "xoxb-stored-fake-0000", team_id: TEAM }));
    expect(b.run(["classify", CHAN], { env: { SLACK_AXI_TOKEN: "" } }).json.class).toBe("internal");
    expect(b.api()).toEqual([]);
    const r = b.run(["post", CHAN, "x"], { env: { SLACK_AXI_TOKEN: "" } });
    expect(r.code).toBe(0);
    expect(new Set(b.api().map((c) => c.auth))).toEqual(new Set(["Bearer xoxb-stored-fake-0000"]));
    expect(r.out + r.err).not.toContain("xoxb-");
    const none = bot();
    expect(none.run(["classify", CHAN], { env: { SLACK_AXI_TOKEN: "" } }).json.class).toBe("internal");
    expect(none.run(["post", CHAN, "x"], { env: { SLACK_AXI_TOKEN: "" } }).json.error).toBe("could not confirm the posting identity: no slack-axi workspace to read the bot token from; nothing posted");
  });

  test("bots of the workspace are full members; another workspace of the same org, a deactivated account and an external bot are not", () => {
    const ch = (id: string, members: Member[]) => report({ id, name: "#x", kind: "channel" }, members);
    const b = bot({}, { audience: {
      C0BOTS0001: ch("C0BOTS0001", [bot_, ["U0OTHERB01", "bot", "bot"], [ANN, "full", ""]]),
      C0SIBL0001: ch("C0SIBL0001", [bot_, ["U0SIB00001", "other_workspace", "same org, other workspace (team T0SIB00001)"]]),
      C0GONE0001: ch("C0GONE0001", [bot_, [GONE, "deactivated", "deactivated"]]),
      C0EXTB0001: ch("C0EXTB0001", [bot_, ["U0EXTBOT01", "external", "other organization (team T0OTHER001)"]]),
      C0EMPT0001: ch("C0EMPT0001", []),
      D0NOUSER01: report({ id: "D0NOUSER01", name: "@x", kind: "im" }, [bot_]),
      C0BROKEN01: "workspace: Example (T0TEAM0001)\nconversation:\n  id: C0BROKEN01\n",
    } });
    const cls = (c: string) => b.run(["classify", c]).json;
    expect(cls("C0BOTS0001")).toMatchObject({ class: "internal", why: "not shared; all 3 members are full members" });
    expect(cls("C0SIBL0001")).toMatchObject({ class: "external", why: "U0SIB00001 is from another organization" });
    expect(cls("C0GONE0001")).toMatchObject({ class: "external", why: `${GONE} is deactivated` });
    expect(cls("C0EXTB0001")).toMatchObject({ class: "external", why: "U0EXTBOT01 is from another organization" });
    expect(cls("C0EMPT0001")).toMatchObject({ class: "unknown", why: "lookup failed: slack-axi audience listed no one" });
    expect(cls("D0NOUSER01")).toMatchObject({ class: "unknown", why: "lookup failed: slack-axi audience gave no user for the DM" });
    expect(cls("C0BROKEN01")).toMatchObject({ class: "unknown", why: "lookup failed: slack-axi audience printed no audience block" });
  });

  test("the report as slack-axi's own spec prints it parses: quoted names, a comma in a name, a single-channel guest", () => {
    const sample = [
      "workspace: \"Acme, Inc (T0TEAM0001)\"",
      "conversation:",
      "  id: C0SPEC0001",
      "  name: \"#proj-shared\"",
      "  kind: channel",
      "  is_member: true",
      "  is_shared: false",
      "  is_ext_shared: false",
      "  is_org_shared: false",
      "  is_pending_ext_shared: false",
      "  num_members: 4",
      "audience:",
      "  members_checked: 4 of 4",
      "  truncated: false",
      "  full: 2",
      "  guests: 1",
      "  external: 0",
      "  other_workspace: 0",
      "  deactivated: 0",
      "  bots: 1",
      "  unresolved: 0",
      "non_full_members[2]{id,name,why}:",
      "  U0GUEST002,\"Pat, \\\"P\\\" Partner\",single-channel guest",
      "  U0BUILD001,Build Bot,bot",
      "help[1]:",
      "  Add `--members` to list every member with its flags",
      "",
    ].join("\n");
    const b = bot({}, { audience: { C0SPEC0001: sample } });
    expect(b.run(["classify", "C0SPEC0001"]).json).toMatchObject({ class: "external", why: "U0GUEST002 is a single-channel guest" });
  });

  test("an older slack-axi without audience: every class is unknown, with the upgrade named", () => {
    const b = bot();
    writeFileSync(join(b.dir, "old-axi"), "");
    expect(b.run(["classify", CHAN]).json).toMatchObject({ class: "unknown", why: "lookup failed: slack-axi has no audience command; it needs 1.6.0 or later (npm install -g slack-axi@latest)" });
    // operator-dm needs audience too: unknown, so a screen still runs as external
    expect(b.run(["classify", ESC]).json.class).toBe("unknown");
  });
});

describe("status: the slack-axi audience row", () => {
  test("1.6.0 with audience is ok; an older one is missing with the upgrade", () => {
    expect(bot().run(["status"]).out).toMatch(/^ok\s+slack-axi-audience\s+slack-axi 1\.6\.0 has audience/m);
    const old = bot();
    writeFileSync(join(old.dir, "old-axi"), "");
    const out = old.run(["status"]).out;
    expect(out).toMatch(/^missing\s+slack-axi-audience\s+slack-axi 1\.4\.1 is older than 1\.6\.0/m);
    expect(out).toContain("fix: npm install -g slack-axi@latest");
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
