// The thermal record: the pmset parser under pressure and without one, the state off macOS and
// through an injected reader, the pooled summary and its phrasing, and the runner stamping every
// row from the entry point's hook with the report line that follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTherm, thermalState, thermalSummary, describeThermal } from "../src/thermal.js";
import { runMatrix, summarize } from "../src/runner.js";
import { printSummary } from "../src/report.js";
import { task as health } from "../src/tasks/health.js";

const PRESSURE = "2026-09-10 18:12:00 -0700\nCPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 63\n";
const IDLE = "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n";

test("parseTherm reads the limits pmset prints under pressure and reports none when nothing is recorded", () => {
  assert.deepEqual(parseTherm(PRESSURE), { speedLimitPct: 63, schedulerLimitPct: 100, availableCpus: 8, pressure: true, recorded: true });
  assert.deepEqual(parseTherm(IDLE), { speedLimitPct: 100, schedulerLimitPct: 100, availableCpus: null, pressure: false, recorded: false });
  assert.equal(parseTherm("CPU_Scheduler_Limit = 40\nCPU_Speed_Limit = 100").pressure, true, "a scheduler limit is pressure too");
  assert.equal(parseTherm("").pressure, false);
});

test("thermalState is null off macOS, and on macOS reads through the injected reader with a timestamp", () => {
  assert.equal(thermalState({ platform: "linux" }), null);
  const s = thermalState({ platform: "darwin", read: () => PRESSURE });
  assert.equal(s.platform, "darwin");
  assert.equal(s.speedLimitPct, 63);
  assert.equal(s.pressure, true);
  assert.match(s.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(thermalState({ platform: "darwin", read: () => { throw new Error("no pmset"); } }), null, "a failed read is no record, not a crash");
  assert.equal(thermalState({ platform: "darwin", read: () => 42 }), null);
});

test("the pooled summary and its phrasing", () => {
  const row = (t) => ({ env: t ? { thermal: t } : null });
  assert.equal(thermalSummary([row(null), {}]), null);
  assert.equal(describeThermal(null), "thermal state not sampled");
  const cool = thermalSummary([row({ speedLimitPct: 100, schedulerLimitPct: 100, pressure: false }), row({ speedLimitPct: 100, schedulerLimitPct: 100, pressure: false })]);
  assert.deepEqual(cool, { sampled: 2, underPressure: 0, minSpeedLimitPct: 100, minSchedulerLimitPct: 100 });
  assert.equal(describeThermal(cool), "no thermal pressure on 2 sampled trials");
  const hot = thermalSummary([row({ speedLimitPct: 100, schedulerLimitPct: 100, pressure: false }), row({ speedLimitPct: 63, schedulerLimitPct: 100, pressure: true }), row({ speedLimitPct: 80, schedulerLimitPct: 50, pressure: true })]);
  assert.deepEqual(hot, { sampled: 3, underPressure: 2, minSpeedLimitPct: 63, minSchedulerLimitPct: 50 });
  assert.equal(describeThermal(hot), "2 of 3 trials started under thermal pressure (CPU speed limit down to 63 %, scheduler limit 50 %)");
});

test("runMatrix stamps every row with the hook's sample, summarize pools it, and the report says so when any trial ran under pressure", async () => {
  const client = { name: "fake:m", model: "m", async chat() { return { text: "ok", usage: null }; }, async runWithTools() { return { text: "{}", structured: {}, toolCalls: [], toolResults: [], rounds: 1, usage: null }; } };
  let n = 0;
  const samples = [{ thermal: { speedLimitPct: 100, schedulerLimitPct: 100, pressure: false } }, { thermal: { speedLimitPct: 63, schedulerLimitPct: 100, pressure: true } }];
  const { rows, summary } = await runMatrix({ tasks: [health], modes: ["noHarness"], clients: [client], count: 2, sampleEnv: () => samples[n++ % 2] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.env.thermal.speedLimitPct).sort((a, b) => a - b), [63, 100]);
  assert.deepEqual(summary.thermal, { sampled: 2, underPressure: 1, minSpeedLimitPct: 63, minSchedulerLimitPct: 100 });
  const lines = [];
  printSummary(summary, { log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /-- thermal: 1 of 2 trials started under thermal pressure \(CPU speed limit down to 63 %\)/);
  // No hook: no env on the rows, no thermal in the summary, no line.
  const plain = await runMatrix({ tasks: [health], modes: ["noHarness"], clients: [client], count: 1 });
  assert.equal(plain.rows[0].env, null);
  assert.equal(plain.summary.thermal, null);
  const throwing = await runMatrix({ tasks: [health], modes: ["noHarness"], clients: [client], count: 1, sampleEnv: () => { throw new Error("no"); } });
  assert.equal(throwing.rows[0].env, null, "a failing sampler is no record, not a failed trial");
  assert.equal(summarize(rows).thermal.sampled, 2);
});
