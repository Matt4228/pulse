-- Every time column is INTEGER milliseconds since the Unix epoch (UTC).

CREATE TABLE checks (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  ms INTEGER,
  cold_start INTEGER NOT NULL DEFAULT 0,
  reason TEXT
);
CREATE INDEX checks_target_at ON checks(target, at);

CREATE TABLE heartbeats (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'fail')),
  detail TEXT
);
CREATE INDEX heartbeats_job_at ON heartbeats(job, at);

CREATE TABLE metrics (
  id INTEGER PRIMARY KEY,
  app TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  tags TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX metrics_app_name_at ON metrics(app, name, at);

CREATE TABLE commits (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  at INTEGER NOT NULL,
  author TEXT,
  message TEXT,
  pr INTEGER,
  PRIMARY KEY (repo, sha)
);

-- subject is target:<id>, job:<id>, or meta:<name> (meta rows store last run time in since).
CREATE TABLE states (
  subject TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  since INTEGER NOT NULL
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  message TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE daily_rollups (
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  checks INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  p50_ms INTEGER,
  p95_ms INTEGER,
  PRIMARY KEY (day, subject)
);

CREATE TABLE usage (
  day TEXT PRIMARY KEY,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0
);
