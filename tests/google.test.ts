/**
 * opsbot-google: the Gmail listener, its heartbeat, login, ensure, install and status, against a
 * stand-in Google: a local HTTP server started here, the scripts pointed at it by the test-only
 * OPSBOT_GOOGLE_*_URL variables. No test touches Google. The core is a stand-in script that logs
 * each `wake backstop` it is asked for. HOME is a temp dir; every value is invented.
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
const LISTENER = join(SKILL, "templates/monitor.d/30-gmail-push");
const HEART = join(SKILL, "templates/heartbeat.d/15-gmail-push");
const NODE = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();

const ACCOUNT = "bot@example.com";
const SUB = "projects/example-project/subscriptions/example-sub";
const SCOPES_GMAIL = "https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/pubsub";
const MARK = "MARKER-a91c"; // in every sender, subject, snippet, thread and message id the stand-in serves
const SETTINGS = { enabled: true, account: ACCOUNT, project: "example-project", topic: "example-topic", subscription: "example-sub", problem_after_minutes: 0.01 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 15000) => { for (const t = Date.now(); !ok() && Date.now() - t < ms; ) await sleep(50); return ok(); };

// ------------------------------------------------------------------ the stand-in Google

type Rec = { id: string; added?: Array<{ id: string; labels?: string[] }>; labelsAdded?: Array<{ id: string; labels: string[] }> };
interface Google {
  url: string;
  requests: Array<{ method: string; path: string; body: any; at: number }>;
  queue: Array<{ ackId: string; data: string }>;
  history: Rec[];
  historyId: number;
  historyGone: boolean;
  historyStatus: number;
  messages: Record<string, string[] | null>; // labels for messages.get; null is a 404
  pullStatus: number;
  watchStatus: number;
  refreshError: string;
  grantScope: string;
  onAck: () => void;
  notify(historyId: number, email?: string): void;
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

function google(): Google {
  let n = 0;
  const g: Google = {
    url: "", requests: [], queue: [], history: [], historyId: 100, historyGone: false, historyStatus: 200, messages: {},
    pullStatus: 200, watchStatus: 200, refreshError: "", grantScope: SCOPES_GMAIL, onAck: () => {},
    notify(historyId, email = ACCOUNT) {
      g.queue.push({ ackId: `ack-${++n}`, data: Buffer.from(JSON.stringify({ emailAddress: email, historyId })).toString("base64") });
    },
    stop: () => server.stop(true),
  };
  const msg = (id: string, labels?: string[]) => ({ id: `${id}-${MARK}`, threadId: `thread-${MARK}`, ...(labels ? { labelIds: labels } : {}), snippet: `snippet ${MARK}`, payload: { headers: [{ name: "From", value: `sender-${MARK}@example.com` }, { name: "Subject", value: `subject ${MARK}` }] } });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const text = await req.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); }
      g.requests.push({ method: req.method, path: u.pathname + u.search, body, at: Date.now() });
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
      if (u.pathname === "/token") {
        if (body.grant_type === "refresh_token") {
          if (g.refreshError) return json({ error: g.refreshError }, 400);
          return json({ access_token: `at-refreshed-${MARK}-${Date.now()}`, expires_in: 3600, scope: g.grantScope, token_type: "Bearer" });
        }
        if (body.grant_type === "authorization_code") {
          if (!body.code_verifier || body.code !== "code-1") return json({ error: "invalid_grant" }, 400);
          return json({ access_token: "at-first", refresh_token: "rt-secret-1", expires_in: 3600, scope: g.grantScope, token_type: "Bearer" });
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      if (u.pathname === "/gmail/v1/users/me/watch") {
        if (g.watchStatus !== 200) return json({ error: { code: g.watchStatus, status: "FAILED_PRECONDITION" } }, g.watchStatus);
        return json({ historyId: String(g.historyId), expiration: String(Date.now() + 7 * 86400000) });
      }
      if (u.pathname === "/gmail/v1/users/me/history") {
        if (g.historyGone) return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
        if (g.historyStatus !== 200) return json({ error: { code: g.historyStatus, status: "INTERNAL" } }, g.historyStatus);
        const start = BigInt(u.searchParams.get("startHistoryId")!);
        const recs = g.history.filter((r) => BigInt(r.id) > start);
        // two pages, to prove the paging
        const page = u.searchParams.get("pageToken") === "p2" ? recs.slice(1) : recs.slice(0, 1);
        const out = page.map((r) => ({
          id: r.id,
          messages: (r.added || []).map((m) => ({ id: `${m.id}-${MARK}`, threadId: `thread-${MARK}` })),
          ...(r.added ? { messagesAdded: r.added.map((m) => ({ message: msg(m.id, m.labels) })) } : {}),
          ...(r.labelsAdded ? { labelsAdded: r.labelsAdded.map((m) => ({ message: msg(m.id, m.labels), labelIds: m.labels })) } : {}),
        }));
        return json({ history: out, historyId: String(g.historyId), ...(u.searchParams.get("pageToken") !== "p2" && recs.length > 1 ? { nextPageToken: "p2" } : {}) });
      }
      const mg = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(u.pathname);
      if (mg) {
        const id = decodeURIComponent(mg[1]!).replace(`-${MARK}`, "");
        const labels = g.messages[id];
        if (!labels) return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
        return json(msg(id, labels));
      }
      if (u.pathname === `/v1/${SUB}:pull`) {
        if (g.pullStatus !== 200) return json({ error: { code: g.pullStatus, status: g.pullStatus === 403 ? "PERMISSION_DENIED" : "UNAVAILABLE" } }, g.pullStatus);
        if (!g.queue.length) { await sleep(body.returnImmediately ? 0 : 100); return json({}); }
        return json({ receivedMessages: g.queue.map((m) => ({ ackId: m.ackId, message: { data: m.data, messageId: "1", publishTime: new Date().toISOString() } })) });
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
  g.url = `http://127.0.0.1:${server.port}`;
  servers.push(g);
  return g;
}

// ------------------------------------------------------------------ a bot

function bot(g: Google, gmail: Record<string, unknown> = {}, opts: { token?: Record<string, unknown> | null; wakeFiles?: unknown[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-google-test-"));
  dirs.push(dir);
  const root = join(dir, "bot");
  mkdirSync(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  const wake = join(dir, ".cache/examplebot/gmail-push.jsonl");
  const state = join(dir, ".cache/examplebot/gmail-push-state.json");
  const tokenFile = join(dir, ".config/examplebot/google-push-token.json");
  const settings = { name: "examplebot", streams: { gmail_push: { ...SETTINGS, ...gmail } }, wake: { files: opts.wakeFiles ?? [{ file: "~/.cache/examplebot/gmail-push.jsonl", inputs: ["15-gmail-push", "20-mail"] }] } };
  writeFileSync(join(root, "opsbot.json"), JSON.stringify(settings, null, 2));
  if (opts.token !== null) {
    mkdirSync(join(dir, ".config/examplebot"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, JSON.stringify(opts.token ?? { client_id: "client-1.apps.example", client_secret: "cs-secret", refresh_token: "rt-secret-1", access_token: "", expires_at: 0, scope: SCOPES_GMAIL }), { mode: 0o600 });
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
    OPSBOT_GOOGLE_AUTH_URL: `${g.url}/auth`, OPSBOT_GOOGLE_TOKEN_URL: `${g.url}/token`, OPSBOT_GOOGLE_GMAIL_URL: g.url, OPSBOT_GOOGLE_PUBSUB_URL: g.url,
    OPSBOT_GOOGLE_BACKOFF_MS: "50", OPSBOT_GOOGLE_SIGNIN_RETRY_MS: "400",
  };
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
  return {
    dir, root, wake, state, tokenFile, env,
    wakeLines: () => lines(wake).map((l) => JSON.parse(l)),
    readState: () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null),
    backstops: () => lines(join(dir, "core.log")),
    /** Start the listener; returns its output so far and a stop. */
    listen() {
      const child = spawn(NODE, [LISTENER], { cwd: root, env });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      const k = { kill: () => child.kill("SIGKILL") };
      kids.push(k);
      return { out: () => out, exited, stop: async () => { child.kill("SIGTERM"); await exited; } };
    },
    /** Run a command (async, so the stand-in keeps answering). */
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
  };
}
type Bot = ReturnType<typeof bot>;
const mode = (p: string) => statSync(p).mode & 0o777;
const ready = (b: Bot, l: { out: () => string }) => until(() => l.out().includes("watch renewed") && !!b.readState());

