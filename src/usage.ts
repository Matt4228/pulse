import type { Env } from "./env";
import { utcDay } from "./time";

/**
 * Tallies D1 rows read and written during one request or tick, so the
 * dashboard can compare the day's total with the free plan's caps.
 * Pass one meter to everything that touches the DB, then flush it once.
 */
export class UsageMeter {
  private read = 0;
  private written = 0;

  add(r: D1Result | D1Result[]): void {
    for (const result of Array.isArray(r) ? r : [r]) {
      this.read += result.meta.rows_read ?? 0;
      this.written += result.meta.rows_written ?? 0;
    }
  }

  async flush(env: Env, now: number): Promise<void> {
    if (this.read === 0 && this.written === 0) return;
    await env.DB.prepare(
      `INSERT INTO usage (day, rows_read, rows_written) VALUES (?1, ?2, ?3)
       ON CONFLICT (day) DO UPDATE SET
         rows_read = rows_read + excluded.rows_read,
         rows_written = rows_written + excluded.rows_written`,
    )
      .bind(utcDay(now), this.read, this.written)
      .run();
    this.read = 0;
    this.written = 0;
  }
}
