import type { Env } from "./env";
import { handleIngest } from "./ingest";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/health") {
      return json({ status: "ok" });
    }

    if (pathname.startsWith("/ingest/")) {
      return handleIngest(req, env, Date.now());
    }

    return json({ error: "not found" }, 404);
  },

  // The per-minute tick lands with the monitoring engine (PR 2).
  async scheduled(_ctl: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {},
} satisfies ExportedHandler<Env>;