// ------------------------------------------------------------------ the listener

describe("monitor.d/30-gmail-push", () => {
  test("node --check passes for every node script of the skill", () => {
    for (const f of [LIB, LISTENER, HEART]) expect(spawnSync(NODE, ["--check", f]).status).toBe(0);
  });

  test("a first run writes a baseline; a new inbox message is one line, then state, then the ack, then the backstop", async () => {
    const g = google();
    const b = bot(g);
    const l = b.listen();
    expect(await ready(b, l)).toBe(true);
    expect(b.wakeLines()).toEqual([{ key: `gmail:${ACCOUNT}:100`, type: "baseline", account: ACCOUNT, count: 0, recorded_at: expect.any(String) }]);
    expect(b.readState().cursor).toBe("100");
    const watch = g.requests.find((r) => r.path.endsWith("/watch"))!;
    expect(watch.body).toEqual({ topicName: "projects/example-project/topics/example-topic", labelIds: ["INBOX"], labelFilterBehavior: "include" });
    // at the ack, the line and the state are already on disk
    let atAck = null as { lines: number; cursor: string } | null;
    g.onAck = () => { atAck ??= { lines: b.wakeLines().length, cursor: b.readState().cursor }; };
    g.history = [{ id: "101", added: [{ id: "m1", labels: ["INBOX", "UNREAD"] }] }];
    g.historyId = 101;
    g.notify(101);
    expect(await until(() => b.backstops().length > 0)).toBe(true);
    await l.stop();
    const lines = b.wakeLines();
    expect(lines[1]).toEqual({ key: `gmail:${ACCOUNT}:101`, type: "inbox", account: ACCOUNT, count: 1, recorded_at: expect.any(String) });
    expect(Object.keys(lines[1]).sort()).toEqual(["account", "count", "key", "recorded_at", "type"]);
    expect(atAck as unknown).toEqual({ lines: 2, cursor: "101" });
    expect(g.queue).toEqual([]);
    expect(b.backstops()[0]).toMatch(new RegExp(`^wake backstop --key gmail:${ACCOUNT}:101 --at \\S+ --grace 20 --reason gmail$`));
    expect(l.out()).toContain("nudged after 0s");
  });

  test("only messages newly added with a watched label, neither SENT nor DRAFT, count; reads, archives and label changes write nothing", async () => {
    const g = google();
    const b = bot(g);
    const l = b.listen();
    await ready(b, l);
    // a read, an archive, a label change: Gmail notifies, the history has no counted add
    g.history = [{ id: "102", labelsAdded: [{ id: "m0", labels: ["STARRED"] }] }];
    g.historyId = 103;
    g.notify(103);
    expect(await until(() => g.queue.length === 0)).toBe(true);
    await sleep(300);
    expect(b.wakeLines().map((x) => x.type)).toEqual(["baseline"]);
    expect(b.readState().cursor).toBe("103");
    // inbox (counts), sent (no), a draft (no), elsewhere (no), no labels then looked up (counts), gone (skipped)
    g.history = [
      { id: "104", added: [{ id: "m1", labels: ["INBOX", "UNREAD"] }] },
      { id: "105", added: [{ id: "m2", labels: ["INBOX", "SENT"] }, { id: "m3", labels: ["DRAFT"] }, { id: "m4", labels: ["CATEGORY_PROMOTIONS"] }, { id: "m5" }, { id: "m6" }] },
    ];
    g.messages = { m5: ["INBOX"], m6: null };
    g.historyId = 106;
    g.notify(106);
    expect(await until(() => b.wakeLines().length === 2)).toBe(true);
    await l.stop();
    expect(b.wakeLines()[1]).toMatchObject({ type: "inbox", count: 2, key: `gmail:${ACCOUNT}:105` });
    expect(b.readState().cursor).toBe("106");
    const hist = g.requests.filter((r) => r.path.startsWith("/gmail/v1/users/me/history"));
    expect(hist.some((r) => r.path.includes("pageToken=p2"))).toBe(true); // paged
    expect(hist.every((r) => r.path.includes("historyTypes=messageAdded"))).toBe(true);
    expect(g.requests.filter((r) => r.path.includes("/messages/")).every((r) => r.path.endsWith("format=minimal"))).toBe(true);
  });

  test("no sender, subject, snippet, thread or message id reaches the wake file, the state file or the journal", async () => {
    const g = google();
    const b = bot(g);
    const l = b.listen();
    await ready(b, l);
    g.history = [{ id: "101", added: [{ id: "m1", labels: ["INBOX"] }, { id: "m2" }] }];
    g.messages = { m2: ["INBOX"] };
    g.historyId = 101;
    g.notify(101);
    await until(() => b.backstops().length > 0);
    await l.stop();
    expect(g.requests.some((r) => r.path.includes(MARK))).toBe(true); // the stand-in did serve them
    expect(readFileSync(b.wake, "utf8")).not.toContain(MARK);
    expect(readFileSync(b.state, "utf8")).not.toContain(MARK);
    expect(l.out()).not.toContain(MARK);
    expect(readFileSync(b.wake, "utf8")).not.toMatch(/thread|snippet|subject|from/i);
  });

  test("a failed state write records the line, acknowledges nothing and does not exit; the redelivery repeats the key, then all goes through", async () => {
    const g = google();
    const b = bot(g);
    const l = b.listen();
    await ready(b, l);
    mkdirSync(`${b.state}.tmp`); // the state's temporary file cannot be written (as with a full disk)
    g.history = [{ id: "101", added: [{ id: "m1", labels: ["INBOX"] }] }];
    g.historyId = 101;
    g.notify(101);
    expect(await until(() => b.wakeLines().filter((x) => x.type === "inbox").length >= 2 && l.out().includes("problem raised: write"))).toBe(true);
    expect(g.requests.filter((r) => r.path.endsWith(":acknowledge"))).toEqual([]);
    expect(g.queue).toHaveLength(1);
    expect(b.backstops()).toEqual([]);
    expect(l.out()).toContain("problem raised: write");
    const inbox = b.wakeLines().filter((x) => x.type === "inbox");
    expect(new Set(inbox.map((x) => x.key))).toEqual(new Set([`gmail:${ACCOUNT}:101`]));
    rmSync(`${b.state}.tmp`, { recursive: true });
    expect(await until(() => g.queue.length === 0)).toBe(true);
    expect(await until(() => b.backstops().length === 1)).toBe(true);
    expect(b.readState().cursor).toBe("101");
    expect(l.out()).toContain("problem cleared: write");
    await l.stop();
    expect(await l.exited).not.toBe(1);
  });

  test("a crash between the line and the acknowledgement: the restarted listener writes the same key again, then acknowledges", async () => {
    const g = google();
    const b = bot(g);
    const l = b.listen();
    await ready(b, l);
    mkdirSync(`${b.state}.tmp`);
    g.history = [{ id: "101", added: [{ id: "m1", labels: ["INBOX"] }] }];
    g.historyId = 101;
    g.notify(101);
    expect(await until(() => b.wakeLines().some((x) => x.type === "inbox"))).toBe(true);
    kids.find(() => true)!.kill(); // SIGKILL: the line is written, the state and the ack are not
    await l.exited;
    expect(g.queue).toHaveLength(1);
    rmSync(`${b.state}.tmp`, { recursive: true });
    const again = b.listen();
    expect(await until(() => g.queue.length === 0)).toBe(true);
    await until(() => b.backstops().length === 1);
    await again.stop();
    const inbox = b.wakeLines().filter((x) => x.type === "inbox");
    expect(inbox.length).toBeGreaterThanOrEqual(2);
    expect(new Set(inbox.map((x) => x.key))).toEqual(new Set([`gmail:${ACCOUNT}:101`]));
    expect(b.readState().cursor).toBe("101");
  });

  test("a failing watch and a failing history read are each raised once, as their own kind", async () => {
    const g = google();
    g.watchStatus = 500;
    const b = bot(g);
    const l = b.listen();
    expect(await until(() => b.wakeLines().some((x) => x.kind === "watch"))).toBe(true);
    await sleep(800);
    expect(b.wakeLines().filter((x) => x.kind === "watch")).toHaveLength(1);
    g.watchStatus = 200;
    expect(await until(() => b.readState()?.cursor === "100" && !b.readState().problems.watch)).toBe(true);
    g.historyStatus = 500;
    g.notify(101);
    expect(await until(() => b.wakeLines().some((x) => x.kind === "history"))).toBe(true);
    await sleep(800);
    expect(b.wakeLines().filter((x) => x.kind === "history")).toHaveLength(1);
    expect(g.requests.filter((r) => r.path.endsWith(":acknowledge"))).toEqual([]); // nothing acknowledged while it fails
    g.history = [{ id: "101", added: [{ id: "m1", labels: ["INBOX"] }] }];
    g.historyId = 101;
    g.historyStatus = 200;
    expect(await until(() => g.queue.length === 0 && !b.readState().problems.history)).toBe(true);
    await l.stop();
    expect(b.wakeLines().filter((x) => x.type === "inbox")).toHaveLength(1);
  });

  test("the watch is renewed when due and keeps the cursor", async () => {
    const g = google();
    const b = bot(g, { renew_hours: 0.0003 }); // about a second
    const l = b.listen();
    await ready(b, l);
    g.history = [{ id: "150", added: [{ id: "m1", labels: ["INBOX"] }] }];
    g.historyId = 150;
    g.notify(150);
    await until(() => b.readState()?.cursor === "150");
    g.historyId = 900; // a renewal's answer carries a newer history id: the cursor stays
    expect(await until(() => g.requests.filter((r) => r.path.endsWith("/watch")).length >= 3)).toBe(true);
    await l.stop();
    expect(b.readState().cursor).toBe("150");
    expect(b.wakeLines().filter((x) => x.type === "baseline")).toHaveLength(1);
  });

  test("a lost cursor resyncs from the newest notification and fails the heartbeat once", async () => {
    const g = google();
    const b = bot(g);
    const l = b.listen();
    await ready(b, l);
    const before = new Date(Date.now() - 1000).toISOString();
    g.historyGone = true;
    g.notify(5000); g.notify(4000);
    expect(await until(() => b.wakeLines().some((x) => x.type === "resync"))).toBe(true);
    await until(() => g.queue.length === 0);
    await l.stop();
    expect(b.wakeLines().find((x) => x.type === "resync")).toEqual({ key: `gmail:${ACCOUNT}:5000`, type: "resync", account: ACCOUNT, count: 0, recorded_at: expect.any(String) });
    expect(b.readState().cursor).toBe("5000");
    expect(b.backstops()).toHaveLength(1);
    const hb = (wm: string) => b.run(NODE, [HEART], { env: { OPSBOT_WATERMARK: wm } });
    const failed = await hb(before);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("resynchronized");
    const after = await hb(new Date(Date.now() + 1000).toISOString());
    expect(after.code).toBe(0);
  });

  test("a failing pull is raised once after problem_after_minutes, recorded in state, survives a restart, and clears on success", async () => {
    const g = google();
    g.pullStatus = 503;
    const b = bot(g);
    const l = b.listen();
    expect(await until(() => b.wakeLines().some((x) => x.type === "problem"))).toBe(true);
    await sleep(1200); // many more failures: still one line
    await l.stop();
    const problems = b.wakeLines().filter((x) => x.type === "problem");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toEqual({ key: expect.stringMatching(/^gmail:problem:pull:\d{4}-/), type: "problem", kind: "pull", recorded_at: expect.any(String) });
    expect(readFileSync(b.wake, "utf8")).not.toContain("503"); // the detail is in the state, never the wake file
    expect(b.readState().problems.pull).toMatchObject({ raised: true, detail: "HTTP 503 UNAVAILABLE" });
    // a restart: still standing, not raised again
    const again = b.listen();
    await sleep(1200);
    expect(b.wakeLines().filter((x) => x.type === "problem")).toHaveLength(1);
    expect((await b.run(NODE, [HEART])).err).toContain("the pull problem stands");
    g.pullStatus = 200;
    expect(await until(() => !b.readState().problems.pull)).toBe(true);
    await again.stop();
    expect(again.out()).toContain("problem cleared: pull");
    expect((await b.run(NODE, [HEART])).code).toBe(0);
  });

  test("a revoked grant is the sign-in problem at once; a missing scope too; the listener then waits between tries", async () => {
    const g = google();
    g.refreshError = "invalid_grant";
    const b = bot(g, { problem_after_minutes: 60 });
    const l = b.listen();
    expect(await until(() => b.wakeLines().some((x) => x.type === "problem"))).toBe(true);
    await l.stop();
    expect(b.wakeLines().filter((x) => x.type === "problem").map((x) => x.kind)).toEqual(["sign-in"]);
    expect(l.out()).toContain("opsbot-google login");
    expect(b.readState().problems["sign-in"].detail).toContain("invalid_grant");

    const h = google();
    const c = bot(h, { problem_after_minutes: 60 }, { token: { client_id: "c", refresh_token: "r", scope: "https://www.googleapis.com/auth/pubsub" } });
    const m = c.listen();
    expect(await until(() => c.wakeLines().some((x) => x.type === "problem"))).toBe(true);
    await m.stop();
    expect(c.readState().problems["sign-in"].detail).toContain("lacks gmail.metadata");
    expect(h.requests.filter((r) => r.path === "/token")).toEqual([]); // never even tried
  });

  test("the token file is refreshed in place, stays 0600, and no token is ever printed; every file is 0600 in a 0700 directory", async () => {
    const g = google();
    const b = bot(g);
    const l = b.listen();
    await ready(b, l);
    await l.stop();
    const t = JSON.parse(readFileSync(b.tokenFile, "utf8"));
    expect(t.access_token).toStartWith("at-refreshed-");
    expect(t.refresh_token).toBe("rt-secret-1");
    expect(Object.keys(t).sort()).toEqual(["access_token", "client_id", "client_secret", "expires_at", "refresh_token", "scope"]);
    for (const f of [b.tokenFile, b.wake, b.state]) expect(mode(f)).toBe(0o600);
    for (const d of [join(b.dir, ".cache/examplebot"), join(b.dir, ".cache"), join(b.dir, ".config/examplebot")]) expect(mode(d)).toBe(0o700);
    expect(l.out()).not.toMatch(/rt-secret|at-refreshed|cs-secret/);
  });

  test("a required key missing: the listener refuses to start and names it; not enabled: it does nothing", async () => {
    const g = google();
    const b = bot(g, { project: undefined, subscription: "" });
    const l = b.listen();
    expect(await l.exited).toBe(1);
    expect(l.out()).toContain("streams.gmail_push.project is required");
    expect(l.out()).toContain("streams.gmail_push.subscription is required");
    expect(g.requests).toEqual([]);
    const off = bot(g, { enabled: false });
    const o = off.listen();
    await sleep(800);
    await o.stop();
    expect(o.out()).toContain("enabled is not true");
    expect(g.requests).toEqual([]);
    expect(existsSync(off.wake)).toBe(false);
  });
});

