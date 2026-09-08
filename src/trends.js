// trends.js — what a model's capabilities did over time, and whether a checkpoint has regressed:
// against its own earlier runs, or against the parent its lineage entry names. Pure functions over
// indexed trial rows ({ runId, createdAt, task, mode, client, correct }); the CLI and the web API
// fetch the rows from the SQLite index and hand them here.

import { wilsonInterval, deltaBetween } from "./runner.js";

const rate = (rows) => {
  const correct = rows.filter((r) => r.correct).length;
  return { runs: rows.length, correct, correctPct: rows.length ? (correct / rows.length) * 100 : null, wilson: rows.length ? wilsonInterval(correct, rows.length) : null };
};

// Per run, per capability, per mode — the time series behind a trend line.
export function seriesFor(rows, capabilitiesOf, { capability = null, mode = null } = {}) {
  const runs = [...new Map(rows.map((r) => [r.runId, r.createdAt])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const caps = capability ? [capability] : [...new Set(rows.flatMap((r) => capabilitiesOf[r.task] ?? []))].sort();
  const modes = mode ? [mode] : [...new Set(rows.map((r) => r.mode))];
  return runs.map(([runId, createdAt]) => {
    const own = rows.filter((r) => r.runId === runId);
    const byCapability = {};
    for (const cap of caps) {
      const cr = own.filter((r) => (capabilitiesOf[r.task] ?? []).includes(cap));
      if (!cr.length) continue;
      byCapability[cap] = Object.fromEntries(modes.filter((m) => cr.some((r) => r.mode === m)).map((m) => [m, rate(cr.filter((r) => r.mode === m))]));
    }
    return { runId, createdAt, byCapability };
  });
}

// "Fell below by more than the band": the later side's Wilson band lies entirely under the earlier
// side's. Conservative on purpose — an alert should be worth reading.
export function bandsSeparate(earlier, later) {
  return !!(earlier?.wilson && later?.wilson && later.wilson.high < earlier.wilson.low);
}

// Both sides restricted to the tasks they share, so a change of task mix (chain yesterday, restock
// today, both "multi-step") is never read as a change in the model.
// Balanced as well: per task the same number of trials on each side (the most recent ones), so a
// side heavy in the hardest task does not tilt the pool.
const byRecency = (rows) => [...rows].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
const sharedTasks = (a, b) => {
  const inB = new Set(b.map((r) => r.task));
  const tasks = [...new Set(a.filter((r) => inB.has(r.task)).map((r) => r.task))].sort();
  const A = [], B = [], perTask = [];
  for (const task of tasks) {
    const ta = byRecency(a.filter((r) => r.task === task)), tb = byRecency(b.filter((r) => r.task === task));
    const k = Math.min(ta.length, tb.length);
    const ka = ta.slice(0, k), kb = tb.slice(0, k);
    A.push(...ka); B.push(...kb);
    perTask.push({ task, n: k, earlier: ka.filter((r) => r.correct).length, later: kb.filter((r) => r.correct).length });
  }
  return { a: A, b: B, tasks, perTask };
};

// A client's latest results against its earlier ones, per capability and mode. Per task, the
// later side is the most recent run that ran the task and the earlier side every older run that
// did; a task run only once has no earlier side and drops out. Pooled per capability, so this works
// both for suite runs (every task every time) and for one family at a time.
export function regressionsFor(rows, capabilitiesOf, { minTrials = 4, modes = ["harness", "noHarness"] } = {}) {
  if (!rows.length) return { flags: [], compared: 0, latestRuns: [] };
  const runAt = new Map(rows.map((r) => [r.runId, String(r.createdAt)]));
  const flags = [];
  let compared = 0;
  const latestRuns = new Set();
  for (const cap of [...new Set(rows.flatMap((r) => capabilitiesOf[r.task] ?? []))].sort()) {
    for (const mode of modes) {
      const own = rows.filter((r) => r.mode === mode && (capabilitiesOf[r.task] ?? []).includes(cap));
      const later = [], earlier = [], runsHere = new Set();
      for (const task of new Set(own.map((r) => r.task))) {
        const tr = own.filter((r) => r.task === task);
        const runs = [...new Set(tr.map((r) => r.runId))].sort((a, b) => runAt.get(a).localeCompare(runAt.get(b)));
        if (runs.length < 2) continue;
        const last = runs[runs.length - 1];
        runsHere.add(last);
        for (const r of tr) (r.runId === last ? later : earlier).push(r);
      }
      const { a, b, tasks, perTask } = sharedTasks(earlier, later);
      if (a.length < minTrials || b.length < minTrials) continue;
      compared += 1;
      for (const id of runsHere) latestRuns.add(id);
      const before = rate(a), now = rate(b);
      if (bandsSeparate(before, now)) {
        const ids = [...new Set(b.map((r) => r.runId))].sort();
        flags.push({ capability: cap, mode, tasks, perTask, earlier: before, later: now, dropPp: before.correctPct - now.correctPct, delta: deltaBetween(a, b, { bootstrap: false }), earlierRuns: new Set(a.map((r) => r.runId)).size, latestRuns: ids, latestAt: ids.map((id) => runAt.get(id)).sort().pop() });
      }
    }
  }
  return { flags, compared, latestRuns: [...latestRuns].sort() };
}

// A checkpoint against its parent, both pooled over every run, per capability and mode, on the
// tasks both ran.
export function parentGaps(childRows, parentRows, capabilitiesOf, { minTrials = 4, modes = ["harness", "noHarness"] } = {}) {
  const flags = [];
  let compared = 0;
  for (const cap of [...new Set([...childRows, ...parentRows].flatMap((r) => capabilitiesOf[r.task] ?? []))].sort()) {
    for (const mode of modes) {
      const { a: p, b: c, tasks, perTask } = sharedTasks(parentRows.filter((r) => r.mode === mode && (capabilitiesOf[r.task] ?? []).includes(cap)), childRows.filter((r) => r.mode === mode && (capabilitiesOf[r.task] ?? []).includes(cap)));
      if (p.length < minTrials || c.length < minTrials) continue;
      compared += 1;
      const parent = rate(p), child = rate(c);
      if (bandsSeparate(parent, child)) flags.push({ capability: cap, mode, tasks, perTask, parent, child, dropPp: parent.correctPct - child.correctPct, delta: deltaBetween(p, c, { bootstrap: false }) });
    }
  }
  return { flags, compared };
}
