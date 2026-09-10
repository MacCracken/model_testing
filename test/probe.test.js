// The readiness probe (`cli probe`): every verdict through a fake client — ready; a route that
// drops tools; an answer that is not JSON; a refused reasoning parameter; a model the route does
// not list; a request that throws — and the printed report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeClient, describeProbe } from "../src/probe.js";

// A fake endpoint client: answers plainly, calls the echo tool and repeats the token, returns JSON
// when asked, and takes the reasoning parameter — unless a flaw is asked for.
function fake({ flaw = null, provider = "local" } = {}) {
  return {
    name: `${provider}:m`, model: "m", provider,
    async chat(messages, tools, opts = {}) {
      const ask = messages.at(-1).content;
      if (opts.extraParams && flaw === "refuses-reasoning") throw new Error("400: unknown parameter reasoning");
      if (/JSON/.test(ask)) return { text: flaw === "no-json" ? "Sure! Here you go." : '{"ok": true, "n": 3}', usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }, ttftMs: 120, reasoningChars: 0 };
      if (flaw === "throws") throw new Error("ECONNREFUSED 127.0.0.1:8000");
      return { text: flaw === "empty" ? "" : "OK", usage: flaw === "no-usage" ? null : { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 }, ttftMs: 90, reasoningChars: 0 };
    },
    async runWithTools(prompt, tools, system, opts) {
      const echo = tools.find((t) => t.name === "echo");
      if (flaw === "drops-tools") return { text: "pong", toolCalls: [], toolResults: [], rounds: 1, usage: null };
      const out = await echo.impl({ word: "ping" });
      const text = flaw === "ignores-result" ? "The token is XXXX." : out.token;
      return { text, toolCalls: [{ id: "c1", name: "echo", arguments: { word: "ping" } }], toolResults: [{ id: "c1", name: "echo", ok: true, content: JSON.stringify(out) }], rounds: 2, usage: null };
    },
  };
}
const ids = (p) => Object.fromEntries(p.checks.map((c) => [c.id, c.ok]));

test("a ready endpoint: listed, answers with usage, calls the tool and takes the token, JSON, the reasoning parameter accepted", async () => {
  const p = await probeClient(fake(), { listModels: async () => ["m", "other"] });
  assert.deepEqual(ids(p), { listed: true, answers: true, usage: true, tools: true, json: true, reasoning: true });
  assert.equal(p.ready, true);
  assert.match(p.checks.find((c) => c.id === "listed").note, /lists it \(2 models\)/);
  assert.match(p.checks.find((c) => c.id === "answers").note, /"OK", first token 90 ms, 15\+3 tokens/);
  assert.match(p.checks.find((c) => c.id === "tools").note, /called echo and took the result \(2 rounds\)/);
  assert.match(p.checks.find((c) => c.id === "reasoning").note, /reasoning=\{"effort":"none"\} accepted/);
  const text = describeProbe(p);
  assert.match(text, /^local:m — readiness for the bench\n  ✓ listed/);
  assert.match(text, /ready: yes — a harness-mode run will work/);
});

test("the flaws each fail their own check with the note that explains it, and the verdict follows the checks a harness run depends on", async () => {
  const drops = await probeClient(fake({ flaw: "drops-tools" }), { listModels: async () => ["m"] });
  assert.equal(drops.ready, false);
  assert.match(drops.checks.find((c) => c.id === "tools").note, /no tool call \(the route may not pass tools through; it answered "pong"\)/);
  assert.match(describeProbe(drops), /ready: no — tools$/m);
  const ignores = await probeClient(fake({ flaw: "ignores-result" }), { listModels: async () => ["m"] });
  assert.equal(ignores.ready, false);
  assert.match(ignores.checks.find((c) => c.id === "tools").note, /called echo but the answer does not carry the token/);
  const nojson = await probeClient(fake({ flaw: "no-json" }), { listModels: async () => ["m"] });
  assert.equal(nojson.ready, false);
  assert.match(nojson.checks.find((c) => c.id === "json").note, /not the object asked for: "Sure! Here you go."/);
  const refused = await probeClient(fake({ flaw: "refuses-reasoning" }), { listModels: async () => ["m"] });
  assert.equal(refused.ready, true, "the reasoning knob is not a readiness requirement");
  assert.equal(refused.checks.find((c) => c.id === "reasoning").ok, false);
  assert.match(refused.checks.find((c) => c.id === "reasoning").note, /refused: 400: unknown parameter reasoning/);
  const unlisted = await probeClient(fake(), { listModels: async () => ["a", "b"] });
  assert.equal(unlisted.ready, false);
  assert.match(unlisted.checks.find((c) => c.id === "listed").note, /does not list "m" \(a, b\)/);
  const nolist = await probeClient(fake(), { listModels: async () => [] });
  assert.equal(nolist.checks.find((c) => c.id === "listed").ok, null, "a route that lists nothing is not judged");
  assert.equal(nolist.ready, true);
  assert.match(describeProbe(nolist), /· listed/);
  const nousage = await probeClient(fake({ flaw: "no-usage" }), { listModels: async () => ["m"] });
  assert.equal(nousage.checks.find((c) => c.id === "usage").ok, false);
  assert.equal(nousage.ready, true, "usage is advice, not a requirement");
  const empty = await probeClient(fake({ flaw: "empty" }), { listModels: async () => ["m"] });
  assert.equal(empty.checks.find((c) => c.id === "answers").ok, false);
  assert.equal(empty.ready, false);
});

test("a request that throws is a failed check with the error, not a crash; a provider without a reasoning parameter is not judged; a failed listing is a note", async () => {
  const thrown = await probeClient(fake({ flaw: "throws" }), { listModels: async () => { throw new Error("fetch failed"); } });
  assert.equal(thrown.checks.find((c) => c.id === "answers").ok, false);
  assert.match(thrown.checks.find((c) => c.id === "answers").note, /error: ECONNREFUSED/);
  assert.equal(thrown.checks.find((c) => c.id === "usage").ok, null);
  assert.match(thrown.checks.find((c) => c.id === "listed").note, /could not read \/v1\/models: fetch failed/);
  assert.equal(thrown.ready, false);
  const mistral = await probeClient(fake({ provider: "mistral" }), { listModels: async () => ["m"] });
  assert.equal(mistral.checks.find((c) => c.id === "reasoning").ok, null);
  assert.match(mistral.checks.find((c) => c.id === "reasoning").note, /mistral takes no reasoning parameter/);
  assert.equal(mistral.ready, true);
  const openai = await probeClient(fake({ provider: "openai" }), { listModels: null, effort: "low" });
  assert.match(openai.checks.find((c) => c.id === "reasoning").note, /reasoning_effort="low" accepted/);
  assert.equal(openai.checks.find((c) => c.id === "listed").ok, null);
});
