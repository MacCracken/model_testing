// harness/codex.js — OpenAI Codex CLI as the harness arm.
//
// `codex exec --json '<prompt>'` runs one non-interactive turn and prints JSONL: `thread.started`,
// `turn.started`, `item.completed` items (`agent_message`, `command_execution` with the command and
// its aggregated output, `mcp_tool_call`, `reasoning`, `error`), then `turn.completed` with token
// usage (no cost). Command outputs are present, so the webserver's replies can be recovered and
// every task scored (see harness/util.js).
//
// `--ephemeral` and `--skip-git-repo-check` keep the run self-contained; `-C` points it at a scratch
// directory. Network access needs the sandbox relaxed — `CODEX_SANDBOX_ARGS` (default
// `--dangerously-bypass-approvals-and-sandbox`, the documented no-prompt mode) is passed through as
// given. Codex authenticates through its own login (`codex login`, or `codex login --with-api-key`);
// the bench does not manage that.
//
// Event field names follow the documented shapes; this arm has not yet been exercised live here
// because Codex was not logged in on this machine when it was written.

import { parseJSONLoose } from "../json.js";
import { goalPrompt, synthesizeToolResults, recentGreetings, splitCommand, runChild } from "./util.js";
import { BASE } from "../tasks/util.js";

export function parseCodexEvents(ndjson) {
  const toolCalls = [];
  const toolResults = [];
  const errors = [];
  let text = null;
  let usage = null;
  let failed = null;
  for (const line of String(ndjson).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === "item.completed") {
      const item = ev.item ?? {};
      if (item.type === "agent_message") text = item.text ?? item.content ?? text;
      else if (item.type === "command_execution") {
        const id = item.id ?? `codex_${toolCalls.length + 1}`;
        toolCalls.push({ id, name: "shell", arguments: { command: item.command ?? "" } });
        toolResults.push({ id, name: "shell", ok: item.exit_code === 0 || (item.exit_code === undefined && item.status !== "failed"), content: item.aggregated_output ?? "" });
      } else if (item.type === "mcp_tool_call") {
        const id = item.id ?? `codex_${toolCalls.length + 1}`;
        toolCalls.push({ id, name: `${item.server ?? "mcp"}.${item.tool ?? "?"}`, arguments: item.arguments ?? {} });
        toolResults.push({ id, name: `${item.server ?? "mcp"}.${item.tool ?? "?"}`, ok: item.status !== "failed", content: typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? "") });
      } else if (item.type === "error") errors.push(item.message ?? "error");
    } else if (ev.type === "turn.completed") {
      const u = ev.usage ?? {};
      const prompt = (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0);
      const completion = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
      usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
    } else if (ev.type === "turn.failed") failed = ev.error?.message ?? ev.message ?? "turn failed";
    else if (ev.type === "error") errors.push(ev.message ?? "error");
  }
  return { text, usage, toolCalls, toolResults, errors, failed };
}

export class CodexClient {
  constructor({ name = "codex", model = "gpt-5-mini", command = process.env.CODEX_CMD ?? "codex", cwd = process.env.CODEX_CWD ?? process.cwd(), sandboxArgs = process.env.CODEX_SANDBOX_ARGS ?? "--dangerously-bypass-approvals-and-sandbox", timeoutMs = 300_000 } = {}) {
    this.name = name;
    this.provider = "codex";
    this.model = model;
    this.command = command;
    this.cwd = cwd;
    this.sandboxArgs = sandboxArgs;
    this.timeoutMs = timeoutMs;
    this.structuredOnly = true;
  }

  async chat() {
    throw new Error("the codex arm only runs structured modes; use a synthetic client for the free-form baseline");
  }

  async runWithTools(prompt, _tools, system, { signal, task, mode, timeoutMs = this.timeoutMs } = {}) {
    const argv = [
      ...splitCommand(this.command), "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", this.cwd,
      "-m", this.model, ...splitCommand(this.sandboxArgs), goalPrompt(task, mode, prompt),
    ];
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    const { stdout, stderr, code } = await runChild(argv, { signal, timeoutMs, env, label: "codex" });
    const endedAt = new Date().toISOString();
    const p = parseCodexEvents(stdout);
    if (p.failed) throw new Error(`codex: ${p.failed}`);
    if (p.text === null) throw new Error(`codex: ${p.errors.at(-1) ?? (code !== 0 ? `exited ${code}: ${stderr.trim().split("\n").filter(Boolean).pop() ?? ""}` : "no agent message")}`);
    const served = await recentGreetings(BASE, startedAt, endedAt);
    const toolResults = [...p.toolResults, ...synthesizeToolResults(task, mode, p.toolResults.map((r) => r.content), served)];
    return {
      text: p.text,
      structured: parseJSONLoose(p.text),
      toolCalls: p.toolCalls,
      toolResults,
      rounds: 1,
      finishReason: "stop",
      usage: p.usage,
      ttftMs: null,
      ttfaMs: null,
      elapsedMs: Math.round(performance.now() - t0),
      harness: { kind: "codex", model: this.model, system, warnings: p.errors },
    };
  }
}
