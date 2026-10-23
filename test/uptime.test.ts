import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TARGETS, type Target } from "../src/config";
import { dueTargets, nextTargetState, runCheck, runDueChecks } from "../src/uptime";
import { UsageMeter } from "../src/usage";
import { at, resetDb } from "./helpers";

const OPEN = at("2026-10-22T14:00:00Z"); // Thursday, market open
const MIN = 60_000;

function target(id: string): Target {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
}

const ids = (ts: Target[]) => ts.map((t) => t.id).sort();

/** A fake clock that returns the given readings in order. */
function clockOf(...readings: number[]): () => number {
  return () => readings.shift() ?? 0;
}

describe("dueTargets", () => {
  it("every target is due on a fresh database", () => {
    expect(ids(dueTargets(OPEN, {}))).toEqual(["apex-os", "doc-worker", "doc-worker-api", "maa"]);
  });

  it("does not recheck a target checked 30 s ago", () => {
    expect(ids(dueTargets(OPEN, { "apex-os": OPEN - 30_000 }))).not.toContain("apex-os");
  });

  it("a target checked 4 min 40 s ago is due (cron jitter slack)", () => {
    expect(ids(dueTargets(OPEN, { "apex-os": OPEN - 280_000 }))).toContain("apex-os");
  });

  it("a target last checked 7 minutes ago is due", () => {
    expect(ids(dueTargets(OPEN, { "apex-os": OPEN - 7 * MIN }))).toContain("apex-os");
  });

  it("maa is not due while the market is closed", () => {
    expect(ids(dueTargets(at("2026-10-22T22:00:00Z"), {}))).not.toContain("maa");
  });

  it("doc-worker-api is not due 2 hours after its last check", () => {
    const now = OPEN;
    expect(ids(dueTargets(now, { "doc-worker-api": now - 120 * MIN }))).not.toContain("doc-worker-api");
    expect(ids(dueTargets(now, { "doc-worker-api": now - 180 * MIN }))).toContain("doc-worker-api");
  });
});

describe("runCheck", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a 200 is ok", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("fine"));
    const r = await runCheck(target("apex-os"), OPEN, OPEN - 5 * MIN, clockOf(0, 120));
    expect(r).toEqual({ target: "apex-os", at: OPEN, ok: true, status: 200, ms: 120, coldStart: false, reason: null });
  });

  it("a 503 is a failed check with reason status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    const r = await runCheck(target("apex-os"), OPEN, OPEN - 5 * MIN);
    expect(r).toMatchObject({ ok: false, status: 503, reason: "status" });
  });

  it("a response slower than the timeout is reason timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const quick: Target = { ...target("apex-os"), timeoutMs: 20 };
    const r = await runCheck(quick, OPEN, OPEN - 5 * MIN);
    expect(r).toMatchObject({ ok: false, status: null, reason: "timeout" });
  });

  it("a DNS or connection failure is reason network", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const r = await runCheck(target("apex-os"), OPEN, OPEN - 5 * MIN);
    expect(r).toMatchObject({ ok: false, status: null, reason: "network" });
  });

  it("a Render check taking 40 s counts as up and is flagged cold start", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const r = await runCheck(target("maa"), OPEN, OPEN - 5 * MIN, clockOf(0, 40_000));
    expect(r).toMatchObject({ ok: true, ms: 40_000, coldStart: true });
  });

  it("a fast Render check after 16 idle minutes is still a cold start; after 5 it is not", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    expect((await runCheck(target("maa"), OPEN, OPEN - 16 * MIN, clockOf(0, 300))).coldStart).toBe(true);
    expect((await runCheck(target("maa"), OPEN, OPEN - 5 * MIN, clockOf(0, 300))).coldStart).toBe(false);
  });

  it("a slow Vercel check is never a cold start", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    expect((await runCheck(target("apex-os"), OPEN, undefined, clockOf(0, 40_000))).coldStart).toBe(false);
  });
});

describe("nextTargetState", () => {
  it("one failure keeps a target up; two in a row mark it down; one ok brings it back up", () => {
    expect(nextTargetState([false], "up")).toBe("up");
    expect(nextTargetState([false, true], "up")).toBe("up");
    expect(nextTargetState([false, false], "up")).toBe("down");
    expect(nextTargetState([false, false], "down")).toBe("down");
    expect(nextTargetState([true, false], "down")).toBe("up");
    expect(nextTargetState([false], undefined)).toBe("up");
  });
});

describe("runDueChecks", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("stores a row per due target and alerts only on the second failure in a row", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("apex-os") ? new Response("", { status: 500 }) : new Response("ok"),
    );
    await runDueChecks(env, OPEN);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM checks").first())?.n).toBe(4);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts").first())?.n).toBe(0);

    await runDueChecks(env, OPEN + 5 * MIN);
    const alerts = await env.DB.prepare("SELECT subject, kind FROM alerts").all();
    expect(alerts.results).toEqual([{ subject: "target:apex-os", kind: "down" }]);
  });

  it("a second tick in the same minute checks nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    await runDueChecks(env, OPEN);
    expect(await runDueChecks(env, OPEN + 20_000)).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("a slow check still in flight is not started again by the next tick", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("doc-worker-api")) await gate; // a 50 s cold start
      return new Response("ok");
    });
    const first = runDueChecks(env, OPEN);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4));
    const second = await runDueChecks(env, OPEN + MIN);
    expect(second.map((r) => r.target)).not.toContain("doc-worker-api");
    release();
    await first;
    const apiCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes("doc-worker-api"));
    expect(apiCalls).toHaveLength(1);
  });

  it("reads a handful of rows per tick even with 30 days of history", async () => {
    // 4 targets x 30 days x one check a minute: far more than real cadence.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 43200)
       INSERT INTO checks (target, at, ok, ms)
       SELECT t.id, ?1 - n.i * 60000, 1, 100 FROM n,
         (SELECT 'apex-os' AS id UNION ALL SELECT 'doc-worker' UNION ALL SELECT 'doc-worker-api' UNION ALL SELECT 'maa') AS t`,
    )
      .bind(OPEN)
      .run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const meter = new UsageMeter();
    await runDueChecks(env, OPEN, meter);
    expect(meter.totals.read).toBeLessThan(100);
  });
});
