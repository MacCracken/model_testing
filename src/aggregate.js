// aggregate.js — run the full task x mode x client matrix and print comparative results.
//
// Usage:
//   node src/aggregate.js                         # all tasks x [noHarness, harness] x every configured client
//   node src/aggregate.js --task hello --clients local --modes harness
//   node src/aggregate.js --tasks hello,health --clients local --modes harness
//
// Prints per-mode/per-task/per-model breakdowns and the harness delta.

import { resolveClients } from "./providers/index.js";
import { parseArgs } from "./args.js";
import { mean, pct } from "./util.js";

function fail(msg) {
    console.error(JSON.stringify({ ok: false, error: msg }));
    process.exit(1);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    console.log("DEBUG aggregate args:", JSON.stringify(args, null, 2));

     // Handle task name - use "all" as default when not specified
    let taskName = args.task ?? "all";
    const count = args.count ?? 1;

        // Normalize task names: split comma-separated values into array
    let taskNamesArray;
    if (typeof taskName === 'string') {
        taskNamesArray = String(taskName).split(",").map((s) => s.trim()).filter(Boolean);
        console.log("DEBUG parsed taskNamesArray:", JSON.stringify(taskNamesArray));
      } else if (Array.isArray(taskName)) {
        taskNamesArray = taskName;
       } else {
        taskNamesArray = ["all"];
     }

    // Handle modes - use default ["noHarness", "harness"] if not specified
    let modeList;
    if (args.mode) {
         // Normalize mode argument: accept comma-separated string or array
        modeList = Array.isArray(args.mode) ? args.mode : String(args.mode).split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        modeList = ["noHarness", "harness"];
      }

    // Import the tasks registry now that we've parsed args
    const { getTask, tasks: allTasks } = await import("./tasks/registry.js");
    console.log("DEBUG loaded task names:", JSON.stringify(allTasks.map(t => t.name)));

     // Resolve task list based on how taskName was specified
    let taskList;
    if (args.task === undefined) {
       // No --task flag at all -> use all tasks
        taskList = allTasks;
     } else if (Array.isArray(taskNamesArray)) {
         // Array of names from comma-split string like "hello,health"
        taskList = [];
        for (const name of taskNamesArray) {
            console.log("DEBUG getting task:", name);
            try {
                const t = getTask(name);
                taskList.push(t);
                 console.log("DEBUG loaded:", t.name);
              } catch (err) {
               console.error("ERROR: unknown task:", name, err.message);
             }
         }
     } else if (typeof taskName === 'string') {
       // Single string name that's not "all"
        try {
            const t = getTask(taskName);
            taskList = [t];
            console.log("DEBUG loaded single task:", taskName);
         } catch (err) {
             console.error("ERROR: unknown task:", taskName, err.message);
             process.exit(1);
          }
      } else {
       // Fallback for undefined/null/other cases
        console.warn("WARNING: couldn't resolve tasks from input");
       }

    if (!taskList.length) {
        console.log("no tasks could be resolved");
        process.exit(0);
     }

     // Resolve clients - handles bare provider names like "local" that expand to default models
    const clients = resolveClients(args.clients);
    if (!clients.length) {
        console.error("no clients configured — set *_API_KEY in .env or pass --clients");
        process.exit(1);
     }

    const rows = [];
    for (const t of taskList) {
        for (const m of modeList) {
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

      // Overall stats by mode
    const modes = [...new Set(rows.map((r) => r.mode))];
    for (const m of modes) {
        const rowsM = rows.filter((r) => r.mode === m);
        const correct = rowsM.filter((r) => r.correct).length;
        const toolUsed = pct(rowsM, (r) => r.toolCalls?.length > 0);
        const schemaValid = pct(rowsM, (r) => r.schemaValid);
        const avgLat = mean(rowsM.map((r) => r.latencyMs));
        console.log(`-- mode: ${m}`);
        console.log(`   correct:           ${correct}/${rowsM.length} (${pct(rowsM, (r) => r.correct).toFixed(1)}%)`);
        console.log(`   schemaValid:       ${schemaValid.toFixed(1)}%`);
        console.log(`   toolCalls:         ${toolUsed.toFixed(1)}%`);
        console.log(`   avgLatency:        ${avgLat.toFixed(0)}ms`);
      }

     // Per-task, per-model breakdown
    console.log("\n-- per task x mode x model");
    for (const t of taskList) {
        for (const m of modes) {
            const rowsTM = rows.filter((r) => r.task === t.name && r.mode === m);
            if (!rowsTM.length) continue;

            const label = t.model(m);
            const line = rowsTM.map((r) => `${t.model(m)}: ${r.correct ? "PASS" : "FAIL"} (${pct([r], (x) => x.correct).toFixed(0)}%)`).join("       ");
            console.log(`\n[${t.name}] ${m}`);
            console.log(`      ${line}`);
        }
    }

     // Harness delta comparison
    const noH = rows.filter((r) => r.mode === "noHarness");
    const withH = rows.filter((r) => r.mode === "harness");
    console.log("\n-- harness delta");

    const diff = (a, b) => {
        if (!b.length) return "n/a";
        const aCorrect = pct(a, (r) => !!r.correct);
        const bCorrect = pct(b, (r) => !!r.correct);
        return `${aCorrect.toFixed(1)}% -> ${bCorrect.toFixed(1)}% (+${(bCorrect - aCorrect).toFixed(1)}pp)`;
      };

    console.log(`   correctness:       ${diff(noH, withH)}`);
    console.log(`   toolUsed:          ${pct(noH, (r) => !!r.toolCalls?.length).toFixed(1)}% -> ${pct(withH, (r) => !!r.toolCalls?.length).toFixed(1)}%`);
    console.log(`   schemaValid:       ${pct(noH, (r) => !!r.schemaValid).toFixed(1)}% -> ${pct(withH, (r) => !!r.schemaValid).toFixed(1)}%`);
}

main().catch((err) => {
    console.error("aggregate failed:", err.message);
    process.exit(1);
});
