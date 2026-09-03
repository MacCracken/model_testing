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
import { resolveTasks, resolveModes, describeSkipped } from "./bench.js";
import { runMatrix, planMatrix, describeSignificance } from "./runner.js";
import { newRunId, saveRun } from "./results.js";
import { parseArgs } from "./args.js";

export async function main() {
  const args = parseArgs(process.argv.slice(2));

  const taskList = resolveTasks(args.task);
  const modeList = resolveModes(args.mode);
  const count = args.count ?? 1;

  const clients = resolveClients(args.clients);
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

  for (const mode of summary.modes) {
    const s = summary.byMode[mode];
    console.log(`-- mode: ${mode}`);
    console.log(`   correct:      ${s.correct}/${s.runs} (${s.correctPct.toFixed(1)}%)`);
    console.log(`   schemaValid:  ${s.schemaValidPct.toFixed(1)}%`);
    console.log(`   toolCalls:    ${s.toolUsePct.toFixed(1)}%`);
    console.log(`   errors:       ${s.errorPct.toFixed(1)}%`);
    console.log(`   avgLatency:   ${s.avgLatencyMs}ms`);
  }

  console.log("\n-- per task x mode x client");
  for (const cell of summary.cells) {
    console.log(`   ${cell.task.padEnd(8)} ${cell.mode.padEnd(10)} ${cell.client.padEnd(28)} ${cell.correct}/${cell.runs} (${cell.correctPct.toFixed(0)}%)  ${cell.avgLatencyMs}ms`);
  }

  // A delta needs both noHarness and harness rows; describeSignificance says so when one is missing.
  const fmt = (d) => d
    ? `${d.noHarnessPct.toFixed(1)}% -> ${d.harnessPct.toFixed(1)}% (${d.deltaPp >= 0 ? "+" : ""}${d.deltaPp.toFixed(1)}pp)  [${describeSignificance(d)}]`
    : describeSignificance(null);

  console.log("\n-- harness delta (correctness)");
  console.log(`   overall:      ${fmt(summary.delta.overall)}`);
  for (const [task, d] of Object.entries(summary.delta.byTask)) {
    console.log(`   ${task.padEnd(13)} ${fmt(d)}`);
  }
  for (const [client, d] of Object.entries(summary.delta.byClient)) {
    console.log(`   ${client.padEnd(13)} ${fmt(d)}`);
  }

  const run = {
    id: newRunId(),
    createdAt: rows[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "done",
    source: "aggregate",
    config: { tasks: taskList.map((t) => t.name), modes: modeList, clients: clients.map((c) => c.name), count },
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
