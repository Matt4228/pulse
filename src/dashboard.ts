import type { JWTVerifyGetKey } from "jose";
import { verifyAccess } from "./auth";
import { D1_FREE_DAILY, GITHUB_OWNER, JOBS, RENDER_FREE_HOURS, REPOS, TARGETS, type Target } from "./config";
import type { Env } from "./env";
import { estimateAwakeHours, percentile } from "./retention";
import { getMeta } from "./scheduler";
import { isMarketOpen, utcDay } from "./time";
import { UsageMeter } from "./usage";

const DAY = 24 * 60 * 60_000;
const SOURCES = ["quote", "chart_fallback", "reconciliation", "history", "fundamentals"] as const;

export type TargetStatus = "up" | "down" | "asleep" | "unknown";

export interface TargetView {
  id: string;
  host: Target["host"];
  status: TargetStatus;
  uptime24h: number | null;
  p50: number | null;
  p95: number | null;
  lastCheckAt: number | null;
}

export interface JobView {
  id: string;
  state: string | null;
  lastOkAt: number | null;
}

export interface CommitView {
  repo: string;
  sha: string;
  at: number;
  author: string | null;
  message: string | null;
  pr: number | null;
}

export interface AppView {
  app: string;
  status: TargetStatus;
  targets: TargetView[];
  jobs: JobView[];
  lastCommit: CommitView | null;
  openAlert: boolean;
}

export interface AlertView {
  subject: string;
  kind: string;
  at: number;
  message: string;
  sent: number;
}

export interface SourceMix {
  label: string;
  counts: Record<string, number>;
  fallbackShare: number | null;
}

export interface DashboardData {
  now: number;
  lastTick: number | null;
  apps: AppView[];
  alerts: AlertView[];
  commits: Record<string, CommitView[]>;
  sourceMix: SourceMix[];
  usage: { read: number; written: number };
  renderHours: number;
}

const APPS = [...new Set(TARGETS.map((t) => t.app))];
const OPEN_STATES = new Set(["down", "late", "failing"]);

/** Worst first: a down target makes the whole app down. */
const STATUS_RANK: Record<TargetStatus, number> = { down: 3, unknown: 2, up: 1, asleep: 0 };

function worst(statuses: TargetStatus[]): TargetStatus {
  return statuses.reduce<TargetStatus>((w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w), "asleep");
}

/** Runs a query and counts its rows, so the dashboard's own reads show up in the usage panel. */
function querier(env: Env, meter: UsageMeter) {
  return async function q<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
    const res = await env.DB.prepare(sql).bind(...binds).run<T>();
    meter.add(res);
    return res.results;
  };
}
type Query = ReturnType<typeof querier>;

async function sourceMix(q: Query, since: number, label: string): Promise<SourceMix> {
  const results = await q<{ name: string; total: number }>(
    `SELECT name, SUM(value) AS total FROM metrics
     WHERE app = 'market-anomaly-alerts' AND name LIKE 'source.%' AND at >= ?1 GROUP BY name`,
    since,
  );
  const counts: Record<string, number> = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  for (const r of results) counts[r.name.slice("source.".length)] = r.total;
  const live = (counts.quote ?? 0) + (counts.chart_fallback ?? 0);
  return { label, counts, fallbackShare: live > 0 ? (counts.chart_fallback ?? 0) / live : null };
}

