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
  // The loop's turns: what the model said each round, which calls it made, and when.
  assert.equal(r.turns.length, 2);
  assert.deepEqual(r.turns.map((t) => [t.round, t.calls, t.text, t.finishReason]), [[1, ["c1"], "", "tool_calls"], [2, [], "{\"ok\":1}", "stop"]]);
  assert.ok(r.turns.every((t) => typeof t.ms === "number" && t.ms >= 0));
  assert.ok(r.turns[1].ms >= r.turns[0].ms);
});

test("runWithTools out of rounds asks once more without tools and records that forced turn", async () => {
  const client = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    return body.tools
      ? sseFetch([chunk({ tool_calls: [{ index: 0, id: "c9", function: { name: "noop", arguments: "{}" } }] }, "tool_calls"), "[DONE]"])()
      : sseFetch([chunk({ content: "final" }, "stop"), "[DONE]"])();
  } });
  const r = await client.runWithTools("go", [{ name: "noop", parameters: {}, impl: async () => "done" }], "", { maxRounds: 2 });
  assert.equal(r.finishReason, "max_rounds");
  assert.equal(r.text, "final");
  assert.deepEqual(r.turns.map((t) => [t.round, t.calls.length, t.forced ?? false]), [[1, 1, false], [2, 1, false], [3, 0, true]]);
});

test("an HTTP error on a streamed request still surfaces the provider's message", async () => {
  const client = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 }) });
  await assert.rejects(client.chat([{ role: "user", content: "hi" }]), /HTTP 400 from t: bad model/);
});

test("a turn that stops for a tool call it never made is asked once more, and the row's turns say so", async () => {
  const bodies = [];
  let n = 0;
  const client = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    n += 1;
    return n === 1
      ? sseFetch([chunk({ content: "Now I'll extract the fields:" }, "tool_calls"), "[DONE]"])()
      : sseFetch([chunk({ content: "{\"total\":1}" }, "stop"), "[DONE]"])();
  } });
  const r = await client.runWithTools("go", [{ name: "get_document", parameters: {}, impl: async () => "doc" }], "");
  assert.equal(r.text, "{\"total\":1}");
  assert.deepEqual(r.structured, { total: 1 });
  assert.equal(r.rounds, 2);
  assert.deepEqual(r.turns.map((t) => [t.round, t.finishReason, t.retried ?? false]), [[1, "tool_calls", true], [2, "stop", false]]);
  const last = bodies[1].messages.at(-1);
  assert.equal(last.role, "user");
  assert.match(last.content, /stopped for a tool call that never arrived/);
  assert.equal(bodies[1].messages.at(-2).content, "Now I'll extract the fields:");
  // Only once: a second such turn is taken as the answer.
  n = 0;
  const twice = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: async () => sseFetch([chunk({ content: "still nothing" }, "tool_calls"), "[DONE]"])() });
  const r2 = await twice.runWithTools("go", [{ name: "get_document", parameters: {}, impl: async () => "doc" }], "");
  assert.equal(r2.text, "still nothing");
  assert.equal(r2.rounds, 2);
});

test("runWithTools continues a conversation handed in as history and hands it back grown as messages", async () => {
  const bodies = [];
  let n = 0;
  const client = new Client({ name: "t", model: "m", apiKey: "k", url: "http://x", fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    n += 1;
    return n === 1
      ? sseFetch([chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "noop", arguments: "{}" } }] }, "tool_calls"), "[DONE]"])()
      : sseFetch([chunk({ content: "second answer" }, "stop"), "[DONE]"])();
  } });
  const history = [{ role: "user", content: "first question" }, { role: "assistant", content: "first answer" }];
  const r = await client.runWithTools("second question", [{ name: "noop", parameters: {}, impl: async () => "done" }], "sys", { history });
  assert.deepEqual(bodies[0].messages.map((m) => m.role), ["system", "user", "assistant", "user"], "the history sits between the system prompt and the new turn");
  assert.equal(bodies[0].messages[1].content, "first question");
  assert.equal(r.text, "second answer");
  assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "tool", "assistant"], "the returned conversation has no system message and ends with the answer");
  assert.equal(r.messages.at(-1).content, "second answer");
  assert.equal(r.messages[3].tool_calls[0].function.name, "noop");
  assert.equal(r.messages[4].content, "done");
  // Without history the shape is the old one, plus the messages.
  n = 0;
  const single = await client.runWithTools("q", [{ name: "noop", parameters: {}, impl: async () => "done" }], "");
  assert.deepEqual(single.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
});
