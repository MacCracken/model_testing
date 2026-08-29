#!/usr/bin/env node
// cli.js — entry point. Select providers/tasks/modes and dispatch.
//
// Examples:
//   node src/cli.js bench --task health --mode harness --clients openai:gpt-4o-mini
//   node src/cli.js aggregate --tasks health,hello --modes noHarness,harness
//   node src/cli.js list

import { listTasks } from "./tasks/registry.js";
import { PROVIDERS } from "./providers/index.js";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      console.log("Tasks:");
      for (const t of listTasks()) console.log(`  ${t.name} (${t.category})`);
      console.log("\nProviders:");
      for (const [name, cfg] of Object.entries(PROVIDERS)) {
        console.log(`  ${name}: ${cfg.models.join(", ")}`);
      }
      break;

    case "bench":
    case "run": {
      const { runBenchTask, resolveClients } = await import("./bench.js");
      const args = parseArgs(rest);
      const { getTask, tasks } = await import("./tasks/registry.js");
      const client = resolveClients(args.clients);
      if (!client) throw new Error(`no API key for provider=${args.provider} model=${args.model}`);
      const modeList = Array.isArray(args.mode)
        ? args.mode
        : String(args.mode).split(",").map((s) => s.trim()).filter(Boolean);
      if (modeList.length === 0) modeList = ["noHarness"];
      const taskList = args.task === "all"
        ? tasks
        : (Array.isArray(args.task) ? args.task : [getTask(args.task)]);
      for (const t of taskList) {
        for (const m of modeList) {
          const r = await runBenchTask({ task: t, mode: m, client, count: args.count });
          for (const res of r) {
            const mark = res.correct ? "PASS" : "FAIL";
            console.log(`${mark} ${t.name} [${m}] #${res.index}  ${res.model}  ${res.latencyMs}ms  ${res.reason}`);
            if (!res.correct) console.log(`     ${res.answerText}`);
            if (res.error) console.log(`     ${res.error}`);
          }
        }
      }
      break;
    }

    case "aggregate":
    case "report": {
      const { main: aggMain } = await import("./aggregate.js");
      await aggMain();
      break;
    }

    default:
      console.log("Usage:");
      console.log("  node src/cli.js list");
      console.log("  node src/cli.js bench --task <name|all> --mode noHarness|harness --clients <p:model,...>");
      console.log("  node src/cli.js aggregate --tasks <name,...> --modes noHarness,harness --clients <p:model,...>");
      process.exit(1);
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--task": case "--tasks": args.task = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--mode": case "--modes": args.mode = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--clients": args.clients = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--provider": args.provider = next(); break;
      case "--model": args.model = next(); break;
      case "--count": args.count = Number(next()); break;
      default: args._.push(a);
    }
  }
  return args;
}

main().catch((err) => {
  console.error("cli error:", err.message);
  process.exit(1);
});