export async function loadDashboard(env: Env, now: number, meter: UsageMeter = new UsageMeter()): Promise<DashboardData> {
  const q = querier(env, meter);
  const states = new Map(
    (await q<{ subject: string; state: string }>("SELECT subject, state FROM states")).map((r) => [r.subject, r.state]),
  );

  const targetViews = new Map<string, TargetView>();
  for (const t of TARGETS) {
    const results = await q<{ at: number; ok: number; ms: number | null; cold_start: number }>(
      "SELECT at, ok, ms, cold_start FROM checks WHERE target = ?1 AND at >= ?2 ORDER BY at",
      t.id,
      now - DAY,
    );
    const [last] = await q<{ at: number | null }>("SELECT MAX(at) AS at FROM checks WHERE target = ?1", t.id);
    const warm = results.filter((r) => r.ok && !r.cold_start && r.ms !== null).map((r) => r.ms as number);
    const state = states.get(`target:${t.id}`);
    // Outside its window a Render app is meant to be asleep; its last result isn't news.
    const status: TargetStatus =
      t.cadence === "market-hours" && !isMarketOpen(now) ? "asleep" : state === "up" || state === "down" ? state : "unknown";
    targetViews.set(t.id, {
      id: t.id,
      host: t.host,
      status,
      uptime24h: results.length > 0 ? results.filter((r) => r.ok).length / results.length : null,
      p50: percentile(warm, 50),
      p95: percentile(warm, 95),
      lastCheckAt: last?.at ?? null,
    });
  }

  const jobViews = new Map<string, JobView>();
  for (const j of JOBS) {
    const [lastOk] = await q<{ at: number | null }>("SELECT MAX(at) AS at FROM heartbeats WHERE job = ?1 AND status = 'ok'", j.id);
    jobViews.set(j.id, { id: j.id, state: states.get(`job:${j.id}`) ?? null, lastOkAt: lastOk?.at ?? null });
  }

  const commits: Record<string, CommitView[]> = {};
  for (const repo of REPOS) {
    commits[repo] = await q<CommitView>("SELECT repo, sha, at, author, message, pr FROM commits WHERE repo = ?1 ORDER BY at DESC LIMIT 10", repo);
  }

  const apps: AppView[] = APPS.map((app) => {
    const targets = TARGETS.filter((t) => t.app === app).map((t) => targetViews.get(t.id) as TargetView);
    const jobs = JOBS.filter((j) => j.app === app).map((j) => jobViews.get(j.id) as JobView);
    const openAlert =
      targets.some((t) => t.status === "down") || jobs.some((j) => j.state !== null && OPEN_STATES.has(j.state));
    return { app, status: worst(targets.map((t) => t.status)), targets, jobs, lastCommit: commits[app]?.[0] ?? null, openAlert };
  });

  const alerts = await q<AlertView>("SELECT subject, kind, at, message, sent FROM alerts ORDER BY at DESC, id DESC LIMIT 20");
  const [usageRow] = await q<{ rows_read: number; rows_written: number }>(
    "SELECT rows_read, rows_written FROM usage WHERE day = ?1",
    utcDay(now),
  );

  const monthStart = Date.parse(`${utcDay(now).slice(0, 7)}-01T00:00:00Z`);
  let renderHours = 0;
  for (const t of TARGETS.filter((x) => x.host === "render")) {
    const results = await q<{ at: number }>("SELECT at FROM checks WHERE target = ?1 AND at >= ?2 ORDER BY at", t.id, monthStart);
    renderHours += estimateAwakeHours(results.map((r) => r.at));
  }

  return {
    now,
    lastTick: await getMeta(env, "tick", meter),
    apps,
    alerts,
    commits,
    sourceMix: [await sourceMix(q, now - DAY, "Last 24 h"), await sourceMix(q, now - 7 * DAY, "Last 7 days")],
    usage: { read: usageRow?.rows_read ?? 0, written: usageRow?.rows_written ?? 0 },
    renderHours,
  };
}

// ---- Rendering ----

