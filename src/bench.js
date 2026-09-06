// bench.js — run tasks in one or more modes against one or more clients, score, and record.
//
// Usage:
//   node src/bench.js --task health --mode harness --clients openai:gpt-4o-mini
//   node src/bench.js --task all --modes noHarness,harness --clients local:ornith-1.5:9b --count 3
//   node src/bench.js --task hello --clients local            # every local model
//
// Every run is saved under results/runs/ (so the web UI can review it too); --json also prints
// the rows to stdout, --no-save skips persistence.

import "./env.js";
import "./store.js";
import { getTask, tasks as allTasks } from "./tasks/registry.js";
import { resolveClients } from "./providers/index.js";
import { runMatrix, planMatrix, isStructuredMode, describeSignificance, MODE_NAMES, DEFAULT_MODES } from "./runner.js";
import { newRunId, saveRun } from "./results.js";
import { parseArgs } from "./args.js";
import { benchVersions } from "./version.js";
import { makeJudge } from "./judge.js";
import { envValue } from "./util.js";

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
export function modelParamsFrom({ temperature, seed, modelParam } = {}) {
  const params = {};
  if (Number.isFinite(temperature)) params.temperature = temperature;
  if (Number.isFinite(seed)) params.seed = seed;
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
    ? `${s.task}/${s.mode} skipped for ${s.client}: a harness arm runs structured modes only`
    : `${s.task}/${s.mode} skipped: the task declares no ${s.mode} spec`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let taskList, modeList;
  try {
    taskList = resolveTasks(args.task);
    modeList = resolveModes(args.mode);
  } catch (err) {
    fail(err.message);
  }

  const count = args.count ?? 1;

  // --clients takes precedence over --provider/--model.
  const modelParams = modelParamsFrom(args);
  const clients = args.clients
    ? resolveClients(args.clients, { modelParams })
    : resolveClients([{ provider: args.provider ?? "openai", model: args.model ?? "gpt-4o-mini" }], { modelParams });
  if (!clients.length) {
    fail(`no client resolved — check the model name and that ${(args.provider ?? "the provider").toUpperCase()}_API_KEY is set in .env`);
  }

  let judge = null;
  try { judge = resolveJudge(args.judge); } catch (err) { fail(err.message); }

  const quiet = !!args.json;
  const plan = planMatrix({ tasks: taskList, modes: modeList, clients, count });
  if (!quiet) {
    for (const note of describeSkipped(plan.skipped)) console.log(`skip  ${note}`);
    if (!plan.total) fail("nothing to run — no selected task declares any of the selected modes");
  }

  const { rows, summary, skipped } = await runMatrix({
    tasks: taskList,
    modes: modeList,
    clients,
    count,
    judge,
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

  const run = {
    id: newRunId(),
    createdAt: rows[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "done",
    source: "cli",
    config: {
      tasks: taskList.map((t) => t.name),
      modes: modeList,
      clients: clients.map((c) => c.name),
      count,
      modelParams,
      judge: judge?.name ?? null,
    },
    versions: benchVersions(),
    warnings: describeSkipped(skipped),
    progress: { completed: rows.length, total: rows.length },
    summary,
    rows,
  };

  if (!args.noSave) saveRun(run);

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
