#!/usr/bin/env node
// cli.js — entry point. Select providers/tasks/modes and dispatch.
//
// Examples:
//   node src/cli.js list
//   node src/cli.js serve --port 4000
//   node src/cli.js bench --task health --mode harness --clients openai:gpt-4o-mini
//   node src/cli.js aggregate --tasks health,hello --modes noHarness,harness

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { listTasks } from "./tasks/registry.js";
import { PROVIDERS, apiKeyFor, labelModel, probeLocalModels } from "./providers/index.js";
import { parseArgs } from "./args.js";

const SRC = dirname(fileURLToPath(import.meta.url));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "list": {
      console.log("Tasks:");
      for (const t of listTasks()) {
        console.log(`  ${t.name.padEnd(10)} ${t.category.padEnd(10)} ${t.description}`);
      }
      const live = await probeLocalModels();
      console.log("\nProviders:");
      for (const [name, cfg] of Object.entries(PROVIDERS)) {
        const models = name === "local" && live ? live : cfg.models;
        const status = apiKeyFor(name) ? "key set" : `${name.toUpperCase()}_API_KEY missing`;
        console.log(`  ${name.padEnd(10)} [${status}]`);
        for (const m of models) console.log(`    ${name}:${m.padEnd(30)} ${labelModel(m)}`);
      }
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
      console.log("  node src/cli.js serve [--port 4000] [--host 127.0.0.1] [--open]");
      console.log("  node src/cli.js bench --task <name|all> --modes noHarness,harness --clients <p:model,...> [--count N] [--json]");
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
