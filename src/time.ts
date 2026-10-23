import { NYSE_EARLY_CLOSES, NYSE_HOLIDAYS } from "./config";

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function nyFields(now: number): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const p of NY.formatToParts(now)) fields[p.type] = p.value;
  return fields;
}

/** Wall-clock date, minutes since midnight and weekday (0 = Sunday) in New York. */
export function nyParts(now: number): { date: string; minutes: number; weekday: number } {
  const f = nyFields(now);
  return {
    date: `${f.year}-${f.month}-${f.day}`,
    minutes: Number(f.hour) * 60 + Number(f.minute),
    weekday: WEEKDAYS.indexOf(f.weekday ?? ""),
  };
}

function isTradingDay(date: string, weekday: number): boolean {
  return weekday >= 1 && weekday <= 5 && !NYSE_HOLIDAYS.includes(date);
}

/** True from 9:30 up to (not including) the close, New York time, on trading days. */
export function isMarketOpen(now: number): boolean {
  const { date, minutes, weekday } = nyParts(now);
  if (!isTradingDay(date, weekday)) return false;
  const close = NYSE_EARLY_CLOSES.includes(date) ? EARLY_CLOSE_MIN : CLOSE_MIN;
  return minutes >= OPEN_MIN && minutes < close;
}

/** Today's 9:30 New York open as ms epoch, or null if today is not a trading day. */
export function marketOpenedAt(now: number): number | null {
  const { date, weekday } = nyParts(now);
  if (!isTradingDay(date, weekday)) return null;
  // New York's UTC offset right now. DST switches at 2 a.m., so it is the same at 9:30.
  const f = nyFields(now);
  const wallAsUtc = Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), Number(f.hour), Number(f.minute), Number(f.second));
  const offset = wallAsUtc - Math.floor(now / 1000) * 1000;
  return Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), 9, 30) - offset;
}

/** The UTC calendar day, YYYY-MM-DD. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
