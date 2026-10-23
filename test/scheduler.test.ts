import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { getMeta, healthStatus, tick } from "../src/scheduler";
import { at, resetDb } from "./helpers";

const MIN = 60_000;
const OPEN = at("2026-10-22T14:00:00Z");
const slackEnv: Env = { ...env, SLACK_WEBHOOK_URL: "https://hooks.slack.test/x" };

describe("tick", () => {
  beforeEach(async () => {
    await resetDb();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("a tick runs due checks, evaluates jobs and records meta:tick", async () => {
    const report = await tick(env, OPEN);
    expect(report).toEqual({ checks: 4, alerts: 0, errors: [] });
    expect(await getMeta(env, "tick")).toBe(OPEN);
    const { results } = await env.DB.prepare("SELECT subject, state FROM states WHERE subject LIKE 'job:%' ORDER BY subject").all();
    // Neither job has pinged: apex-reseed is past its 06:30 deadline, maa-poll is 30 min past the open.
    // As first observations these set state without alerting.
    expect(results).toEqual([
      { subject: "job:apex-reseed", state: "late" },
      { subject: "job:maa-poll", state: "late" },
    ]);
  });

  it("a failing GitHub refresh does not stop alerts from flushing", async () => {
    const failing = vi.fn(async () => {
      throw new Error("GitHub 502");
    });
    await env.DB.prepare("INSERT INTO alerts (subject, kind, at, message) VALUES ('target:x', 'down', ?1, 'x down')").bind(OPEN).run();
    const report = await tick(slackEnv, OPEN, failing);
    expect(failing).toHaveBeenCalledOnce();
    expect(report.errors).toEqual(["github: GitHub 502"]);
    expect(report.alerts).toBe(1);
    // Not marked as refreshed, so the next tick retries.
    expect(await getMeta(env, "github")).toBeNull();
  });

  it("refreshes GitHub every 15 minutes, not every tick", async () => {
    const refresh = vi.fn(async () => {});
    for (const m of [0, 1, 14, 15]) await tick(env, OPEN + m * MIN, refresh);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("retention runs once per UTC day, not on every tick after 00:10", async () => {
    await tick(env, at("2026-10-23T00:05:00Z"));
    expect(await getMeta(env, "retention")).toBeNull();
    await tick(env, at("2026-10-23T00:10:00Z"));
    expect(await getMeta(env, "retention")).toBe(at("2026-10-23T00:10:00Z"));
    await tick(env, at("2026-10-23T00:11:00Z"));
    await tick(env, at("2026-10-23T18:00:00Z"));
    expect(await getMeta(env, "retention")).toBe(at("2026-10-23T00:10:00Z"));
    await tick(env, at("2026-10-24T00:10:00Z"));
    expect(await getMeta(env, "retention")).toBe(at("2026-10-24T00:10:00Z"));
  });

  it("records the tick's D1 usage", async () => {
    await tick(env, OPEN);
    const row = await env.DB.prepare("SELECT rows_read, rows_written FROM usage WHERE day = '2026-10-22'").first<{ rows_read: number; rows_written: number }>();
    expect(row?.rows_written).toBeGreaterThan(0);
  });

  it("the scheduled handler ticks at the scheduled minute", async () => {
    await worker.scheduled(createScheduledController({ scheduledTime: OPEN, cron: "* * * * *" }), env, createExecutionContext());
    expect(await getMeta(env, "tick")).toBe(OPEN);
  });
});

describe("health", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("health is 200 with lastTick right after a tick", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    await tick(env, OPEN);
    expect(await healthStatus(env, OPEN + MIN)).toEqual({ healthy: true, lastTick: OPEN });
  });

  it("health is 503 when the last tick is over 5 minutes old", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    await tick(env, OPEN);
    expect(await healthStatus(env, OPEN + 5 * MIN)).toEqual({ healthy: true, lastTick: OPEN });
    expect(await healthStatus(env, OPEN + 5 * MIN + 1)).toEqual({ healthy: false, lastTick: OPEN });
  });

  it("with no tick yet: healthy on a fresh database, stale once apps have reported for 5 minutes", async () => {
    expect(await healthStatus(env, OPEN)).toEqual({ healthy: true, lastTick: null });
    await env.DB.prepare("INSERT INTO heartbeats (job, at, status) VALUES ('maa-poll', ?1, 'ok')").bind(OPEN).run();
    expect(await healthStatus(env, OPEN + 4 * MIN)).toEqual({ healthy: true, lastTick: null });
    expect(await healthStatus(env, OPEN + 6 * MIN)).toEqual({ healthy: false, lastTick: null });
  });

  it("GET /health answers 503 with status stale when the scheduler has stopped", async () => {
    await env.DB.prepare("INSERT INTO states (subject, state, since) VALUES ('meta:tick', 'ran', ?1)").bind(Date.now() - 10 * MIN).run();
    const res = await exports.default.fetch("https://pulse.test/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "stale" });
  });
});
