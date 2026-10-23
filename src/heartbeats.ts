import { transition } from "./alerts";
import { JOBS, type Job } from "./config";
import type { Env } from "./env";
import { isMarketOpen, marketOpenedAt, utcDay } from "./time";
import type { UsageMeter } from "./usage";

export type JobState = "ok" | "late" | "failing" | "idle";
export interface Ping {
  at: number;
  status: "ok" | "fail";
}

const MIN = 60_000;
const LOOKBACK_MS = 26 * 60 * MIN;
const MAX_PINGS = 30;

/** Today's HH:MM UTC as ms epoch. */
function utcTimeToday(now: number, hhmm: string): number {
  return Date.parse(`${utcDay(now)}T${hhmm}:00Z`);
}

/** `pings` are newest first and cover at least the last 26 hours. */
export function evaluateJob(job: Job, now: number, pings: Ping[]): JobState {
  if (job.rule === "market-hours") {
    const opened = marketOpenedAt(now);
    // Give the job one full window after the open before expecting a ping.
    if (!isMarketOpen(now) || opened === null || now - opened < job.lateAfterMin * MIN) return "idle";
    const newest = pings.slice(0, job.failingAfter);
    // A job that runs but fails is worse than late: it's the 2026-10-22 poller bug.
    if (newest.length === job.failingAfter && newest.every((p) => p.status === "fail")) return "failing";
    const recentOk = pings.some((p) => p.status === "ok" && now - p.at <= job.lateAfterMin * MIN);
    return recentOk ? "ok" : "late";
  }

  const deadline = utcTimeToday(now, job.deadlineUtc);
  if (now < deadline) {
    // Not due yet today. "ok" if yesterday's run worked; otherwise unknown, not late,
    // so the first deploy doesn't open with an alert.
    return pings.some((p) => p.status === "ok" && now - p.at <= LOOKBACK_MS) ? "ok" : "idle";
  }
  const windowStart = utcTimeToday(now, job.windowStartUtc);
  return pings.some((p) => p.status === "ok" && p.at >= windowStart) ? "ok" : "late";
}

export async function evaluateJobs(env: Env, now: number, meter?: UsageMeter): Promise<void> {
  const query = env.DB.prepare(
    "SELECT at, status FROM heartbeats WHERE job = ?1 AND at > ?2 ORDER BY at DESC LIMIT ?3",
  );
  const results = await env.DB.batch<Ping>(JOBS.map((j) => query.bind(j.id, now - LOOKBACK_MS, MAX_PINGS)));
  meter?.add(results);

  for (const [i, job] of JOBS.entries()) {
    const state = evaluateJob(job, now, results[i]?.results ?? []);
    await transition(env, `job:${job.id}`, state, now, job.id, meter);
  }
}