/** Escapes text for HTML. Commit messages and alert text come from outside Pulse. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ago(at: number | null, now: number): string {
  if (at === null) return '<span class="muted">never</span>';
  const min = Math.round((now - at) / 60_000);
  const text = min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
  return `<time datetime="${new Date(at).toISOString()}" title="${new Date(at).toISOString()}">${text}</time>`;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(x === 1 ? 0 : 1)}%`);
const ms = (x: number | null) => (x === null ? "n/a" : `${x.toLocaleString("en-US")} ms`);

const STATUS_LABEL: Record<TargetStatus, string> = { up: "up", down: "down", asleep: "asleep (expected)", unknown: "no data" };
const JOB_CLASS: Record<string, string> = { ok: "up", late: "warn", failing: "down", idle: "asleep" };

function badge(status: TargetStatus): string {
  return `<span class="badge ${status}">${STATUS_LABEL[status]}</span>`;
}

function commitLink(c: CommitView): string {
  const base = `https://github.com/${GITHUB_OWNER}/${encodeURIComponent(c.repo)}`;
  const pr = c.pr !== null ? ` <a href="${base}/pull/${c.pr}">#${c.pr}</a>` : "";
  // The PR link replaces a squash merge's trailing "(#12)".
  const message = (c.message ?? "").replace(/\s*\(#\d+\)\s*$/, "");
  return `<a class="sha" href="${base}/commit/${esc(c.sha)}">${esc(c.sha.slice(0, 7))}</a> ${esc(message)}${pr}`;
}

function renderApp(a: AppView, now: number): string {
  const targets = a.targets
    .map(
      (t) => `<tr>
        <td>${esc(t.id)} <span class="muted">${esc(t.host)}</span></td>
        <td>${badge(t.status)}</td>
        <td class="num">${pct(t.uptime24h)}</td>
        <td class="num">${ms(t.p50)}</td>
        <td class="num">${ms(t.p95)}</td>
        <td>${ago(t.lastCheckAt, now)}</td>
      </tr>`,
    )
    .join("");
  const jobs = a.jobs
    .map(
      (j) => `<li><strong>${esc(j.id)}</strong>
        <span class="badge ${JOB_CLASS[j.state ?? ""] ?? "unknown"}">${esc(j.state ?? "no data")}</span>
        <span class="muted">last ok ${ago(j.lastOkAt, now)}</span></li>`,
    )
    .join("");
  const commit = a.lastCommit
    ? `<p class="commit">${commitLink(a.lastCommit)} <span class="muted">by ${esc(a.lastCommit.author)}, ${ago(a.lastCommit.at, now)}</span></p>`
    : '<p class="muted">No commits loaded yet.</p>';

  return `<section class="card app">
    <header><h2>${esc(a.app)}</h2>${badge(a.status)}${a.openAlert ? '<span class="badge down">open alert</span>' : ""}</header>
    <div class="scroll"><table class="targets">
      <colgroup><col class="c-target"><col class="c-status"><col span="3"><col class="c-last"></colgroup>
      <thead><tr><th>Target</th><th>Status</th><th class="num">24 h uptime</th><th class="num">p50</th><th class="num">p95</th><th>Last check</th></tr></thead>
      <tbody>${targets}</tbody>
    </table></div>
    ${jobs ? `<ul class="jobs">${jobs}</ul>` : ""}
    ${commit}
  </section>`;
}

function renderSourceMix(mixes: SourceMix[]): string {
  const head = mixes.map((m) => `<th class="num">${esc(m.label)}</th>`).join("");
  const rows = SOURCES.map(
    (s) => `<tr><td>${s.replace("_", " ")}</td>${mixes.map((m) => `<td class="num">${(m.counts[s] ?? 0).toLocaleString("en-US")}</td>`).join("")}</tr>`,
  ).join("");
  const share = `<tr class="total"><td>fallback share</td>${mixes.map((m) => `<td class="num">${pct(m.fallbackShare)}</td>`).join("")}</tr>`;
  return `<table><thead><tr><th>Source</th>${head}</tr></thead><tbody>${rows}${share}</tbody></table>`;
}

function meter(label: string, used: number, cap: number, unit: string, note = ""): string {
  const ratio = Math.min(1, used / cap);
  const level = ratio > 0.8 ? "down" : ratio > 0.5 ? "warn" : "up";
  return `<div class="meter">
    <div class="meter-label"><span>${esc(label)}</span><span class="num">${used.toLocaleString("en-US", { maximumFractionDigits: 1 })} / ${cap.toLocaleString("en-US")} ${unit}</span></div>
    <div class="bar"><div class="fill ${level}" style="width:${(ratio * 100).toFixed(1)}%"></div></div>
    ${note ? `<p class="muted small">${esc(note)}</p>` : ""}
  </div>`;
}

export function renderDashboard(d: DashboardData): string {
  const alerts = d.alerts.length
    ? `<ul class="list">${d.alerts
        .map((a) => `<li>${esc(a.message)} <span class="muted">${ago(a.at, d.now)}${a.sent ? "" : ", not yet sent"}</span></li>`)
        .join("")}</ul>`
    : '<p class="muted">No alerts. Quiet is good.</p>';

  const activity = Object.entries(d.commits)
    .map(
      ([repo, list]) => `<details${list.length ? " open" : ""}><summary>${esc(repo)} <span class="muted">${list.length ? ago(list[0]?.at ?? null, d.now) : "no data"}</span></summary>
        <ul class="list">${list.map((c) => `<li>${commitLink(c)} <span class="muted">${esc(c.author)}, ${ago(c.at, d.now)}</span></li>`).join("")}</ul>
      </details>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Pulse</title>
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --text: #1b1f24; --muted: #66707a; --line: #e3e6ea;
  --up: #1a7f37; --up-bg: #dafbe1; --down: #c62828; --down-bg: #ffe0e0;
  --warn: #9a6700; --warn-bg: #fff4d0; --asleep: #57606a; --asleep-bg: #eef0f3; --link: #0a58ca;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --card: #171b21; --text: #e6e8eb; --muted: #8b949e; --line: #2a3038;
    --up: #56d364; --up-bg: #12301b; --down: #ff7b72; --down-bg: #3a1618;
    --warn: #e3b341; --warn-bg: #352a0f; --asleep: #9da7b1; --asleep-bg: #222831; --link: #79b8ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
a { color: var(--link); }
h1 { font-size: 1.5rem; margin: 0; }
h2 { font-size: 1.1rem; margin: 0; }
h3 { font-size: 0.95rem; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.top { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; min-width: 0; }
.app header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.grid { margin-bottom: 16px; }
.grid .card { margin-bottom: 0; }
table.targets { table-layout: fixed; min-width: 620px; }
.c-target { width: 30%; } .c-status { width: 20%; } .c-last { width: 17%; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-weight: 600; color: var(--muted); font-size: 0.85rem; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.total td { font-weight: 600; border-bottom: none; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
.badge.up { color: var(--up); background: var(--up-bg); }
.badge.down { color: var(--down); background: var(--down-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.asleep, .badge.unknown { color: var(--asleep); background: var(--asleep-bg); }
.muted { color: var(--muted); }
.small { font-size: 0.8rem; margin: 4px 0 0; }
.jobs, .list { list-style: none; padding: 0; margin: 12px 0 0; }
.jobs li, .list li { padding: 4px 0; overflow-wrap: anywhere; }
.list li + li { border-top: 1px solid var(--line); }
.commit { margin: 12px 0 0; overflow-wrap: anywhere; }
.sha { font-family: ui-monospace, Consolas, monospace; font-size: 0.85rem; }
details + details { margin-top: 8px; }
summary { cursor: pointer; font-weight: 600; }
.meter + .meter { margin-top: 14px; }
.meter-label { display: flex; justify-content: space-between; gap: 8px; font-size: 0.9rem; }
.bar { height: 8px; background: var(--asleep-bg); border-radius: 4px; overflow: hidden; margin-top: 4px; }
.fill { height: 100%; }
.fill.up { background: var(--up); } .fill.warn { background: var(--warn); } .fill.down { background: var(--down); }
</style>
</head>
<body>
<main>
  <div class="top">
    <h1>Pulse</h1>
    <span class="muted">Last tick ${ago(d.lastTick, d.now)}. Refreshes every 5 minutes.</span>
  </div>
  ${d.apps.map((a) => renderApp(a, d.now)).join("")}
  <div class="grid">
    <section class="card"><h3>Recent alerts</h3>${alerts}</section>
    <section class="card"><h3>market-anomaly-alerts data sources</h3>${renderSourceMix(d.sourceMix)}</section>
    <section class="card"><h3>Free plan usage</h3>
      ${meter("D1 rows read today", d.usage.read, D1_FREE_DAILY.rowsRead, "")}
      ${meter("D1 rows written today", d.usage.written, D1_FREE_DAILY.rowsWritten, "")}
      ${meter("Render hours this month", d.renderHours, RENDER_FREE_HOURS, "h", "Lower bound: counts only time Pulse's own checks kept Render awake.")}
    </section>
  </div>
  <section class="card"><h3>Repo activity</h3>${activity}</section>
</main>
</body>
</html>`;
}

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // No scripts at all, and the page can't be framed by another site.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export async function handleDashboard(req: Request, env: Env, now: number, keys?: JWTVerifyGetKey): Promise<Response> {
  // Fail closed: without Access settings there is no way to tell who is asking.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL) {
    return new Response("Dashboard not configured", { status: 503 });
  }
  if (!(await verifyAccess(req, env, keys))) {
    return new Response("Forbidden", { status: 403 });
  }
  const meter = new UsageMeter();
  const html = renderDashboard(await loadDashboard(env, now, meter));
  await meter.flush(env, now);
  return new Response(html, { headers: SECURITY_HEADERS });
}
