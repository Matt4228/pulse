import { appForKey } from "./auth";
import { JOBS } from "./config";
import type { Env } from "./env";
import { UsageMeter } from "./usage";

export const MAX_BODY_BYTES = 4096;
const MAX_METRICS = 50;
const METRIC_NAME = /^[a-z0-9_.]{1,64}$/;

type Handler = (body: unknown, app: string, env: Env, now: number, meter: UsageMeter) => Promise<Response>;

class BadRequest extends Error {}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads at most MAX_BODY_BYTES, whatever Content-Length claims. Null means too large. */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return null;
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const heartbeat: Handler = async (body, app, env, now, meter) => {
  if (!isPlainObject(body)) throw new BadRequest("body must be an object");
  const { job, status, detail } = body;
  const known = JOBS.find((j) => j.id === job);
  if (!known || known.app !== app) throw new BadRequest("unknown job for this app");
  if (status !== "ok" && status !== "fail") throw new BadRequest('status must be "ok" or "fail"');
  if (detail !== undefined && !isPlainObject(detail)) throw new BadRequest("detail must be an object");

  meter.add(
    await env.DB.prepare("INSERT INTO heartbeats (job, at, status, detail) VALUES (?1, ?2, ?3, ?4)")
      .bind(known.id, now, status, detail === undefined ? null : JSON.stringify(detail))
      .run(),
  );
  return json({ stored: 1 }, 202);
};

const metric: Handler = async (body, app, env, now, meter) => {
  const metrics = isPlainObject(body) ? body.metrics : undefined;
  if (!Array.isArray(metrics) || metrics.length < 1 || metrics.length > MAX_METRICS) {
    throw new BadRequest(`metrics must be an array of 1 to ${MAX_METRICS} items`);
  }

  const rows = metrics.map((m: unknown) => {
    if (!isPlainObject(m)) throw new BadRequest("each metric must be an object");
    const { name, value, tags } = m;
    if (typeof name !== "string" || !METRIC_NAME.test(name)) throw new BadRequest("metric name must match [a-z0-9_.]{1,64}");
    if (typeof value !== "number" || !Number.isFinite(value)) throw new BadRequest("metric value must be a finite number");
    if (tags !== undefined && !(isPlainObject(tags) && Object.values(tags).every((t) => typeof t === "string"))) {
      throw new BadRequest("metric tags must map strings to strings");
    }
    return { name, value, tags: tags === undefined ? null : JSON.stringify(tags) };
  });

  const insert = env.DB.prepare("INSERT INTO metrics (app, name, value, tags, at) VALUES (?1, ?2, ?3, ?4, ?5)");
  meter.add(await env.DB.batch(rows.map((r) => insert.bind(app, r.name, r.value, r.tags, now))));
  return json({ stored: rows.length }, 202);
};

const ROUTES: Record<string, Handler> = {
  "/ingest/heartbeat": heartbeat,
  "/ingest/metric": metric,
};

/** Every ingest path. Tests walk this list so a new route can't skip auth. */
export const INGEST_ROUTES = Object.keys(ROUTES);

export async function handleIngest(req: Request, env: Env, now: number): Promise<Response> {
  const handler = ROUTES[new URL(req.url).pathname];
  if (!handler) return json({ error: "not found" }, 404);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Authenticate before reading the body, so strangers can't make us parse anything.
  const app = await appForKey(req, env);
  if (!app) return json({ error: "unauthorized" }, 401);

  const text = await readCapped(req);
  if (text === null) return json({ error: `body over ${MAX_BODY_BYTES} bytes` }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const meter = new UsageMeter();
  try {
    const res = await handler(body, app, env, now, meter);
    await meter.flush(env, now);
    return res;
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
}
