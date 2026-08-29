// aggregate.js — run the full task x mode x client matrix and print comparative results.
//
// Usage:
//   node src/aggregate.js            # all tasks x [noHarness, harness] x every configured client
//   node src/aggregate.js --tasks health --clients openai:gpt-4o-mini --modes harness
//
// Prints per-mode/per-task/per-model breakdowns and the harness delta.

import { resolveClients } from "./providers/index.js";
import { parseArgs } from "./args.js";
import { mean, pct } from "./util.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskName = args.task ?? "all";
  const count = args.count ?? 1;
  const taskNames = Array.isArray(taskName)
    ? taskName
    : String(taskName).split(",").map((s) => s.trim()).filter(Boolean);
  const modeList = Array.isArray(args.mode)
    ? args.mode
    : String(args.mode)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  if (modeList.length === 0) modeList = ["noHarness", "harness"];
  // Validate and normalize the requested modes before running.
  const mode = modeList.map((m) => {
    if (!["noHarness", "harness"].includes(m)) {
      fail(`--modes must be "noHarness" or "harness", got ${m}`);
    }
    return m;
  });

  const clients = resolveClients(args.clients);
  if (!clients.length) {
    console.error("no clients configured — set *_API_KEY in .env or pass --clients");
    process.exit(1);
  }

  const { getTask, tasks } = await import("./tasks/registry.js");
  const taskList = taskNames.length === 1
    ? [getTask(taskNames[0])]
    : tasks.filter((t) => taskNames.includes(t.name));

  const rows = [];
  for (const t of taskList) {
    for (const m of mode) {
      for (const client of clients) {

        const r = await import("./bench.js").then((b) => b.runBenchTask({ task: t, mode: m, client, count }));
        for (const res of r) rows.push(res);
      }
    }
  }

  if (!rows.length) {
    console.log("no results — all runs errored.");
    process.exit(1);
  }

  console.log("=== Harness benchmark results ===\n");

  // Overall
  const modes = [...new Set(rows.map((r) => r.mode))];
  for (const m of modes) {
    const rowsM = rows.filter((r) => r.mode === m);
    const correct = rowsM.filter((r) => r.correct).length;
    const toolUsed = pct(rowsM, (r) => r.toolCalls?.length > 0);
    const schemaValid = pct(rowsM, (r) => r.schemaValid);
    const avgLat = mean(rowsM.map((r) => r.latencyMs));
    console.log(`-- mode: ${m}`);
    console.log(`   correct:      ${correct}/${rowsM.length} (${pct(rowsM, (r) => r.correct).toFixed(1)}%)`);
    console.log(`   schemaValid:  ${schemaValid.toFixed(1)}%`);
    console.log(`   toolCalls:    ${toolUsed.toFixed(1)}%`);
    console.log(`   avgLatency:   ${avgLat.toFixed(0)}ms`);
  }

  console.log("\n-- per task x mode x model");
  for (const t of taskList) {
    for (const m of modes) {
      const rowsTM = rows.filter((r) => r.task === t.name && r.mode === m);
      const byModel = {};
      for (const r of rowsTM) {
        const c = r.correct ? 1 : 0;
        byModel[r.model] = (byModel[r.model] ?? 0) + c;
      }
      const label = t.model(r.model);
      const line = rowsTM
        .map((r) => `${label}: ${r.correct ? "PASS" : "FAIL"} (${pct([r], (x) => x.correct).toFixed(0)}%)`)
        .join("   ");
      console.log(`\n[${t.name}] ${m}`);
      console.log(`   ${line}`);
    }
  }

  // Harness delta
  const noH = rows.filter((r) => r.mode === "noHarness");
  const withH = rows.filter((r) => r.mode === "harness");
  console.log("\n-- harness delta");
  const diff = (a, b) => {
    if (!b.length) return "n/a";
    const aCorrect = pct(a, (r) => r.correct);
    const bCorrect = pct(b, (r) => r.correct);
    return `${aCorrect.toFixed(1)}% -> ${bCorrect.toFixed(1)}% (+${(bCorrect - aCorrect).toFixed(1)}pp)`;
  };
  console.log(`   correctness:  ${diff(noH, withH)}`);
  console.log(`   toolUsed:     ${pct(noH, (r) => r.toolCalls?.length > 0).toFixed(1)}% -> ${pct(withH, (r) => r.toolCalls?.length > 0).toFixed(1)}%`);
  console.log(`   schemaValid:  ${pct(noH, (r) => r.schemaValid).toFixed(1)}% -> ${pct(withH, (r) => r.schemaValid).toFixed(1)}%`);
}

main().catch((err) => {
  console.error("aggregate failed:", err.message);
  process.exit(1);
});
