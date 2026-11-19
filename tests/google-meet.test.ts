/**
 * opsbot-google, the Meet source: the listener, the 25-meet-transcripts reader with its enrich
 * hook, login, ensure, install and status, against a stand-in Google (Workspace Events, Pub/Sub,
 * Meet REST, the token endpoint) started here, the scripts pointed at it by the test-only
 * OPSBOT_GOOGLE_*_URL variables. No test touches Google. The core is a stand-in that logs each
 * `wake backstop`. HOME is a temp dir; every value is invented.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(60000);

const SKILL = resolve(import.meta.dir, "..", "skills", "opsbot-google");
const CLI = join(SKILL, "scripts/opsbot-google");
const LIB = join(SKILL, "scripts/google-push.mjs");
const LISTENER = join(SKILL, "templates/monitor.d/35-meet-transcripts");
const READER = join(SKILL, "templates/heartbeat.d/25-meet-transcripts");
const NODE = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();

const ACCOUNT = "bot@example.com";
const USER_ID = "100000000000000000001";
const TARGET = `//cloudidentity.googleapis.com/users/${USER_ID}`;
const TOPIC = "projects/example-project/topics/example-meet-topic";
const SUB = "projects/example-project/subscriptions/example-meet-sub";
const EVENT = "google.workspace.meet.transcript.v2.fileGenerated";
const SCOPES_MEET = "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/pubsub";
const SCOPES_GMAIL = "https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/pubsub";
const MARK = "SPOKEN-WORDS-7f3e"; // only in the transcript's entries and the document's text, which must never be read
const SETTINGS = { enabled: true, account: ACCOUNT, user_id: USER_ID, project: "example-project", topic: "example-meet-topic", subscription: "example-meet-sub", problem_after_minutes: 0.01 };
const TR = "conferenceRecords/conf-1/transcripts/tr-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 15000) => { for (const t = Date.now(); !ok() && Date.now() - t < ms; ) await sleep(50); return ok(); };

// ------------------------------------------------------------------ the stand-in Google

type Sub = { name: string; state: string; expireTime: string; targetResource: string; eventTypes: string[]; notificationEndpoint: { pubsubTopic: string } };
interface Google {
  url: string;
  requests: Array<{ method: string; path: string; body: any }>;
  queue: Array<{ ackId: string; data: string; attributes: Record<string, string> }>;
  subs: Sub[];
  pullStatus: number;
  listStatus: number;
  meetStatus: number;
  pendingOps: boolean;
  grantScope: string;
  onAck: () => void;
  transcript(name?: string): void;
  lifecycle(kind: "expirationReminder" | "expired" | "suspended"): void;
  stop(): void;
}
let servers: Google[] = [];
let dirs: string[] = [];
let kids: Array<{ kill: () => void }> = [];
afterEach(() => {
  for (const k of kids) k.kill();
  kids = [];
  for (const s of servers) s.stop();
  servers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const later = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

function google(): Google {
  let n = 0, made = 0;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  const g: Google = {
    url: "", requests: [], queue: [], subs: [], pullStatus: 200, listStatus: 200, meetStatus: 200, pendingOps: false, grantScope: SCOPES_MEET, onAck: () => {},
    transcript(name = TR) {
      const id = ++n;
      g.queue.push({ ackId: `ack-${id}`, data: b64({ transcript: { name } }), attributes: { "ce-type": EVENT, "ce-subject": `//meet.googleapis.com/${name}`, "ce-id": `ev-${id}`, "ce-time": new Date().toISOString() } });
    },
    lifecycle(kind) {
      const id = ++n;
      const sub = g.subs[0]?.name || "subscriptions/sub-x";
      g.queue.push({ ackId: `ack-${id}`, data: b64({ subscription: { name: sub, expireTime: later(0.04), ...(kind === "suspended" ? { suspensionReason: "USER_SCOPE_REVOKED" } : {}) } }), attributes: { "ce-type": `google.workspace.events.subscription.v1.${kind}`, "ce-id": `ev-${id}`, "ce-time": new Date().toISOString() } });
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const text = await req.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); }
      g.requests.push({ method: req.method, path: u.pathname + u.search, body });
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
      const operation = (sub: Sub) => (g.pendingOps ? (pending.set(`operations/op-${made}`, sub), json({ name: `operations/op-${made}` })) : json({ name: `operations/op-${made}`, done: true, response: sub }));
      if (u.pathname === "/token") {
        if (body.grant_type === "refresh_token") return json({ access_token: `at-refreshed-${Date.now()}`, expires_in: 3600, scope: SCOPES_MEET, token_type: "Bearer" });
        if (body.grant_type === "authorization_code") return json({ access_token: "at-first", refresh_token: "rt-secret-1", expires_in: 3600, scope: g.grantScope, token_type: "Bearer" });
        return json({ error: "unsupported_grant_type" }, 400);
      }
      // Workspace Events
      if (u.pathname === "/v1/subscriptions" && req.method === "GET") {
        if (g.listStatus !== 200) return json({ error: { code: g.listStatus, status: "INTERNAL" } }, g.listStatus);
        const f = u.searchParams.get("filter") || "";
        const hit = g.subs.filter((s) => f.includes(`target_resource="${s.targetResource}"`) && s.eventTypes.some((e) => f.includes(`event_types:"${e}"`)));
        // two pages, to prove the paging
        if (u.searchParams.get("pageToken") === "p2") return json({ subscriptions: hit.slice(1) });
        return json({ subscriptions: hit.slice(0, 1), ...(hit.length > 1 ? { nextPageToken: "p2" } : {}) });
      }
      if (u.pathname === "/v1/subscriptions" && req.method === "POST") {
        made++;
        const sub: Sub = { name: `subscriptions/made-${made}`, state: "ACTIVE", expireTime: later(7), targetResource: body.targetResource, eventTypes: body.eventTypes, notificationEndpoint: body.notificationEndpoint };
        g.subs.push(sub);
        return operation(sub);
      }
      const op = /^\/v1\/(operations\/[^/]+)$/.exec(u.pathname);
      if (op && pending.has(op[1]!)) return json({ name: op[1], done: true, response: pending.get(op[1]!) });
      const sm = /^\/v1\/(subscriptions\/[^/:]+)(:reactivate)?$/.exec(u.pathname);
      if (sm) {
        const sub = g.subs.find((s) => s.name === sm[1]);
        if (!sub) return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
        made++;
        if (sm[2] && req.method === "POST") { sub.state = "ACTIVE"; sub.expireTime = later(7); return operation(sub); }
        if (req.method === "PATCH") { sub.expireTime = later(7); return operation(sub); }
      }
      // Meet REST
      if (u.pathname.startsWith("/v2/")) {
        if (g.meetStatus !== 200) return json({ error: { code: g.meetStatus, status: "UNAVAILABLE" } }, g.meetStatus);
        const p = u.pathname.slice(4);
        if (/^conferenceRecords\/[^/]+\/transcripts\/[^/]+\/entries/.test(p)) return json({ transcriptEntries: [{ text: MARK }] });
        const t = /^conferenceRecords\/([^/]+)\/transcripts\/([^/]+)$/.exec(p);
        if (t) return json({ name: p, state: "FILE_GENERATED", startTime: "2030-01-02T15:00:05Z", endTime: "2030-01-02T15:44:50Z", docsDestination: { document: `doc-${t[2]}`, exportUri: `https://docs.example.invalid/document/d/doc-${t[2]}/export?format=txt` } });
        const c = /^conferenceRecords\/([^/]+)$/.exec(p);
        if (c) return json({ name: p, startTime: "2030-01-02T15:00:00Z", endTime: "2030-01-02T15:45:00Z", expireTime: "2030-02-01T15:45:00Z", space: `spaces/space-${c[1]}` });
        const sp = /^spaces\/([^/]+)$/.exec(p);
        if (sp) return json({ name: p, meetingUri: "https://meet.example.invalid/abc-defg-hij", meetingCode: "abc-defg-hij" });
        return json({ error: { code: 404 } }, 404);
      }
      // Pub/Sub
      if (u.pathname === `/v1/${SUB}:pull`) {
        if (g.pullStatus !== 200) return json({ error: { code: g.pullStatus, status: "UNAVAILABLE" } }, g.pullStatus);
        if (!g.queue.length) { await sleep(body.returnImmediately ? 0 : 100); return json({}); }
        return json({ receivedMessages: g.queue.map((m) => ({ ackId: m.ackId, message: { data: m.data, attributes: m.attributes, messageId: m.ackId, publishTime: new Date().toISOString() } })) });
      }
      if (u.pathname === `/v1/${SUB}:acknowledge`) {
        g.onAck();
        g.queue = g.queue.filter((m) => !body.ackIds.includes(m.ackId));
        return json({});
      }
      if (u.pathname === `/v1/${SUB}:modifyAckDeadline`) return json({});
      return json({ error: { code: 404 } }, 404);
    },
  });
  const pending = new Map<string, Sub>();
  g.url = `http://127.0.0.1:${server.port}`;
  servers.push(g);
  return g;
}

const other = (state = "ACTIVE"): Sub => ({ name: "subscriptions/someone-elses", state, expireTime: later(1), targetResource: TARGET, eventTypes: [EVENT], notificationEndpoint: { pubsubTopic: "projects/example-project/topics/another-topic" } });
const ours = (state = "ACTIVE"): Sub => ({ name: "subscriptions/ours-1", state, expireTime: later(0.5), targetResource: TARGET, eventTypes: [EVENT], notificationEndpoint: { pubsubTopic: TOPIC } });

// ------------------------------------------------------------------ a bot

function bot(g: Google, meet: Record<string, unknown> = {}, opts: { token?: Record<string, unknown> | null; gmail?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-google-meet-test-"));
  dirs.push(dir);
  const root = join(dir, "bot");
  mkdirSync(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  const wake = join(dir, ".cache/examplebot/meet-push.jsonl");
  const state = join(dir, ".cache/examplebot/meet-push-state.json");
  const cache = join(dir, ".cache/examplebot/meet-push-cache.json");
  const tokenFile = join(dir, ".config/examplebot/google-push-token.json");
  const settings: Record<string, any> = { name: "examplebot", streams: { meet_push: { ...SETTINGS, ...meet } }, wake: { files: [{ file: "~/.cache/examplebot/meet-push.jsonl", inputs: ["25-meet-transcripts"] }] } };
  if (opts.gmail) settings.streams.gmail_push = opts.gmail;
  writeFileSync(join(root, "opsbot.json"), JSON.stringify(settings, null, 2));
  if (opts.token !== null) {
    mkdirSync(join(dir, ".config/examplebot"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, JSON.stringify(opts.token ?? { client_id: "client-1.apps.example", client_secret: "cs-secret", refresh_token: "rt-secret-1", access_token: "", expires_at: 0, scope: SCOPES_MEET }), { mode: 0o600 });
  }
  const core = join(dir, "core");
  writeFileSync(core, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/core.log"\necho "backstop: nudged after 0s"\n`);
  chmodSync(core, 0o755);
  const bin = join(dir, "pathbin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\nif [ -e "${dir}/unit-active" ]; then echo active; else echo inactive; exit 3; fi\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:${resolve(NODE, "..")}:/usr/bin:/bin`, HOME: dir, OPSBOT_ROOT: root, OPSBOT_CORE: core, OPSBOT_GOOGLE_PUSH: LIB,
    OPSBOT_GOOGLE_AUTH_URL: `${g.url}/auth`, OPSBOT_GOOGLE_TOKEN_URL: `${g.url}/token`, OPSBOT_GOOGLE_PUBSUB_URL: g.url,
    OPSBOT_GOOGLE_EVENTS_URL: g.url, OPSBOT_GOOGLE_MEET_URL: g.url, OPSBOT_GOOGLE_GMAIL_URL: g.url,
    OPSBOT_GOOGLE_BACKOFF_MS: "50", OPSBOT_GOOGLE_SIGNIN_RETRY_MS: "400",
  };
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
  return {
    dir, root, wake, state, cache, tokenFile, env,
    wakeLines: () => lines(wake).map((l) => JSON.parse(l)),
    readState: () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null),
    backstops: () => lines(join(dir, "core.log")),
    listen() {
      const child = spawn(NODE, [LISTENER], { cwd: root, env });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      kids.push({ kill: () => child.kill("SIGKILL") });
      return { out: () => out, exited, stop: async () => { child.kill("SIGTERM"); await exited; } };
    },
    run(cmd: string, args: string[], o: { env?: Record<string, string>; input?: string } = {}) {
      return new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const child = spawn(cmd, args, { cwd: root, env: { ...env, ...(o.env ?? {}) } });
        let out = "", err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        if (o.input !== undefined) child.stdin.end(o.input); else child.stdin.end();
        child.on("exit", (code) => done({ code, out, err }));
      });
    },
    /** Run the reader; its items parsed. */
    async read(env: Record<string, string> = {}) {
      const r = await this.run(NODE, [READER], { env });
      return { ...r, items: r.out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
    },
  };
}
type Bot = ReturnType<typeof bot>;
const mode = (p: string) => statSync(p).mode & 0o777;
const ready = (b: Bot, l: { out: () => string }) => until(() => l.out().includes("subscription ") && !!b.readState()?.subscription);
/** A healthy state file, so the reader's health check passes. */
function healthy(b: Bot) {
  mkdirSync(join(b.dir, ".cache/examplebot"), { recursive: true, mode: 0o700 });
  writeFileSync(b.state, JSON.stringify({ subscription: { name: "subscriptions/ours-1", state: "ACTIVE", expire_time: later(5), renewed_at: new Date().toISOString() }, last_pull: new Date().toISOString(), problems: {} }), { mode: 0o600 });
}
const line = (key: string, extra: Record<string, unknown>) => JSON.stringify({ key, recorded_at: new Date().toISOString(), ...extra }) + "\n";
const meetCalls = (g: Google) => g.requests.filter((r) => r.path.startsWith("/v2/"));

