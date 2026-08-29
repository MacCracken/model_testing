// bench.js — run one task in one mode against one client, score it, and record a result.
//
// Usage:
//   node src/bench.js --task health --mode harness --provider openai --model gpt-4o-mini
//   node src/bench.js --task health --mode noHarness --provider openai --model gpt-4o-mini
//   node src/bench.js --task hello --clients "local:ornith-1.5:9b"   (uses default modes)
//
// Exit code 0 on success, 1 on error (prints a JSON error to stdout).

import { getTask, tasks } from "./tasks/registry.js";
import { resolveClients } from "./providers/index.js";
import { parseArgs } from "./args.js";

function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

// Turn a model's final message content into an answer, according to extract mode.
async function extractAnswer(mode, resp) {
     // Harness mode: the structured tool result is what we score, not the model's prose wrap-up.
     // fall back to the model's final message if there was no tool result.
    const content = mode === "structured" && resp.structured !== undefined
       ? resp.structured
       : resp.text ?? "";

    if (mode === "structured") {
      // If resp.structured is already an object or array (the model returned structured output), use it directly.
      // Otherwise, try to parse the text as JSON.
      if (typeof content === "object" && content !== null) {
        return { value: content, schemaValid: true };
       }
      const parsed = tryParseJSON(content);
      if (parsed === null) return { value: null, schemaValid: false };
      return { value: parsed, schemaValid: true };
     }

    return { value: content, schemaValid: true };
}

function tryParseJSON(str) {
  if (typeof str !== "string") return null;
  const trimmed = str.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

export async function runBenchTask({ task, mode, client, count = 1 }) {
       // Tasks define optional `system`/`tools` on either mode; normalize defensively so a task
       // missing a system prompt (e.g. the no-harness `health` task) never crashes the runner.
      const spec = mode === "harness" ? task.harness : task.noHarness;

    const results = [];

    for (let i = 0; i < count; i++) {
      const start = performance.now();
      let resp, answer, score;
      try {
        if (mode === "harness") {
          resp = await client.runWithTools(spec.prompt, spec.tools, spec.system ?? "");
          answer = await extractAnswer("structured", resp);
         } else {
          resp = await client.chat([
            ...(spec.system ? [{ role: "system", content: spec.system }] : []),
            { role: "user", content: spec.prompt },
           ]);
          answer = await extractAnswer("text", resp);
         }

        const ground = await task.eval.ground();
        const scorer = mode === "harness" ? task.eval.scoreHarness : task.eval.scoreNoHarness;

        console.log(`DEBUG answer.value (structured):`, JSON.stringify(answer.value));
        score = await scorer(answer.value, ground);

        results.push({
          index: i + 1,
          mode,
          task: task.name,
          provider: client.name,
          model: client.model,
          latencyMs: Math.round(performance.now() - start),
          toolCalls: resp.toolCalls ?? [],
          finishReason: resp.finishReason,
          schemaValid: answer.schemaValid,
          answerText: String(answer.value),
          correct: score.correct,
          reason: score.reason,
          usage: resp.usage,
          error: null,
        });
      } catch (err) {
        console.error(`[bench] ${err.stack || err.message}`);
        results.push({
          index: i + 1,
          mode,
          task: task.name,
          provider: client.name,
          model: client.model,
          latencyMs: 0,
          answerText: null,
          reason: "exception",
          error: err.message,
          correct: false,
        });
      }
    }
    return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskName = args.task ?? "all";

       // --mode / --modes accepts a comma-separated list ("noHarness,harness"); normalize to an array.
    let modeList;
    if (args.mode === undefined) {
      modeList = ["noHarness", "harness"];
     } else if (Array.isArray(args.mode)) {
      modeList = args.mode;
     } else {
      modeList = String(args.mode).split(",").map((s) => s.trim()).filter(Boolean);
     }

       // If no mode was specified at all, use both modes for comparison; otherwise use what was requested
    const mode = modeList.length > 0 ? modeList : ["noHarness", "harness"];

    const count = args.count ?? 1;

       // --clients takes precedence over --provider/--model.
      let provider = args.provider ?? "openai";
      let model = args.model ?? "gpt-4o-mini";
      if (args.clients) {
        const clients = resolveClients(args.clients);
        if (!clients.length) fail(`no client for --clients=${args.clients}`);
        const [c] = clients;
        provider = c.provider ?? provider;
        model = c.model ?? model;
      }

      // Validate modes are only "noHarness" or "harness"
    if (Array.isArray(mode)) {
      for (const m of mode) {
        if (!["noHarness", "harness"].includes(m)) {
          fail(`--mode must be "noHarness" or "harness", got ${m}`);
         }
       }
     } else if (!["noHarness", "harness"].includes(mode)) {
      fail(`--mode must be "noHarness" or "harness", got ${mode}`);
     }

    const client = resolveClients([provider, model])[0];
    if (!client) fail(`no client for provider=${provider} model=${model}`);

    const taskList = taskName === "all" ? tasks : [getTask(taskName)];

    for (const m of mode) {
      const all = [];
      if (args.json) {
        for (const t of taskList) {
          const r = await runBenchTask({ task: t, mode: m, client, count });
          all.push(...r);
         }
        console.log(JSON.stringify(all, null, 2));
      } else {
        for (const t of taskList) {
          console.log(`\n=== ${t.name} [${m}] ${client.name} ===`);
          const r = await runBenchTask({ task: t, mode: m, client, count });
          all.push(...r);
          for (const res of r) {
            const mark = res.correct ? "PASS" : "FAIL";
            console.log(`${mark} ${t.name} #${res.index}      ${res.model.padEnd(18)}  ${res.latencyMs}ms    ${res.reason}`);
            if (!res.correct) console.log(`     answer: ${res.answerText}`);
            if (res.error) console.log(`     error: ${res.error}`);
           }

          const total = all.length;
          const passed = all.filter((r) => r.correct).length;
          console.log(`\n[total] ${m}: ${total} runs, ${passed}/${total} correct`);
         }
       }
     }
   }

main().catch((err) => fail(err.message));

// Export resolveClients for use by aggregate.js and other modules
export { resolveClients };
