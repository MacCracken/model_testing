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
import { goalPrompt, synthesizeToolResults, recentGreetings, splitCommand, runChild, eventTimings, skillBlock, nativeSkill } from "./util.js";
import { startToolBridge, mcpServerSpec, bridgedToolName, sharedToolsNote, SERVER_NAME } from "./toolbridge.js";
import { BASE } from "../tasks/util.js";

// What a sub-agents variant tells Claude Code, in place of the synthetic parent's delegate note:
// its own Agent tool, and under shared tools a worker agent that carries the bench's tools.
export const ARM_AGENT_NOTE = {
  available: "Sub-agents: you may use the Agent tool to offload independent pieces of work (one item or one batch per sub-agent), giving each a self-contained goal with every id and value it needs. You remain responsible for checking the results and giving the final answer.",
  required: "Sub-agents: do the per-item work through the Agent tool rather than yourself — after reading the state, delegate the updates to sub-agents (a self-contained goal each, with every id and value it needs), then collect what they return, verify, and finish the job yourself. You remain responsible for the final answer.",
};
export const WORKER_AGENT = "worker";

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
  // One entry per assistant message — its text and the calls it made, in order: the arm's turns.
  const turns = [];
  let model = null;
  let result = null;
  for (const m of messages) {
    if (m.type === "system" && m.subtype === "init") model = m.model ?? model;
    else if (m.type === "assistant") {
      const turn = { round: turns.length + 1, ms: null, text: "", calls: [] };
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") {
          const id = b.id ?? `cc_${toolCalls.length + 1}`;
          toolCalls.push({ id, name: b.name, arguments: b.input ?? {} });
          turn.calls.push(id);
        } else if (b.type === "text" && typeof b.text === "string") turn.text += (turn.text ? "\n" : "") + b.text;
      }
      turns.push(turn);
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
    numTurns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? null,
    toolCalls,
    toolResults,
    turns,
  };
}

export class ClaudeCodeClient {
  constructor({ name = "claude-code", model = "claude-haiku-4-5", command = process.env.CLAUDE_CODE_CMD ?? "claude", tools = "Bash", apiKey = null, timeoutMs = 300_000, sharedTools = false } = {}) {
    this.name = name;
    this.provider = "claude-code";
    this.model = model;
    this.command = command;
    this.tools = tools;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.structuredOnly = true;
    // Shared tools: the bench's own tools over MCP instead of Bash — every call runs in the bench
    // and is scored by the task's tool-use verdict (see harness/toolbridge.js).
    this.sharedTools = !!sharedTools;
  }

  async chat() {
    throw new Error("the claude-code arm only runs structured modes; use a synthetic client for the free-form baseline");
  }

