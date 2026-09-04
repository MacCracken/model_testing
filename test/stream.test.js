import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "../src/providers/client.js";

// A fetch stand-in that streams the given SSE body in a few pieces, like a real connection.
function sseFetch(lines, { status = 200 } = {}) {
  const body = lines.map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`).join("");
  return async () => {
    const encoder = new TextEncoder();
    const parts = [body.slice(0, 40), body.slice(40, 90), body.slice(90)];
    const stream = new ReadableStream({
      start(controller) { for (const p of parts) if (p) controller.enqueue(encoder.encode(p)); controller.close(); },
    });
    return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
  };
}

const chunk = (delta, finish = null) => ({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });

test("streams text: reasoning marks first token, content marks first answer, usage from the trailing chunk", async () => {
  const client = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: sseFetch([
    chunk({ role: "assistant", content: "", reasoning: "thinking" }),
    chunk({ content: "Hel" }),
    chunk({ content: "lo" }, "stop"),
    { id: "x", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    "[DONE]",
  ]) });
  const r = await client.chat([{ role: "user", content: "hi" }]);
  assert.equal(r.text, "Hello");
  assert.equal(r.finishReason, "stop");
  assert.deepEqual(r.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.ok(typeof r.ttftMs === "number" && r.ttftMs >= 0);
  assert.ok(typeof r.ttfaMs === "number" && r.ttfaMs >= r.ttftMs);
  assert.deepEqual(r.toolCalls, []);
});

test("streams tool calls: arguments split across chunks are reassembled by index", async () => {
  const client = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: sseFetch([
    chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "hello", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"na" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "me\":\"alice\"}" } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "health", arguments: "{}" } }] }),
    chunk({}, "tool_calls"),
    "[DONE]",
  ]) });
  const r = await client.chat([{ role: "user", content: "go" }], [{ name: "hello", parameters: {} }, { name: "health", parameters: {} }]);
  assert.equal(r.finishReason, "tool_calls");
  assert.deepEqual(r.toolCalls, [
    { id: "call_a", name: "hello", arguments: { name: "alice" } },
    { id: "call_b", name: "health", arguments: {} },
  ]);
  assert.equal(r.usage, null, "no usage chunk was sent");
});

test("the request asks for a stream with usage, and stream=false keeps the old path", async () => {
  let seen = null;
  const streaming = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: async (_url, init) => { seen = JSON.parse(init.body); return sseFetch([chunk({ content: "ok" }, "stop"), "[DONE]"])(); } });
  await streaming.chat([{ role: "user", content: "hi" }]);
  assert.equal(seen.stream, true);
  assert.deepEqual(seen.stream_options, { include_usage: true });

  const plain = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", stream: false, fetchImpl: async (_url, init) => { seen = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } }), { status: 200 }); } });
  const r = await plain.chat([{ role: "user", content: "hi" }]);
  assert.equal(seen.stream, undefined);
  assert.equal(r.text, "ok");
  assert.equal(r.ttftMs, null);
});

test("runWithTools keeps the first round's timings", async () => {
  let round = 0;
  const client = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: async () => {
    round += 1;
    return round === 1
      ? sseFetch([chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "noop", arguments: "{}" } }] }, "tool_calls"), "[DONE]"])()
      : sseFetch([chunk({ content: "{\"ok\":1}" }, "stop"), "[DONE]"])();
  } });
  const r = await client.runWithTools("go", [{ name: "noop", parameters: {}, impl: async () => "done" }], "");
  assert.equal(r.rounds, 2);
  assert.deepEqual(r.structured, { ok: 1 });
  assert.ok(typeof r.ttftMs === "number");
});

test("an HTTP error on a streamed request still surfaces the provider's message", async () => {
  const client = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 }) });
  await assert.rejects(client.chat([{ role: "user", content: "hi" }]), /HTTP 400 from t: bad model/);
});
