// harness/thoth.js — a real agent harness as the harness arm: Thoth, driven one-shot.
//
// Thoth (the operator's own terminal coding agent) runs a task non-interactively with
// `thoth --events '<task>'`, streaming NDJSON: turn_start → tool_call / tool_result … → response
// (or error) → turn_end. This client turns one such run into the same result shape the synthetic
// `Client.runWithTools` returns, so `runTrial` scores it unchanged. Differences from the synthetic
// harness, all deliberate:
//   - Thoth brings its own tools (its shell, daimon's MCP tools); the task's function tools are not
//     sent. The prompt is the task's `goal` — the plain statement of the job plus the endpoint docs —
//     with the same schema instruction the synthetic harness gets.
//   - `tool_result` events carry a name, ok flag and byte count, not the content, so `toolResults`
//     here have empty content. Tasks whose ground truth is read from tool results (`lookup`, `chain`)
//     therefore cannot be scored from this arm yet; see plan.md.
//   - stdin MUST be closed: in one-shot mode Thoth appends piped stdin to the task and blocks until
//     EOF, which over ssh means forever.
//
// Where Thoth runs is configured, not assumed: THOTH_CMD is the command prefix (default `thoth`),
// e.g. `ssh -n arch cd ~/Repos/thoth && thoth` when it lives on another host. The model is whatever
// Thoth's config routes to; the `model` reported in the events is recorded on every row.

import { spawn } from "node:child_process";
import { parseJSONLoose } from "../json.js";
import { schemaHint } from "../schema.js";

export function parseEvents(ndjson) {
  const toolCalls = [];
  const toolResults = [];
  let text = null;
  let error = null;
  let model = null;
  let tokens = null;
  let turnEnd = null;
  for (const line of String(ndjson).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    switch (ev.event) {
      case "turn_start": model = ev.model ?? model; break;
      case "tool_call": {
        let args = ev.args ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { raw: args }; } }
        toolCalls.push({ id: `thoth_${toolCalls.length + 1}`, name: ev.name ?? "?", arguments: args });
        break;
      }
      case "tool_result": {
        const call = toolCalls[toolResults.length];
        toolResults.push({ id: call?.id ?? `thoth_${toolResults.length + 1}`, name: ev.name ?? call?.name ?? "?", ok: ev.ok !== false, bytes: ev.bytes ?? null, content: "" });
        break;
      }
      case "response": text = ev.text ?? ""; break;
      case "error": error = ev.message ?? "error"; break;
      case "turn_end": turnEnd = ev; if (typeof ev.tokens === "number") tokens = ev.tokens; break;
      default: break;
    }
  }
  return { text, error, model, tokens, turnEnd, toolCalls, toolResults };
}

// Split a command prefix into argv; the last element is the executable and the rest its args.
function splitCommand(cmd) {
  return String(cmd).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) ?? ["thoth"];
}

export class ThothClient {
  constructor({ name = "thoth", model = "thoth", command = process.env.THOTH_CMD ?? "thoth", timeoutMs = 300_000 } = {}) {
    this.name = name;
    this.provider = "thoth";
    this.model = model;
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  // Free-form mode has no meaning for a harness arm — Thoth always brings its tools — so a task's
  // noHarness rows come from the synthetic client for the same model, never from here.
  async chat() {
    throw new Error("the thoth arm only runs structured modes; use a synthetic client for the free-form baseline");
  }

  async runWithTools(prompt, _tools, system, { signal, task, mode, timeoutMs = this.timeoutMs } = {}) {
    const goal = task?.goal ?? prompt;
    const schema = task?.[mode]?.schema;
    const taskText = [
      goal,
      schema
        ? `Return your final answer as a JSON value that is an instance of this JSON Schema (a value that validates against it — not the schema itself):\n${schemaHint(schema)}\nReply with that JSON value only — no prose, no markdown fences.`
        : "",
    ].filter(Boolean).join("\n\n");

    const prefix = splitCommand(this.command);
    // Over ssh the remote shell re-parses the argument list, so the task text is single-quoted for it.
    const remote = prefix[0] === "ssh";
    const argv = [...prefix, "--events", remote ? `'${taskText.replace(/'/g, "'\\''")}'` : taskText];
    const t0 = performance.now();
    const { stdout, stderr, code } = await run(argv, { signal, timeoutMs });
    const parsed = parseEvents(stdout);
    const text = parsed.text ?? "";
    if (parsed.error) throw new Error(`thoth: ${parsed.error}`);
    if (code !== 0 && !parsed.text) throw new Error(`thoth exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
    if (parsed.model) this.model = parsed.model;
    return {
      text,
      structured: parseJSONLoose(text),
      toolCalls: parsed.toolCalls,
      toolResults: parsed.toolResults,
      rounds: 1,
      finishReason: parsed.turnEnd?.ok === false ? "error" : "stop",
      usage: parsed.tokens === null ? null : { total_tokens: parsed.tokens },
      elapsedMs: Math.round(performance.now() - t0),
      harness: { kind: "thoth", model: parsed.model, system },
    };
  }
}

function run(argv, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`thoth timed out after ${timeoutMs}ms`)); }, timeoutMs);
    const onAbort = () => { child.kill("SIGTERM"); reject(new Error("cancelled")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve({ stdout, stderr, code }); });
  });
}