// ------------------------------------------------------------------ settings, the heartbeat

describe("settings and heartbeat.d/15-gmail-push", () => {
  test("no setting has a default naming a project, an address or a zone", async () => {
    const m = await import(LIB);
    const s = m.gmailSettings({ name: "examplebot", streams: { gmail_push: { enabled: true } } });
    expect(s.missing).toEqual(["account", "project", "topic", "subscription"]);
    expect([s.account, s.project, s.topic, s.subscription]).toEqual(["", "", "", ""]);
    const src = readFileSync(LIB, "utf8");
    expect(src).not.toMatch(/example\.com|example-project|projects\/[a-z]/);
    expect(src).not.toMatch(/timeZone|America\/|Europe\//);
  });

  test("fails with each reason; passes when healthy; the same under a peek, which writes nothing and calls nothing", async () => {
    const g = google();
    const b = bot(g);
    const hb = (env: Record<string, string> = {}) => b.run(NODE, [HEART], { env });
    const none = await hb();
    expect(none.code).toBe(1);
    expect(none.err).toContain("no state at");
    mkdirSync(join(b.dir, ".cache/examplebot"), { recursive: true });
    const now = Date.now();
    const write = (st: unknown) => writeFileSync(b.state, JSON.stringify(st), { mode: 0o600 });
    write({ cursor: "1", watch: { expiration: new Date(now - 1000).toISOString(), renewed_at: new Date(now - 8 * 86400000).toISOString() }, last_pull: new Date(now - 3600000).toISOString(), problems: { watch: { since: "2030-01-01T00:00:00Z", raised: true, detail: "HTTP 403" } } });
    const bad = await hb();
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("the watch problem stands");
    expect(bad.err).toContain("the Gmail watch lapsed");
    expect(bad.err).toContain("no pull since");
    expect(bad.out).toBe(""); // never an item
    write({ cursor: "1", watch: { expiration: new Date(now + 86400000).toISOString(), renewed_at: new Date(now).toISOString() }, last_pull: new Date(now).toISOString(), problems: {} });
    const before = readFileSync(b.state, "utf8");
    const good = await hb();
    expect(good).toMatchObject({ code: 0, out: "" });
    const peek = await hb({ OPSBOT_PEEK: "1" });
    expect(peek).toMatchObject({ code: 0, out: "" });
    expect(readFileSync(b.state, "utf8")).toBe(before);
    expect(g.requests).toEqual([]);
    const off = bot(g, { enabled: false });
    expect((await off.run(NODE, [HEART])).code).toBe(0);
  });
});

// ------------------------------------------------------------------ login, ensure

describe("scripts/opsbot-google login and ensure", () => {
  const client = (b: Bot) => { const f = join(b.dir, "client.json"); writeFileSync(f, JSON.stringify({ installed: { client_id: "client-1.apps.example", client_secret: "cs-secret" } })); return f; };

  /** Start login, wait for its consent URL, and return it with the running process. */
  async function startLogin(b: Bot, extra: string[] = []) {
    const child = spawn("bash", [CLI, "login", "--source", "gmail", "--client", client(b), ...extra], { cwd: b.root, env: b.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    kids.push({ kill: () => child.kill("SIGKILL") });
    await until(() => /https?:\/\/\S+\/auth\?\S+/.test(out));
    const consent = new URL(/(https?:\/\/\S+\/auth\?\S+)/.exec(out)![1]!);
    return { child, consent, out: () => out, err: () => err, exited };
  }

  test("asks for exactly the two scopes with PKCE; the loopback redirect writes the token file 0600 in a 0700 directory, never printed", async () => {
    const g = google();
    const b = bot(g, {}, { token: null });
    const r = await startLogin(b);
    expect(r.consent.searchParams.get("scope")!.split(" ").sort()).toEqual(SCOPES_GMAIL.split(" ").sort());
    expect(r.consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(r.consent.searchParams.get("login_hint")).toBe(ACCOUNT);
    const redirect = r.consent.searchParams.get("redirect_uri")!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const back = await fetch(`${redirect}/?code=code-1&state=${r.consent.searchParams.get("state")}&scope=x`);
    expect(back.status).toBe(200);
    expect(await r.exited).toBe(0);
    const ex = g.requests.find((q) => q.path === "/token")!.body;
    expect(ex).toMatchObject({ grant_type: "authorization_code", code: "code-1", redirect_uri: redirect, client_id: "client-1.apps.example" });
    expect(ex.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(mode(b.tokenFile)).toBe(0o600);
    expect(mode(join(b.dir, ".config/examplebot"))).toBe(0o700);
    expect(JSON.parse(readFileSync(b.tokenFile, "utf8"))).toMatchObject({ client_id: "client-1.apps.example", refresh_token: "rt-secret-1", scope: SCOPES_GMAIL });
    expect(r.out() + r.err()).not.toMatch(/rt-secret|at-first|cs-secret/);
  });

  test("--paste takes the redirect's address on stdin; a wrong state or a partial grant writes nothing", async () => {
    const g = google();
    const b = bot(g, {}, { token: null });
    const r = await startLogin(b, ["--paste"]);
    const redirect = r.consent.searchParams.get("redirect_uri")!;
    r.child.stdin.end(`${redirect}/?code=code-1&state=${r.consent.searchParams.get("state")}\n`);
    expect(await r.exited).toBe(0);
    expect(existsSync(b.tokenFile)).toBe(true);

    const c = bot(g, {}, { token: null });
    const w = await startLogin(c, ["--paste"]);
    w.child.stdin.end(`${redirect}/?code=code-1&state=not-it\n`);
    expect(await w.exited).toBe(1);
    expect(w.err()).toContain("state does not match");
    expect(existsSync(c.tokenFile)).toBe(false);

    g.grantScope = "https://www.googleapis.com/auth/pubsub";
    const d = bot(g, {}, { token: null });
    const p = await startLogin(d, ["--paste"]);
    p.child.stdin.end(`${p.consent.searchParams.get("redirect_uri")}/?code=code-1&state=${p.consent.searchParams.get("state")}\n`);
    expect(await p.exited).toBe(1);
    expect(p.err()).toContain("did not grant gmail.metadata");
    expect(existsSync(d.tokenFile)).toBe(false);
  });

  test("a Meet-only sign-in that would drop the enabled Gmail source's scopes from the shared token file is refused; bad usage is exit 2", async () => {
    const g = google();
    const b = bot(g, {}, { token: null });
    const m = await b.run("bash", [CLI, "login", "--source", "meet", "--client", "x"]);
    expect(m.err).toContain("login --source both");
    expect(m.code).toBe(1);
    expect(existsSync(b.tokenFile)).toBe(false);
    expect((await b.run("bash", [CLI, "login", "--source", "gmail"])).code).toBe(2);
    const e = await b.run("bash", [CLI, "ensure", "--source", "meet"]);
    expect(e.code).toBe(1);
    expect(e.err).toContain("streams.meet_push: account is not set");
    expect((await b.run("bash", [CLI, "ensure", "--bogus"])).code).toBe(2);
    expect((await b.run("bash", [CLI, "nothing"])).code).toBe(2);
  });

  test("ensure creates the watch now and records its expiry, keeping the cursor; --dry-run calls nothing", async () => {
    const g = google();
    const b = bot(g);
    const dry = await b.run("bash", [CLI, "ensure", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would watch");
    expect(g.requests).toEqual([]);
    mkdirSync(join(b.dir, ".cache/examplebot"), { recursive: true, mode: 0o700 });
    writeFileSync(b.state, JSON.stringify({ cursor: "42", problems: {} }), { mode: 0o600 });
    const r = await b.run("bash", [CLI, "ensure"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("gmail: watch on projects/example-project/topics/example-topic");
    expect(b.readState()).toMatchObject({ cursor: "42", watch: { expiration: expect.any(String) } });
    g.watchStatus = 403;
    const f = await b.run("bash", [CLI, "ensure"]);
    expect(f.code).toBe(1);
    expect(f.err).toContain("HTTP 403");
  });
});

// ------------------------------------------------------------------ install, status

describe("scripts/opsbot-google install and status", () => {
  const PIECES = ["monitor.d/30-gmail-push", "heartbeat.d/15-gmail-push"];

  test("install copies the source's scripts and prints the settings and the wake.files entry; it never writes opsbot.json", async () => {
    const g = google();
    const b = bot(g, { account: undefined, project: undefined, topic: undefined, subscription: undefined });
    const before = readFileSync(join(b.root, "opsbot.json"), "utf8");
    const dry = await b.run("bash", [CLI, "install", "--dry-run"]);
    expect(dry.code).toBe(0);
    for (const p of PIECES) expect(dry.out).toContain(`would write  opsbot.d/${p}`);
    expect(existsSync(join(b.root, "opsbot.d"))).toBe(false);
    const r = await b.run("bash", [CLI, "install"]);
    expect(r.code).toBe(0);
    for (const p of PIECES) {
      const f = join(b.root, "opsbot.d", p);
      expect(readFileSync(f, "utf8")).toBe(readFileSync(join(SKILL, "templates", p), "utf8"));
      expect(statSync(f).mode & 0o111).not.toBe(0);
    }
    expect(r.out).toContain('"gmail_push": {');
    expect(r.out).toContain('"account": "<the bot\'s Google account');
    expect(r.out).toContain(`"wake": { "files": [{ "file": "~/.cache/examplebot/gmail-push.jsonl", "inputs": ["15-gmail-push", "<the bot's own inbox reader`);
    expect(r.out).toContain("opsbot-google login --source gmail --client");
    expect(readFileSync(join(b.root, "opsbot.json"), "utf8")).toBe(before);
    expect(g.requests).toEqual([]);
    writeFileSync(join(b.root, "opsbot.d", PIECES[0]!), "changed\n");
    expect((await b.run("bash", [CLI, "install"])).out).toContain("differs from the template; --force replaces it");
    expect((await b.run("bash", [CLI, "install", "--force"])).out).toContain(`replaced     opsbot.d/${PIECES[0]}`);
    const both = await b.run("bash", [CLI, "install", "--source", "both", "--dry-run"]);
    expect(both.out).toContain("would write  opsbot.d/monitor.d/35-meet-transcripts");
    expect(both.out).toContain('"meet_push": {');
    expect((await b.run("bash", [CLI, "install", "--bogus"])).code).toBe(2);
  });

  test("status: every row ok against the stand-in, and it only reads", async () => {
    const g = google();
    const b = bot(g);
    await b.run("bash", [CLI, "install"]);
    mkdirSync(join(b.dir, ".cache/examplebot"), { recursive: true, mode: 0o700 });
    const now = Date.now();
    writeFileSync(b.state, JSON.stringify({ cursor: "1", watch: { expiration: new Date(now + 86400000).toISOString(), renewed_at: new Date(now).toISOString() }, last_pull: new Date(now).toISOString(), problems: {} }), { mode: 0o600 });
    writeFileSync(join(b.dir, "unit-active"), "");
    g.notify(7); // a message waiting: status hands it straight back
    const token = readFileSync(b.tokenFile, "utf8");
    const state = readFileSync(b.state, "utf8");
    const r = await b.run("bash", [CLI, "status"]);
    const pieces = r.out.trim().split("\n").filter((l) => /^(ok|missing|differs) /.test(l)).map((l) => l.split(/\s{2,}/)[1]);
    expect(pieces).toEqual(["streams.gmail_push", "token", "subscription", "watch", "last pull", "problems", "wake.files", ...PIECES, "listener"]);
    expect(r.out.trim().split("\n").pop()).toBe(`status: all ${pieces.length} ok`);
    expect(r.code).toBe(0);
    expect(readFileSync(b.tokenFile, "utf8")).toBe(token); // the refresh stayed in memory
    expect(readFileSync(b.state, "utf8")).toBe(state);
    expect(g.requests.map((q) => q.path).filter((p) => p !== "/token")).toEqual([`/v1/${SUB}:pull`, `/v1/${SUB}:modifyAckDeadline`]);
    expect(g.requests.find((q) => q.path.endsWith(":pull"))!.body).toEqual({ maxMessages: 1, returnImmediately: true });
    expect(g.queue).toHaveLength(1);
    expect(r.out).not.toMatch(/rt-secret|at-refreshed|cs-secret/);
    const meet = await b.run("bash", [CLI, "status", "--source", "both"]);
    expect(meet.out).toMatch(/^missing +streams\.meet_push +not in opsbot\.json/m);
  });

  test("status: each problem is a row with its fix", async () => {
    const g = google();
    g.pullStatus = 404;
    const b = bot(g, { topic: "" }, { wakeFiles: ["~/.cache/examplebot/gmail-push.jsonl"] });
    chmodSync(b.tokenFile, 0o644);
    mkdirSync(join(b.dir, ".cache/examplebot"), { recursive: true, mode: 0o700 });
    writeFileSync(b.state, JSON.stringify({ cursor: "1", watch: { expiration: "2020-01-01T00:00:00.000Z", renewed_at: "2019-12-25T00:00:00.000Z" }, last_pull: "2020-01-01T00:00:00.000Z", problems: { "sign-in": { since: "2020-01-01T00:00:00.000Z", raised: true, detail: "token refresh refused: invalid_grant" } } }), { mode: 0o600 });
    const r = await b.run("bash", [CLI, "status"]);
    expect(r.code).toBe(1);
    const row = (piece: string) => r.out.split("\n").find((l) => l.split(/\s{2,}/)[1] === piece) || "";
    const fixOf = (piece: string) => { const ls = r.out.split("\n"); return ls[ls.findIndex((l) => l.split(/\s{2,}/)[1] === piece) + 1] || ""; };
    expect(row("streams.gmail_push")).toMatch(/^missing .*required: topic/);
    expect(row("token")).toMatch(/^differs .*readable by others/);
    expect(fixOf("token")).toContain(`chmod 600 ${b.tokenFile}`);
    expect(row("watch")).toMatch(/^differs .*lapsed/);
    expect(fixOf("watch")).toContain("opsbot-google ensure");
    expect(row("last pull")).toMatch(/^differs/);
    expect(row("problem")).toMatch(/^differs .*sign-in since/);
    expect(fixOf("problem")).toContain("opsbot-google login");
    expect(row("wake.files")).toMatch(/^differs .*without 15-gmail-push/);
    for (const p of PIECES) expect(row(p)).toMatch(/^missing/);
    expect(row("listener")).toMatch(/^missing/);

    chmodSync(b.tokenFile, 0o600);
    const c = bot(g);
    const s = await c.run("bash", [CLI, "status"]);
    const srow = s.out.split("\n").find((l) => l.split(/\s{2,}/)[1] === "subscription") || "";
    expect(srow).toMatch(/^missing .*HTTP 404/);
    expect(s.out).toContain("templates/infra/");
  });
});
