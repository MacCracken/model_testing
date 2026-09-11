// bench.js — run tasks in one or more modes against one or more clients, score, and record.
//
// Usage:
//   node src/bench.js --task health --mode harness --clients openai:gpt-4o-mini
//   node src/bench.js --task all --modes noHarness,harness --clients local:ornith-1.5:9b --count 3
//   node src/bench.js --task health,reason,regex --modes noHarness,harness --clients openai:gpt-4o-mini --count 8 --parallel 8
//   node src/bench.js --task wordmath4,tally60 --modes noHarness,harness --clients openai:gpt-4o-mini --count 4 --instance-seed 7   # same problems every run
//   node src/bench.js --task hello --clients local            # every local model
//
// Every run is saved under results/runs/ (so the web UI can review it too); --json also prints
// the rows to stdout, --no-save skips persistence.

import "./env.js";
import "./store.js";
import { lineageOf } from "./lineage.js";
import { getTask, tasks as allTasks } from "./tasks/registry.js";
import { endpointsFor, resolveClients } from "./providers/index.js";
import { runMatrix, planMatrix, isStructuredMode, describeSignificance, compareRows, describePaired, MODE_NAMES, DEFAULT_MODES } from "./runner.js";
import { newRunId, saveRun, loadRun } from "./results.js";
import { pricingFor } from "./prices.js";
import { parseArgs } from "./args.js";
import { benchVersions } from "./version.js";
import { thermalState, sampleEnvironment } from "./thermal.js";
import { makeJudge } from "./judge.js";
import { envValue } from "./util.js";
import { gatesFromArgs, gateNames, gateRun, describeRunGates } from "./gates.js";

// The judge model for open-ended tasks: --judge provider:model, else BENCH_JUDGE, else none.
export function resolveJudge(spec) {
  const chosen = spec || envValue("BENCH_JUDGE");
  if (!chosen) return null;
  const [client] = resolveClients(chosen);
  if (!client) throw new Error(`--judge ${chosen}: no usable client (unknown provider, missing key, or a harness arm)`);
  if (client.structuredOnly) throw new Error(`--judge ${chosen}: a harness arm cannot be the judge`);
  return makeJudge(client);
}

function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

export function resolveTasks(spec) {
  if (!spec) return allTasks;
  const names = (Array.isArray(spec) ? spec : String(spec).split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!names.length || names.includes("all")) return allTasks;
  return names.map(getTask);
}

export function resolveModes(spec) {
  if (!spec) return [...DEFAULT_MODES];
  const modes = (Array.isArray(spec) ? spec : String(spec).split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!modes.length) return [...DEFAULT_MODES];
  for (const m of modes) {
    if (!MODE_NAMES.includes(m)) throw new Error(`--mode must be one of ${MODE_NAMES.join(", ")}, got "${m}"`);
  }
  return modes;
}

// The determinism knobs from the CLI, keeping only the ones actually given.
// `--model-param key=value` covers everything else a provider accepts (e.g. `think=false` for
// Ollama's thinking models); values parse as JSON when they can, else stay strings.
export function modelParamsFrom({ temperature, seed, modelParam, effort } = {}) {
  const params = {};
  if (Number.isFinite(temperature)) params.temperature = temperature;
  if (Number.isFinite(seed)) params.seed = seed;
  // The reasoning-effort knob for the whole run; translated per provider when the client is built.
  if (effort) params.effort = effort;
  for (const kv of modelParam ?? []) {
    const eq = String(kv).indexOf("=");
    if (eq === -1) throw new Error(`--model-param expects key=value, got "${kv}"`);
    const key = kv.slice(0, eq).trim();
    const raw = kv.slice(eq + 1).trim();
    let value = raw;
    try { value = JSON.parse(raw); } catch { /* keep the string */ }
    params[key] = value;
  }
  return params;
}

// Human-readable note for each (task, mode) pair a run skips because the task has no such spec.
export function describeSkipped(skipped) {
  return skipped.map((s) => (s.client
    ? `${s.task}/${s.mode} skipped for ${s.client}: ${s.why === "multi-turn" ? "a harness arm cannot take a user's scripted turns" : "a harness arm runs structured modes only"}`
    : `${s.task}/${s.mode} skipped: the task declares no ${s.mode} spec`));
}

