// report.js — print a run summary the same way everywhere (aggregate.js after a run, `cli show`
// for a saved one). Pure formatting over the runner's summary shape.

import { describeSignificance } from "./runner.js";

const fmtDelta = (d) => d
  ? `${d.noHarnessPct.toFixed(1)}% -> ${d.harnessPct.toFixed(1)}% (${d.deltaPp >= 0 ? "+" : ""}${d.deltaPp.toFixed(1)}pp)  [${describeSignificance(d)}]`
  : describeSignificance(null);

export function printSummary(summary, { log = console.log } = {}) {
  for (const mode of summary.modes) {
    const s = summary.byMode[mode];
    log(`-- mode: ${mode}`);
    log(`   correct:      ${s.correct}/${s.runs} (${s.correctPct.toFixed(1)}%)`);
    log(`   schemaValid:  ${s.schemaValidPct.toFixed(1)}%`);
    log(`   toolCalls:    ${s.toolUsePct.toFixed(1)}%`);
    log(`   toolArgsOk:   ${s.toolArgsJudged ? `${s.toolArgsOkPct.toFixed(1)}% of ${s.toolArgsJudged} judged` : "n/a"}`);
    log(`   errors:       ${s.errorPct.toFixed(1)}%`);
    log(`   latency:      avg ${s.avgLatencyMs}ms · p50 ${s.latencyP50Ms}ms · p95 ${s.latencyP95Ms}ms · max ${s.latencyMaxMs}ms`);
  }

  log("\n-- per task x mode x client");
  for (const cell of summary.cells) {
    log(`   ${cell.task.padEnd(8)} ${cell.mode.padEnd(10)} ${cell.client.padEnd(28)} ${cell.correct}/${cell.runs} (${cell.correctPct.toFixed(0)}%)  ${cell.avgLatencyMs}ms`);
  }

  log("\n-- harness delta (correctness)");
  log(`   overall:      ${fmtDelta(summary.delta.overall)}`);
  for (const [task, d] of Object.entries(summary.delta.byTask)) log(`   ${task.padEnd(13)} ${fmtDelta(d)}`);
  for (const [client, d] of Object.entries(summary.delta.byClient)) log(`   ${client.padEnd(13)} ${fmtDelta(d)}`);

  const cells = Object.entries(summary.delta.byTaskClient ?? {});
  if (cells.length > 1) {
    log("\n-- harness delta per task x client");
    for (const [key, d] of cells) {
      const [task, client] = key.split("|");
      log(`   ${task.padEnd(8)} ${client.padEnd(28)} ${fmtDelta(d)}`);
    }
  }
}

// A compact task × mode table (counts), handy for pasting into notes.
export function summaryTable(summary) {
  const modes = summary.modes;
  const head = `| task | ${modes.join(" | ")} |`;
  const sep = `|---|${modes.map(() => "---").join("|")}|`;
  const rows = summary.tasks.map((task) => {
    const cells = modes.map((mode) => {
      const sub = summary.cells.filter((c) => c.task === task && c.mode === mode);
      const runs = sub.reduce((a, c) => a + c.runs, 0);
      const correct = sub.reduce((a, c) => a + c.correct, 0);
      return runs ? `${correct}/${runs}` : "—";
    });
    return `| ${task} | ${cells.join(" | ")} |`;
  });
  const totals = modes.map((m) => `${summary.byMode[m].correct}/${summary.byMode[m].runs}`);
  return [head, sep, ...rows, `| **all** | ${totals.map((t) => `**${t}**`).join(" | ")} |`].join("\n");
}
