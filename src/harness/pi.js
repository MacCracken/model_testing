// harness/pi.js — Pi (pi.dev, the minimal coding agent) as the harness arm.
//
// `pi --mode json -p '<prompt>'` runs one non-interactive turn and prints JSONL events. Everything a
// trial needs is on the `message_end` events: an assistant message carries text and/or `toolCall`
// blocks plus `usage` (tokens and a cost computed from the rates Pi has for the model); a
// `toolResult` message carries the tool's output with `isError`. Tool outputs are present, so the
// webserver's replies can be recovered and every task scored (see harness/util.js).
//
// Pi's tools are limited to `bash` here; `-nc` keeps AGENTS.md / CLAUDE.md out of the prompt and
// `--no-session` leaves nothing behind. Pi reads its API key from its own auth store or `--api-key`;
// the arm passes the bench's key for the model's provider (`PROVIDER_API_KEY`), so the same key
// that drives the synthetic arm drives Pi. Model ids are `provider/model`, as Pi spells them.

import { parseJSONLoose } from "../json.js";
import { goalPrompt, synthesizeToolResults, recentGreetings, splitCommand, runChild, eventTimings } from "./util.js";
import { BASE } from "../tasks/util.js";

export function parsePiEvents(ndjson) {
  const toolCalls = [];
  const toolResults = [];
  let text = null;
  let model = null;
  let provider = null;
  let error = null;
  let sawUsage = false;
  let cost = 0;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const line of String(ndjson).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === "error") { error = ev.message ?? ev.error ?? "error"; continue; }
    if (ev.type !== "message_end") continue;
    const m = ev.message ?? {};
    if (m.role === "assistant") {
      model = m.model ?? model;
      provider = m.provider ?? provider;
      const texts = (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "");
      if (texts.length) text = texts.join("\n");
      for (const b of m.content ?? []) {
        if (b.type === "toolCall") toolCalls.push({ id: b.id ?? `pi_${toolCalls.length + 1}`, name: b.name ?? "?", arguments: b.arguments ?? {} });
      }
      if (m.usage) {
        sawUsage = true;
        usage.prompt_tokens += (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
        usage.completion_tokens += (m.usage.output ?? 0) + (m.usage.reasoning ?? 0);
        cost += m.usage.cost?.total ?? 0;
      }
    } else if (m.role === "toolResult") {
      const content = (m.content ?? []).map((b) => b.text ?? "").join("\n");
      toolResults.push({ id: m.toolCallId ?? `pi_${toolResults.length + 1}`, name: m.toolName ?? "?", ok: !m.isError, content });
    }
  }
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return { text, model, provider, usage: sawUsage ? usage : null, costUsd: cost || null, toolCalls, toolResults, error };
}

export class PiClient {
  constructor({ name = "pi", model = "openai/gpt-4o-mini", command = process.env.PI_CMD ?? "pi", tools = "bash", apiKey = null, timeoutMs = 300_000 } = {}) {
    this.name = name;
    this.provider = "pi";
    this.model = model;
    this.command = command;
    this.tools = tools;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.structuredOnly = true;
  }

  async chat() {
    throw new Error("the pi arm only runs structured modes; use a synthetic client for the free-form baseline");
  }

  async runWithTools(prompt, _tools, system, { signal, task, mode, timeoutMs = this.timeoutMs } = {}) {
    const slash = this.model.indexOf("/");
    const providerName = slash === -1 ? null : this.model.slice(0, slash);
    const modelId = slash === -1 ? this.model : this.model.slice(slash + 1);
    const argv = [
      ...splitCommand(this.command), "--mode", "json", "-p", "--no-session", "-nc",
      ...(providerName ? ["--provider", providerName] : []), "--model", modelId,
      "--tools", this.tools,
      ...(this.apiKey ? ["--api-key", this.apiKey] : []),
      goalPrompt(task, mode, prompt),
    ];
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    const { stdout, stderr, code, lines } = await runChild(argv, { signal, timeoutMs, env, label: "pi" });
    const timing = eventTimings(lines,
      (l) => /"type":"message_update"/.test(l) || (/"type":"message_end"/.test(l) && /"role":"assistant"/.test(l)),
      (l) => /"type":"message_end"/.test(l) && /"role":"assistant"/.test(l) && /"type":"text"/.test(l));
    const endedAt = new Date().toISOString();
    const p = parsePiEvents(stdout);
    if (p.text === null) throw new Error(`pi: ${p.error ?? (code !== 0 ? `exited ${code}: ${stderr.trim().split("\n").filter(Boolean).pop() ?? ""}` : "no assistant message")}`);
    if (p.model) this.model = providerName ? `${providerName}/${p.model}` : p.model;
    const served = await recentGreetings(BASE, startedAt, endedAt);
    const toolResults = [...p.toolResults, ...synthesizeToolResults(task, mode, p.toolResults.map((r) => r.content), served)];
    return {
      ttftMs: timing.ttftMs,
      ttfaMs: timing.ttfaMs,
      text: p.text,
      structured: parseJSONLoose(p.text),
      toolCalls: p.toolCalls,
      toolResults,
      rounds: 1,
      finishReason: "stop",
      usage: p.usage,
      elapsedMs: Math.round(performance.now() - t0),
      harness: { kind: "pi", model: p.model && p.provider ? `${p.provider}/${p.model}` : p.model, provider: p.provider, costUsd: p.costUsd, system },
    };
  }
}
