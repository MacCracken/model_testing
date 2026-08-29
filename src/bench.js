// bench.js — run tasks in one or more modes against one or more clients, score, and record.
//
// Usage:
//   node src/bench.js --task health --mode harness --clients openai:gpt-4o-mini
//   node src/bench.js --task all --modes noHarness,harness --clients local:ornith-1.5:9b --count 3
//   node src/bench.js --task hello --clients local            # every local model
//
// Every run is saved under results/runs/ (so the web UI can review it too); --json also prints
// the rows to stdout, --no-save skips persistence.

import { getTask, tasks as allTasks } from "./tasks/registry.js";
import { resolveClients } from "./providers/index.js";
import { runMatrix, runTrial, MODES } from "./runner.js";
import { newRunId, saveRun } from "./results.js";
import { parseArgs } from "./args.js";

function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

/** Back-compat wrapper: run one task in one mode `count` times. */
export async function runBenchTask({ task, mode, client, count = 1, signal }) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(await runTrial({ task, mode, client, index: i + 1, signal }));
  }
  return results;
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
  if (!spec) return [...MODES];
  const modes = (Array.isArray(spec) ? spec : String(spec).split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!modes.length) return [...MODES];
  for (const m of modes) {
    if (!MODES.includes(m)) throw new Error(`--mode must be one of ${MODES.join(", ")}, got "${m}"`);
  }
  return modes;
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
  const clients = args.clients
    ? resolveClients(args.clients)
    : resolveClients([{ provider: args.provider ?? "openai", model: args.model ?? "gpt-4o-mini" }]);
  if (!clients.length) {
    fail(`no client resolved — check the model name and that ${(args.provider ?? "the provider").toUpperCase()}_API_KEY is set in .env`);
  }

  const quiet = !!args.json;
  const { rows, summary } = await runMatrix({
    tasks: taskList,
    modes: modeList,
    clients,
    count,
    onEvent: quiet ? undefined : (ev) => {
      if (ev.type !== "trial") return;
      const r = ev.result;
      const mark = r.correct ? "PASS" : "FAIL";
      console.log(
        `${mark}  ${r.task.padEnd(8)} ${r.mode.padEnd(9)} ${r.model.padEnd(22)} #${r.index}  ${String(r.latencyMs).padStart(6)}ms  ${r.reason}`,
      );
      if (r.error) console.log(`      error: ${r.error}`);
      else if (!r.correct) console.log(`      answer: ${preview(r.mode === "harness" ? r.structured ?? r.answerText : r.answerText)}`);
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
    },
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
    console.log(`[${mode}] ${s.correct}/${s.runs} correct (${s.correctPct.toFixed(1)}%)  schema ${s.schemaValidPct.toFixed(0)}%  tools ${s.toolUsePct.toFixed(0)}%  ${s.avgLatencyMs}ms avg`);
  }
  const d = summary.delta.overall;
  if (d) console.log(`\nharness delta: ${d.noHarnessPct.toFixed(1)}% -> ${d.harnessPct.toFixed(1)}% (${d.deltaPp >= 0 ? "+" : ""}${d.deltaPp.toFixed(1)}pp)`);
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

export { resolveClients };
