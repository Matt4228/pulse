import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./helpers";

describe("worker routes", () => {
  beforeEach(resetDb);

  it("GET /health returns 200 with status ok", async () => {
    const res = await exports.default.fetch("https://pulse.test/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("unknown path returns 404", async () => {
    const res = await exports.default.fetch("https://pulse.test/nope");
    expect(res.status).toBe(404);
  });
});

describe("schema", () => {
  it("migrations create all 8 tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'sqlite%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(
      ["alerts", "checks", "commits", "daily_rollups", "heartbeats", "metrics", "states", "usage"],
    );
  });
});
