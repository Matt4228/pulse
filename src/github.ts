import type { Env } from "./env";
import type { UsageMeter } from "./usage";

// Placeholder until repo activity lands (PR 3). The scheduler already calls it
// every 15 minutes, so that PR only has to fill in the body.
export async function refreshRepos(_env: Env, _now: number, _meter?: UsageMeter): Promise<void> {}
