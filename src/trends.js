// trends.js — what a model's capabilities did over time, and whether a checkpoint has regressed:
// against its own earlier runs, or against the parent its lineage entry names. Pure functions over
// indexed trial rows ({ runId, createdAt, task, mode, client, correct }); the CLI and the web API
// fetch the rows from the SQLite index and hand them here.

import { wilsonInterval, deltaBetween, capabilityStats, instanceVariance } from "./runner.js";

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

// A lineage family across its checkpoints: per member (in the registry's order), the rate per
// capability in one mode, pooled over every run the index holds; and the whole family pooled.
export function familyScorecard(rowsByClient, capabilitiesOf, members, { mode = "harness" } = {}) {
  const out = [];
  for (const m of members) {
    const rows = rowsByClient[m.id] ?? [];
    const own = rows.filter((r) => r.mode === mode);
    const byCapability = {};
    for (const cap of [...new Set(own.flatMap((r) => capabilitiesOf[r.task] ?? []))].sort()) byCapability[cap] = rate(own.filter((r) => (capabilitiesOf[r.task] ?? []).includes(cap)));
    out.push({ id: m.id, checkpoint: m.checkpoint ?? null, step: m.step ?? null, parent: m.parent ?? null, trials: rows.length, runs: new Set(rows.map((r) => r.runId)).size, byCapability });
  }
  const all = members.flatMap((m) => rowsByClient[m.id] ?? []);
  const capabilities = [...new Set(out.flatMap((m) => Object.keys(m.byCapability)))].sort();
  return { mode, members: out, capabilities, pooled: capabilityStats(all, capabilitiesOf), trials: all.length };
}

// Every client's regressions in one document — the shape a CI step reads or a webhook receives:
// per client its own flags (latest run against earlier runs) and, for a checkpoint with a
// registered parent, the gaps against it; plus one flat list of flags across clients.
export function regressionsReport(rows, capabilitiesOf, entries = {}, { client = null, since = null, minTrials = 4, now = new Date() } = {}) {
  const clients = client ? [client] : [...new Set(rows.map((r) => r.client))].sort();
  const flat = [];
  const perClient = [];
  for (const c of clients) {
    const own = rows.filter((r) => r.client === c);
    const runs = new Set(own.map((r) => r.runId)).size;
    const reg = runs >= 2 ? regressionsFor(own, capabilitiesOf, { minTrials }) : { flags: [], compared: 0, latestRuns: [] };
    const e = entries[c];
    const parentRows = e?.parent ? rows.filter((r) => r.client === e.parent) : [];
    const vsParent = e?.parent && own.length && parentRows.length ? { parent: e.parent, ...parentGaps(own, parentRows, capabilitiesOf, { minTrials }) } : null;
    perClient.push({ client: c, runs, trials: own.length, own: reg, vsParent });
    for (const f of reg.flags) flat.push({ kind: "own", client: c, capability: f.capability, mode: f.mode, from: f.earlier, to: f.later, dropPp: f.dropPp, pValue: f.delta.pValue, earlierRuns: f.earlierRuns, latestRuns: f.latestRuns, latestAt: f.latestAt, perTask: f.perTask });
    for (const f of vsParent?.flags ?? []) flat.push({ kind: "parent", client: c, parent: e.parent, capability: f.capability, mode: f.mode, from: f.parent, to: f.child, dropPp: f.dropPp, pValue: f.delta.pValue, perTask: f.perTask });
  }
  // The biggest drop first; at a tie a client's own regression before a gap against its parent.
  flat.sort((a, b) => b.dropPp - a.dropPp || (a.kind === "own" ? 0 : 1) - (b.kind === "own" ? 0 : 1) || a.client.localeCompare(b.client));
  return { generatedAt: now.toISOString(), since, minTrials, clients: perClient, flags: flat, count: flat.length };
}

