// results.js — persist benchmark runs to disk so they can be reviewed later.
//
// One JSON file per run under `results/runs/`. `results/` is gitignored; nothing here assumes
// the directory exists yet.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = process.env.RESULTS_DIR
  ? resolve(process.env.RESULTS_DIR)
  : resolve(process.cwd(), "results");

const RUNS_DIR = join(ROOT, "runs");

export function runsDir() {
  mkdirSync(RUNS_DIR, { recursive: true });
  return RUNS_DIR;
}

// Sortable, human-readable id: 20260829T174512-3f9a
export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `${stamp}-${randomUUID().slice(0, 4)}`;
}

function pathFor(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid run id: ${id}`);
  return join(runsDir(), `${id}.json`);
}

export function saveRun(run) {
  writeFileSync(pathFor(run.id), JSON.stringify(run, null, 2));
  return run;
}

export function loadRun(id) {
  const p = pathFor(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function deleteRun(id) {
  const p = pathFor(id);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

/** Run headers, newest first — everything except the per-trial rows. */
export function listRuns({ limit = 100 } = {}) {
  let files = [];
  try {
    files = readdirSync(runsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs = [];
  for (const f of files.sort().reverse().slice(0, limit)) {
    const run = loadRun(f.replace(/\.json$/, ""));
    if (run) runs.push(runHeader(run));
  }
  return runs;
}

export function runHeader(run) {
  const { rows, ...rest } = run;
  return { ...rest, rowCount: rows?.length ?? 0 };
}
