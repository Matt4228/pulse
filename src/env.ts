// Bindings and secrets. Secrets are optional so a missing one fails closed
// in the code that needs it instead of crashing the whole Worker.
export interface Env {
  DB: D1Database;
  SLACK_WEBHOOK_URL?: string;
  GITHUB_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  INGEST_KEY_MAA?: string;
  INGEST_KEY_APEX?: string;
  INGEST_KEY_DOCWORKER?: string;
}
