#!/usr/bin/env node
// cli.js — entry point. Select providers/tasks/modes and dispatch.
//
// Examples:
//   node src/cli.js list
//   node src/cli.js serve --port 4000
//   node src/cli.js bench --task health --mode harness --clients openai:gpt-4o-mini
//   node src/cli.js aggregate --tasks health,hello --modes noHarness,harness

import "./env.js";
import "./store.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { listTasks } from "./tasks/registry.js";
import { PROVIDERS, hasCredentials, labelModel, probeLocalModels } from "./providers/index.js";
import { parseArgs } from "./args.js";
import { listRuns, loadRun } from "./results.js";
import { summarize } from "./runner.js";
import { printSummary, summaryTable } from "./report.js";
import { rowsToCsv, cellsToCsv } from "./export.js";
import { writeFileSync } from "node:fs";

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
        if (cfg.harness && name !== "local") { /* the arm's model is whatever it routes to */ }
        const status = cfg.harness
          ? `harness arm · ${cfg.baseUrl}${cfg.keyEnv ? (hasCredentials(name) ? ` · ${cfg.keyEnv} set` : ` · ${cfg.keyEnv} missing`) : ""}`
          : cfg.needsKey === false
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

    // The SQLite index over results/runs: rebuild it, ask it questions, or compact old files.
    case "index": {
      const args = parseArgs(rest);
      const { indexRuns } = await import("./store.js");
      const r = indexRuns({ full: !!args.full });
      console.log(`indexed ${r.indexed}, unchanged ${r.skipped}, removed ${r.removed} → ${r.path}`);
      break;
    }

    case "query": {
      const args = parseArgs(rest);
      const { indexRuns, queryRuns, trend, cellHistory, worstCells, rawQuery } = await import("./store.js");
      indexRuns();
      const what = args._[0];
      const table = (rows) => { if (!rows.length) { console.log("(no rows)"); return; } console.table(rows); };
      if (args.sql) { table(rawQuery(args.sql)); break; }
      if (what === "runs") {
        for (const r of queryRuns({ q: args.q, task: args.task, client: args.client, mode: args.mode, since: args.since, limit: args.limit })) {
          console.log(`${r.id}  ${String(r.status).padEnd(9)} ${String(r.source).padEnd(9)} ${r.config.clients.join(",").padEnd(30)} ${r.config.tasks.join(",")} × ${r.config.modes.join(",")} × ${r.config.count}  (${r.rowCount} rows)${r.compacted ? "  compacted" : ""}`);
        }
      } else if (what === "trend") {
        if (!args.task || !args.client) { console.error("usage: query trend --task <name> --client <provider:model> [--mode harness]"); process.exit(1); }
        table(trend({ task: args.task, client: args.client, mode: args.mode ?? "harness" }));
      } else if (what === "cell") {
        if (!args.task || !args.client) { console.error("usage: query cell --task <name> --client <provider:model> [--mode harness]"); process.exit(1); }
        const c = cellHistory({ task: args.task, client: args.client, mode: args.mode ?? "harness" });
        console.log(`${c.task} · ${c.client} · ${c.mode}: ${c.correct}/${c.trials} correct across ${c.runs} run(s)${c.correctPct === null ? "" : ` (${c.correctPct.toFixed(1)}%)`}${c.first ? `, ${c.first.slice(0, 10)} → ${c.last.slice(0, 10)}` : ""}`);
        table(c.history);
      } else if (what === "worst") {
        table(worstCells({ mode: args.mode ?? "harness", limit: args.limit ?? 10 }));
      } else {
        console.error("usage: node src/cli.js query runs|trend|cell|worst [--task] [--client] [--mode] [--q] [--since] [--limit] | --sql \"select …\"");
        process.exit(1);
      }
      break;
    }

    case "compact": {
      const args = parseArgs(rest);
      const { compactRuns } = await import("./store.js");
      const r = compactRuns({ olderThanDays: args.olderThan, apply: !!args.yes });
      for (const f of r.files) console.log(`${f.applied ? "compacted" : "would compact"}  ${f.id}  ${(f.bytesBefore / 1024).toFixed(0)} KB → ${(f.bytesAfter / 1024).toFixed(0)} KB`);
      console.log(`${r.files.length} run(s) older than ${r.cutoff.slice(0, 10)}; ${r.apply ? "saved" : "would save"} ${(r.savedBytes / 1024).toFixed(0)} KB${r.apply ? "" : " — add --yes to apply"}`);
      break;
    }

    // CSV export of a saved run: trial rows by default, --cells for the task × model × mode cells.
    case "export": {
      const args = parseArgs(rest);
      const id = args._[0];
      if (!id) { console.error("usage: node src/cli.js export <run-id> [--cells] [--out file.csv]"); process.exit(1); }
      const run = loadRun(id);
      if (!run) { console.error(`unknown run: ${id}`); process.exit(1); }
      const body = args.cells ? cellsToCsv(run.id, summarize(run.rows)) : rowsToCsv(run);
      if (args.out) { writeFileSync(args.out, body); console.log(`wrote ${args.out}`); }
      else process.stdout.write(body);
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
      console.log("  node src/cli.js export <run-id> [--cells] [--out file.csv]");
      console.log("  node src/cli.js index [--full]                        # rebuild the SQLite index over results/runs");
      console.log("  node src/cli.js query runs|trend|cell|worst [...]    # cross-run questions (or --sql)");
      console.log("  node src/cli.js compact --older-than <days> [--yes]  # strip prompts/transcripts from old runs");
      console.log("  node src/cli.js serve [--port 4000] [--host 127.0.0.1] [--open]");
      console.log("  node src/cli.js bench --task <name|all> --modes noHarness,harness,schemaOnly,toolOnly --clients <p:model,...> [--count N] [--temperature T] [--seed S] [--model-param k=v]... [--json]");
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
