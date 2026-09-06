// harness/claude-code.js — Claude Code as the harness arm.
//
// `claude -p <prompt> --bare --output-format json` runs one non-interactive turn and prints the
// whole transcript as a JSON array: a system/init message (model, tools), assistant messages with
// `tool_use` blocks, user messages with `tool_result` blocks (the tool's actual output — Bash
// stdout included), and a final `result` with the answer text, usage, cost and turn count. That
// is everything a trial needs, so this arm can score every task, including the ones whose truth
// comes from what the webserver served (see harness/util.js).
//
// `--bare` skips hooks, skills, CLAUDE.md and memory (the harness under test is Claude Code's loop
// and tools, not this repo's instructions) and needs ANTHROPIC_API_KEY. The tool set is limited to
// Bash with permission prompts bypassed, so the run never blocks. Nested-session guards are
// removed from the environment so the arm also works when the bench itself runs under Claude Code.

import { parseJSONLoose } from "../json.js";
import { goalPrompt, synthesizeToolResults, recentGreetings, splitCommand, runChild, eventTimings } from "./util.js";
import { BASE } from "../tasks/util.js";

export function parseTranscript(raw) {
  // `json` output is one array; `stream-json` is one message per line. Accept both.
  let messages = [];
  const text = String(raw ?? "").trim();
  if (text.startsWith("[")) {
    try { messages = JSON.parse(text); } catch { messages = []; }
  }
  if (!messages.length) {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try { messages.push(JSON.parse(t)); } catch { /* not a message line */ }
    }
  }
  const toolCalls = [];
  const toolResults = [];
  let model = null;
  let result = null;
  for (const m of messages) {
    if (m.type === "system" && m.subtype === "init") model = m.model ?? model;
    else if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") toolCalls.push({ id: b.id ?? `cc_${toolCalls.length + 1}`, name: b.name, arguments: b.input ?? {} });
      }
    } else if (m.type === "user") {
      for (const b of m.message?.content ?? []) {
        if (b.type !== "tool_result") continue;
        const content = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("\n") : String(b.content ?? "");
        const call = toolCalls.find((c) => c.id === b.tool_use_id);
        toolResults.push({ id: b.tool_use_id ?? `cc_${toolResults.length + 1}`, name: call?.name ?? "?", ok: !b.is_error, content });
      }
    } else if (m.type === "result") result = m;
  }
  if (!result) throw new Error("claude-code: no result message in the transcript");
  const usage = result.usage
    ? { prompt_tokens: (result.usage.input_tokens ?? 0) + (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0), completion_tokens: result.usage.output_tokens ?? 0, total_tokens: 0 }
    : null;
  if (usage) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return {
    text: typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? ""),
    isError: !!result.is_error,
    subtype: result.subtype ?? null,
    model,
    usage,
    costUsd: result.total_cost_usd ?? null,
    turns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? null,
    toolCalls,
    toolResults,
  };
}

export class ClaudeCodeClient {
  constructor({ name = "claude-code", model = "claude-haiku-4-5", command = process.env.CLAUDE_CODE_CMD ?? "claude", tools = "Bash", apiKey = null, timeoutMs = 300_000 } = {}) {
    this.name = name;
    this.provider = "claude-code";
    this.model = model;
    this.command = command;
    this.tools = tools;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.structuredOnly = true;
  }

  async chat() {
    throw new Error("the claude-code arm only runs structured modes; use a synthetic client for the free-form baseline");
  }

  async runWithTools(prompt, _tools, system, { signal, task, mode, timeoutMs = this.timeoutMs } = {}) {
    const argv = [
      ...splitCommand(this.command), "-p", goalPrompt(task, mode, prompt),
      "--bare", "--output-format", "stream-json", "--verbose", "--model", this.model, "--no-session-persistence",
      "--allowedTools", this.tools, "--permission-mode", "bypassPermissions",
    ];
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID") delete env[k];
    if (this.apiKey) env.ANTHROPIC_API_KEY = this.apiKey;
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    const { stdout, stderr, code, lines } = await runChild(argv, { signal, timeoutMs, env, label: "claude-code" });
    const timing = eventTimings(lines,
      (l) => /"type":"assistant"/.test(l),
      (l) => /"type":"result"/.test(l));
    const endedAt = new Date().toISOString();
    if (code !== 0 && !stdout.trim()) throw new Error(`claude-code exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
    const t = parseTranscript(stdout);
    if (t.isError) throw new Error(`claude-code: ${t.subtype ?? "error"}: ${t.text.slice(0, 200)}`);
    if (t.model) this.model = t.model;
    // Real tool outputs plus the bench-shaped results recovered from them (for lookup/chain/hello).
    const served = await recentGreetings(BASE, startedAt, endedAt);
    const toolResults = [...t.toolResults, ...synthesizeToolResults(task, mode, t.toolResults.map((r) => r.content), served)];
    return {
      ttftMs: timing.ttftMs,
      ttfaMs: timing.ttfaMs,
      text: t.text,
      structured: parseJSONLoose(t.text),
      toolCalls: t.toolCalls,
      toolResults,
      rounds: t.turns ?? 1,
      finishReason: "stop",
      usage: t.usage,
      elapsedMs: Math.round(performance.now() - t0),
      harness: { kind: "claude-code", model: t.model, costUsd: t.costUsd, system },
    };
  }
}

