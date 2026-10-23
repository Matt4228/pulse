// Everything Pulse watches, and the limits it works within. Values are pinned
// from the design doc; change them here, not in the modules that use them.

export type Host = "vercel" | "render";
export type Cadence = "always" | "market-hours";

export interface Target {
  id: string;
  app: string;
  url: string;
  host: Host;
  cadence: Cadence;
  everyMin: number;
  timeoutMs: number;
}

export type Job =
  | { id: string; app: string; rule: "market-hours"; lateAfterMin: number; failingAfter: number }
  | { id: string; app: string; rule: "daily-utc"; deadlineUtc: string; windowStartUtc: string };

export const TARGETS: Target[] = [
  { id: "apex-os", app: "apex-os", url: "https://apex-os-sand.vercel.app", host: "vercel", cadence: "always", everyMin: 5, timeoutMs: 10_000 },
  { id: "doc-worker", app: "doc-worker", url: "https://doc-worker.vercel.app", host: "vercel", cadence: "always", everyMin: 5, timeoutMs: 10_000 },
  // Every 3 hours: each check wakes the Render instance, which costs free hours.
  { id: "doc-worker-api", app: "doc-worker", url: "https://doc-worker-api.onrender.com/health", host: "render", cadence: "always", everyMin: 180, timeoutMs: 90_000 },
  // Checking during market hours also keeps it awake for the poller.
  { id: "maa", app: "market-anomaly-alerts", url: "https://market-anomaly-alerts.onrender.com/health", host: "render", cadence: "market-hours", everyMin: 5, timeoutMs: 90_000 },
];

export const JOBS: Job[] = [
  { id: "maa-poll", app: "market-anomaly-alerts", rule: "market-hours", lateAfterMin: 15, failingAfter: 3 },
  // Vercel Hobby runs the 05:00 UTC cron anywhere in that hour.
  { id: "apex-reseed", app: "apex-os", rule: "daily-utc", deadlineUtc: "06:30", windowStartUtc: "04:00" },
];

export const GITHUB_OWNER = "Matt4228";
export const REPOS = ["apex-os", "doc-worker", "market-anomaly-alerts", "zoe-workspace"];

// App name to the name of the Worker secret holding that app's ingest key.
export const INGEST_KEYS = {
  "market-anomaly-alerts": "INGEST_KEY_MAA",
  "apex-os": "INGEST_KEY_APEX",
  "doc-worker": "INGEST_KEY_DOCWORKER",
} as const;

// Full-day closures, from nyse.com/markets/hours-calendars (checked 2026-10-23).
export const NYSE_HOLIDAYS = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
];

// Days the market closes at 1:00 p.m. New York time (same source).
export const NYSE_EARLY_CLOSES = ["2026-11-27", "2026-12-24", "2027-11-26"];

export const D1_FREE_DAILY = { rowsRead: 5_000_000, rowsWritten: 100_000 };
export const RENDER_FREE_HOURS = 750;
export const RENDER_IDLE_MS = 15 * 60_000;
