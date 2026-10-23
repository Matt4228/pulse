import { flushAlerts } from "./alerts";
import type { Env } from "./env";
import { refreshRepos } from "./github";
import { evaluateJobs } from "./heartbeats";
import { prune, rollupDay } from "./retention";
import { utcDay } from "./time";
import { runDueChecks } from "./uptime";
import { UsageMeter } from "./usage";

const MIN = 60_000;
const GITHUB_EVERY_MS = 15 * MIN - 30_000; // same cron jitter slack as uptime
const RETENTION_AFTER_MIN_UTC = 10; // 00:10 UTC, so yesterday's last checks are in
const STALE_TICK_MS = 5 * MIN;

export interface TickReport {
  checks: number;
  alerts: number;
  errors: string[];
}

export async function getMeta(env: Env, name: string, meter?: UsageMeter): Promise<number | null> {
  const res = await env.DB.prepare("SELECT since FROM states WHERE subject = ?1").bind(`meta:${name}`).run<{ since: number }>();
  meter?.add(res);
  return res.results[0]?.since ?? null;
}

async function setMeta(env: Env, name: string, now: number, meter?: UsageMeter): Promise<void> {
  const res = await env.DB.prepare(
    "INSERT INTO states (subject, state, since) VALUES (?1, 'ran', ?2) ON CONFLICT (subject) DO UPDATE SET since = excluded.since",
  )
    .bind(`meta:${name}`, now)
    .run();
  meter?.add(res);
}

/**
 * One minute of work. Each step is isolated: if GitHub is down, checks,
 * heartbeats and alerts still run. Every step is safe to repeat, because
 * cron may deliver the same tick twice or skip one. `refresh` is swappable
 * so tests can make the GitHub step fail.
 */
export async function tick(env: Env, now: number, refresh: typeof refreshRepos = refreshRepos): Promise<TickReport> {
  const meter = new UsageMeter();
  const report: TickReport = { checks: 0, alerts: 0, errors: [] };

  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${name}: ${message}`);
      console.error(`tick step ${name} failed`, err);
    }
  }

  await step("tick", () => setMeta(env, "tick", now, meter));

  await step("uptime", async () => {
    report.checks = (await runDueChecks(env, now, meter)).length;
  });

  await step("heartbeats", () => evaluateJobs(env, now, meter));

  await step("github", async () => {
    const last = await getMeta(env, "github", meter);
    if (last !== null && now - last < GITHUB_EVERY_MS) return;
    await refresh(env, now, meter);
    await setMeta(env, "github", now, meter);
  });

  await step("retention", async () => {
    const minutesUtc = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
    if (minutesUtc < RETENTION_AFTER_MIN_UTC) return;
    const last = await getMeta(env, "retention", meter);
    if (last !== null && utcDay(last) >= utcDay(now)) return;
    await rollupDay(env, utcDay(now - 24 * 60 * MIN), meter);
    await prune(env, now, meter);
    await setMeta(env, "retention", now, meter);
  });

  await step("alerts", async () => {
    report.alerts = await flushAlerts(env, meter);
  });

  await step("usage", () => meter.flush(env, now));
  return report;
}

/**
 * Pulse's own health, for the external monitor. A Worker whose cron has
 * stopped still answers HTTP, so "the server responds" isn't enough.
 */
export async function healthStatus(env: Env, now: number): Promise<{ healthy: boolean; lastTick: number | null }> {
  const lastTick = await getMeta(env, "tick");
  if (lastTick !== null) return { healthy: now - lastTick <= STALE_TICK_MS, lastTick };

  // Never ticked. Fine right after the first deploy; not fine if apps have
  // been reporting for a while, which means the cron trigger isn't running.
  const oldest = await env.DB.prepare(
    "SELECT MIN(at) AS at FROM (SELECT MIN(at) AS at FROM heartbeats UNION ALL SELECT MIN(at) FROM metrics)",
  ).first<{ at: number | null }>();
  const oldestAt = oldest?.at ?? null;
  return { healthy: oldestAt === null || now - oldestAt <= STALE_TICK_MS, lastTick: null };
}
