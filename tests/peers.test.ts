import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "skills/opsbot-core/templates/heartbeat.d/50-peer-sessions");

/** A stand-in for agent-recall-axi: writes canned JSON to --json-out, or fails for session "bad". */
function setup(events: unknown[], sessions: unknown[], peers: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-peers-test-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(dir, "events.json"), JSON.stringify({ events }));
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ sessions }));
  writeFileSync(join(bin, "agent-recall-axi"), `#!/bin/bash
out=""; for a in "$@"; do case "$a" in --json-out=*) out="\${a#--json-out=}";; esac; done
echo "$@" >> "${dir}/calls.log"
if [ "$2" = "bad" ]; then echo "error: no such session"; exit 1; fi
cp "${dir}/$1.json" "$out"
`);
  chmodSync(join(bin, "agent-recall-axi"), 0o755);
  writeFileSync(join(dir, "opsbot.json"), JSON.stringify({ name: "leadbot", streams: { peers } }));
  const run = () => {
    const r = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, OPSBOT_RECALL: join(bin, "agent-recall-axi"), OPSBOT_CONFIG: join(dir, "opsbot.json"), OPSBOT_NAME: "leadbot", OPSBOT_SINCE: "2026-03-02T14:00:00Z" },
    });
    return { code: r.status, items: r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)), err: r.stderr };
  };
  return { dir, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const EVENTS = [
  { id: "aaaa1111:10", t: "2026-03-02T14:05:00Z", kind: "human", text: "ship the fix today, skip the refactor" },
  { id: "aaaa1111:12", t: "2026-03-02T14:06:00Z", kind: "assistant", text: "Reading the module to see where the grant lives." },
  { id: "aaaa1111:20", t: "2026-03-02T14:20:00Z", kind: "assistant", text: "PR opened and CI is green; waiting on review." },
  { id: "aaaa1111:22", t: "2026-03-02T14:21:00Z", kind: "human.queued", text: "also bump the version" },
];

describe("heartbeat.d/50-peer-sessions", () => {
  test("no peers configured: nothing printed, exit 0", () => {
    const t = setup([], [], {});
    try { const r = t.run(); expect(r.code).toBe(0); expect(r.items).toEqual([]); } finally { t.cleanup(); }
  });

  test("the operator's messages come through verbatim; the peer's only when they change state; keys are the event ids", () => {
    const t = setup(EVENTS, [], { sessions: [{ name: "dev", session: "aaaa1111" }] });
    try {
      const r = t.run();
      expect(r.code).toBe(0);
      expect(r.items.map((i) => i.key)).toEqual(["peer:dev:aaaa1111:10", "peer:dev:aaaa1111:20", "peer:dev:aaaa1111:22"]);
      expect(r.items[0]).toMatchObject({ from: "operator to dev", text: "ship the fix today, skip the refactor", conv: "peer:dev", kind: "peer" });
      expect(r.items[1]!.from).toBe("dev");
    } finally { t.cleanup(); }
  });

  test("a custom state_pattern replaces the default; long text is cut with its size and the command for the rest", () => {
    const long = { id: "aaaa1111:30", t: "2026-03-02T14:30:00Z", kind: "human", text: "x".repeat(500) };
    const t = setup([...EVENTS, long], [], { sessions: [{ name: "dev", session: "aaaa1111" }], state_pattern: "Reading", max_text: 100 });
    try {
      const r = t.run();
      expect(r.items.map((i) => i.event)).toEqual(["aaaa1111:10", "aaaa1111:12", "aaaa1111:22", "aaaa1111:30"]);
      expect(r.items[3]!.text).toContain("500 chars");
      expect(r.items[3]!.text.length).toBeLessThan(200);
    } finally { t.cleanup(); }
  });

  test("a newer session in the peer's project is one rollover item; the bot's own session and the watched one are not", () => {
    const sessions = [
      { id: "aaaa1111-0000", title: "dev", last: "2026-03-02T14:00:00Z" },
      { id: "cccc3333-0000", title: "leadbot", last: "2026-03-02T15:00:00Z" },
      { id: "bbbb2222-0000", title: "dev again", last: "2026-03-02T14:40:00Z" },
    ];
    const t = setup([], sessions, { sessions: [{ name: "dev", session: "aaaa1111", project: "proj" }] });
    try {
      const r = t.run();
      expect(r.items).toHaveLength(1);
      expect(r.items[0]!.key).toBe("peer:dev:rollover:bbbb2222-0000");
    } finally { t.cleanup(); }
    const same = setup([], sessions.slice(0, 2), { sessions: [{ name: "dev", session: "aaaa1111", project: "proj" }] });
    try { expect(same.run().items).toEqual([]); } finally { same.cleanup(); }
  });

  test("a peer that cannot be read fails the input (degraded) and the others still report", () => {
    const t = setup(EVENTS, [], { sessions: [{ name: "gone", session: "bad" }, { name: "dev", session: "aaaa1111" }] });
    try {
      const r = t.run();
      expect(r.code).toBe(1);
      expect(r.items.length).toBe(3);
      expect(r.err).toContain("no such session");
    } finally { t.cleanup(); }
  });
});