// A replay takes the saved run's tasks, modes, clients, count, parallelism, instance seed and
// judge wherever the command line leaves them unsaid, and its model knobs under any given now:
// the same instances against the same or another model, as a new run parented to the original.
export function replayArgs(run, args = {}) {
  const c = run.config ?? {};
  const out = { replayParams: c.modelParams ?? {} };
  if (args.task === undefined && c.tasks?.length) out.task = c.tasks.join(",");
  if (args.mode === undefined && c.modes?.length) out.mode = c.modes.join(",");
  if (args.clients === undefined && c.clients?.length) out.clients = c.clients.join(",");
  if (args.count === undefined && Number.isInteger(c.count)) out.count = c.count;
  if (args.parallel === undefined && Number.isInteger(c.parallel)) out.parallel = c.parallel;
  if (args.instanceSeed === undefined && Number.isInteger(c.instanceSeed)) out.instanceSeed = c.instanceSeed;
  if (args.judge === undefined && c.judge) out.judge = c.judge;
  return out;
}

// The paired reading of a replay against its parent: the same instances, so McNemar applies.
export function describeReplay(parent, run) {
  const c = compareRows(parent.rows ?? [], run.rows ?? []);
  const L = [`replay of ${parent.id}: ${c.pairs} paired trial(s) (${c.unpairedA} parent-only, ${c.unpairedB} replay-only)`];
  if (!c.pairs) {
    L.push("nothing pairs — a pair needs the same task and trial index, and the same client when both runs share models; narrow with --clients, --task or --modes");
    return L.join("\n");
  }
  L.push(`${"task".padEnd(12)} ${"parent".padEnd(7)} ${"replay".padEnd(7)} both  parent-only  replay-only  neither  McNemar`);
  for (const [task, d] of Object.entries(c.byTask)) {
    L.push(`${task.padEnd(12)} ${(d.aPct.toFixed(0) + "%").padEnd(7)} ${(d.bPct.toFixed(0) + "%").padEnd(7)} ${String(d.both).padStart(4)}  ${String(d.onlyBase).padStart(11)}  ${String(d.onlyTreat).padStart(11)}  ${String(d.neither).padStart(7)}  p=${d.pValue.toFixed(3)}${d.significant ? " *" : ""}`);
  }
  if (c.overall) L.push(`overall: parent ${c.overall.aPct.toFixed(1)}% → replay ${c.overall.bPct.toFixed(1)}% · ${describePaired(c.overall)}`);
  return L.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --replay <run>: the saved run's configuration, each part overridable, and the new run parented to it.
  let parentRun = null;
  if (args.replay) {
    parentRun = loadRun(args.replay);
    if (!parentRun) fail(`unknown run: ${args.replay}`);
    Object.assign(args, replayArgs(parentRun, args));
  }

  let taskList, modeList;
  try {
    taskList = resolveTasks(args.task);
    modeList = resolveModes(args.mode);
  } catch (err) {
    fail(err.message);
  }

  const count = args.count ?? 1;
  const parallel = Math.max(1, Math.floor(args.parallel ?? 1) || 1);

  // --clients takes precedence over --provider/--model.
  const modelParams = { ...(args.replayParams ?? {}), ...modelParamsFrom(args) };
  const clients = args.clients
    ? resolveClients(args.clients, { modelParams })
    : resolveClients([{ provider: args.provider ?? "openai", model: args.model ?? "gpt-4o-mini" }], { modelParams });
  if (!clients.length) {
    fail(`no client resolved — check the model name and that ${(args.provider ?? "the provider").toUpperCase()}_API_KEY is set in .env`);
  }

  let judge = null;
  try { judge = resolveJudge(args.judge); } catch (err) { fail(err.message); }

  // Gates (--gate <spec>, --gates <file>) are read before the run so a bad spec fails fast, and
  // evaluated once the run is saved — with an exit code, so a checkpoint can fail CI.
  let gateSpec = null;
  if (args.gate?.length || args.gates) {
    try { gateSpec = gatesFromArgs(args, gateNames(allTasks), { fallbackMinTrials: count }); } catch (err) { fail(err.message); }
  }
  const capabilitiesOfAll = Object.fromEntries(allTasks.map((t) => [t.name, t.capabilities ?? []]));
  const levelsOfAll = Object.fromEntries(allTasks.filter((t) => t.family).map((t) => [t.name, { family: t.family, level: t.level }]));

  // A time box (--time-box <minutes>): when it is up, no more trials start, the ones in flight are
  // cancelled, and what completed is saved (status "timeout") and gated like any run.
  const controller = new AbortController();
  const timeBoxMs = Number.isFinite(args.timeBox) && args.timeBox > 0 ? Math.round(args.timeBox * 60_000) : null;
  let timeBoxHit = false;
  const timer = timeBoxMs ? setTimeout(() => { timeBoxHit = true; controller.abort(); }, timeBoxMs) : null;

  const quiet = !!args.json;
  const plan = planMatrix({ tasks: taskList, modes: modeList, clients, count });
  if (!quiet) {
    for (const note of describeSkipped(plan.skipped)) console.log(`skip  ${note}`);
    if (!plan.total) fail("nothing to run — no selected task declares any of the selected modes");
  }

  // OpenAI's chat route refuses a temperature other than the default on its reasoning models, and
  // function tools with any reasoning_effort but "none"; say so before the rows do.
  if (clients.some((c) => (c.provider === "openai" || String(c.name).startsWith("openai:")) && (c.effort || modelParams.effort)) && modelParams.temperature !== undefined) {
    console.error("note: OpenAI's reasoning models refuse a temperature with reasoning_effort (and function tools with any effort but none); those rows will carry the refusal");
  }
  const thermalStart = thermalState();
  const { rows, summary, skipped, instanceSeed } = await runMatrix({
    sampleEnv: sampleEnvironment,
    pricing: pricingFor(),
    tasks: taskList,
    modes: modeList,
    clients,
    count,
    parallel,
    instanceSeed: Number.isInteger(args.instanceSeed) ? args.instanceSeed : null,
    judge,
    signal: controller.signal,
    onEvent: quiet ? undefined : (ev) => {
      if (ev.type !== "trial") return;
      const r = ev.result;
      const mark = r.correct ? "PASS" : "FAIL";
      console.log(
        `${mark}  ${r.task.padEnd(8)} ${r.mode.padEnd(10)} ${r.model.padEnd(22)} #${r.index}  ${String(r.latencyMs).padStart(6)}ms  ${r.reason}`,
      );
      if (r.error) console.log(`      error: ${r.error}`);
      else if (!r.correct) console.log(`      answer: ${preview(isStructuredMode(r.mode) ? r.structured ?? r.answerText : r.answerText)}`);
    },
  });

  if (timer) clearTimeout(timer);
  const completed = rows.filter((r) => !(r.error && r.reason === "cancelled")).length;
  const run = {
    id: newRunId(),
    createdAt: rows[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: timeBoxHit ? "timeout" : "done",
    source: "cli",
    parent: parentRun ? { id: parentRun.id, kind: "replay" } : null,
    config: {
      tasks: taskList.map((t) => t.name),
      modes: modeList,
      clients: clients.map((c) => c.name),
      count,
      parallel,
      instanceSeed,
      modelParams,
      judge: judge?.name ?? null,
      suite: process.env.BENCH_SUITE ?? null,
      timeBoxMs,
      lineage: lineageOf(clients.map((c) => c.name)),
      endpoints: endpointsFor(clients.map((c) => c.name)),
    },
    versions: benchVersions(),
    env: thermalStart ? { thermal: { start: thermalStart, end: thermalState() } } : null,
    warnings: [...describeSkipped(skipped), ...(timeBoxHit ? [`time box of ${args.timeBox} min reached: ${completed} of ${plan.total} trials completed`] : [])],
    progress: { completed: rows.length, total: rows.length },
    summary,
    rows,
  };

  if (!args.noSave) saveRun(run);

  // Gates read the saved run (the regressions gate needs it in the index) and set the exit code.
  if (gateSpec) {
    run.gates = await gateRun(run, { ...gateSpec, capabilitiesOf: capabilitiesOfAll, levelsOf: levelsOfAll });
    if (!args.noSave) saveRun(run);
    process.exitCode = run.gates.exitCode;
  }

  if (args.json) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  console.log("");
  for (const mode of summary.modes) {
    const s = summary.byMode[mode];
    const args = s.toolArgsJudged ? `  args ok ${s.toolArgsOkPct.toFixed(0)}%` : "";
    console.log(`[${mode}] ${s.correct}/${s.runs} correct (${s.correctPct.toFixed(1)}%)  schema ${s.schemaValidPct.toFixed(0)}%  tools ${s.toolUsePct.toFixed(0)}%${args}  ${s.avgLatencyMs}ms avg · p95 ${s.latencyP95Ms}ms`);
  }
  const d = summary.delta.overall;
  if (d) {
    console.log(`\nharness delta: ${d.noHarnessPct.toFixed(1)}% -> ${d.harnessPct.toFixed(1)}% (${d.deltaPp >= 0 ? "+" : ""}${d.deltaPp.toFixed(1)}pp)  [${describeSignificance(d)}]`);
  }
  if (!args.noSave) console.log(`\nsaved: results/runs/${run.id}.json`);
  if (timeBoxHit) console.log(`\ntime box: ${args.timeBox} min reached — ${completed} of ${plan.total} trials completed; the run is saved as "timeout"`);
  if (parentRun) console.log(`\n${describeReplay(parentRun, run)}`);
  if (run.gates) console.log(`\n${describeRunGates(run.gates)}`);
}

function preview(value, max = 200) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return "(empty)";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Only run the CLI when invoked directly, not when imported by aggregate.js or the web server.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => fail(err.message));
}
