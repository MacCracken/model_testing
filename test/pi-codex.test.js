import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePiEvents, PiClient } from "../src/harness/pi.js";
import { parseCodexEvents, CodexClient } from "../src/harness/codex.js";
import { runTrial } from "../src/runner.js";
import { getTask } from "../src/tasks/registry.js";

const ID = "6587ee8e-6a23-4a37-b342-c5a9799d9964";
// Trimmed from a real `pi --mode json -p` run on 2026-09-04 (openai/gpt-4o-mini, bash tool).
const PI = [
  { type: "session", version: 3, id: "s" },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "goal" }] } },
  { type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_delta", delta: "{" } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1|fc_1", name: "bash", arguments: { command: "curl -s 'http://localhost:3000/api/hello?name=alice'" } }], provider: "openai", model: "gpt-4o-mini", usage: { input: 593, output: 32, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 625, cost: { total: 0.0001 } } } },
  { type: "message_end", message: { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "bash", content: [{ type: "text", text: `{"message":"Hello, alice!","id":"${ID}"}` }], isError: false } },
  { type: "turn_end", message: { role: "assistant", content: [] } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "```json\n{\"message\":\"Hello, alice!\",\"id\":\"" + ID + "\"}\n```" }], provider: "openai", model: "gpt-4o-mini", usage: { input: 664, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 704, cost: { total: 0.0002 } } } },
  { type: "agent_end", messages: [] },
].map((e) => JSON.stringify(e)).join("\n");

test("parsePiEvents folds message_end events into calls, results, the final text, usage and cost", () => {
  const p = parsePiEvents(PI);
  assert.equal(p.model, "gpt-4o-mini");
  assert.equal(p.provider, "openai");
  assert.deepEqual(p.toolCalls, [{ id: "call_1|fc_1", name: "bash", arguments: { command: "curl -s 'http://localhost:3000/api/hello?name=alice'" } }]);
  assert.equal(p.toolResults.length, 1);
  assert.equal(p.toolResults[0].ok, true);
  assert.match(p.toolResults[0].content, /Hello, alice!/);
  assert.match(p.text, /alice/);
  assert.deepEqual(p.usage, { prompt_tokens: 1257, completion_tokens: 72, total_tokens: 1329 });
  assert.ok(Math.abs(p.costUsd - 0.0003) < 1e-9);
});

test("a pi arm trial runs through a stub binary with the provider split out of the model id", async () => {
  const stub = join(mkdtempSync(join(tmpdir(), "pi-stub-")), "pi.js");
  writeFileSync(stub, `const a = process.argv.slice(2); const need = [["--mode","json"],["--provider","openai"],["--model","gpt-4o-mini"],["--api-key","k"],["--tools","bash"]]; for (const [f,v] of need) { const i = a.indexOf(f); if (i === -1 || a[i+1] !== v) { process.stderr.write("bad " + f + " " + a.join(" ")); process.exit(3); } } if (!a.at(-1).includes("A webserver runs at")) { process.stderr.write("no goal"); process.exit(4); } process.stdout.write(${JSON.stringify(PI)});`);
  const client = new PiClient({ name: "pi:openai/gpt-4o-mini", model: "openai/gpt-4o-mini", command: `${process.execPath} ${stub}`, apiKey: "k" });
  const row = await runTrial({ task: getTask("lookup"), mode: "harness", client });
  assert.equal(row.error, null, row.error ?? "");
  assert.equal(row.harness, "pi");
  assert.equal(row.model, "openai/gpt-4o-mini");
  assert.deepEqual(row.ground[0], { name: "alice", ids: [ID] });
  assert.equal(row.usage.total_tokens, 1329);
});

// Codex shapes follow the documented exec --json events (not yet exercised live here).
const CODEX = [
  { type: "thread.started", thread_id: "t" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata for `x` not found. Defaulting to fallback metadata" } },
  { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "curl -s 'http://localhost:3000/api/hello?name=alice'", aggregated_output: `{"message":"Hello, alice!","id":"${ID}"}\n`, exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "{\"name\":\"alice\",\"id\":\"" + ID + "\"}" } },
  { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 10 } },
].map((e) => JSON.stringify(e)).join("\n");

test("parseCodexEvents folds items into calls, results, text and usage, keeping non-fatal errors as warnings", () => {
  const p = parseCodexEvents(CODEX);
  assert.equal(p.toolCalls.length, 1);
  assert.equal(p.toolCalls[0].name, "shell");
  assert.equal(p.toolResults[0].ok, true);
  assert.match(p.toolResults[0].content, /Hello, alice!/);
  assert.match(p.text, /alice/);
  assert.deepEqual(p.usage, { prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060 });
  assert.equal(p.errors.length, 1);
  assert.equal(p.failed, null);
  const dead = parseCodexEvents('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}');
  assert.equal(dead.failed, "401 Unauthorized");
});

test("a codex arm trial runs through a stub binary and recovers the lookup ground", async () => {
  const stub = join(mkdtempSync(join(tmpdir(), "codex-stub-")), "codex.js");
  writeFileSync(stub, `const a = process.argv.slice(2); for (const f of ["exec","--json","--ephemeral","-m","-C","--dangerously-bypass-approvals-and-sandbox"]) if (!a.includes(f)) { process.stderr.write("missing " + f); process.exit(3); } process.stdout.write(${JSON.stringify(CODEX)});`);
  const client = new CodexClient({ name: "codex:test", model: "gpt-5-mini", command: `${process.execPath} ${stub}`, cwd: tmpdir() });
  const row = await runTrial({ task: getTask("lookup"), mode: "harness", client });
  assert.equal(row.error, null, row.error ?? "");
  assert.equal(row.harness, "codex");
  assert.deepEqual(row.ground[0], { name: "alice", ids: [ID] });
  assert.equal(row.usage.total_tokens, 1060);
});
