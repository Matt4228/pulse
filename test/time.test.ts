import { describe, expect, it } from "vitest";
import { isMarketOpen, marketOpenedAt, nyParts, utcDay } from "../src/time";
import { at } from "./helpers";

describe("nyParts", () => {
  it("converts UTC to New York date, minutes and weekday", () => {
    // 02:30 UTC Friday is 22:30 Thursday in New York (EDT).
    expect(nyParts(at("2026-10-23T02:30:00Z"))).toEqual({ date: "2026-10-22", minutes: 22 * 60 + 30, weekday: 4 });
  });

  it("midnight New York is minute 0, not 24:00", () => {
    expect(nyParts(at("2026-10-22T04:00:00Z")).minutes).toBe(0);
  });
});

describe("isMarketOpen", () => {
  it("open at 14:00 UTC on Thu 2026-10-22", () => {
    expect(isMarketOpen(at("2026-10-22T14:00:00Z"))).toBe(true);
  });

  it("closed at 13:29 UTC on 2026-10-22 (9:29 EDT)", () => {
    expect(isMarketOpen(at("2026-10-22T13:29:00Z"))).toBe(false);
  });

  it("closed at 20:00 UTC on 2026-10-22 (16:00 EDT is exclusive)", () => {
    expect(isMarketOpen(at("2026-10-22T19:59:00Z"))).toBe(true);
    expect(isMarketOpen(at("2026-10-22T20:00:00Z"))).toBe(false);
  });

  it("open 9:30 New York on 2026-11-02 is 14:30 UTC (after DST ends)", () => {
    expect(isMarketOpen(at("2026-11-02T14:29:00Z"))).toBe(false);
    expect(isMarketOpen(at("2026-11-02T14:30:00Z"))).toBe(true);
  });

  it("market closed on Thanksgiving", () => {
    expect(isMarketOpen(at("2026-11-26T16:00:00Z"))).toBe(false);
  });

  it("closed on Saturday 2026-10-24", () => {
    expect(isMarketOpen(at("2026-10-24T15:00:00Z"))).toBe(false);
  });

  it("closes at 1 pm New York on the day after Thanksgiving", () => {
    expect(isMarketOpen(at("2026-11-27T17:59:00Z"))).toBe(true);
    expect(isMarketOpen(at("2026-11-27T18:00:00Z"))).toBe(false);
  });
});

describe("marketOpenedAt", () => {
  it("is 13:30 UTC on 2026-10-22 and null on Saturday", () => {
    expect(marketOpenedAt(at("2026-10-22T18:00:00Z"))).toBe(at("2026-10-22T13:30:00Z"));
    expect(marketOpenedAt(at("2026-10-24T15:00:00Z"))).toBeNull();
  });

  it("is 14:30 UTC once DST has ended", () => {
    expect(marketOpenedAt(at("2026-11-02T20:00:00Z"))).toBe(at("2026-11-02T14:30:00Z"));
  });

  it("is null on a holiday", () => {
    expect(marketOpenedAt(at("2026-11-26T16:00:00Z"))).toBeNull();
  });
});

describe("utcDay", () => {
  it("formats the UTC calendar day", () => {
    expect(utcDay(at("2026-10-23T23:59:59Z"))).toBe("2026-10-23");
  });
});
