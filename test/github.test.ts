import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPOS } from "../src/config";
import type { Env } from "../src/env";
import { prFromMessage, refreshRepos } from "../src/github";
import { at, resetDb } from "./helpers";

const NOW = at("2026-10-23T15:00:00Z");
const tokenEnv: Env = { ...env, GITHUB_TOKEN: "test-token" };

function fakeCommits(repo: string, n = 10) {
  return Array.from({ length: n }, (_, i) => ({
    sha: `${repo}-sha-${i}`,
    author: { login: "Matt4228" },
    commit: {
      message: `Change ${i} in ${repo} (#${i + 1})\n\nBody text that should not be stored.`,
      author: { name: "Matt" },
      committer: { date: `2026-10-2${i % 3}T12:00:00Z` },
    },
  }));
}

function repoOf(input: unknown): string {
  return /repos\/Matt4228\/([^/]+)\/commits/.exec(String(input))?.[1] ?? "";
}

describe("prFromMessage", () => {
  it('"Stop sending the admin token (#5)" is 5, and "Merge pull request #4 from x" is 4', () => {
    expect(prFromMessage("Stop sending the admin token (#5)")).toBe(5);
    expect(prFromMessage("Merge pull request #4 from Matt4228/testing-cicd")).toBe(4);
  });

  it("is null for a plain commit and only reads the first line", () => {
    expect(prFromMessage("Fix typo")).toBeNull();
    expect(prFromMessage("Fix typo\n\nSee (#9)")).toBeNull();
  });
});

describe("refreshRepos", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("refresh stores 10 commits per repo and is idempotent on a second run", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => Response.json(fakeCommits(repoOf(input))));
    expect(await refreshRepos(tokenEnv, NOW)).toBe(10 * REPOS.length);
    expect(await refreshRepos(tokenEnv, NOW)).toBe(0);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
    const row = await env.DB.prepare("SELECT * FROM commits WHERE sha = 'apex-os-sha-0'").first();
    expect(row).toEqual({
      repo: "apex-os",
      sha: "apex-os-sha-0",
      at: at("2026-10-20T12:00:00Z"),
      author: "Matt4228",
      message: "Change 0 in apex-os (#1)",
      pr: 1,
    });
  });

  it("a 403 from one repo still stores the others", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      repoOf(input) === "zoe-workspace" ? new Response("forbidden", { status: 403 }) : Response.json(fakeCommits(repoOf(input))),
    );
    expect(await refreshRepos(tokenEnv, NOW)).toBe(10 * (REPOS.length - 1));
  });

  it("throws when every repo fails, so the scheduler retries", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad credentials", { status: 401 }));
    await expect(refreshRepos(tokenEnv, NOW)).rejects.toThrow("GitHub 401");
  });

  it("no token means no requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await refreshRepos(env, NOW)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
