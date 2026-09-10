// probe.js — is an endpoint ready for the bench? One command, six checks, a verdict.
//
// A checkpoint served through vLLM, llama.cpp, MLX or Ollama reaches the bench as an
// OpenAI-compatible route, and the bench relies on more of that route than "it answers": the
// model has to be listed, call a tool and take its result back, return JSON when asked, and —
// for a thinking model — accept the reasoning knob the effort treatment sends. `probeClient` runs
// each check through the same client the bench uses and says which passed, with the note that
// explains a failure (the error the route returned, the answer that was not JSON). `ready` is the
// verdict for the checks a harness-mode run depends on: listed (when the route lists at all),
// answers, calls the tool and takes its result, returns JSON. `cli probe <provider:model>` prints
// it and exits 1 when the endpoint is not ready.

import { parseJSONLoose } from "./json.js";
import { effortParams } from "./effort.js";

// A tool the model cannot answer without calling: the token is minted per probe.
const echoTool = (token) => ({
  name: "echo",
  description: "Echo a word back with a one-time token. Returns { echoed, token }.",
  parameters: { type: "object", properties: { word: { type: "string", description: "The word to echo." } }, required: ["word"] },
  impl: async ({ word }) => ({ echoed: String(word ?? ""), token }),
});

const ms = (t0) => Math.round(performance.now() - t0);
const fail = (id, err, t0) => ({ id, ok: false, note: `error: ${String(err?.message ?? err).slice(0, 160)}`, ms: ms(t0) });

export async function probeClient(client, { provider = client?.provider ?? String(client?.name ?? "").split(":")[0], listModels = null, effort = "none" } = {}) {
  const checks = [];
  const model = client.model;

  // 1. Listed: the route's /models names the model. A route that lists nothing is not judged.
  {
    const t0 = performance.now();
    let listed = null, note = "the route lists no models (not judged)";
    if (typeof listModels === "function") {
      try {
        const ids = await listModels(provider);
        if (Array.isArray(ids) && ids.length) { listed = ids.includes(model); note = listed ? `/v1/models lists it (${ids.length} model${ids.length === 1 ? "" : "s"})` : `/v1/models does not list "${model}" (${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ", …" : ""})`; }
      } catch (err) { note = `could not read /v1/models: ${String(err?.message ?? err).slice(0, 120)}`; }
    }
    checks.push({ id: "listed", ok: listed, note, ms: ms(t0) });
  }

  // 2. Answers: a plain completion comes back with text, and streaming reports its usage.
  let answered = false;
  {
    const t0 = performance.now();
    try {
      const r = await client.chat([{ role: "user", content: "Reply with exactly: OK" }]);
      const text = String(r.text ?? "").trim();
      answered = text.length > 0;
      const u = r.usage ?? null;
      const tokens = u ? `${u.prompt_tokens ?? "?"}+${u.completion_tokens ?? "?"} tokens` : "no usage reported";
      checks.push({ id: "answers", ok: answered, note: answered ? `"${text.slice(0, 40).replace(/\s+/g, " ")}"${r.ttftMs != null ? `, first token ${r.ttftMs} ms` : ""}, ${tokens}${r.reasoningChars ? `, ${r.reasoningChars} chars of reasoning` : ""}` : "empty answer", ms: ms(t0) });
      checks.push({ id: "usage", ok: !!(u && (u.total_tokens ?? 0) > 0), note: u && (u.total_tokens ?? 0) > 0 ? "streamed usage present" : "no usage on the stream (the cost view will show the rows unpriced)", ms: 0 });
    } catch (err) { checks.push(fail("answers", err, t0)); checks.push({ id: "usage", ok: null, note: "not reached", ms: 0 }); }
  }

  // 3. Tools: the model calls the tool and repeats the token the result carried.
  let toolsOk = false;
  {
    const t0 = performance.now();
    const token = `T${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
    try {
      const r = await client.runWithTools("Call the echo tool with the word \"ping\", then reply with the token it returns and nothing else.", [echoTool(token)], "You are a tool-using assistant. Use the tool; do not guess its output.", { maxRounds: 3 });
      const calls = (r.toolCalls ?? []).filter((c) => c.name === "echo");
      const took = String(r.text ?? "").includes(token);
      toolsOk = calls.length > 0 && took;
      const note = !calls.length ? `no tool call (the route may not pass tools through${r.text ? `; it answered "${String(r.text).slice(0, 40).replace(/\s+/g, " ")}"` : ""})` : !took ? `called echo but the answer does not carry the token (${JSON.stringify(String(r.text ?? "").slice(0, 60))})` : `called echo and took the result (${r.rounds ?? "?"} round${r.rounds === 1 ? "" : "s"})`;
      checks.push({ id: "tools", ok: toolsOk, note, ms: ms(t0) });
    } catch (err) { checks.push(fail("tools", err, t0)); }
  }

  // 4. JSON: the answer parses when JSON is asked for.
  let jsonOk = false;
  {
    const t0 = performance.now();
    try {
      const r = await client.chat([{ role: "user", content: 'Reply with only this JSON object and nothing else: {"ok": true, "n": 3}' }]);
      const parsed = parseJSONLoose(String(r.text ?? ""));
      jsonOk = !!(parsed && typeof parsed === "object" && parsed.ok === true);
      checks.push({ id: "json", ok: jsonOk, note: jsonOk ? "parsed the object back" : `not the object asked for: ${JSON.stringify(String(r.text ?? "").slice(0, 60))}`, ms: ms(t0) });
    } catch (err) { checks.push(fail("json", err, t0)); }
  }

  // 5. Reasoning knob: the effort treatment's parameter for this provider is accepted.
  {
    const t0 = performance.now();
    const params = effortParams(provider, effort);
    if (!Object.keys(params).length) checks.push({ id: "reasoning", ok: null, note: `${provider} takes no reasoning parameter (nothing sent)`, ms: 0 });
    else {
      try {
        const r = await client.chat([{ role: "user", content: "Reply with exactly: OK" }], undefined, { extraParams: params });
        const sent = Object.entries(params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
        checks.push({ id: "reasoning", ok: true, note: `${sent} accepted${r.reasoningChars ? ` (${r.reasoningChars} chars of reasoning came back regardless)` : ""}`, ms: ms(t0) });
      } catch (err) { checks.push({ id: "reasoning", ok: false, note: `refused: ${String(err?.message ?? err).slice(0, 160)}`, ms: ms(t0) }); }
    }
  }

  const listed = checks.find((c) => c.id === "listed").ok;
  const ready = listed !== false && answered && toolsOk && jsonOk;
  return { client: client.name, model, provider, checks, ready };
}

const MARK = { true: "✓", false: "✗", null: "·" };
export function describeProbe(p) {
  const lines = [`${p.client} — readiness for the bench`];
  for (const c of p.checks) lines.push(`  ${MARK[String(c.ok)]} ${c.id.padEnd(10)} ${c.note}${c.ms ? ` (${(c.ms / 1000).toFixed(1)} s)` : ""}`);
  lines.push(p.ready
    ? `ready: yes — a harness-mode run will work; try node src/bench.js --task health --modes harness --clients ${p.client} --count 1`
    : `ready: no — ${p.checks.filter((c) => c.ok === false && ["listed", "answers", "tools", "json"].includes(c.id)).map((c) => c.id).join(", ") || "see above"}`);
  return lines.join("\n");
}
