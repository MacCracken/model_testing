import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTranscript, ClaudeCodeClient } from "../src/harness/claude-code.js";
import { greetingsIn, synthesizeToolResults, goalPrompt } from "../src/harness/util.js";
import { runTrial } from "../src/runner.js";
import { getTask } from "../src/tasks/registry.js";

const ID = "b9402ffe-e589-463d-b33b-a21b4a32e6c3";
// Trimmed from a real `claude -p --bare --output-format json` run (2026-09-04).
const TRANSCRIPT = [
  { type: "system", subtype: "init", model: "claude-haiku-4-5", tools: ["Bash"] },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "curl http://localhost:3000/api/hello?name=alice" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Exit code 1\n(eval):1: no matches found" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "curl -s \"http://localhost:3000/api/hello?name=alice\"" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: `{"message":"Hello, alice!","id":"${ID}"}` }] }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "```json\n{\"name\":\"alice\",\"id\":\"" + ID + "\"}\n```" }] } },
  { type: "result", subtype: "success", is_error: false, result: "```json\n{\"name\":\"alice\",\"id\":\"" + ID + "\"}\n```", num_turns: 3, total_cost_usd: 0.008, duration_ms: 7015, usage: { input_tokens: 6042, output_tokens: 424, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
];

test("parseTranscript folds a Claude Code JSON transcript into calls, results, text, usage and cost", () => {
  const t = parseTranscript(JSON.stringify(TRANSCRIPT));
  assert.equal(t.model, "claude-haiku-4-5");
  assert.equal(t.toolCalls.length, 2);
  assert.equal(t.toolCalls[1].name, "Bash");
  assert.equal(t.toolResults.length, 2);
  assert.equal(t.toolResults[0].ok, false);
  assert.equal(t.toolResults[1].ok, true);
  assert.match(t.toolResults[1].content, /Hello, alice!/);
  assert.deepEqual(t.usage, { prompt_tokens: 6042, completion_tokens: 424, total_tokens: 6466 });
  assert.equal(t.costUsd, 0.008);
  assert.equal(t.turns, 3);
  assert.match(t.text, /alice/);
});

test("greetingsIn recovers the webserver's replies from raw tool output", () => {
  const text = `  % Total\n{"message":"Hello, alice!","id":"${ID}"}\nsome noise {"status":"ok"} {"message":"Hello, bob!","id":"other-id"}`;
  assert.deepEqual(greetingsIn(text), [{ name: "alice", message: "Hello, alice!", id: ID }, { name: "bob", message: "Hello, bob!", id: "other-id" }]);
  assert.deepEqual(greetingsIn("nothing here"), []);
});

test("synthesized tool results let lookup, chain and hello grounds work from a real harness", () => {
  const texts = [`{"message":"Hello, alice!","id":"${ID}"}`, `{"message":"Hello, ${ID}!","id":"second"}`];
  const chain = getTask("chain");
  const synth = synthesizeToolResults(chain, "harness", texts);
  assert.equal(synth.length, 1);
  assert.equal(synth[0].name, "hello");
  assert.deepEqual(chain.eval.ground({ toolResults: synth }), { firstId: ID, expected: `Hello, ${ID}!` });
  const lookup = getTask("lookup");
  const g = lookup.eval.ground({ toolResults: synthesizeToolResults(lookup, "harness", [texts[0]]) });
  assert.deepEqual(g[0], { name: "alice", ids: [ID] });
  assert.deepEqual(synthesizeToolResults(getTask("health"), "harness", texts), [], "health declares no name tool, nothing to synthesize");
});

test("goalPrompt appends the same schema instruction the synthetic harness uses", () => {
  const p = goalPrompt(getTask("health"), "harness", "fallback");
  assert.match(p, /A webserver runs at/);
  assert.match(p, /instance of this JSON Schema/);
  assert.equal(goalPrompt({ goal: "g" }, "harness", "f"), "g");
  assert.equal(goalPrompt(null, "harness", "f"), "f");
});

test("a claude-code arm trial runs end to end through a stub binary and scores lookup from recovered results", async () => {
  const stub = join(mkdtempSync(join(tmpdir(), "cc-stub-")), "claude.js");
  const transcript = JSON.stringify(TRANSCRIPT).replace(/\\"name\\":\\"alice\\",\\"id\\":\\"[^"]*\\"/, "");
  writeFileSync(stub, `const a = process.argv.slice(2); const want = ["-p", "--bare", "--output-format", "--allowedTools", "--permission-mode", "--model"]; for (const w of want) if (!a.includes(w)) { process.stderr.write("missing " + w); process.exit(3); } if (process.env.CLAUDECODE) { process.stderr.write("nested guard not cleared"); process.exit(4); } process.stdout.write(${JSON.stringify(JSON.stringify(TRANSCRIPT))});`);
  const client = new ClaudeCodeClient({ name: "claude-code:test", model: "claude-haiku-4-5", command: `${process.execPath} ${stub}` });
  // The stub's "result" reports alice's id, which is exactly what the lookup task wants for alice.
  const task = { ...getTask("lookup"), goal: "fetch alice", harness: { ...getTask("lookup").harness } };
  const row = await runTrial({ task, mode: "harness", client });
  assert.equal(row.error, null, row.error ?? "");
  assert.equal(row.harness, "claude-code");
  assert.equal(row.model, "claude-haiku-4-5");
  assert.equal(row.toolCalls.length, 2);
  assert.ok(row.toolResults.some((r) => r.synthesized), "bench-shaped results were recovered from Bash output");
  assert.deepEqual(row.ground[0], { name: "alice", ids: [ID] });
  assert.match(row.reason, /1\/3 ids match|never looked up bob, carol/);
  assert.equal(row.usage.total_tokens, 6466);
});

test("synthesizeToolResults merges the server's own log with output-recovered greetings, by id", () => {
  const served = [{ name: "alice", message: "Hello, alice!", id: ID }, { name: "bob", message: "Hello, bob!", id: "bob-id" }];
  // The output only shows a jq-reshaped object with no message, so alice comes from the server log.
  const synth = synthesizeToolResults(getTask("lookup"), "harness", ['{"name": null, "id": "' + ID + '"}'], served);
  const ground = getTask("lookup").eval.ground({ toolResults: synth });
  assert.deepEqual(ground[0], { name: "alice", ids: [ID] });
  assert.deepEqual(ground[1], { name: "bob", ids: ["bob-id"] });
  assert.deepEqual(ground[2], { name: "carol", ids: [] });
  // Duplicates across the two sources collapse.
  const both = synthesizeToolResults(getTask("lookup"), "harness", [`{"message":"Hello, alice!","id":"${ID}"}`], served);
  assert.equal(JSON.parse(both[0].content).greetings.filter((g) => g.id === ID).length, 1);
});

test("recentGreetings is empty when the endpoint is missing or unreachable", async () => {
  const { recentGreetings } = await import("../src/harness/util.js");
  assert.deepEqual(await recentGreetings("http://127.0.0.1:9", "2026-01-01T00:00:00.000Z"), []);
});

test("eventTimings reads first-output and final-answer times off timestamped lines", async () => {
  const { eventTimings } = await import("../src/harness/util.js");
  const lines = [
    { t: 10, line: '{"type":"system"}' },
    { t: 250, line: '{"type":"assistant","message":{}}' },
    { t: 900, line: '{"type":"user"}' },
    { t: 1400, line: '{"type":"assistant","message":{}}' },
    { t: 1500, line: '{"type":"result"}' },
  ];
  const t = eventTimings(lines, (l) => /"type":"assistant"/.test(l), (l) => /"type":"result"/.test(l));
  assert.deepEqual(t, { ttftMs: 250, ttfaMs: 1500 });
  assert.deepEqual(eventTimings([], () => true, () => true), { ttftMs: null, ttfaMs: null });
});

test("parseTranscript accepts stream-json (one message per line) as well as the json array", () => {
  const msgs = [
    { type: "system", subtype: "init", model: "claude-haiku-4-5" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "curl x" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] } },
    { type: "result", result: "{\"ok\":1}", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001, num_turns: 2 },
  ];
  const fromLines = parseTranscript(msgs.map((m) => JSON.stringify(m)).join("\n"));
  const fromArray = parseTranscript(JSON.stringify(msgs));
  assert.equal(fromLines.text, fromArray.text);
  assert.equal(fromLines.toolResults[0].content, "out");
  assert.equal(fromLines.model, "claude-haiku-4-5");
});
