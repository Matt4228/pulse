import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
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

/** Accepts "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com/". */
export function accessHost(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// One key set per team domain. jose caches the fetched keys and refetches
// when Cloudflare rotates them.
const remoteKeys = new Map<string, JWTVerifyGetKey>();

function keysFor(host: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(host);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`));
    remoteKeys.set(host, keys);
  }
  return keys;
}

/**
 * The signed-in owner, or null. Cloudflare Access puts a signed JWT in
 * Cf-Access-Jwt-Assertion on every request it lets through. Checking it here
 * means the Worker stays private even if the Access policy is misconfigured
 * or someone reaches the Worker without going through Access.
 */
export async function verifyAccess(req: Request, env: Env, keys?: JWTVerifyGetKey): Promise<{ email: string } | null> {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNER_EMAIL } = env;
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD || !OWNER_EMAIL) return null;
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;

  const host = accessHost(ACCESS_TEAM_DOMAIN);
  try {
    const { payload } = await jwtVerify(token, keys ?? keysFor(host), {
      issuer: `https://${host}`,
      audience: ACCESS_AUD,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? payload.email : "";
    return email.toLowerCase() === OWNER_EMAIL.toLowerCase() ? { email } : null;
  } catch {
    return null;
  }
}
