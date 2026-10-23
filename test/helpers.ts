import { env } from "cloudflare:workers";

/** ISO timestamp to ms epoch, so tests read like the times they describe. */
export function at(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad test time: ${iso}`);
  return ms;
}

const TABLES = ["checks", "heartbeats", "metrics", "commits", "states", "alerts", "daily_rollups", "usage"];

/** Empties every table. Call in beforeEach for tests that count rows. */
export async function resetDb(): Promise<void> {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}
