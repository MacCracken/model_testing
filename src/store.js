// store.js — a SQLite index over the run files, for cross-run questions.
//
// The JSON files under results/runs/ stay the source of truth. This index holds the scalar columns
// that queries need — one row per run, per trial and per task × client × mode cell — plus a pointer
// back to the file, and it is rebuilt incrementally from file mtimes. node:sqlite keeps the
// zero-dependency rule. From the callers' point of view everything here is best-effort: a missing
// or broken index never blocks a run from being saved.

import { DatabaseSync } from "node:sqlite";
import { statSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runsDir, resultsRoot, loadRun, onRunSaved } from "./results.js";
import { summarize } from "./runner.js";

const SCHEMA = `
create table if not exists runs (
  id text primary key, created_at text, finished_at text, status text, source text,
  tasks text, modes text, clients text, count integer, model_params text, judge text,
  versions text, warnings text, row_count integer, compacted text, file_mtime real, indexed_at text
);
create table if not exists trials (
  run_id text not null, idx integer not null, task text, mode text, client text, model text, harness text,
  trial_index integer, correct integer, reason text, error text, tool_calls integer, tool_use_ok integer,
  tool_use_reason text, schema_valid integer, judge_score real, judge_reason text, latency_ms integer,
  ttft_ms integer, ttfa_ms integer, prompt_tokens integer, completion_tokens integer, total_tokens integer,
  rounds integer, finish_reason text, started_at text,
  primary key (run_id, idx)
);
create index if not exists trials_by_cell on trials(task, client, mode);
create table if not exists cells (
  run_id text not null, task text, client text, mode text, runs integer, correct integer, correct_pct real,
  tool_use_pct real, tool_args_ok_pct real, schema_valid_pct real, error_pct real, avg_latency_ms integer,
  latency_p50_ms integer, latency_p95_ms integer, ttft_p50_ms integer, total_tokens integer,
  primary key (run_id, task, client, mode)
);
create index if not exists cells_by_cell on cells(task, client, mode);
`;

let db = null;

export function dbPath() {
  return join(resultsRoot(), "index.sqlite");
}

export function openStore() {
  if (db) return db;
  runsDir(); // ensures the results root exists
  db = new DatabaseSync(dbPath());
  db.exec(SCHEMA);
  return db;
}

// For tests: forget the open handle so a new RESULTS_DIR takes effect.
export function closeStore() {
  try { db?.close(); } catch { /* already closed */ }
  db = null;
}

