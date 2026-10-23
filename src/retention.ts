import { RENDER_IDLE_MS } from "./config";
import type { Env } from "./env";
import type { UsageMeter } from "./usage";

const DAY = 24 * 60 * 60_000;

/** Nearest-rank percentile: the smallest value with at least p% of values at or below it. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/**
 * Summarizes one UTC day of checks per target. Uptime counts every check;
 * latency skips cold starts, since a Render boot says nothing about the app.
 * Safe to rerun: it overwrites that day's rows.
 */
export async function rollupDay(env: Env, day: string, meter?: UsageMeter): Promise<void> {
  const start = Date.parse(`${day}T00:00:00Z`);
  // No index on `at` alone, so this scans the table: about 20k rows, once a day.
  const rows = await env.DB.prepare("SELECT target, ok, ms, cold_start FROM checks WHERE at >= ?1 AND at < ?2")
    .bind(start, start + DAY)
    .run<{ target: string; ok: number; ms: number | null; cold_start: number }>();
  meter?.add(rows);

  const byTarget = new Map<string, { checks: number; ok: number; ms: number[] }>();
  for (const r of rows.results) {
    const agg = byTarget.get(r.target) ?? { checks: 0, ok: 0, ms: [] };
    agg.checks++;
    if (r.ok) agg.ok++;
    if (r.ok && !r.cold_start && r.ms !== null) agg.ms.push(r.ms);
    byTarget.set(r.target, agg);
  }
  if (byTarget.size === 0) return;

  const upsert = env.DB.prepare(
    `INSERT INTO daily_rollups (day, subject, checks, ok, p50_ms, p95_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (day, subject) DO UPDATE SET
       checks = excluded.checks, ok = excluded.ok, p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms`,
  );
  const written = await env.DB.batch(
    [...byTarget].map(([target, a]) =>
      upsert.bind(day, `target:${target}`, a.checks, a.ok, percentile(a.ms, 50), percentile(a.ms, 95)),
    ),
  );
  meter?.add(written);
}

export async function prune(env: Env, now: number, meter?: UsageMeter): Promise<void> {
  const keep30 = now - 30 * DAY;
  const keepRollups = new Date(now - 365 * DAY).toISOString().slice(0, 10);
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM checks WHERE at < ?1").bind(keep30),
    env.DB.prepare("DELETE FROM heartbeats WHERE at < ?1").bind(keep30),
    env.DB.prepare("DELETE FROM metrics WHERE at < ?1").bind(keep30),
    env.DB.prepare("DELETE FROM alerts WHERE at < ?1").bind(now - 90 * DAY),
    env.DB.prepare("DELETE FROM daily_rollups WHERE day < ?1").bind(keepRollups),
  ]);
  meter?.add(results);
}

/**
 * Hours a Render instance was awake, assuming each check keeps it up for the
 * idle timeout. A lower bound: real visitors also wake it, and Pulse can't see them.
 */
export function estimateAwakeHours(checkTimes: number[], idleMs = RENDER_IDLE_MS): number {
  let total = 0;
  let spanStart: number | null = null;
  let spanEnd = 0;
  for (const t of checkTimes) {
    if (spanStart === null || t > spanEnd) {
      if (spanStart !== null) total += spanEnd - spanStart;
      spanStart = t;
    }
    spanEnd = Math.max(spanEnd, t + idleMs);
  }
  if (spanStart !== null) total += spanEnd - spanStart;
  return total / 3_600_000;
}
