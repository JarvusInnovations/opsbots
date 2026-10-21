import { afterEach, describe, expect, test } from "bun:test";
import { nextDelay } from "../src/opsbot-core/cadence";
import { withDefaults } from "../src/opsbot-core/settings";
import type { LogLine } from "../src/opsbot-core/state";
import { BASE_SETTINGS, cli, makeBot, setSettings, type Bot } from "./helpers";

// The support-desk bot's table, as it ran: Eastern time, working hours
// Monday to Friday 7:30 a.m. to 4:30 p.m., night 9 p.m. to 7:30 a.m.
const SUPPORT_DESK = withDefaults({
  ...BASE_SETTINGS,
  timezone: "America/New_York",
  cadence: {
    hot: 180,
    warm: 600,
    quiet_working: 600,
    quiet: 1800,
    night: 2700,
    cap: 2700,
    working_hours: { days: [1, 2, 3, 4, 5], start: "07:30", end: "16:30" },
    night_hours: { start: "21:00", end: "07:30" },
  },
});
const KIT = withDefaults({ ...BASE_SETTINGS });

const arrival = (at: string, n = 1): LogLine => ({ at, outcome: "new", new: n });
const quiet = (at: string): LogLine => ({ at, outcome: "nothing-new", new: 0 });
const at = (iso: string) => Date.parse(iso);

describe("next-delay: the support-desk table", () => {
  // 2026-10-21 is a Wednesday; Eastern is UTC-4 then
  const cases: Array<[string, string, LogLine[], number, string]> = [
    ["arrival 5 min ago, working hours", "2026-10-21T14:00:00Z", [arrival("2026-10-21T13:55:00Z")], 180, "arrived in the last 15 minutes"],
    ["arrival 30 min ago, working hours", "2026-10-21T14:00:00Z", [arrival("2026-10-21T13:30:00Z")], 600, "arrived in the last hour"],
    ["quiet, working hours", "2026-10-21T14:00:00Z", [quiet("2026-10-21T13:50:00Z")], 600, "quiet, working hours"],
    ["quiet, weekday evening", "2026-10-21T22:00:00Z", [], 1800, "quiet, otherwise"],
    ["night beats a 30-minute-old arrival", "2026-10-22T02:00:00Z", [arrival("2026-10-22T01:30:00Z")], 2700, "night"],
    ["a fresh arrival beats night", "2026-10-22T02:00:00Z", [arrival("2026-10-22T01:55:00Z")], 180, "arrived in the last 15 minutes"],
    ["before 7:30 a.m. is night", "2026-10-22T11:00:00Z", [], 2700, "night"],
    ["7:30 a.m. on a weekday is working hours", "2026-10-22T11:30:00Z", [], 600, "quiet, working hours"],
    ["4:30 p.m. is no longer working hours", "2026-10-22T20:30:00Z", [], 1800, "quiet, otherwise"],
    ["Saturday morning", "2026-10-24T14:00:00Z", [], 1800, "quiet, otherwise"],
    ["a degraded check with items counts as an arrival", "2026-10-21T14:00:00Z", [{ at: "2026-10-21T13:58:00Z", outcome: "degraded", new: 2 }], 180, "arrived in the last 15 minutes"],
    ["a check with no items is not an arrival", "2026-10-21T22:00:00Z", [{ at: "2026-10-21T21:58:00Z", outcome: "degraded", new: 0 }], 1800, "quiet, otherwise"],
  ];
  for (const [name, now, lines, seconds, reason] of cases) {
    test(name, () => {
      expect(nextDelay(SUPPORT_DESK, lines, at(now))).toEqual({ seconds, reason });
    });
  }
});

describe("next-delay: kit defaults", () => {
  test("weekday noon UTC is working hours", () => {
    expect(nextDelay(KIT, [], at("2026-10-21T12:00:00Z"))).toEqual({ seconds: 600, reason: "quiet, working hours" });
  });
  test("weekday 8 a.m. is quiet, otherwise", () => {
    expect(nextDelay(KIT, [], at("2026-10-21T08:00:00Z"))).toEqual({ seconds: 1800, reason: "quiet, otherwise" });
  });
  test("11 p.m. is night", () => {
    expect(nextDelay(KIT, [], at("2026-10-21T23:00:00Z"))).toEqual({ seconds: 2700, reason: "night" });
  });
  test("never over the cap", () => {
    const s = withDefaults({ ...BASE_SETTINGS, cadence: { quiet: 1800, night: 2700, cap: 1200 } });
    expect(nextDelay(s, [], at("2026-10-21T23:00:00Z")).seconds).toBe(1200);
  });
});

describe("next-delay command", () => {
  let bot: Bot;
  afterEach(() => bot?.cleanup());
  test("prints <seconds> <reason> from the committed settings", () => {
    bot = makeBot();
    setSettings(bot, { cadence: { quiet: 1500 } });
    const r = cli(bot, ["next-delay"], { now: "2026-10-21T08:00:00Z" });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('next: "1500 quiet, otherwise"');
  });
});