// What the index holds per registered checkpoint, for the lineage graph: trials, runs, the last
// run, the pooled harness rate, and how many regression flags (own, and against the parent).
export function lineageStats(rows, capabilitiesOf, entries, { minTrials = 4 } = {}) {
  const report = regressionsReport(rows, capabilitiesOf, entries, { minTrials });
  const flagsFor = Object.fromEntries(report.clients.map((c) => [c.client, { own: c.own.flags.length, parent: c.vsParent?.flags.length ?? 0 }]));
  const out = {};
  for (const id of Object.keys(entries)) {
    const own = rows.filter((r) => r.client === id);
    if (!own.length) continue;
    const h = own.filter((r) => r.mode === "harness");
    const correct = h.filter((r) => r.correct).length;
    out[id] = { trials: own.length, runs: new Set(own.map((r) => r.runId)).size, last: own.map((r) => String(r.createdAt)).sort().pop() ?? null, harnessN: h.length, harnessCorrect: correct, harnessPct: h.length ? (correct / h.length) * 100 : null, flags: flagsFor[id] ?? { own: 0, parent: 0 } };
  }
  return out;
}

// Variance across settings: the same cells under each value of one model parameter (temperature
// by default; seed, effort…), pooled over every run at that setting — agreement and flakiness per
// instance, so a generated task's repeats come from replays and runs on the same instance seed.
// Rows: { runId, createdAt, task, mode, client, correct, canon, seed, seeded, params }.
export function varianceBySetting(rows, { by = "temperature" } = {}) {
  const settingOf = (r) => { const v = r.params?.[by]; return v === undefined || v === null ? "default" : String(v); };
  const out = {};
  for (const setting of [...new Set(rows.map(settingOf))].sort((a, b) => (a === "default") - (b === "default") || a.localeCompare(b, undefined, { numeric: true }))) {
    const sub = rows.filter((r) => settingOf(r) === setting);
    const cells = [];
    for (const key of [...new Set(sub.map((r) => `${r.task}|${r.mode}`))].sort()) {
      const [task, mode] = key.split("|");
      const cr = sub.filter((r) => r.task === task && r.mode === mode);
      cells.push({ task, mode, runs: new Set(cr.map((r) => r.runId)).size, trials: cr.length, correct: cr.filter((r) => r.correct).length, ...instanceVariance(cr) });
    }
    const canonCells = cells.filter((c) => c.agreementPct !== null);
    const weight = canonCells.reduce((a, c) => a + c.canonRuns, 0);
    out[setting] = {
      setting: by, value: setting,
      runs: new Set(sub.map((r) => r.runId)).size, trials: sub.length, correct: sub.filter((r) => r.correct).length,
      repeatedInstances: cells.reduce((a, c) => a + c.repeatedInstances, 0), flakyInstances: cells.reduce((a, c) => a + c.flakyInstances, 0),
      agreementPct: weight ? canonCells.reduce((a, c) => a + c.agreementPct * c.canonRuns, 0) / weight : null,
      canonCells: canonCells.length, cells,
    };
  }
  return out;
}

// Stability per run over time: each run's repeated instances, how many were flaky, and the
// agreement — one point per run, oldest first, with the run's setting for the sparkline's label.
export function stabilityOverTime(rows, { by = "temperature" } = {}) {
  const runs = [...new Map(rows.map((r) => [r.runId, r])).values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return runs.map((run) => {
    const own = rows.filter((r) => r.runId === run.runId);
    const cells = [...new Set(own.map((r) => `${r.task}|${r.mode}`))].map((key) => { const [task, mode] = key.split("|"); return { task, mode, ...instanceVariance(own.filter((r) => r.task === task && r.mode === mode)) }; });
    const canonCells = cells.filter((c) => c.agreementPct !== null);
    const weight = canonCells.reduce((a, c) => a + c.canonRuns, 0);
    const v = run.params?.[by];
    return { runId: run.runId, createdAt: run.createdAt, setting: v === undefined || v === null ? "default" : String(v), trials: own.length, correct: own.filter((r) => r.correct).length, repeatedInstances: cells.reduce((a, c) => a + c.repeatedInstances, 0), flakyInstances: cells.reduce((a, c) => a + c.flakyInstances, 0), agreementPct: weight ? canonCells.reduce((a, c) => a + c.agreementPct * c.canonRuns, 0) / weight : null };
  });
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
