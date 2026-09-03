#!/usr/bin/env node
// cli.js — entry point. Select providers/tasks/modes and dispatch.
//
// Examples:
//   node src/cli.js list
//   node src/cli.js serve --port 4000
//   node src/cli.js bench --task health --mode harness --clients openai:gpt-4o-mini
//   node src/cli.js aggregate --tasks health,hello --modes noHarness,harness

import "./env.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { listTasks } from "./tasks/registry.js";
import { PROVIDERS, hasCredentials, labelModel, probeLocalModels } from "./providers/index.js";
import { parseArgs } from "./args.js";
import { listRuns, loadRun } from "./results.js";
import { summarize } from "./runner.js";
import { printSummary, summaryTable } from "./report.js";

const SRC = dirname(fileURLToPath(import.meta.url));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "list": {
      console.log("Tasks:");
      for (const t of listTasks()) {
        console.log(`  ${t.name.padEnd(10)} ${t.category.padEnd(15)} modes: ${t.modes.join(",").padEnd(30)} ${t.description}`);
      }
      const live = await probeLocalModels();
      console.log("\nProviders:");
      for (const [name, cfg] of Object.entries(PROVIDERS)) {
        const models = name === "local" && live ? live : cfg.models;
        const status = cfg.needsKey === false
          ? (live ? `live, ${live.length} model(s)` : "offline — showing the fallback list")
          : (hasCredentials(name) ? "key set" : `${name.toUpperCase()}_API_KEY missing`);
        console.log(`  ${name.padEnd(10)} [${status}]`);
        for (const m of models) console.log(`    ${name}:${m.padEnd(30)} ${labelModel(m)}`);
      }
      break;
    }

    // Review a saved run without the UI: `show` lists recent runs, `show <id>` prints one.
    case "show": {
      const args = parseArgs(rest);
      const id = args._[0];
      if (!id) {
        for (const r of listRuns({ limit: 20 })) {
          console.log(`${r.id}  ${r.status.padEnd(9)} ${r.source.padEnd(9)} ${r.config.clients.join(",").padEnd(30)} ${r.config.tasks.join(",")} × ${r.config.modes.join(",")} × ${r.config.count}  (${r.rowCount} rows)`);
        }
        break;
      }
      const run = loadRun(id);
      if (!run) { console.error(`unknown run: ${id}`); process.exit(1); }
      console.log(`run ${run.id} · ${run.source} · ${run.status} · ${run.config.clients.join(", ")} · ${run.rows.length} rows`);
      for (const w of run.warnings ?? []) console.log(`warning: ${w}`);
      console.log("");
      // Summaries are recomputed from the rows, so a run saved before a scorer's *reporting* changed
      // still prints with today's aggregation; the verdicts themselves are whatever was recorded.
      const summary = summarize(run.rows);
      printSummary(summary);
      if (args.table) console.log(`\n${summaryTable(summary)}`);
      break;
    }

    case "serve":
    case "web": {
      const args = parseArgs(rest);
      const { serve } = await import("./web/server.js");
      const { url } = await serve({ port: args.port ?? 4000, host: args.host ?? "127.0.0.1" });
      if (args.open) spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      break;
    }

    // bench/aggregate own their own flag parsing; re-exec them with the remaining argv.
    case "bench":
    case "run":
      await runScript(join(SRC, "bench.js"), rest);
      break;

    case "aggregate":
    case "report":
      await runScript(join(SRC, "aggregate.js"), rest);
      break;

    default:
      console.log("Usage:");
      console.log("  node src/cli.js list");
      console.log("  node src/cli.js show [<run-id>] [--table]");
      console.log("  node src/cli.js serve [--port 4000] [--host 127.0.0.1] [--open]");
      console.log("  node src/cli.js bench --task <name|all> --modes noHarness,harness,schemaOnly,toolOnly --clients <p:model,...> [--count N] [--json]");
      console.log("  node src/cli.js aggregate [--tasks <name,...>] [--modes ...] [--clients ...] [--count N]");
      process.exit(cmd ? 1 : 0);
  }
}

function runScript(file, argv) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [file, ...argv], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : process.exit(code ?? 1)));
  });
}

main().catch((err) => {
  console.error("cli error:", err.message);
  process.exit(1);
});
