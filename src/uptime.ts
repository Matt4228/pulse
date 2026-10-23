import { transition } from "./alerts";
import { RENDER_IDLE_MS, TARGETS, type Target } from "./config";
import type { Env } from "./env";
import { isMarketOpen } from "./time";
import type { UsageMeter } from "./usage";

// Cron fires a few seconds late or early. Without slack, a 5-minute target
// checked at 12:00:03 would not be due at 12:05:01 and would slip to 12:06.
const JITTER_SLACK_MS = 30_000;
const COLD_START_MS = 10_000;

export interface CheckResult {
  target: string;
  at: number;
  ok: boolean;
  status: number | null;
  ms: number;
  coldStart: boolean;
  reason: "timeout" | "status" | "network" | null;
}

export type TargetState = "up" | "down";

export function dueTargets(now: number, lastCheckAt: Record<string, number | undefined>): Target[] {
  return TARGETS.filter((t) => {
    if (t.cadence === "market-hours" && !isMarketOpen(now)) return false;
    const last = lastCheckAt[t.id];
    return last === undefined || now - last >= t.everyMin * 60_000 - JITTER_SLACK_MS;
  });
}

/**
 * One GET against the target. `clock` is only for tests: inside a Worker,
 * Date.now() advances across awaits, which is what timing a request needs.
 */
export async function runCheck(t: Target, now: number, prevAt?: number, clock: () => number = Date.now): Promise<CheckResult> {
  const start = clock();
  let status: number | null = null;
  let reason: CheckResult["reason"] = null;
  try {
    const res = await fetch(t.url, {
      headers: { "user-agent": "pulse-monitor (+https://github.com/Matt4228/pulse)" },
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    status = res.status;
    // Free the connection; we only need the status.
    await res.body?.cancel();
    if (!res.ok) reason = "status";
  } catch (err) {
    reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
  }
  const ms = clock() - start;

  // A sleeping Render instance takes 30 to 60 s to boot. That's expected, so it
  // counts as up, but the slow response is kept out of latency percentiles.
  const coldStart =
    t.host === "render" && (ms > COLD_START_MS || prevAt === undefined || now - prevAt > RENDER_IDLE_MS);

  return { target: t.id, at: now, ok: reason === null, status, ms, coldStart, reason };
}

/** Down after 2 failures in a row; up again on the first success. One failure is noise. */
export function nextTargetState(recentOk: boolean[], current: TargetState | undefined): TargetState {
  if (recentOk[0] === true) return "up";
  if (recentOk.length >= 2 && recentOk[0] === false && recentOk[1] === false) return "down";
  return current ?? "up";
}

export async function runDueChecks(env: Env, now: number, meter?: UsageMeter): Promise<CheckResult[]> {
  // One indexed MAX per target reads a single row each, however much history is stored.
  // Also read when a check last *started*: a Render cold start takes up to 90 s,
  // so the next minute's tick begins before this one has stored its result.
  const lastQuery = env.DB.prepare(
    `SELECT (SELECT MAX(at) FROM checks WHERE target = ?1) AS at,
            (SELECT since FROM states WHERE subject = 'started:' || ?1) AS started`,
  );
  const lasts = await env.DB.batch<{ at: number | null; started: number | null }>(TARGETS.map((t) => lastQuery.bind(t.id)));
  meter?.add(lasts);
  const lastCheckAt: Record<string, number | undefined> = {};
  const lastStartAt: Record<string, number | undefined> = {};
  TARGETS.forEach((t, i) => {
    const row = lasts[i]?.results[0];
    lastCheckAt[t.id] = row?.at ?? undefined;
    const started = Math.max(row?.at ?? 0, row?.started ?? 0);
    lastStartAt[t.id] = started > 0 ? started : undefined;
  });

  const due = dueTargets(now, lastStartAt);
  if (due.length === 0) return [];

  const markStarted = env.DB.prepare(
    "INSERT INTO states (subject, state, since) VALUES ('started:' || ?1, 'ran', ?2) ON CONFLICT (subject) DO UPDATE SET since = excluded.since",
  );
  const marked = await env.DB.batch(due.map((t) => markStarted.bind(t.id, now)));
  meter?.add(marked);

  const results = await Promise.all(due.map((t) => runCheck(t, now, lastCheckAt[t.id])));

  const insert = env.DB.prepare(
    "INSERT INTO checks (target, at, ok, status, ms, cold_start, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  );
  const inserted = await env.DB.batch(
    results.map((r) => insert.bind(r.target, r.at, r.ok ? 1 : 0, r.status, r.ms, r.coldStart ? 1 : 0, r.reason)),
  );
  meter?.add(inserted);

  const recentQuery = env.DB.prepare("SELECT ok FROM checks WHERE target = ?1 ORDER BY at DESC LIMIT 2");
  const stateQuery = env.DB.prepare("SELECT state FROM states WHERE subject = ?1");
  const lookups = await env.DB.batch<{ ok?: number; state?: string }>(
    due.flatMap((t) => [recentQuery.bind(t.id), stateQuery.bind(`target:${t.id}`)]),
  );
  meter?.add(lookups);

  for (const [i, t] of due.entries()) {
    const recentOk = (lookups[2 * i]?.results ?? []).map((r) => r.ok === 1);
    const current = lookups[2 * i + 1]?.results[0]?.state as TargetState | undefined;
    await transition(env, `target:${t.id}`, nextTargetState(recentOk, current), now, t.id, meter);
  }
  return results;
}
