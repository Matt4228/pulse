import { handleDashboard } from "./dashboard";
import type { Env } from "./env";
import { handleIngest } from "./ingest";
import { healthStatus, tick } from "./scheduler";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/health") {
      const { healthy, lastTick } = await healthStatus(env, Date.now());
      return json({ status: healthy ? "ok" : "stale", lastTick }, healthy ? 200 : 503);
    }

    if (pathname === "/" && req.method === "GET") {
      return handleDashboard(req, env, Date.now());
    }

    if (pathname.startsWith("/ingest/")) {
      return handleIngest(req, env, Date.now());
    }

    return json({ error: "not found" }, 404);
  },

  // Uses the minute the cron was scheduled for, so a duplicate delivery of
  // the same tick sees the same `now`.
  async scheduled(ctl: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const report = await tick(env, ctl.scheduledTime);
    if (report.errors.length > 0) console.error("tick finished with errors", report.errors);
  },
} satisfies ExportedHandler<Env>;
