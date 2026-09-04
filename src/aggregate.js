// aggregate.js — run the full task x mode x client matrix and print comparative results.
//
// Usage:
//   node src/aggregate.js                                    # all tasks x both modes x every keyed client
//   node src/aggregate.js --tasks hello,health --clients local --modes harness
//   node src/aggregate.js --clients openai:gpt-4o-mini --count 3
//
// Prints per-mode and per-cell breakdowns plus the harness delta.

import "./env.js";
import { resolveClients } from "./providers/index.js";
import { resolveTasks, resolveModes, describeSkipped, modelParamsFrom, resolveJudge } from "./bench.js";
import { benchVersions } from "./version.js";
import { runMatrix, planMatrix } from "./runner.js";
import { printSummary } from "./report.js";
import { newRunId, saveRun } from "./results.js";
import { parseArgs } from "./args.js";

export async function main() {
  const args = parseArgs(process.argv.slice(2));

  const taskList = resolveTasks(args.task);
  const modeList = resolveModes(args.mode);
  const count = args.count ?? 1;

  const modelParams = modelParamsFrom(args);
  const clients = resolveClients(args.clients, { modelParams });
  const judge = resolveJudge(args.judge);
  if (!clients.length) {
    console.error("no clients configured — set *_API_KEY in .env or pass --clients");
    process.exit(1);
  }

  const plan = planMatrix({ tasks: taskList, modes: modeList, clients, count });
  for (const note of describeSkipped(plan.skipped)) console.log(`skip  ${note}`);
  const label = `${taskList.length} task(s) x ${modeList.length} mode(s) x ${clients.length} client(s) x ${count}`;
  console.log(`running ${label} = ${plan.total} trials\n`);

  const { rows, summary, skipped } = await runMatrix({
    tasks: taskList,
    modes: modeList,
    clients,
    count,
    judge,
    onEvent: (ev) => {
      if (ev.type !== "trial") return;
      const r = ev.result;
      const mark = r.correct ? "PASS" : "FAIL";
      console.log(`  [${String(ev.completed).padStart(3)}/${ev.total}] ${mark}  ${r.task.padEnd(8)} ${r.mode.padEnd(10)} ${r.model.padEnd(22)} ${String(r.latencyMs).padStart(6)}ms  ${r.reason}`);
    },
  });

  if (!rows.length) {
    console.log("no results — nothing ran.");
    process.exit(1);
  }

  console.log("\n=== Harness benchmark results ===\n");
  printSummary(summary);

  const run = {
    id: newRunId(),
    createdAt: rows[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "done",
    source: "aggregate",
    config: { tasks: taskList.map((t) => t.name), modes: modeList, clients: clients.map((c) => c.name), count, modelParams, judge: judge?.name ?? null },
    versions: benchVersions(),
    warnings: describeSkipped(skipped),
    progress: { completed: rows.length, total: rows.length },
    summary,
    rows,
  };
  if (!args.noSave) {
    saveRun(run);
    console.log(`\nsaved: results/runs/${run.id}.json`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("aggregate failed:", err.message);
    process.exit(1);
  });
}