const flag = (v) => (v === true ? 1 : v === false ? 0 : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const json = (v) => JSON.stringify(v ?? null);

// Index one run (header always; trials and cells only once it is no longer running, so the
// per-trial saves of a live web run stay cheap).
export function indexRun(run, { mtime = null } = {}) {
  const d = openStore();
  d.exec("begin");
  try {
    d.prepare("delete from trials where run_id = ?").run(run.id);
    d.prepare("delete from cells where run_id = ?").run(run.id);
    d.prepare(`insert or replace into runs
      (id, created_at, finished_at, status, source, tasks, modes, clients, count, model_params, judge, versions, warnings, row_count, compacted, file_mtime, indexed_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.id, run.createdAt ?? null, run.finishedAt ?? null, run.status ?? null, run.source ?? null,
      json(run.config?.tasks ?? []), json(run.config?.modes ?? []), json(run.config?.clients ?? []),
      num(run.config?.count), json(run.config?.modelParams ?? {}), run.config?.judge ?? null,
      json(run.versions ?? null), json(run.warnings ?? []), (run.rows ?? []).length, run.compacted ?? null,
      mtime, new Date().toISOString(),
    );
    if (run.status !== "running") {
      const ins = d.prepare(`insert into trials
        (run_id, idx, task, mode, client, model, harness, trial_index, correct, reason, error, tool_calls, tool_use_ok, tool_use_reason,
         schema_valid, judge_score, judge_reason, latency_ms, ttft_ms, ttfa_ms, prompt_tokens, completion_tokens, total_tokens, rounds, finish_reason, started_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      (run.rows ?? []).forEach((r, i) => ins.run(
        run.id, i, r.task ?? null, r.mode ?? null, r.client ?? null, r.model ?? null, r.harness ?? null,
        num(r.index), flag(!!r.correct), r.reason ?? null, r.error ?? null, (r.toolCalls ?? []).length,
        flag(r.toolUseOk === true ? true : r.toolUseOk === false ? false : null), r.toolUseReason ?? null,
        flag(r.schemaValid === true ? true : r.schemaValid === false ? false : null), num(r.judgeScore), r.judgeReason ?? null,
        num(r.latencyMs), num(r.ttftMs), num(r.ttfaMs), num(r.usage?.prompt_tokens), num(r.usage?.completion_tokens),
        num(r.usage?.total_tokens), num(r.rounds), r.finishReason ?? null, r.startedAt ?? null,
      ));
      const cell = d.prepare(`insert into cells
        (run_id, task, client, mode, runs, correct, correct_pct, tool_use_pct, tool_args_ok_pct, schema_valid_pct, error_pct,
         avg_latency_ms, latency_p50_ms, latency_p95_ms, ttft_p50_ms, total_tokens)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const c of summarize(run.rows ?? []).cells) {
        cell.run(run.id, c.task, c.client, c.mode, c.runs, c.correct, c.correctPct, c.toolUsePct,
          c.toolArgsJudged ? c.toolArgsOkPct : null, c.schemaValidPct, c.errorPct, c.avgLatencyMs,
          c.latencyP50Ms, c.latencyP95Ms, c.ttftP50Ms ?? null, c.totalTokens);
      }
    }
    d.exec("commit");
  } catch (err) {
    d.exec("rollback");
    throw err;
  }
}

// Bring the index in line with the directory: files whose mtime changed are re-read, files that
// vanished are dropped. `full` re-reads everything.
export function indexRuns({ full = false } = {}) {
  const d = openStore();
  const dir = runsDir();
  const seen = new Set();
  let indexed = 0, skipped = 0;
  const known = new Map(d.prepare("select id, file_mtime from runs").all().map((r) => [r.id, r.file_mtime]));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const id = f.replace(/\.json$/, "");
    let mtime;
    try { mtime = statSync(join(dir, f)).mtimeMs / 1000; } catch { continue; }
    if (!full && known.has(id) && known.get(id) === mtime) { seen.add(id); skipped++; continue; }
    const run = loadRun(id);
    if (!run) continue; // not a run file (malformed or a stray) — never indexed, never counted
    indexRun(run, { mtime });
    seen.add(id);
    indexed++;
  }
  let removed = 0;
  for (const id of known.keys()) {
    if (seen.has(id)) continue;
    d.prepare("delete from trials where run_id = ?").run(id);
    d.prepare("delete from cells where run_id = ?").run(id);
    d.prepare("delete from runs where id = ?").run(id);
    removed++;
  }
  return { indexed, skipped, removed, path: dbPath() };
}

// ---- queries -----------------------------------------------------------------------------------

function headerOf(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    status: row.status,
    source: row.source,
    config: { tasks: JSON.parse(row.tasks ?? "[]"), modes: JSON.parse(row.modes ?? "[]"), clients: JSON.parse(row.clients ?? "[]"), count: row.count, modelParams: JSON.parse(row.model_params ?? "{}"), judge: row.judge },
    versions: JSON.parse(row.versions ?? "null"),
    warnings: JSON.parse(row.warnings ?? "[]"),
    rowCount: row.row_count,
    compacted: row.compacted,
  };
}

// Run headers, newest first, filtered. `q` matches the id, a task name or a client name.
export function queryRuns({ q = null, task = null, client = null, mode = null, since = null, limit = 100 } = {}) {
  const d = openStore();
  const where = [];
  const params = [];
  if (q) { where.push("(id like ? or tasks like ? or clients like ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (task) { where.push("tasks like ?"); params.push(`%"${task}"%`); }
  if (client) { where.push("clients like ?"); params.push(`%"${client}"%`); }
  if (mode) { where.push("modes like ?"); params.push(`%"${mode}"%`); }
  if (since) { where.push("created_at >= ?"); params.push(since); }
  const sql = `select * from runs ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc limit ?`;
  return d.prepare(sql).all(...params, Math.max(1, Math.min(1000, Number(limit) || 100))).map(headerOf);
}

// One (task, client, mode) cell across runs, oldest first — a trend line.
export function trend({ task, client, mode = "harness" }) {
  const d = openStore();
  return d.prepare(`select r.id as run_id, r.created_at, c.correct, c.runs, c.correct_pct, c.avg_latency_ms, c.total_tokens, c.tool_args_ok_pct, c.schema_valid_pct
    from cells c join runs r on r.id = c.run_id
    where c.task = ? and c.client = ? and c.mode = ? order by r.created_at asc`).all(task, client, mode);
}

// The same cell pooled across every run, plus its per-run history.
export function cellHistory({ task, client, mode = "harness" }) {
  const runs = trend({ task, client, mode });
  const correct = runs.reduce((a, r) => a + r.correct, 0);
  const trials = runs.reduce((a, r) => a + r.runs, 0);
  return { task, client, mode, runs: runs.length, correct, trials, correctPct: trials ? (correct / trials) * 100 : null, first: runs[0]?.created_at ?? null, last: runs.at(-1)?.created_at ?? null, history: runs };
}

// Cells with the lowest pooled correctness — where to look first.
export function worstCells({ mode = "harness", minTrials = 4, limit = 10 } = {}) {
  const d = openStore();
  return d.prepare(`select task, client, mode, sum(correct) as correct, sum(runs) as trials, 100.0 * sum(correct) / sum(runs) as correct_pct, count(*) as run_count
    from cells where mode = ? group by task, client, mode having trials >= ? order by correct_pct asc, trials desc limit ?`).all(mode, minTrials, limit);
}

// Read-only escape hatch for anything the canned reports do not cover.
export function rawQuery(sql) {
  const ro = new DatabaseSync(dbPath(), { readOnly: true });
  try { return ro.prepare(sql).all(); } finally { ro.close(); }
}

// ---- retention -------------------------------------------------------------------------------
//
// Compaction keeps every run file and every scalar (so the index and the tables stay complete) but
// strips the bulky text from old trials: prompts, the final message, tool-result contents. A dry run
// reports what it would do; `apply` rewrites the files and re-indexes them.
const BULKY = ["system", "prompt", "answerText"];

export function compactRuns({ olderThanDays, apply = false, now = Date.now() } = {}) {
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 0) throw new Error("compact needs --older-than <days>");
  const cutoff = new Date(now - days * 86400_000).toISOString();
  const dir = runsDir();
  const report = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const id = f.replace(/\.json$/, "");
    const run = loadRun(id);
    if (!run || run.compacted || run.status === "running") continue;
    if (!(run.createdAt && run.createdAt < cutoff)) continue;
    const file = join(dir, f);
    const before = statSync(file).size;
    const stripped = { ...run, compacted: new Date(now).toISOString(), rows: run.rows.map((r) => {
      const row = { ...r };
      for (const k of BULKY) if (k in row) row[k] = null;
      row.toolResults = (r.toolResults ?? []).map((t) => ({ ...t, content: null }));
      return row;
    }) };
    const body = JSON.stringify(stripped);
    const after = Buffer.byteLength(body);
    report.push({ id, createdAt: run.createdAt, bytesBefore: before, bytesAfter: after, applied: apply });
    if (apply) {
      writeFileSync(file, body);
      try { indexRun(stripped, { mtime: statSync(file).mtimeMs / 1000 }); } catch { /* the next index pass catches up */ }
    }
  }
  return { cutoff, apply, files: report, savedBytes: report.reduce((a, r) => a + (r.bytesBefore - r.bytesAfter), 0) };
}

// Keep the index current as runs are saved. The header goes in on every save; trials and cells
// land when the run stops running. Never let indexing fail a save.
onRunSaved((run, path) => {
  try {
    let mtime = null;
    try { mtime = statSync(path).mtimeMs / 1000; } catch { /* keep null */ }
    indexRun(run, { mtime });
  } catch { /* best effort */ }
});

export { existsSync as _existsSync, readFileSync as _readFileSync };
