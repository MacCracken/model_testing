// holes.js — what a run was asked for and does not have, and the same question over the index.
//
// A planned trial is a hole when no scored row answers for it: its row is an error row (the
// endpoint was down, the request timed out, a time box cancelled it mid-flight) or it never started
// (the box, a cancel, an endpoint the matrix gave up on). `bench --replay <run> --holes` runs
// exactly those again, on the same seeds, as a run parented to the first (`parent.kind: "fill"`) —
// pooled views read the scored rows of both and never count a trial twice, since a hole is by
// definition not a scored row. A refused request (a 400: the route does not take the parameter) is
// not a hole: asking again gets the same refusal. Pure functions; Node-free.

import { trialKey, errorKindOf } from "./runner.js";
import { seedFor } from "./tasks/gen.js";

// Error kinds worth running again. "request" is deterministic, so it is left out.
export const FILLABLE = ["transport", "timeout", "cancelled", "bench"];

const kindOf = (row) => (row?.error ? row.errorKind ?? errorKindOf(row.error) ?? "bench" : null);

// The holes of one run. `cells` is `planMatrix(...).cells` for the run's configuration (the caller
// has the task and client objects; a saved run only has their names), `count` its trials per cell.
// A run that was itself a fill (`config.only`) was only ever asked for those trials.
export function holesOf(run, { cells, count = run?.config?.count ?? 1, kinds = FILLABLE } = {}) {
  const asked = Array.isArray(run?.config?.only) ? new Set(run.config.only) : null;
  const best = new Map(); // key → the row that answers for it (a scored one wins over an error row)
  for (const row of run?.rows ?? []) {
    const key = trialKey(row);
    if (!best.has(key) || (best.get(key).error && !row.error)) best.set(key, row);
  }
  const holes = [];
  for (const { task, mode, client } of cells ?? []) {
    for (let index = 1; index <= count; index++) {
      const at = { task: task.name ?? task, mode, client: client.name ?? client, index };
      const key = trialKey(at);
      if (asked && !asked.has(key)) continue;
      const row = best.get(key);
      if (row && !row.error) continue;
      const kind = row ? kindOf(row) : null;
      if (row && !kinds.includes(kind)) continue;
      holes.push({ ...at, key, why: row ? kind : "not run" });
    }
  }
  return holes;
}

// The holes nothing has closed since. `scored` is the index's set of scored instances (`keyOf`
// builds a key the same way); a hole's trial seed is its error row's, or — for a trial that never
// started — the one the run's instance seed gives that task and index.
export function stillOpen(holes, run, scored, keyOf) {
  if (!scored?.size) return holes;
  const rowSeed = new Map((run.rows ?? []).map((r) => [trialKey(r), r.seed]));
  const seedOf = (h) => rowSeed.get(h.key) ?? (Number.isInteger(run.config?.instanceSeed) ? seedFor(run.config.instanceSeed, h.task, h.index) : null);
  return holes.filter((h) => !scored.has(keyOf({ task: h.task, mode: h.mode, client: h.client, seed: seedOf(h), modelParams: run.config?.modelParams ?? {} })));
}

// "12 transport, 38 not run" — what the holes are made of.
export function describeHoles(holes) {
  const by = {};
  for (const h of holes) by[h.why] = (by[h.why] ?? 0) + 1;
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ") || "none";
}

// What a fill did with its parent's holes.
export function describeFill(parent, run, holes) {
  const scored = new Set((run.rows ?? []).filter((r) => !r.error).map(trialKey));
  const filled = holes.filter((h) => scored.has(h.key));
  const right = (run.rows ?? []).filter((r) => !r.error && r.correct && holes.some((h) => h.key === trialKey(r))).length;
  const left = holes.length - filled.length;
  return `fill of ${parent.id}: ${filled.length} of ${holes.length} hole(s) now have a scored row (${right} right)${left ? `; ${left} still open — run the same command on ${run.id} to go on` : ""}`;
}

// Coverage over indexed trial rows ({ task, mode, client, correct, error, error_kind }): per cell,
// the scored trials, how many were right, and the error rows by kind. `min` marks a cell short.
export function coverage(rows, { min = 4 } = {}) {
  const cells = new Map();
  for (const r of rows) {
    const key = `${r.task}|${r.mode}|${r.client}`;
    if (!cells.has(key)) cells.set(key, { task: r.task, mode: r.mode, client: r.client, scored: 0, correct: 0, lost: {}, runs: new Set() });
    const c = cells.get(key);
    if (r.run_id) c.runs.add(r.run_id);
    if (r.error) { const k = r.error_kind ?? errorKindOf(r.error) ?? "bench"; c.lost[k] = (c.lost[k] ?? 0) + 1; }
    else { c.scored += 1; if (r.correct) c.correct += 1; }
  }
  return [...cells.values()].map((c) => ({ ...c, runs: [...c.runs], lostTotal: Object.values(c.lost).reduce((a, b) => a + b, 0), short: c.scored < min }));
}

// The coverage as a table: tasks down, clients across, for one mode. `tasks` fixes the row order
// and names the tasks a client never ran ("·"); "3/4" is right/scored, "+2" error rows beside them,
// "lost" a cell with error rows only. A short cell carries a "!".
export function coverageTable(cells, { tasks, clients, mode, min = 4 }) {
  const at = new Map(cells.filter((c) => c.mode === mode).map((c) => [`${c.task}|${c.client}`, c]));
  const show = (c) => (!c ? "·" : c.scored === 0 ? `lost ${c.lostTotal}` : `${c.correct}/${c.scored}${c.lostTotal ? ` +${c.lostTotal}` : ""}${c.scored < min ? " !" : ""}`);
  const width = Math.max(12, ...clients.map((c) => c.length + 2));
  const lines = [`${mode} — right/scored per cell (· never run, +n error rows beside scored ones, ! under ${min} scored)`, `${"task".padEnd(14)}${clients.map((c) => c.padStart(width)).join("")}`];
  for (const t of tasks) {
    if (!clients.some((c) => at.has(`${t}|${c}`))) continue;
    lines.push(`${t.padEnd(14)}${clients.map((c) => show(at.get(`${t}|${c}`)).padStart(width)).join("")}`);
  }
  return lines.join("\n");
}
