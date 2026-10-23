import type { Env } from "./env";
import type { UsageMeter } from "./usage";

const MAX_PER_FLUSH = 20;
const SLACK_TIMEOUT_MS = 5_000;

export type AlertKind = "down" | "recovered" | "job_late" | "job_failing" | "job_recovered";

/** Which state changes are worth a message. Anything involving "idle" is not. */
function alertKind(subject: string, from: string, to: string): AlertKind | null {
  if (subject.startsWith("target:")) {
    if (from === "up" && to === "down") return "down";
    if (from === "down" && to === "up") return "recovered";
    return null;
  }
  if (subject.startsWith("job:")) {
    if (to === "late") return "job_late";
    if (to === "failing") return "job_failing";
    if (to === "ok" && (from === "late" || from === "failing")) return "job_recovered";
  }
  return null;
}

/** "12 min", "3 h 5 min", "2 d 4 h". Never less than 1 min. */
function duration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

export function alertMessage(kind: string, label: string, sinceMs: number, now: number): string {
  switch (kind) {
    case "down":
      return `🔴 ${label} is down (2 failed checks in a row).`;
    case "recovered":
      return `🟢 ${label} recovered after ${duration(now - sinceMs)}.`;
    case "job_late":
      return `🟠 ${label} has not checked in on time.`;
    case "job_failing":
      return `🔴 ${label} is running but its last 3 runs failed.`;
    case "job_recovered":
      return `🟢 ${label} is checking in again after ${duration(now - sinceMs)}.`;
    default:
      return `${label}: ${kind}`;
  }
}

/**
 * Records a subject's latest state. Returns true when the change created an alert.
 *
 * The UPDATE only applies if the state is still the one we read, so when cron
 * delivers the same tick twice, only one of them wins and alerts.
 */
export async function transition(
  env: Env,
  subject: string,
  next: string,
  now: number,
  label: string,
  meter?: UsageMeter,
): Promise<boolean> {
  const current = await env.DB.prepare("SELECT state, since FROM states WHERE subject = ?1")
    .bind(subject)
    .run<{ state: string; since: number }>();
  meter?.add(current);
  const row = current.results[0];

  if (!row) {
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO states (subject, state, since) VALUES (?1, ?2, ?3)")
      .bind(subject, next, now)
      .run();
    meter?.add(inserted);
    return false;
  }
  if (row.state === next) return false;

  const updated = await env.DB.prepare("UPDATE states SET state = ?1, since = ?2 WHERE subject = ?3 AND state = ?4")
    .bind(next, now, subject, row.state)
    .run();
  meter?.add(updated);
  if (updated.meta.changes !== 1) return false;

  const kind = alertKind(subject, row.state, next);
  if (!kind) return false;
  const alert = await env.DB.prepare("INSERT INTO alerts (subject, kind, at, message) VALUES (?1, ?2, ?3, ?4)")
    .bind(subject, kind, now, alertMessage(kind, label, row.since, now))
    .run();
  meter?.add(alert);
  return true;
}

/**
 * Sends unsent alerts to Slack. Rows are claimed (sent = 1) before posting,
 * so two overlapping ticks can't both send the same alert. A failed post
 * hands the row back for the next tick. At most 20 per call, because a
 * Worker invocation may only make 50 outbound requests.
 */
export async function flushAlerts(env: Env, meter?: UsageMeter): Promise<number> {
  const hook = env.SLACK_WEBHOOK_URL;
  if (!hook) return 0;

  const claimed = await env.DB.prepare(
    `UPDATE alerts SET sent = 1
     WHERE id IN (SELECT id FROM alerts WHERE sent = 0 ORDER BY id LIMIT ?1)
     RETURNING id, message`,
  )
    .bind(MAX_PER_FLUSH)
    .run<{ id: number; message: string }>();
  meter?.add(claimed);

  let sent = 0;
  for (const alert of claimed.results) {
    let ok: boolean;
    try {
      const res = await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: alert.message }),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      sent++;
    } else {
      const released = await env.DB.prepare("UPDATE alerts SET sent = 0 WHERE id = ?1").bind(alert.id).run();
      meter?.add(released);
    }
  }
  return sent;
}
