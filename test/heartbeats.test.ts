import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { JOBS, type Job } from "../src/config";
import { evaluateJob, evaluateJobs, type Ping } from "../src/heartbeats";
import { at, resetDb } from "./helpers";

const MIN = 60_000;

function job(id: string): Job {
  const j = JOBS.find((x) => x.id === id);
  if (!j) throw new Error(id);
  return j;
}

const ok = (iso: string): Ping => ({ at: at(iso), status: "ok" });
const fail = (iso: string): Ping => ({ at: at(iso), status: "fail" });

describe("maa-poll (market hours)", () => {
  const maa = job("maa-poll");

  it("maa-poll is idle at 13:40 UTC (10 min after open)", () => {
    expect(evaluateJob(maa, at("2026-10-22T13:40:00Z"), [])).toBe("idle");
  });

  it("maa-poll is late at 14:00 UTC with no pings today", () => {
    expect(evaluateJob(maa, at("2026-10-22T14:00:00Z"), [ok("2026-10-21T19:55:00Z")])).toBe("late");
  });

  it("maa-poll is ok with an ok ping 4 minutes ago", () => {
    expect(evaluateJob(maa, at("2026-10-22T14:00:00Z"), [ok("2026-10-22T13:56:00Z")])).toBe("ok");
  });

  it("three fail pings in a row is failing even though the job is running", () => {
    const pings = [fail("2026-10-22T13:58:00Z"), fail("2026-10-22T13:53:00Z"), fail("2026-10-22T13:48:00Z")];
    expect(evaluateJob(maa, at("2026-10-22T14:00:00Z"), pings)).toBe("failing");
  });

  it("two fails after an ok is still ok", () => {
    const pings = [fail("2026-10-22T13:58:00Z"), fail("2026-10-22T13:53:00Z"), ok("2026-10-22T13:48:00Z")];
    expect(evaluateJob(maa, at("2026-10-22T14:00:00Z"), pings)).toBe("ok");
  });

  it("maa-poll is idle on Thanksgiving", () => {
    expect(evaluateJob(maa, at("2026-11-26T16:00:00Z"), [])).toBe("idle");
  });

  it("maa-poll is idle after a 1 p.m. early close", () => {
    expect(evaluateJob(maa, at("2026-11-27T18:30:00Z"), [ok("2026-11-27T17:55:00Z")])).toBe("idle");
  });

  it("maa-poll is idle at 14:40 UTC the day after DST ends (10 min after the 14:30 open)", () => {
    expect(evaluateJob(maa, at("2026-11-02T14:40:00Z"), [])).toBe("idle");
    expect(evaluateJob(maa, at("2026-11-02T14:46:00Z"), [])).toBe("late");
  });
});

describe("apex-reseed (daily UTC)", () => {
  const reseed = job("apex-reseed");

  it("apex-reseed is ok at 06:35 UTC after an ok ping at 05:40", () => {
    expect(evaluateJob(reseed, at("2026-10-22T06:35:00Z"), [ok("2026-10-22T05:40:00Z")])).toBe("ok");
  });

  it("apex-reseed is late at 06:30 UTC with no ping since 04:00", () => {
    expect(evaluateJob(reseed, at("2026-10-22T06:30:00Z"), [ok("2026-10-21T05:10:00Z")])).toBe("late");
  });

  it("a fail ping does not count as the run succeeding", () => {
    expect(evaluateJob(reseed, at("2026-10-22T07:00:00Z"), [fail("2026-10-22T05:10:00Z")])).toBe("late");
  });

  it("before the deadline it is ok if yesterday worked, idle if nothing is known", () => {
    expect(evaluateJob(reseed, at("2026-10-22T03:00:00Z"), [ok("2026-10-21T05:10:00Z")])).toBe("ok");
    expect(evaluateJob(reseed, at("2026-10-22T03:00:00Z"), [])).toBe("idle");
  });
});

describe("evaluateJobs", () => {
  beforeEach(resetDb);

  it("alerts once when maa-poll goes from ok to failing", async () => {
    const insert = env.DB.prepare("INSERT INTO heartbeats (job, at, status) VALUES ('maa-poll', ?1, ?2)");
    const t0 = at("2026-10-22T14:00:00Z");
    await insert.bind(t0 - 2 * MIN, "ok").run();
    await evaluateJobs(env, t0);
    for (const m of [3, 8, 13]) await insert.bind(t0 + m * MIN, "fail").run();
    await evaluateJobs(env, t0 + 14 * MIN);
    await evaluateJobs(env, t0 + 15 * MIN);
    const { results } = await env.DB.prepare("SELECT subject, kind FROM alerts").all();
    expect(results).toEqual([{ subject: "job:maa-poll", kind: "job_failing" }]);
  });
});
