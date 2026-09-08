import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentsSuffix, withDelegation, AGENT_MODES } from "../src/agents.js";
import { summarize } from "../src/runner.js";
import { resolveClients } from "../src/providers/index.js";

test("parseAgentsSuffix reads the @agents variant off a client spec", () => {
  assert.deepEqual(AGENT_MODES, ["available", "required"]);
  assert.deepEqual(parseAgentsSuffix("openai:gpt-4o-mini"), { base: "openai:gpt-4o-mini", how: null });
  assert.deepEqual(parseAgentsSuffix("openai:gpt-4o-mini@agents"), { base: "openai:gpt-4o-mini", how: "available" });
  assert.deepEqual(parseAgentsSuffix("claude-code:claude-haiku-4-5@agents:required"), { base: "claude-code:claude-haiku-4-5", how: "required" });
  assert.throws(() => parseAgentsSuffix("x@agents:swarm"), /unknown sub-agent mode/);
});

// A client whose parent turn delegates twice (sequentially here; the real loop runs a turn's calls
// together) and whose children each make one tool call.
function fakeClient() {
  const calls = [];
  const client = {
    name: "local:m", model: "m", provider: "local",
    async chat() { return { text: "ok", toolCalls: [], finishReason: "stop", usage: { total_tokens: 1 } }; },
    async runWithTools(prompt, tools, system, opts) {
      calls.push({ prompt, tools: tools.map((t) => t.name), system, opts });
      const delegate = tools.find((t) => t.name === "delegate");
      if (delegate) {
        const results = [];
        for (const goal of ["do A", "do B"]) {
          try { results.push(await delegate.impl({ goal })); } catch (err) { results.push({ error: err.message }); }
        }
        return {
          text: JSON.stringify(results), structured: results,
          toolCalls: results.map((_, i) => ({ id: String(i + 1), name: "delegate", arguments: { goal: ["do A", "do B"][i] } })),
          toolResults: results.map((r, i) => ({ id: String(i + 1), name: "delegate", ok: !r.error, content: JSON.stringify(r) })),
          rounds: 2, finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      return {
        text: `did ${prompt}`, structured: null,
        toolCalls: [{ id: "c", name: "update_item", arguments: { id: prompt } }],
        toolResults: [{ id: "c", name: "update_item", ok: true, content: "{}" }],
        rounds: 1, finishReason: "stop", usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      };
    },
  };
  return { calls, client };
}

test("the parent gets a delegate tool; children run with the task's tools only and fold back into the record", async () => {
  const { calls, client } = fakeClient();
  const w = withDelegation(client, "available");
  assert.equal(w.name, "local:m@agents:available");
  assert.equal(w.baseName, "local:m");
  assert.equal(w.agents, "available");
  const r = await w.runWithTools("parent goal", [{ name: "update_item", impl: async () => "" }], "sys", { task: { name: "restock3" }, mode: "harness", maxRounds: 9 });
  assert.deepEqual(calls[0].tools, ["update_item", "delegate"]);
  assert.match(calls[0].system, /^sys\n\nSub-agents: you have a delegate tool/);
  assert.deepEqual(calls[1].tools, ["update_item"], "a child never gets delegate — depth stays at one");
  assert.match(calls[1].system, /sub-agent working one piece/);
  assert.equal(calls[1].prompt, "do A");
  assert.equal(calls[1].opts.maxRounds, 9, "children keep the task's round budget");
  assert.equal(r.agents.applied, true);
  assert.match(r.effectiveSystem, /delegate tool/);
  assert.equal(r.agents.delegations, 2);
  assert.equal(r.agents.childCalls, 2);
  assert.equal(r.agents.childTokens, 12);
  assert.equal(r.agents.children[1].answer, "did do B");
  assert.equal(r.toolCalls.length, 4, "parent's two delegate calls plus the children's two");
  assert.deepEqual(r.toolCalls.slice(2).map((c) => c.agent), [1, 2]);
  assert.equal(r.toolResults.length, 4);
  assert.equal(r.usage.total_tokens, 27, "parent 15 + children 12");
  assert.deepEqual(r.structured.map((x) => x.subAgent), [1, 2]);
  const free = await w.chat([{ role: "user", content: "hi" }], undefined, {});
  assert.deepEqual(free.agents.applied, false);
});

test("the child limit is a tool error the parent sees; 'required' changes the instruction", async () => {
  const { calls, client } = fakeClient();
  const w = withDelegation(client, "required", { maxChildren: 1 });
  const r = await w.runWithTools("p", [], "sys", { task: {}, mode: "harness" });
  assert.match(calls[0].system, /Do the per-item work through sub-agents/);
  assert.equal(r.agents.delegations, 1);
  assert.match(r.structured[1].error, /sub-agent limit \(1\) reached/);
  assert.throws(() => withDelegation(client, "swarm"), /unknown sub-agent mode/);
});

test("arms get the request in opts and report their own channel, or none", async () => {
  const seen = [];
  const capable = { name: "arm:x", model: "m", structuredOnly: true, async runWithTools(p, t, s, opts) { seen.push(opts); return { text: "{}", structured: {}, toolCalls: [], toolResults: [], rounds: 1, agents: { how: opts.agents.how, applied: "native", delegations: 3, childCalls: 0, childTokens: 0, children: [] } }; } };
  const a = await withDelegation(capable, "available").runWithTools("p", [], "s", { task: {}, mode: "harness" });
  assert.deepEqual(seen[0].agents, { how: "available" });
  assert.equal(a.agents.applied, "native");
  assert.equal(a.agents.delegations, 3);
  const mute = { name: "arm:y", model: "m", structuredOnly: true, async runWithTools() { return { text: "{}", structured: {}, toolCalls: [], toolResults: [], rounds: 1 }; } };
  const b = await withDelegation(mute, "available").runWithTools("p", [], "s", { task: {}, mode: "harness" });
  assert.equal(b.agents.applied, false, "no channel → the treatment did not happen, and the row says so");
});

test("summarize pairs delegation variants with their base client, separately from skills", () => {
  const row = (client, correct, i, over = {}) => ({ task: "restock12", mode: "harness", client, model: "m", index: i, correct, toolCalls: [], latencyMs: 1, ...over });
  const ag = (delegations) => ({ baseClient: "local:m", agents: { how: "available", applied: true, delegations, childCalls: delegations, childTokens: delegations * 100, children: [] } });
  const rows = [
    row("local:m", false, 1), row("local:m", false, 2), row("local:m", true, 3), row("local:m", false, 4),
    row("local:m@agents:available", true, 1, ag(6)), row("local:m@agents:available", true, 2, ag(0)), row("local:m@agents:available", false, 3, ag(12)), row("local:m@agents:available", true, 4, ag(6)),
    row("local:m@skill:preload", true, 1, { baseClient: "local:m", skill: { how: "preload", applied: "preload", loaded: null } }),
  ];
  const s = summarize(rows);
  const d = s.delta.byAgents["restock12|harness|local:m@agents:available"];
  assert.equal(d.basePct, 25);
  assert.equal(d.treatPct, 75);
  assert.equal(d.how, "available");
  assert.equal(d.used, 3, "trials that delegated at least once");
  assert.equal(d.delegations, 24);
  assert.equal(d.childTokens, 2400);
  assert.equal(s.delta.agents.available.deltaPp, 50);
  assert.equal(s.delta.agents.available.treatRuns, 4);
  assert.deepEqual(Object.keys(s.delta.bySkill), ["restock12|harness|local:m@skill:preload"], "skill pairing is untouched");
  assert.equal(s.delta.skill.preload.treatRuns, 1);
  assert.equal(summarize(rows.slice(0, 4)).delta.agents, null);
});

test("resolveClients wraps @agents and refuses two variants on one client", () => {
  const [plain, delegating] = resolveClients("local:m,local:m@agents:required");
  assert.equal(plain.name, "local:m");
  assert.equal(delegating.name, "local:m@agents:required");
  assert.equal(delegating.baseName, "local:m");
  assert.equal(delegating.model, "m");
  assert.equal(resolveClients("local:m@agents,local:m@agents:available").length, 1);
  assert.throws(() => resolveClients("local:m@skill:preload@agents"), /one variant per client/);
});
