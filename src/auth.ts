import { INGEST_KEYS } from "./config";
import type { Env } from "./env";

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/**
 * The app whose ingest key matches the request's bearer token, or null.
 *
 * Comparing SHA-256 digests keeps both sides the same length, which
 * timingSafeEqual requires, so response time reveals nothing about the key.
 * An unset key is skipped, so it can never match.
 */
export async function appForKey(req: Request, env: Env): Promise<string | null> {
  const match = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  if (!match?.[1]) return null;
  const supplied = await sha256(match[1]);

  let found: string | null = null;
  for (const [app, secretName] of Object.entries(INGEST_KEYS)) {
    const expected = env[secretName];
    if (!expected) continue;
    // Check every key without stopping early, so timing doesn't reveal which app matched.
    if (crypto.subtle.timingSafeEqual(supplied, await sha256(expected))) found = app;
  }
  return found;
}