// ------------------------------------------------------------------ ensure

describe("the Meet subscription: ensure", () => {
  test("node --check passes for the Meet scripts", () => {
    for (const f of [LISTENER, READER]) expect(spawnSync(NODE, ["--check", f]).status).toBe(0);
  });

  test("ensure creates, reactivates and extends only its own subscription, never one delivering elsewhere; --dry-run calls nothing", async () => {
    const g = google();
    g.subs = [other()];
    const b = bot(g);
    const dry = await b.run("bash", [CLI, "ensure", "--source", "meet", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`would ensure the transcript subscription on ${TARGET} delivering to ${TOPIC}`);
    expect(g.requests).toEqual([]);

    // none of ours: created, with the target, the event, our topic and no resource data
    const made = await b.run("bash", [CLI, "ensure", "--source", "meet"]);
    expect(made.code).toBe(0);
    expect(made.out).toContain("meet: subscription created: subscriptions/made-1 ACTIVE");
    expect(made.out).toContain("1 other subscription(s)");
    const list = g.requests.find((r) => r.method === "GET" && r.path.startsWith("/v1/subscriptions?"))!;
    expect(new URL(`http://x${list.path}`).searchParams.get("filter")).toBe(`event_types:"${EVENT}" AND target_resource="${TARGET}"`);
    expect(g.requests.find((r) => r.method === "POST" && r.path === "/v1/subscriptions")!.body).toEqual({ targetResource: TARGET, eventTypes: [EVENT], notificationEndpoint: { pubsubTopic: TOPIC }, payloadOptions: { includeResource: false } });
    expect(b.readState().subscription).toMatchObject({ name: "subscriptions/made-1", state: "ACTIVE", expire_time: expect.any(String), renewed_at: expect.any(String) });
    expect(mode(b.state)).toBe(0o600);

    // ours, active: extended to the maximum lifetime (paged: ours is on the second page)
    g.requests = [];
    const ext = await b.run("bash", [CLI, "ensure", "--source", "meet"]);
    expect(ext.out).toContain("meet: subscription extended: subscriptions/made-1");
    expect(g.requests.some((r) => r.path.includes("pageToken=p2"))).toBe(true);
    const patch = g.requests.find((r) => r.method === "PATCH")!;
    expect(patch).toMatchObject({ path: "/v1/subscriptions/made-1?updateMask=ttl", body: { ttl: "0s" } });

    // ours, suspended: reactivated
    g.subs[1]!.state = "SUSPENDED";
    g.requests = [];
    const re = await b.run("bash", [CLI, "ensure", "--source", "meet"]);
    expect(re.out).toContain("meet: subscription reactivated: subscriptions/made-1 ACTIVE");
    expect(g.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`).filter((p) => !p.includes("/token"))).toEqual(["POST /v1/subscriptions/made-1:reactivate"]);

    // the other one, delivering to another topic, was never written to
    expect(g.requests.some((r) => r.path.includes("someone-elses"))).toBe(false);
    expect(g.subs[0]).toMatchObject({ name: "subscriptions/someone-elses", state: "ACTIVE", notificationEndpoint: { pubsubTopic: "projects/example-project/topics/another-topic" } });
  });

  test("an operation not yet done is polled until it is", async () => {
    const g = google();
    g.pendingOps = true;
    const b = bot(g);
    const r = await b.run("bash", [CLI, "ensure", "--source", "meet"]);
    expect(r.code).toBe(0);
    expect(g.requests.some((q) => q.method === "GET" && q.path.startsWith("/v1/operations/"))).toBe(true);
    expect(b.readState().subscription.name).toBe("subscriptions/made-1");
  });

  test("the listener ensures at start and every renew_hours", async () => {
    const g = google();
    g.subs = [ours()];
    const b = bot(g, { renew_hours: 0.0003 });
    const l = b.listen();
    expect(await ready(b, l)).toBe(true);
    expect(await until(() => g.requests.filter((r) => r.method === "PATCH").length >= 3)).toBe(true);
    await l.stop();
    expect(g.requests.some((r) => r.method === "POST" && r.path === "/v1/subscriptions")).toBe(false);
  });
});

// ------------------------------------------------------------------ the listener and the reader

describe("monitor.d/35-meet-transcripts and heartbeat.d/25-meet-transcripts", () => {
  test("a transcript event is one line, then state, then the ack, then the backstop; the reader makes it one item and never fetches the transcript's text", async () => {
    const g = google();
    g.subs = [ours()];
    const b = bot(g);
    const l = b.listen();
    expect(await ready(b, l)).toBe(true);
    let atAck = null as { lines: number; pulled: boolean } | null;
    g.onAck = () => { atAck ??= { lines: b.wakeLines().length, pulled: !!b.readState()?.last_pull }; };
    g.transcript();
    expect(await until(() => b.backstops().length > 0)).toBe(true);
    await l.stop();
    expect(b.wakeLines()).toEqual([{ key: `meet:transcript:${TR}`, type: "transcript", account: ACCOUNT, transcript: TR, recorded_at: expect.any(String) }]);
    expect(atAck as unknown).toEqual({ lines: 1, pulled: true });
    expect(g.queue).toEqual([]);
    expect(b.backstops()[0]).toMatch(new RegExp(`^wake backstop --key meet:transcript:${TR} --at \\S+ --grace 20 --reason meet$`));
    expect(meetCalls(g)).toEqual([]); // the listener resolves nothing

    // the same event again (a redelivery): the reader still gives one item
    writeFileSync(b.wake, readFileSync(b.wake, "utf8") + readFileSync(b.wake, "utf8"));
    const r = await b.read();
    expect(r.code).toBe(0);
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect(it).toEqual({
      key: `meet:transcript:${TR}`, at: expect.any(String), conv: `meet:${ACCOUNT}`, kind: "group", from: "google-meet",
      text: "A Meet transcript was written for the meeting abc-defg-hij that started 2030-01-02T15:00:00Z and ended 2030-01-02T15:45:00Z.",
      transcript: TR, conference: "conferenceRecords/conf-1", start: "2030-01-02T15:00:00Z", end: "2030-01-02T15:45:00Z", meeting_code: "abc-defg-hij",
      doc: { id: "doc-tr-1", url: "https://docs.example.invalid/document/d/doc-tr-1/export?format=txt" },
    });
    expect(it.text).not.toMatch(/\byou\b|should|must|please|summar|read the/i);
    expect(meetCalls(g).map((q) => q.path)).toEqual([`/v2/${TR}`, "/v2/conferenceRecords/conf-1", "/v2/spaces/space-conf-1"]);
    expect(g.requests.some((q) => /entries|export|docs\.example/.test(q.path))).toBe(false);
    for (const f of [b.wake, b.state, b.cache]) expect(readFileSync(f, "utf8")).not.toContain(MARK);
    expect(r.out + l.out()).not.toContain(MARK);

    // the cache: 0600, metadata only; a second check makes no Meet call
    expect(mode(b.cache)).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(b.cache, "utf8")).transcripts[TR]).sort()).toEqual(["conference", "doc", "end", "meeting_code", "start"]);
    const before = meetCalls(g).length;
    const again = await b.read();
    expect(again.items).toEqual(r.items);
    expect(meetCalls(g).length).toBe(before);

    // lines before OPSBOT_SINCE less lookback_minutes are not items
    const old = await b.read({ OPSBOT_SINCE: new Date(Date.now() + 3600000).toISOString() });
    expect(old.items).toEqual([]);
  });

  test("under a peek the reader calls nothing and writes nothing: one unresolved item per line", async () => {
    const g = google();
    const b = bot(g);
    healthy(b);
    writeFileSync(b.wake, line(`meet:transcript:${TR}`, { type: "transcript", account: ACCOUNT, transcript: TR }) + line("meet:transcript:conferenceRecords/conf-2/transcripts/tr-9", { type: "transcript", account: ACCOUNT, transcript: "conferenceRecords/conf-2/transcripts/tr-9" }), { mode: 0o600 });
    writeFileSync(join(b.root, "enrich"), `#!/usr/bin/env bash\ntouch "${b.dir}/enrich-ran"\necho '{}'\n`);
    chmodSync(join(b.root, "enrich"), 0o755);
    const state = readFileSync(b.state, "utf8");
    const p = await b.read({ OPSBOT_PEEK: "1" });
    expect(p.code).toBe(0);
    expect(p.items).toEqual([
      { key: `meet:transcript:${TR}`, at: expect.any(String), conv: `meet:${ACCOUNT}`, kind: "group", from: "google-meet", text: "A Meet transcript was written; its meeting was not looked up in this check.", transcript: TR, conference: "conferenceRecords/conf-1" },
      expect.objectContaining({ transcript: "conferenceRecords/conf-2/transcripts/tr-9", conference: "conferenceRecords/conf-2" }),
    ]);
    expect(g.requests).toEqual([]);
    expect(existsSync(b.cache)).toBe(false);
    expect(readFileSync(b.state, "utf8")).toBe(state);
    // a resolved cache is not even read under a peek, and enrich does not run
    writeFileSync(b.cache, JSON.stringify({ transcripts: { [TR]: { conference: "x", start: "s", end: "e", meeting_code: "c", doc: { id: "d", url: "u" } } } }), { mode: 0o600 });
    const cached = readFileSync(b.cache, "utf8");
    writeFileSync(join(b.root, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { meet_push: { ...SETTINGS, enrich: "enrich" } } }));
    const q = await b.read({ OPSBOT_PEEK: "1" });
    expect(q.items[0].meeting_code).toBeUndefined();
    expect(readFileSync(b.cache, "utf8")).toBe(cached);
    expect(existsSync(join(b.dir, "enrich-ran"))).toBe(false);
    expect(g.requests).toEqual([]);
  });

  test("enrich adds keys, never over one the item has; a failing hook fails the input after the items; a path outside the repo is refused", async () => {
    const g = google();
    const b = bot(g, { enrich: "bin/enrich" });
    healthy(b);
    writeFileSync(b.wake, line(`meet:transcript:${TR}`, { type: "transcript", account: ACCOUNT, transcript: TR }), { mode: 0o600 });
    mkdirSync(join(b.root, "bin"));
    const hook = join(b.root, "bin/enrich");
    writeFileSync(hook, `#!/usr/bin/env bash\ncat > "${b.dir}/enrich-in.json"\necho '{"title": "Weekly sync", "attendees": ["a@example.com"], "from": "someone else"}'\n`);
    chmodSync(hook, 0o755);
    const r = await b.read();
    expect(r.code).toBe(0);
    expect(r.items[0]).toMatchObject({ title: "Weekly sync", attendees: ["a@example.com"], from: "google-meet", meeting_code: "abc-defg-hij" });
    const given = JSON.parse(readFileSync(join(b.dir, "enrich-in.json"), "utf8"));
    expect(given).toMatchObject({ key: `meet:transcript:${TR}`, transcript: TR, meeting_code: "abc-defg-hij", doc: { id: "doc-tr-1" } });

    writeFileSync(hook, `#!/usr/bin/env bash\necho "calendar unreachable" >&2\nexit 3\n`);
    const f = await b.read();
    expect(f.code).toBe(1);
    expect(f.items).toHaveLength(1); // printed anyway
    expect(f.items[0].title).toBeUndefined();
    expect(f.err).toContain(`enrich for meet:transcript:${TR}: calendar unreachable`);

    writeFileSync(hook, `#!/usr/bin/env bash\necho '["not", "an object"]'\n`);
    const n = await b.read();
    expect(n.code).toBe(1);
    expect(n.items).toHaveLength(1);
    expect(n.err).toContain("did not print a JSON object");

    for (const outside of ["../enrich", "/usr/bin/true"]) {
      writeFileSync(join(b.root, "opsbot.json"), JSON.stringify({ name: "examplebot", streams: { meet_push: { ...SETTINGS, enrich: outside } } }));
      const o = await b.read();
      expect(o.code).toBe(1);
      expect(o.items).toHaveLength(1);
      expect(o.err).toContain("streams.meet_push.enrich must be a path inside the repo");
    }
  });

  test("a failed lookup still prints the item, unresolved, and fails the input", async () => {
    const g = google();
    g.meetStatus = 503;
    const b = bot(g);
    healthy(b);
    writeFileSync(b.wake, line(`meet:transcript:${TR}`, { type: "transcript", account: ACCOUNT, transcript: TR }), { mode: 0o600 });
    const r = await b.read();
    expect(r.code).toBe(1);
    expect(r.items).toEqual([expect.objectContaining({ transcript: TR, conference: "conferenceRecords/conf-1", text: expect.stringContaining("not looked up") })]);
    expect(r.err).toContain(`could not look up ${TR}: HTTP 503`);
    expect(existsSync(b.cache)).toBe(false);
  });

  test("lifecycle: expired and suspended are items, a reminder is not; each makes the listener ensure again; no backstop for them", async () => {
    const g = google();
    g.subs = [ours()];
    const b = bot(g);
    const l = b.listen();
    expect(await ready(b, l)).toBe(true);
    const lists = () => g.requests.filter((r) => r.method === "GET" && r.path.startsWith("/v1/subscriptions?")).length;
    const first = lists();
    g.lifecycle("expirationReminder");
    g.lifecycle("suspended");
    g.lifecycle("expired");
    expect(await until(() => g.queue.length === 0 && lists() > first)).toBe(true);
    await sleep(300);
    await l.stop();
    const lines = b.wakeLines();
    expect(lines.map((x) => [x.type, x.event])).toEqual([["lifecycle", "expirationReminder"], ["lifecycle", "suspended"], ["lifecycle", "expired"]]);
    expect(lines[0]).toEqual({ key: expect.stringMatching(/^meet:lifecycle:expirationReminder:ev-\d+$/), type: "lifecycle", event: "expirationReminder", expire_time: expect.any(String), recorded_at: expect.any(String) });
    expect(readFileSync(b.wake, "utf8")).not.toContain("USER_SCOPE_REVOKED"); // the reason goes to the journal only
    expect(l.out()).toContain("subscription suspended: USER_SCOPE_REVOKED");
    expect(b.backstops()).toEqual([]);
    const r = await b.read();
    expect(r.code).toBe(0);
    expect(r.items.map((x) => x.event)).toEqual(["suspended", "expired"]);
    expect(r.items[0]).toMatchObject({ conv: `meet:${ACCOUNT}`, kind: "group", from: "google-meet", text: expect.stringContaining("suspended") });
    expect(meetCalls(g)).toEqual([]);
  });

  test("problems once each: a failing pull is raised once, kept in state across a restart, fails the reader, and clears; a Gmail-only grant is sign-in at once", async () => {
    const g = google();
    g.subs = [ours()];
    g.pullStatus = 503;
    const b = bot(g);
    const l = b.listen();
    expect(await until(() => b.wakeLines().some((x) => x.type === "problem"))).toBe(true);
    await sleep(800);
    await l.stop();
    const problems = b.wakeLines().filter((x) => x.type === "problem");
    expect(problems).toEqual([{ key: expect.stringMatching(/^meet:problem:pull:\d{4}-/), type: "problem", kind: "pull", recorded_at: expect.any(String) }]);
    expect(readFileSync(b.wake, "utf8")).not.toContain("503");
    expect(b.readState().problems.pull).toMatchObject({ raised: true, detail: "HTTP 503 UNAVAILABLE" });
    const again = b.listen();
    await sleep(800);
    expect(b.wakeLines().filter((x) => x.type === "problem")).toHaveLength(1);
    const failing = await b.read();
    expect(failing.code).toBe(1);
    expect(failing.err).toContain("the pull problem stands");
    g.pullStatus = 200;
    expect(await until(() => !b.readState().problems.pull)).toBe(true);
    await again.stop();
    expect((await b.read()).code).toBe(0);

    const h = google();
    const c = bot(h, { problem_after_minutes: 60 }, { token: { client_id: "c", refresh_token: "r", scope: SCOPES_GMAIL } });
    const m = c.listen();
    expect(await until(() => c.wakeLines().some((x) => x.type === "problem"))).toBe(true);
    await m.stop();
    expect(c.wakeLines().filter((x) => x.type === "problem").map((x) => x.kind)).toEqual(["sign-in"]);
    expect(c.readState().problems["sign-in"].detail).toContain("lacks meetings.space.readonly");
    expect(m.out()).toContain("opsbot-google login --source meet");
  });

  test("a failing subscription ensure is the watch problem, raised once; the reader fails without state, with a lapsed or suspended subscription, or a stale pull", async () => {
    const g = google();
    g.listStatus = 500;
    const b = bot(g);
    const r0 = await b.read();
    expect(r0.code).toBe(1);
    expect(r0.err).toContain("no state at");
    const l = b.listen();
    expect(await until(() => b.wakeLines().some((x) => x.kind === "watch"))).toBe(true);
    await sleep(600);
    await l.stop();
    expect(b.wakeLines().filter((x) => x.kind === "watch")).toHaveLength(1);
    expect(b.wakeLines()[0].key).toMatch(/^meet:problem:watch:/);
    writeFileSync(b.state, JSON.stringify({ subscription: { name: "subscriptions/ours-1", state: "SUSPENDED", expire_time: later(1) }, last_pull: new Date(Date.now() - 3600000).toISOString(), problems: {} }), { mode: 0o600 });
    const r1 = await b.read();
    expect(r1.err).toContain("is SUSPENDED");
    expect(r1.err).toContain("no pull since");
    writeFileSync(b.state, JSON.stringify({ subscription: { name: "subscriptions/ours-1", state: "ACTIVE", expire_time: later(-1) }, last_pull: new Date().toISOString(), problems: {} }), { mode: 0o600 });
    expect((await b.read()).err).toContain("lapsed");
    const before = readFileSync(b.state, "utf8");
    expect((await b.read({ OPSBOT_PEEK: "1" })).code).toBe(1); // the same under a peek, which only reads
    expect(readFileSync(b.state, "utf8")).toBe(before);
  });

  test("a required key missing: the listener refuses to start and names it; user_id has no default", async () => {
    const g = google();
    const b = bot(g, { user_id: undefined });
    const l = b.listen();
    expect(await l.exited).toBe(1);
    expect(l.out()).toContain("streams.meet_push.user_id is required");
    expect(g.requests).toEqual([]);
    const m = await import(LIB);
    const s = m.meetSettings({ name: "examplebot", streams: { meet_push: { enabled: true } } });
    expect(s.missing).toEqual(["account", "user_id", "project", "topic", "subscription"]);
    expect(m.SCOPES.meet).toEqual(SCOPES_MEET.split(" "));
  });
});

// ------------------------------------------------------------------ login, install, status

describe("scripts/opsbot-google for the Meet source", () => {
  test("login --source meet asks for exactly meetings.space.readonly and pubsub; --source both for the union, written once to the shared file", async () => {
    const g = google();
    const b = bot(g, {}, { token: null });
    const client = join(b.dir, "client.json");
    writeFileSync(client, JSON.stringify({ installed: { client_id: "client-1.apps.example", client_secret: "cs-secret" } }));
    const start = async (source: string) => {
      const child = spawn("bash", [CLI, "login", "--source", source, "--client", client, "--paste"], { cwd: b.root, env: b.env });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      kids.push({ kill: () => child.kill("SIGKILL") });
      await until(() => /https?:\/\/\S+\/auth\?\S+/.test(out));
      const consent = new URL(/(https?:\/\/\S+\/auth\?\S+)/.exec(out)![1]!);
      child.stdin.end(`${consent.searchParams.get("redirect_uri")}/?code=code-1&state=${consent.searchParams.get("state")}\n`);
      return { consent, code: await exited, out };
    };
    const m = await start("meet");
    expect(m.consent.searchParams.get("scope")!.split(" ").sort()).toEqual(SCOPES_MEET.split(" ").sort());
    expect(m.consent.searchParams.get("login_hint")).toBe(ACCOUNT);
    expect(m.code).toBe(0);
    expect(mode(b.tokenFile)).toBe(0o600);
    g.grantScope = `${SCOPES_GMAIL} ${SCOPES_MEET}`;
    const both = await start("both");
    expect(both.code).toBe(0);
    expect(both.consent.searchParams.get("scope")!.split(" ").sort()).toEqual([...new Set([...SCOPES_GMAIL.split(" "), ...SCOPES_MEET.split(" ")])].sort());
    expect(both.out.match(/signed in:/g)).toHaveLength(1);
  });

  test("install --source meet copies the Meet scripts and prints its block and wake.files entry; it never writes opsbot.json", async () => {
    const g = google();
    const b = bot(g, { account: undefined, user_id: undefined, project: undefined, topic: undefined, subscription: undefined });
    const before = readFileSync(join(b.root, "opsbot.json"), "utf8");
    const r = await b.run("bash", [CLI, "install", "--source", "meet"]);
    expect(r.code).toBe(0);
    for (const p of ["monitor.d/35-meet-transcripts", "heartbeat.d/25-meet-transcripts"]) {
      const f = join(b.root, "opsbot.d", p);
      expect(readFileSync(f, "utf8")).toBe(readFileSync(join(SKILL, "templates", p), "utf8"));
      expect(statSync(f).mode & 0o111).not.toBe(0);
    }
    expect(existsSync(join(b.root, "opsbot.d/monitor.d/30-gmail-push"))).toBe(false);
    expect(r.out).toContain('"meet_push": {');
    expect(r.out).toContain('"user_id": "<that account\'s directory id');
    expect(r.out).toContain('{ "file": "~/.cache/examplebot/meet-push.jsonl", "inputs": ["25-meet-transcripts"] }');
    expect(r.out).toContain("only for meetings the account organized");
    expect(r.out).toContain("opsbot-google login --source meet --client");
    expect(readFileSync(join(b.root, "opsbot.json"), "utf8")).toBe(before);
    expect(g.requests).toEqual([]);
  });

  test("status --source meet: every row ok against the stand-in and it only reads; a missing user_id says how to find it", async () => {
    const g = google();
    const b = bot(g);
    await b.run("bash", [CLI, "install", "--source", "meet"]);
    healthy(b);
    writeFileSync(join(b.dir, "unit-active"), "");
    const token = readFileSync(b.tokenFile, "utf8");
    const state = readFileSync(b.state, "utf8");
    const r = await b.run("bash", [CLI, "status", "--source", "meet"]);
    const pieces = r.out.trim().split("\n").filter((l) => /^(ok|missing|differs) /.test(l)).map((l) => l.split(/\s{2,}/)[1]);
    expect(pieces).toEqual(["streams.meet_push", "meet token", "meet subscription", "meet events", "meet last pull", "meet problems", "meet wake.files", "monitor.d/35-meet-transcripts", "heartbeat.d/25-meet-transcripts", "meet listener"]);
    expect(r.out.trim().split("\n").pop()).toBe(`status: all ${pieces.length} ok`);
    expect(r.code).toBe(0);
    expect(readFileSync(b.tokenFile, "utf8")).toBe(token);
    expect(readFileSync(b.state, "utf8")).toBe(state);
    expect(g.requests.map((q) => q.path).filter((p) => p !== "/token")).toEqual([`/v1/${SUB}:pull`]);

    const c = bot(g, { user_id: "" });
    const s = await c.run("bash", [CLI, "status", "--source", "meet"]);
    expect(s.code).toBe(1);
    expect(s.out).toMatch(/^missing +streams\.meet_push +required: user_id/m);
    expect(s.out).toContain("users.get with fields=id");
    expect(s.out).toContain("admin.googleapis.com/admin/directory/v1/users/<account>?fields=id");
    expect(s.out).toContain("Admin console");
    expect(s.out).toMatch(/^missing +meet events/m);
    expect(g.requests.some((q) => q.path.includes("admin"))).toBe(false); // it never calls the Admin SDK
  });
});

// ------------------------------------------------------------------ the docs

describe("the README", () => {
  test("states first that only meetings the account organized deliver an event", () => {
    const readme = readFileSync(join(SKILL, "README.md"), "utf8");
    const firstParagraph = readme.split(/\n\s*\n/).find((p) => !p.startsWith("#"))!;
    expect(firstParagraph).toMatch(/only for meetings (the|its|that) account organi[sz]ed/i);
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    expect(skill).toMatch(/only for meetings the account organized/i);
    const infra = readFileSync(join(SKILL, "templates/infra/README.md"), "utf8");
    expect(infra).toContain("meet-api-event-push@system.gserviceaccount.com");
    expect(infra).toContain("https://developers.google.com/workspace/events/guides/create-subscription");
  });
});
