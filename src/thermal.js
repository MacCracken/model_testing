// thermal.js — the machine's thermal state, recorded with a run so a slow local row is
// explainable. A laptop serving a model through Ollama runs hot, and macOS answers by lowering
// the CPU and GPU clocks (thermal pressure); the same model then takes twelve seconds on one
// trial and three hundred on the next, and the daemon can stop answering for a minute. Nothing in
// the model's row says why. `thermalState()` reads `pmset -g therm` (no privileges needed) and
// returns the CPU speed limit macOS is imposing — 100 when none is recorded — with the scheduler
// limit and the CPUs available; null off macOS. The entry points sample it at the start and end
// of a run (`run.env.thermal`) and hand `sampleEnvironment` to `runMatrix`, which stamps every
// trial's start state on its row (`row.env.thermal`); `summarize` pools those into
// `summary.thermal` and the report prints a line when any trial ran under pressure. Node-side.

import { spawnSync } from "node:child_process";

// The lines pmset prints under pressure: "CPU_Speed_Limit = 63", "CPU_Available_CPUs = 8",
// "CPU_Scheduler_Limit = 100". When nothing has been recorded it prints notes instead.
export function parseTherm(text) {
  const t = String(text ?? "");
  const num = (key) => { const m = t.match(new RegExp(`${key}\\s*=\\s*(\\d+)`)); return m ? Number(m[1]) : null; };
  const speed = num("CPU_Speed_Limit"), scheduler = num("CPU_Scheduler_Limit"), cpus = num("CPU_Available_CPUs");
  const speedLimitPct = speed ?? 100, schedulerLimitPct = scheduler ?? 100;
  return { speedLimitPct, schedulerLimitPct, availableCpus: cpus, pressure: speedLimitPct < 100 || schedulerLimitPct < 100, recorded: speed !== null || scheduler !== null };
}

export function thermalState({ platform = process.platform, read = null } = {}) {
  if (platform !== "darwin") return null;
  let text;
  try {
    text = read ? read() : spawnSync("pmset", ["-g", "therm"], { encoding: "utf8", timeout: 2000 }).stdout;
  } catch { return null; }
  if (typeof text !== "string") return null;
  return { platform: "darwin", ...parseTherm(text), at: new Date().toISOString() };
}

// What `runMatrix` stamps on a trial: the environment at its start, or null where nothing is read.
export function sampleEnvironment() {
  const thermal = thermalState();
  return thermal ? { thermal } : null;
}

// The pooled reading over a run's rows, for the report: how many trials were sampled, how many
// ran under pressure, and the lowest speed limit seen.
export function thermalSummary(rows) {
  const sampled = (rows ?? []).map((r) => r?.env?.thermal).filter((t) => t && typeof t.speedLimitPct === "number");
  if (!sampled.length) return null;
  const under = sampled.filter((t) => t.pressure);
  return { sampled: sampled.length, underPressure: under.length, minSpeedLimitPct: Math.min(...sampled.map((t) => t.speedLimitPct)), minSchedulerLimitPct: Math.min(...sampled.map((t) => t.schedulerLimitPct ?? 100)) };
}

export function describeThermal(t) {
  if (!t) return "thermal state not sampled";
  if (!t.underPressure) return `no thermal pressure on ${t.sampled} sampled trial${t.sampled === 1 ? "" : "s"}`;
  return `${t.underPressure} of ${t.sampled} trials started under thermal pressure (CPU speed limit down to ${t.minSpeedLimitPct} %${t.minSchedulerLimitPct < 100 ? `, scheduler limit ${t.minSchedulerLimitPct} %` : ""})`;
}
