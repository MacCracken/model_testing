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
import { startToolBridge, mcpServerSpec, bridgedToolName, sharedToolsNote, SERVER_NAME } from "./toolbridge.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalPrompt, synthesizeToolResults, recentGreetings, splitCommand, runChild, eventTimings, skillBlock, nativeSkill } from "./util.js";
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
  constructor({ name = "codex", model = "gpt-5-mini", command = process.env.CODEX_CMD ?? "codex", cwd = process.env.CODEX_CWD ?? process.cwd(), sandboxArgs = process.env.CODEX_SANDBOX_ARGS ?? "--dangerously-bypass-approvals-and-sandbox", timeoutMs = 300_000, sharedTools = false } = {}) {
    this.name = name;
    this.provider = "codex";
    this.model = model;
    this.command = command;
    this.cwd = cwd;
    this.sandboxArgs = sandboxArgs;
    this.timeoutMs = timeoutMs;
    this.structuredOnly = true;
    // Shared tools: the bench's tools over MCP beside Codex's shell (which cannot be removed);
    // the goal says to use them, and the verdict says whether it did.
    this.sharedTools = !!sharedTools;
  }

  async chat() {
    throw new Error("the codex arm only runs structured modes; use a synthetic client for the free-form baseline");
  }

  async runWithTools(prompt, tools, system, { signal, task, mode, ctx = null, skill = null, constraints = null, confidence = null, timeoutMs = this.timeoutMs } = {}) {
    // A native skill is the AGENTS.md of the working directory Codex runs in — its own channel for
    // project instructions — so the run gets a scratch directory holding just that file.
    const native = nativeSkill(skill);
    const cwd = native ? mkdtempSync(join(tmpdir(), "hb-codex-")) : this.cwd;
    if (native) writeFileSync(join(cwd, "AGENTS.md"), skillBlock(native));
    const bridge = this.sharedTools ? await startToolBridge(tools ?? []) : null;
    const goal = goalPrompt(task, mode, prompt, ctx, native ? null : skill, constraints, confidence);
    const spec = bridge ? mcpServerSpec(bridge.url) : null;
    const argv = [
      ...splitCommand(this.command), "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", cwd,
      "-m", this.model, ...splitCommand(this.sandboxArgs),
      ...(bridge ? ["-c", `mcp_servers.${SERVER_NAME}.command=${JSON.stringify(spec.command)}`, "-c", `mcp_servers.${SERVER_NAME}.args=${JSON.stringify(spec.args)}`] : []),
      bridge ? `${goal}\n\n${sharedToolsNote(tools)}` : goal,
    ];
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    let child;
    try {
      child = await runChild(argv, { signal, timeoutMs, env, label: "codex" });
    } finally {
      if (native) rmSync(cwd, { recursive: true, force: true });
      if (bridge) await bridge.close();
    }
    const { stdout, stderr, code, lines } = child;
    const timing = eventTimings(lines,
      (l) => /"type":"item\.(started|completed)"/.test(l),
      (l) => /"type":"item\.completed"/.test(l) && /"type":"agent_message"/.test(l));
    const endedAt = new Date().toISOString();
    const p = parseCodexEvents(stdout);
    if (p.failed) throw new Error(`codex: ${p.failed}`);
    if (p.text === null) throw new Error(`codex: ${p.errors.at(-1) ?? (code !== 0 ? `exited ${code}: ${stderr.trim().split("\n").filter(Boolean).pop() ?? ""}` : "no agent message")}`);
    let toolCalls = p.toolCalls;
    let toolResults;
    if (bridge) {
      // The bridge's records are the bench tool calls; the shell calls stay as the transcript shows them.
      const transcriptMcp = p.toolCalls.filter((c) => bridgedToolName(c.name));
      bridge.calls.forEach((c, i) => { const tc = transcriptMcp[i]; if (tc && bridgedToolName(tc.name) === c.name) { const r = bridge.results.find((x) => x.id === c.id); c.id = tc.id; if (r) r.id = tc.id; } });
      toolCalls = [...bridge.calls, ...p.toolCalls.filter((c) => !bridgedToolName(c.name))];
      toolResults = [...bridge.results, ...p.toolResults.filter((r) => !bridgedToolName(r.name))];
    } else {
      const served = await recentGreetings(BASE, startedAt, endedAt);
      toolResults = [...p.toolResults, ...synthesizeToolResults(task, mode, p.toolResults.map((r) => r.content), served)];
    }
    return {
      ttftMs: timing.ttftMs,
      ttfaMs: timing.ttfaMs,
      skillApplied: native ? "native" : null,
      text: p.text,
      structured: parseJSONLoose(p.text),
      toolCalls,
      toolResults,
      rounds: 1,
      finishReason: "stop",
      usage: p.usage,
      elapsedMs: Math.round(performance.now() - t0),
      transcript: { format: "codex/json", text: stdout },
      harness: { kind: "codex", model: this.model, system, warnings: p.errors, sharedTools: !!bridge },
    };
  }
}
