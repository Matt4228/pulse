import { env, exports } from "cloudflare:workers";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessHost } from "../src/auth";
import { handleDashboard, loadDashboard, renderDashboard } from "../src/dashboard";
import type { Env } from "../src/env";
import { at, resetDb } from "./helpers";

const TEAM = "pulse-test.cloudflareaccess.com";
const AUD = "test-aud-tag";
const OWNER = "matt@example.com";
const OPEN = at("2026-10-22T15:00:00Z");
const CLOSED = at("2026-10-22T22:00:00Z");

const accessEnv: Env = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: OWNER };

let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys = async () => pair.publicKey;
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
});

async function token(claims: { email?: string; aud?: string; iss?: string; key?: CryptoKey; exp?: string } = {}): Promise<string> {
  return new SignJWT({ email: claims.email ?? OWNER })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(claims.iss ?? `https://${TEAM}`)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "5m")
    .sign(claims.key ?? privateKey);
}

function dashboardRequest(jwt?: string): Request {
  return new Request("https://pulse.test/", { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });
}

describe("dashboard access", () => {
  beforeEach(resetDb);

  it("dashboard is 503 when Access is not configured", async () => {
    for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL"] as const) {
      const partial: Env = { ...accessEnv, [missing]: undefined };
      const res = await handleDashboard(dashboardRequest(await token()), partial, OPEN, keys);
      expect(res.status, missing).toBe(503);
    }
  });

  it("the deployed worker fails closed with no Access settings", async () => {
    const res = await exports.default.fetch("https://pulse.test/");
    expect(res.status).toBe(503);
  });

  it("missing or invalid token is 403", async () => {
    const bad = [
      undefined,
      "not-a-jwt",
      await token({ key: otherPrivateKey }), // signed by someone else
      await token({ aud: "another-app" }),
      await token({ iss: "https://evil.cloudflareaccess.com" }),
      await token({ exp: "-1m" }), // expired
    ];
    for (const jwt of bad) {
      const res = await handleDashboard(dashboardRequest(jwt), accessEnv, OPEN, keys);
      expect(res.status, String(jwt).slice(0, 30)).toBe(403);
    }
  });

  it("valid token for another email is 403", async () => {
    const res = await handleDashboard(dashboardRequest(await token({ email: "someone@else.com" })), accessEnv, OPEN, keys);
    expect(res.status).toBe(403);
  });

  it("valid owner token gets the HTML with all three apps", async () => {
    const res = await handleDashboard(dashboardRequest(await token({ email: "Matt@Example.com" })), accessEnv, OPEN, keys);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    for (const app of ["apex-os", "doc-worker", "market-anomaly-alerts"]) expect(html).toContain(`<h2>${app}</h2>`);
    expect(html).not.toMatch(/<script/i);
  });

  it("accepts the team domain with or without https://", () => {
    expect(accessHost("https://pulse-test.cloudflareaccess.com/")).toBe(TEAM);
    expect(accessHost(TEAM)).toBe(TEAM);
  });
});

describe("dashboard content", () => {
  beforeEach(resetDb);

  it("a commit message containing <script> is escaped", async () => {
    await env.DB.prepare("INSERT INTO commits (repo, sha, at, author, message, pr) VALUES ('apex-os', 'abc1234def', ?1, '<b>x</b>', ?2, 7)")
      .bind(OPEN, '<script>alert("hi")</script> & more')
      .run();
    const html = renderDashboard(await loadDashboard(env, OPEN));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; more");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain('href="https://github.com/Matt4228/apex-os/pull/7"');
  });

  it("a squash merge's (#n) becomes the PR link instead of appearing twice", async () => {
    await env.DB.prepare("INSERT INTO commits (repo, sha, at, author, message, pr) VALUES ('maa', 'f00ba12', ?1, 'Matt4228', 'Add fallback (#6)', 6)")
      .bind(OPEN)
      .run();
    await env.DB.prepare("UPDATE commits SET repo = 'market-anomaly-alerts'").run();
    const html = renderDashboard(await loadDashboard(env, OPEN));
    expect(html).toContain('Add fallback <a href="https://github.com/Matt4228/market-anomaly-alerts/pull/6">#6</a>');
    expect(html).not.toContain("(#6)");
  });

  it("maa outside market hours shows asleep (expected), not down", async () => {
    await env.DB.prepare("INSERT INTO states (subject, state, since) VALUES ('target:maa', 'down', ?1)").bind(CLOSED - 60_000).run();
    const data = await loadDashboard(env, CLOSED);
    const maa = data.apps.find((a) => a.app === "market-anomaly-alerts");
    expect(maa?.status).toBe("asleep");
    expect(renderDashboard(data)).toContain("asleep (expected)");
  });

  it("an app is as bad as its worst target", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO states (subject, state, since) VALUES ('target:doc-worker', 'up', ?1)").bind(OPEN),
      env.DB.prepare("INSERT INTO states (subject, state, since) VALUES ('target:doc-worker-api', 'down', ?1)").bind(OPEN),
    ]);
    const data = await loadDashboard(env, OPEN);
    const dw = data.apps.find((a) => a.app === "doc-worker");
    expect(dw).toMatchObject({ status: "down", openAlert: true });
  });

  it("uptime and latency come from the last 24 h, with cold starts left out of latency", async () => {
    const insert = env.DB.prepare("INSERT INTO checks (target, at, ok, ms, cold_start) VALUES ('maa', ?1, ?2, ?3, ?4)");
    await env.DB.batch([
      insert.bind(OPEN - 60 * 60_000, 1, 45_000, 1),
      insert.bind(OPEN - 55 * 60_000, 1, 200, 0),
      insert.bind(OPEN - 50 * 60_000, 1, 400, 0),
      insert.bind(OPEN - 45 * 60_000, 0, null, 0),
      insert.bind(OPEN - 2 * 24 * 60 * 60_000, 0, null, 0), // too old to count
    ]);
    const maa = (await loadDashboard(env, OPEN)).apps.find((a) => a.app === "market-anomaly-alerts")?.targets[0];
    expect(maa).toMatchObject({ uptime24h: 0.75, p50: 200, p95: 400 });
  });

  it("shows the data source mix and fallback share", async () => {
    const insert = env.DB.prepare("INSERT INTO metrics (app, name, value, at) VALUES ('market-anomaly-alerts', ?1, ?2, ?3)");
    await env.DB.batch([
      insert.bind("source.quote", 30, OPEN - 60_000),
      insert.bind("source.chart_fallback", 10, OPEN - 60_000),
      insert.bind("source.chart_fallback", 60, OPEN - 3 * 24 * 60 * 60_000), // only in the 7-day window
    ]);
    const [day, week] = (await loadDashboard(env, OPEN)).sourceMix;
    expect(day).toMatchObject({ counts: { quote: 30, chart_fallback: 10 }, fallbackShare: 0.25 });
    expect(week).toMatchObject({ counts: { quote: 30, chart_fallback: 70 }, fallbackShare: 0.7 });
  });

  it("counts its own reads in the usage panel", async () => {
    const insert = env.DB.prepare("INSERT INTO checks (target, at, ok, ms) VALUES ('apex-os', ?1, 1, 100)");
    await env.DB.batch([1, 2, 3].map((m) => insert.bind(OPEN - m * 60_000)));
    await handleDashboard(dashboardRequest(await token()), accessEnv, OPEN, keys);
    const row = await env.DB.prepare("SELECT rows_read FROM usage WHERE day = '2026-10-22'").first<{ rows_read: number }>();
    expect(row?.rows_read).toBeGreaterThanOrEqual(3);
  });
});
