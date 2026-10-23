import { GITHUB_OWNER, REPOS } from "./config";
import type { Env } from "./env";
import type { UsageMeter } from "./usage";

const PER_REPO = 10;
const TIMEOUT_MS = 10_000;

interface GitHubCommit {
  sha: string;
  author: { login: string } | null;
  commit: { message: string; author: { name: string } | null; committer: { date: string } | null };
}

/** PR number from a squash merge "Title (#12)" or a merge commit "Merge pull request #12 from ...". */
export function prFromMessage(message: string): number | null {
  const firstLine = message.split("\n")[0] ?? "";
  const match = /\(#(\d+)\)\s*$/.exec(firstLine) ?? /^Merge pull request #(\d+)/.exec(firstLine);
  return match?.[1] ? Number(match[1]) : null;
}

async function fetchCommits(repo: string, token: string): Promise<GitHubCommit[]> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/commits?per_page=${PER_REPO}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "pulse",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${repo}: GitHub ${res.status}`);
  return res.json();
}

/**
 * Stores the latest commits for each repo. Returns how many were new.
 * One repo failing (a revoked token scope, say) doesn't stop the others;
 * only a total failure throws, so the scheduler retries next tick.
 */
export async function refreshRepos(env: Env, _now: number, meter?: UsageMeter): Promise<number> {
  const token = env.GITHUB_TOKEN;
  if (!token) return 0;

  const settled = await Promise.allSettled(REPOS.map((repo) => fetchCommits(repo, token)));
  const insert = env.DB.prepare(
    "INSERT OR IGNORE INTO commits (repo, sha, at, author, message, pr) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  );
  const statements: D1PreparedStatement[] = [];
  const failures: string[] = [];

  settled.forEach((result, i) => {
    const repo = REPOS[i] ?? "";
    if (result.status === "rejected") {
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      return;
    }
    for (const c of result.value) {
      const firstLine = c.commit.message.split("\n")[0] ?? "";
      // Committer date is when it landed on the branch; a squash merge keeps the PR's original author date.
      const at = Date.parse(c.commit.committer?.date ?? "") || 0;
      const author = c.author?.login ?? c.commit.author?.name ?? null;
      statements.push(insert.bind(repo, c.sha, at, author, firstLine, prFromMessage(firstLine)));
    }
  });

  if (failures.length === REPOS.length) throw new Error(failures.join("; "));
  if (failures.length > 0) console.error("some repos failed to refresh", failures);
  if (statements.length === 0) return 0;

  const results = await env.DB.batch(statements);
  meter?.add(results);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}
