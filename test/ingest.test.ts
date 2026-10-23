import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleIngest, INGEST_ROUTES } from "../src/ingest";
import { at, resetDb } from "./helpers";

const NOW = at("2026-10-22T15:00:00Z");
const MAA_KEY = "test-key-maa";
const APEX_KEY = "test-key-apex";

// INGEST_KEY_DOCWORKER is deliberately left unset.
const testEnv: Env = { ...env, INGEST_KEY_MAA: MAA_KEY, INGEST_KEY_APEX: APEX_KEY };

function post(path: string, body: unknown, key?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== undefined) headers.authorization = `Bearer ${key}`;
  return new Request(`https://pulse.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("ingest", () => {
  beforeEach(resetDb);

  it("every ingest route rejects a missing or wrong key with 401", async () => {
    expect(INGEST_ROUTES.length).toBeGreaterThanOrEqual(2);
    for (const path of INGEST_ROUTES) {
      for (const key of [undefined, "wrong", `${MAA_KEY}x`, MAA_KEY.slice(0, -1)]) {
        const res = await handleIngest(post(path, {}, key), testEnv, NOW);
        expect(res.status, `${path} with key ${key}`).toBe(401);
      }
    }
  });

  it("stores a heartbeat for the caller's own job", async () => {
    const res = await handleIngest(post("/ingest/heartbeat", { job: "maa-poll", status: "ok", detail: { tickers: 6, ok: 6, failed: 0 } }, MAA_KEY), testEnv, NOW);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: 1 });
    const row = await env.DB.prepare("SELECT job, at, status, detail FROM heartbeats").first();
    expect(row).toEqual({ job: "maa-poll", at: NOW, status: "ok", detail: '{"tickers":6,"ok":6,"failed":0}' });
  });

  it("rejects a job belonging to another app", async () => {
    const res = await handleIngest(post("/ingest/heartbeat", { job: "maa-poll", status: "ok" }, APEX_KEY), testEnv, NOW);
    expect(res.status).toBe(400);
    expect(await count("heartbeats")).toBe(0);
  });

  it("rejects an unknown job and a bad status", async () => {
    for (const body of [{ job: "nope", status: "ok" }, { job: "maa-poll", status: "great" }, { job: "maa-poll", status: "ok", detail: [1] }]) {
      const res = await handleIngest(post("/ingest/heartbeat", body, MAA_KEY), testEnv, NOW);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await count("heartbeats")).toBe(0);
  });

  it("rejects a body over 4 KB with 413", async () => {
    const big = { job: "maa-poll", status: "ok", detail: { pad: "x".repeat(5000) } };
    const res = await handleIngest(post("/ingest/heartbeat", big, MAA_KEY), testEnv, NOW);
    expect(res.status).toBe(413);
    expect(await count("heartbeats")).toBe(0);
  });

  it("rejects an oversized body even without a Content-Length header", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1000));
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 6; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const req = new Request("https://pulse.test/ingest/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${MAA_KEY}` },
      body: stream,
    });
    expect(req.headers.get("content-length")).toBeNull();
    const res = await handleIngest(req, testEnv, NOW);
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("https://pulse.test/ingest/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${MAA_KEY}` },
      body: "{not json",
    });
    const res = await handleIngest(req, testEnv, NOW);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON" });
  });

  it("rejects a non-finite metric value", async () => {
    // JSON has no Infinity, so a too-large number literal is how one arrives.
    const req = new Request("https://pulse.test/ingest/metric", {
      method: "POST",
      headers: { authorization: `Bearer ${MAA_KEY}` },
      body: '{"metrics":[{"name":"source.quote","value":1e999}]}',
    });
    const res = await handleIngest(req, testEnv, NOW);
    expect(res.status).toBe(400);
    expect(await count("metrics")).toBe(0);
  });

  it("rejects bad metric names, empty batches and batches over 50", async () => {
    const bodies = [
      { metrics: [{ name: "Source Quote", value: 1 }] },
      { metrics: [{ name: "a".repeat(65), value: 1 }] },
      { metrics: [{ name: "ok", value: "1" }] },
      { metrics: [{ name: "ok", value: 1, tags: { k: 2 } }] },
      { metrics: [] },
      { metrics: Array.from({ length: 51 }, () => ({ name: "n", value: 1 })) },
    ];
    for (const body of bodies) {
      const res = await handleIngest(post("/ingest/metric", body, MAA_KEY), testEnv, NOW);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await count("metrics")).toBe(0);
  });

  it("stores a batch of 3 metrics tagged with the caller's app", async () => {
    const body = {
      metrics: [
        { name: "source.quote", value: 4 },
        { name: "source.chart_fallback", value: 2, tags: { provider: "yfinance" } },
        { name: "source.history", value: 0 },
      ],
    };
    const res = await handleIngest(post("/ingest/metric", body, MAA_KEY), testEnv, NOW);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: 3 });
    const { results } = await env.DB.prepare("SELECT app, name, value, tags, at FROM metrics ORDER BY id").all();
    expect(results).toEqual([
      { app: "market-anomaly-alerts", name: "source.quote", value: 4, tags: null, at: NOW },
      { app: "market-anomaly-alerts", name: "source.chart_fallback", value: 2, tags: '{"provider":"yfinance"}', at: NOW },
      { app: "market-anomaly-alerts", name: "source.history", value: 0, tags: null, at: NOW },
    ]);
  });

  it("an unset key never matches an empty bearer", async () => {
    for (const header of ["Bearer ", "Bearer", ""]) {
      const req = new Request("https://pulse.test/ingest/heartbeat", {
        method: "POST",
        headers: { authorization: header },
        body: JSON.stringify({ job: "maa-poll", status: "ok" }),
      });
      const res = await handleIngest(req, testEnv, NOW);
      expect(res.status, JSON.stringify(header)).toBe(401);
    }
  });

  it("GET /ingest/heartbeat is 405", async () => {
    const res = await handleIngest(new Request("https://pulse.test/ingest/heartbeat"), testEnv, NOW);
    expect(res.status).toBe(405);
  });

  it("records D1 usage for the day", async () => {
    await handleIngest(post("/ingest/heartbeat", { job: "maa-poll", status: "ok" }, MAA_KEY), testEnv, NOW);
    await handleIngest(post("/ingest/heartbeat", { job: "maa-poll", status: "fail" }, MAA_KEY), testEnv, NOW);
    const row = await env.DB.prepare("SELECT day, rows_written FROM usage").first<{ day: string; rows_written: number }>();
    expect(row?.day).toBe("2026-10-22");
    expect(row?.rows_written).toBeGreaterThanOrEqual(2);
  });

  it("the deployed worker routes /ingest and fails closed with no keys configured", async () => {
    const res = await exports.default.fetch(post("/ingest/heartbeat", { job: "maa-poll", status: "ok" }, ""));
    expect(res.status).toBe(401);
  });
});