  async runWithTools(prompt, tools, system, { signal, task, mode, ctx = null, skill = null, constraints = null, agents = null, confidence = null, abstain = null, schema = null, timeoutMs = this.timeoutMs } = {}) {
    // A native skill goes in through Claude Code's own system-prompt flag instead of the goal text.
    const native = nativeSkill(skill);
    // Shared tools: no built-in tools (the Agent tool when a sub-agents variant asks), the bench's
    // tools through the MCP bridge, and the goal names them.
    const bridge = this.sharedTools ? await startToolBridge(tools ?? []) : null;
    const agentNote = agents ? ARM_AGENT_NOTE[agents.how] ?? ARM_AGENT_NOTE.available : null;
    const goal = [goalPrompt(task, mode, prompt, ctx, native ? null : skill, constraints, confidence, { abstain, schema }), bridge ? sharedToolsNote(tools) : null, agentNote].filter(Boolean).join("\n\n");
    // Under shared tools a sub-agents variant also defines a worker agent that carries the bench's
    // tools, so what a sub-agent can do is the same as what the parent can.
    const worker = bridge && agents ? JSON.stringify({ [WORKER_AGENT]: { description: "Works one self-contained piece of the job with the bench's tools and reports the concrete results (ids, tickets, numbers).", prompt: "You are a sub-agent working one piece of a larger job. Use the tools to complete exactly the goal you are given, then reply with a concise final answer stating the concrete results. Do not ask questions; if part of the goal is impossible, say so.", tools: (tools ?? []).map((t) => `mcp__${SERVER_NAME}__${t.name}`) } }) : null;
    const argv = [
      ...splitCommand(this.command), "-p", goal,
      "--bare", "--output-format", "stream-json", "--verbose", "--model", this.model, "--no-session-persistence",
      ...(bridge
        ? ["--tools", agents ? "Agent,Task" : "", "--mcp-config", JSON.stringify({ mcpServers: { [SERVER_NAME]: mcpServerSpec(bridge.url) } }), "--strict-mcp-config", ...(worker ? ["--agents", worker] : [])]
        // A sub-agents variant lets Claude Code use its own Agent tool (Task in older builds).
        : ["--allowedTools", agents ? `${this.tools},Agent,Task` : this.tools]),
      "--permission-mode", "bypassPermissions",
      ...(native ? ["--append-system-prompt", skillBlock(native)] : []),
    ];
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID") delete env[k];
    if (this.apiKey) env.ANTHROPIC_API_KEY = this.apiKey;
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    let run;
    try {
      run = await runChild(argv, { signal, timeoutMs, env, label: "claude-code" });
    } finally {
      if (bridge) await bridge.close();
    }
    const { stdout, stderr, code, lines } = run;
    const timing = eventTimings(lines,
      (l) => /"type":"assistant"/.test(l),
      (l) => /"type":"result"/.test(l));
    const endedAt = new Date().toISOString();
    if (code !== 0 && !stdout.trim()) throw new Error(`claude-code exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
    const t = parseTranscript(stdout);
    if (t.isError) throw new Error(`claude-code: ${t.subtype ?? "error"}: ${t.text.slice(0, 200)}`);
    if (t.model) this.model = t.model;
    let toolCalls = t.toolCalls;
    let toolResults;
    if (bridge) {
      // The bridge executed every bench tool call, so its records are the calls and results —
      // bench-shaped, under the transcript's ids where the two line up — plus whatever else the
      // transcript shows (the Agent tool under a sub-agents variant).
      const transcriptMcp = t.toolCalls.filter((c) => bridgedToolName(c.name));
      bridge.calls.forEach((c, i) => { const tc = transcriptMcp[i]; if (tc && bridgedToolName(tc.name) === c.name) { c.id = tc.id; const r = bridge.results.find((x) => x.id === `mcp_${i + 1}`); if (r) r.id = tc.id; } });
      toolCalls = [...bridge.calls, ...t.toolCalls.filter((c) => !bridgedToolName(c.name))];
      toolResults = [...bridge.results, ...t.toolResults.filter((r) => !bridgedToolName(r.name))];
    } else {
      // Real tool outputs plus the bench-shaped results recovered from them (for lookup/chain/hello).
      const served = await recentGreetings(BASE, startedAt, endedAt);
      toolResults = [...t.toolResults, ...synthesizeToolResults(task, mode, t.toolResults.map((r) => r.content), served)];
    }
    return {
      ttftMs: timing.ttftMs,
      ttfaMs: timing.ttfaMs,
      skillApplied: native ? "native" : null,
      agents: agents ? { how: agents.how, applied: "native", delegations: t.toolCalls.filter((c) => c.name === "Agent" || c.name === "Task").length, childCalls: 0, childTokens: 0, children: [] } : undefined,
      text: t.text,
      structured: parseJSONLoose(t.text),
      toolCalls,
      toolResults,
      turns: t.turns,
      transcript: { format: "claude-code/stream-json", text: stdout },
      rounds: t.numTurns ?? 1,
      finishReason: "stop",
      usage: t.usage,
      elapsedMs: Math.round(performance.now() - t0),
      harness: { kind: "claude-code", model: t.model, costUsd: t.costUsd, system, sharedTools: !!bridge },
    };
  }
}

