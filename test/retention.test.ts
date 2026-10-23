import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateAwakeHours, percentile, prune, rollupDay } from "../src/retention";
import { at, resetDb } from "./helpers";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function insertCheck(target: string, when: number, ok: boolean, ms: number, coldStart = false) {
  await env.DB.prepare("INSERT INTO checks (target, at, ok, ms, cold_start) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(target, when, ok ? 1 : 0, ms, coldStart ? 1 : 0)
    .run();
}

describe("percentile", () => {
  it("percentile of [1..10] p95 is 10 and p50 is 5", () => {
    const xs = [3, 1, 4, 10, 5, 9, 2, 6, 8, 7];
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile(xs, 50)).toBe(5);
  });

  it("is null for no values", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("rollupDay", () => {
  beforeEach(resetDb);

  it("rollup excludes cold starts from p50 and p95 but counts them in uptime", async () => {
    const day = at("2026-10-21T00:00:00Z");
    await insertCheck("maa", day + 60 * MIN, true, 45_000, true);
    await insertCheck("maa", day + 65 * MIN, true, 200);
    await insertCheck("maa", day + 70 * MIN, true, 300);
    await insertCheck("maa", day + 75 * MIN, false, 90_000);
    await insertCheck("maa", day + DAY + MIN, true, 999); // next day, ignored
    await rollupDay(env, "2026-10-21");
    const row = await env.DB.prepare("SELECT * FROM daily_rollups").first();
    expect(row).toEqual({ day: "2026-10-21", subject: "target:maa", checks: 4, ok: 3, p50_ms: 200, p95_ms: 300 });
  });

  it("rerunning a day overwrites instead of duplicating", async () => {
    await insertCheck("apex-os", at("2026-10-21T12:00:00Z"), true, 100);
    await rollupDay(env, "2026-10-21");
    await rollupDay(env, "2026-10-21");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_rollups").first())?.n).toBe(1);
  });
});

describe("prune", () => {
  beforeEach(resetDb);

  it("prune keeps a 29-day-old check and deletes a 31-day-old one", async () => {
    const now = at("2026-10-22T12:00:00Z");
    await insertCheck("apex-os", now - 29 * DAY, true, 100);
    await insertCheck("apex-os", now - 31 * DAY, true, 100);
    await prune(env, now);
    const { results } = await env.DB.prepare("SELECT at FROM checks").all();
    expect(results).toEqual([{ at: now - 29 * DAY }]);
  });

  it("keeps rollups for a year and alerts for 90 days", async () => {
    const now = at("2026-10-22T12:00:00Z");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_rollups (day, subject, checks, ok) VALUES ('2025-10-01', 'target:x', 1, 1)"),
      env.DB.prepare("INSERT INTO daily_rollups (day, subject, checks, ok) VALUES ('2026-01-01', 'target:x', 1, 1)"),
      env.DB.prepare("INSERT INTO alerts (subject, kind, at, message) VALUES ('x', 'down', ?1, 'old')").bind(now - 91 * DAY),
      env.DB.prepare("INSERT INTO alerts (subject, kind, at, message) VALUES ('x', 'down', ?1, 'new')").bind(now - 89 * DAY),
    ]);
    await prune(env, now);
    expect((await env.DB.prepare("SELECT day FROM daily_rollups").all()).results).toEqual([{ day: "2026-01-01" }]);
    expect((await env.DB.prepare("SELECT message FROM alerts").all()).results).toEqual([{ message: "new" }]);
  });
});

describe("estimateAwakeHours", () => {
  it("two checks 5 minutes apart are 20 minutes awake; two 3 hours apart are 30 minutes", () => {
    const t = at("2026-10-22T12:00:00Z");
    expect(estimateAwakeHours([t, t + 5 * MIN])).toBeCloseTo(20 / 60);
    expect(estimateAwakeHours([t, t + 180 * MIN])).toBeCloseTo(30 / 60);
  });

  it("a market day of 5-minute checks is about 6.75 hours", () => {
    const open = at("2026-10-22T13:30:00Z");
    const checks = Array.from({ length: 78 }, (_, i) => open + i * 5 * MIN);
    // 77 gaps of 5 min, then 15 min after the last check.
    expect(estimateAwakeHours(checks)).toBeCloseTo((77 * 5 + 15) / 60);
  });

  it("is 0 with no checks", () => {
    expect(estimateAwakeHours([])).toBe(0);
  });
});
