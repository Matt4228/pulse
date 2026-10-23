import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertMessage, flushAlerts, transition } from "../src/alerts";
import type { Env } from "../src/env";
import { at, resetDb } from "./helpers";

const T0 = at("2026-10-22T14:00:00Z");
const MIN = 60_000;
const HOOK = "https://hooks.slack.test/services/T/B/x";
const slackEnv: Env = { ...env, SLACK_WEBHOOK_URL: HOOK };

async function alertRows() {
  const { results } = await env.DB.prepare("SELECT subject, kind, message, sent FROM alerts ORDER BY id").all();
  return results;
}

async function insertAlerts(n: number) {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare("INSERT INTO alerts (subject, kind, at, message) VALUES (?1, 'down', ?2, ?3)")
      .bind(`target:t${i}`, T0, `alert ${i}`)
      .run();
  }
}

function slackTexts(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).text);
}

describe("transition", () => {
  beforeEach(resetDb);

  it("the first observation creates no alert", async () => {
    expect(await transition(env, "target:apex-os", "down", T0, "apex-os")).toBe(false);
    expect(await alertRows()).toEqual([]);
    const state = await env.DB.prepare("SELECT state, since FROM states WHERE subject = 'target:apex-os'").first();
    expect(state).toEqual({ state: "down", since: T0 });
  });

  it("an unchanged state creates no alert and keeps since", async () => {
    await transition(env, "target:apex-os", "up", T0, "apex-os");
    expect(await transition(env, "target:apex-os", "up", T0 + 5 * MIN, "apex-os")).toBe(false);
    const state = await env.DB.prepare("SELECT since FROM states WHERE subject = 'target:apex-os'").first();
    expect(state).toEqual({ since: T0 });
  });

  it("up to down creates one down alert", async () => {
    await transition(env, "target:apex-os", "up", T0, "apex-os");
    expect(await transition(env, "target:apex-os", "down", T0 + 10 * MIN, "apex-os")).toBe(true);
    expect(await alertRows()).toEqual([
      { subject: "target:apex-os", kind: "down", message: "🔴 apex-os is down (2 failed checks in a row).", sent: 0 },
    ]);
  });

  it("down to up creates a recovered alert with the outage length", async () => {
    await transition(env, "target:apex-os", "up", T0, "apex-os");
    await transition(env, "target:apex-os", "down", T0 + 10 * MIN, "apex-os");
    await transition(env, "target:apex-os", "up", T0 + 22 * MIN, "apex-os");
    expect((await alertRows())[1]).toMatchObject({ kind: "recovered", message: "🟢 apex-os recovered after 12 min." });
  });

  it("ok to idle creates no alert", async () => {
    await transition(env, "job:maa-poll", "ok", T0, "maa-poll");
    expect(await transition(env, "job:maa-poll", "idle", T0 + MIN, "maa-poll")).toBe(false);
    expect(await transition(env, "job:maa-poll", "ok", T0 + 2 * MIN, "maa-poll")).toBe(false);
    expect(await alertRows()).toEqual([]);
  });

  it("idle to late alerts, then late to failing alerts again", async () => {
    await transition(env, "job:maa-poll", "idle", T0, "maa-poll");
    expect(await transition(env, "job:maa-poll", "late", T0 + MIN, "maa-poll")).toBe(true);
    expect(await transition(env, "job:maa-poll", "failing", T0 + 2 * MIN, "maa-poll")).toBe(true);
    expect((await alertRows()).map((r) => r.message)).toEqual([
      "🟠 maa-poll has not checked in on time.",
      "🔴 maa-poll is running but its last 3 runs failed.",
    ]);
  });

  it("late to ok creates a job_recovered alert with the duration", async () => {
    await transition(env, "job:apex-reseed", "ok", T0, "apex-reseed");
    await transition(env, "job:apex-reseed", "late", T0 + MIN, "apex-reseed");
    await transition(env, "job:apex-reseed", "ok", T0 + MIN + 185 * MIN, "apex-reseed");
    expect((await alertRows())[1]).toMatchObject({
      kind: "job_recovered",
      message: "🟢 apex-reseed is checking in again after 3 h 5 min.",
    });
  });

  it("a duplicate tick applying the same change alerts once", async () => {
    await transition(env, "target:apex-os", "up", T0, "apex-os");
    const results = await Promise.all([
      transition(env, "target:apex-os", "down", T0 + MIN, "apex-os"),
      transition(env, "target:apex-os", "down", T0 + MIN, "apex-os"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await alertRows()).toHaveLength(1);
  });
});

describe("alertMessage", () => {
  it('formats 185 minutes as "3 h 5 min"', () => {
    expect(alertMessage("recovered", "x", T0, T0 + 185 * MIN)).toBe("🟢 x recovered after 3 h 5 min.");
  });

  it("formats days, whole hours and sub-minute spans", () => {
    expect(alertMessage("recovered", "x", T0, T0 + (2 * 1440 + 4 * 60 + 7) * MIN)).toBe("🟢 x recovered after 2 d 4 h.");
    expect(alertMessage("recovered", "x", T0, T0 + 120 * MIN)).toBe("🟢 x recovered after 2 h.");
    expect(alertMessage("recovered", "x", T0, T0 + 20_000)).toBe("🟢 x recovered after 1 min.");
  });
});

describe("flushAlerts", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("posts each unsent alert to Slack and marks it sent", async () => {
    await insertAlerts(2);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    expect(await flushAlerts(slackEnv)).toBe(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(HOOK);
    expect(slackTexts(fetchSpy)).toEqual(["alert 0", "alert 1"]);
    expect((await alertRows()).every((r) => r.sent === 1)).toBe(true);
  });

  it("two concurrent flushes send each alert once", async () => {
    await insertAlerts(3);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const [a, b] = await Promise.all([flushAlerts(slackEnv), flushAlerts(slackEnv)]);
    expect(a + b).toBe(3);
    expect(slackTexts(fetchSpy).sort()).toEqual(["alert 0", "alert 1", "alert 2"]);
  });

  it("a failed Slack post leaves the alert unsent for the next tick", async () => {
    await insertAlerts(2);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockRejectedValueOnce(new Error("network down"));
    expect(await flushAlerts(slackEnv)).toBe(0);
    expect((await alertRows()).map((r) => r.sent)).toEqual([0, 0]);
  });

  it("sends at most 20 per call so a Slack outage can't exceed the subrequest limit", async () => {
    await insertAlerts(25);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    expect(await flushAlerts(slackEnv)).toBe(20);
    expect(await flushAlerts(slackEnv)).toBe(5);
  });

  it("does nothing without a webhook configured", async () => {
    await insertAlerts(1);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await flushAlerts(env)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await alertRows())[0]).toMatchObject({ sent: 0 });
  });
});
