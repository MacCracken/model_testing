// Cost in currency ([45]) and the reasoning-effort knob ([46]): the price table and its matching,
// the cost of a row, the run's cost view, the index columns, the report block; the effort levels,
// their per-provider translation, the @effort variant and the run-level --effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hb-cost-"));
process.env.PRICES_FILE = join(dir, "prices.json");
writeFileSync(process.env.PRICES_FILE, JSON.stringify({
  _comment: "ignored",
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6, per: 1000000, asOf: "2026-09-11", source: "x" },
  "openai:special": { input: 10, output: 20 },
  "local:*": { input: 0, output: 0, note: "local" },
  "claude-*": { input: 1, output: 5 },
}));
process.env.RESULTS_DIR = join(dir, "results");
const { loadPrices, priceFor, costOf, pricingFor, fmtUsd, describePrice } = await import("../src/prices.js");
const { summarize, costStats, costView, runTrial } = await import("../src/runner.js");
const { printSummary } = await import("../src/report.js");
const { EFFORT_LEVELS, parseEffortSuffix, effortParams, withEffort, describeEffort } = await import("../src/effort.js");
const { parseClientSpec, resolveClients, buildClient } = await import("../src/providers/index.js");
const { modelParamsFrom } = await import("../src/bench.js");
const { task: health } = await import("../src/tasks/health.js");

test("the price table: exact client, model id, a provider/ prefix dropped, wildcards; unknown models unpriced", () => {
  const { entries } = loadPrices({ force: true });
  assert.deepEqual(Object.keys(entries), ["gpt-4o-mini", "openai:special", "local:*", "claude-*"]);
  assert.equal(priceFor("openai:gpt-4o-mini").id, "gpt-4o-mini");
  assert.equal(priceFor("openai:gpt-4o-mini@format:work").id, "gpt-4o-mini", "a variant is priced as its base");
  assert.equal(priceFor("pi:openai/gpt-4o-mini").id, "gpt-4o-mini", "an arm's routed model");
  assert.equal(priceFor("openai:special").id, "openai:special");
  assert.equal(priceFor("local:ornith-1.5:9b").id, "local:*");
  assert.equal(priceFor("local:ornith-1.5:9b").input, 0);
  assert.equal(priceFor("anthropic:claude-haiku-4-5").id, "claude-*");
  assert.equal(priceFor("openai:gpt-9-ultra"), null);
  assert.equal(priceFor("claude-code:claude-haiku-4-5", { model: "claude-haiku-4-5" }).id, "claude-*");
  assert.match(describePrice(entries["gpt-4o-mini"]), /gpt-4o-mini: \$0\.15\/M in \(\$0\.075 cached\), \$0\.6\/M out, as of 2026-09-11/);
  assert.equal(describePrice(null), "no price");
});

test("the cost of a row: input, cached input and output at their rates; null without usage or price", () => {
  const price = priceFor("openai:gpt-4o-mini");
  const c = costOf({ prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } }, price);
  assert.ok(Math.abs(c.input - (600 * 0.15 + 400 * 0.075) / 1e6) < 1e-12);
  assert.ok(Math.abs(c.output - (500 * 0.6) / 1e6) < 1e-12);
  assert.ok(Math.abs(c.usd - (c.input + c.output)) < 1e-15);
  assert.equal(c.cachedTokens, 400);
  assert.deepEqual([c.currency, c.asOf, c.price], ["USD", "2026-09-11", "gpt-4o-mini"]);
  assert.equal(costOf(null, price), null);
  assert.equal(costOf({ prompt_tokens: 1 }, null), null);
  assert.equal(costOf({ prompt_tokens: 10, completion_tokens: 0 }, priceFor("anthropic:claude-x")).usd, 10 / 1e6, "no cached rate: the input rate applies");
  const pricing = pricingFor();
  assert.equal(pricing({ name: "openai:gpt-9-ultra", model: "gpt-9-ultra" }, { prompt_tokens: 1 }), null);
  assert.equal(pricing({ name: "openai:gpt-4o-mini", model: "gpt-4o-mini" }, null).unpriced, "no usage");
  assert.ok(pricing({ name: "openai:gpt-4o-mini", model: "gpt-4o-mini" }, { prompt_tokens: 1000, completion_tokens: 0 }).usd > 0);
  assert.deepEqual([fmtUsd(0), fmtUsd(0.000123), fmtUsd(0.0123), fmtUsd(0.004), fmtUsd(12.3), fmtUsd(null)], ["$0", "$0.00012", "$0.0123", "$0.004", "$12.30", "—"]);
});

const row = (client, mode, correct, usd, extra = {}) => ({ task: "health", mode, client, model: client.split(":")[1], index: 1, correct, latencyMs: 100, usage: { total_tokens: 100 }, cost: usd === null ? null : { usd }, ...extra });

test("cost stats and the cost view: totals, per trial, per correct, unpriced rows counted; the report prints the block", () => {
  const rows = [row("openai:gpt-4o-mini", "harness", true, 0.001), row("openai:gpt-4o-mini", "harness", false, 0.003), row("openai:gpt-4o-mini", "harness", true, null), row("local:m", "harness", true, 0), row("x:unpriced", "noHarness", true, null)];
  const st = costStats(rows.slice(0, 3));
  assert.ok(Math.abs(st.costUsd - 0.004) < 1e-12);
  assert.ok(Math.abs(st.costPerTrialUsd - 0.002) < 1e-12);
  assert.ok(Math.abs(st.costPerCorrectUsd - 0.004) < 1e-12, "per correct counts the priced correct rows only");
  assert.deepEqual([st.priced, st.unpriced], [2, 1]);
  assert.deepEqual(costStats([row("x", "harness", true, null)]), { costUsd: null, costPerTrialUsd: null, costPerCorrectUsd: null, priced: 0, unpriced: 1 });
  assert.equal(costStats([row("x", "harness", false, 0.5)]).costPerCorrectUsd, null, "nothing correct: no per-correct figure");
  const view = costView(rows);
  assert.deepEqual(view.map((v) => [v.client, v.mode, v.runs, v.priced, v.unpriced]), [["openai:gpt-4o-mini", "harness", 3, 2, 1], ["local:m", "harness", 1, 1, 0], ["x:unpriced", "noHarness", 1, 0, 1]]);
  assert.equal(view[1].costUsd, 0);
  const s = summarize(rows);
  assert.equal(s.cost.length, 3);
  assert.ok(Math.abs(s.byMode.harness.costUsd - 0.004) < 1e-12, "statsFor carries the cost fields");
  assert.equal(s.cells.find((c) => c.client === "x:unpriced").priced, 0);
  const lines = [];
  printSummary(s, { log: (l) => lines.push(l) });
  const block = lines.join("\n");
  assert.match(block, /-- correctness × cost × latency/);
  assert.match(block, /openai:gpt-4o-mini\s+harness\s+2\/3 \(67%\)\s+\$0\.004 total\s+\$0\.002\/trial\s+\$0\.004\/correct\s+p50 100ms\s+\(1 unpriced\)/);
  assert.match(block, /x:unpriced\s+noHarness\s+1\/1 \(100%\)\s+— total/);
});

test("the runner prices a row from the pricing it is given, and records the reasoning characters the client reports", async () => {
  const client = { name: "openai:gpt-4o-mini", model: "gpt-4o-mini", async chat() { return { text: "status: ok\nuptime: 1", usage: { prompt_tokens: 1000, completion_tokens: 100 }, reasoningChars: 42 }; } };
  const r = await runTrial({ task: health, mode: "noHarness", client, index: 1, pricing: pricingFor() });
  assert.ok(r.cost && Math.abs(r.cost.usd - (1000 * 0.15 + 100 * 0.6) / 1e6) < 1e-12);
  assert.equal(r.cost.price, "gpt-4o-mini");
  assert.equal(r.reasoningChars, 42);
  const unpriced = await runTrial({ task: health, mode: "noHarness", client: { ...client, name: "openai:gpt-9", model: "gpt-9" }, index: 1, pricing: pricingFor() });
  assert.equal(unpriced.cost, null);
  const none = await runTrial({ task: health, mode: "noHarness", client, index: 1 });
  assert.equal(none.cost, null, "no pricing given: nothing priced");
});

test("the index carries cost_usd per trial and per cell", async () => {
  const { saveRun } = await import("../src/results.js");
  const { indexRuns, rawQuery, closeStore } = await import("../src/store.js");
  const rows = [row("openai:gpt-4o-mini", "harness", true, 0.001, { effort: { how: "low", applied: true } }), row("openai:gpt-4o-mini", "harness", false, 0.003), row("x:unpriced", "harness", true, null)];
  saveRun({ id: "20260911T000000-cost", createdAt: "2026-09-11T00:00:00Z", status: "done", config: { tasks: ["health"], modes: ["harness"], clients: ["openai:gpt-4o-mini", "x:unpriced"], count: 2 }, rows, summary: summarize(rows) });
  indexRuns({ full: true });
  const t = rawQuery("select client, cost_usd, effort from trials where run_id = '20260911T000000-cost' order by idx");
  assert.deepEqual(t.map((x) => [x.client, x.cost_usd, x.effort]), [["openai:gpt-4o-mini", 0.001, "low"], ["openai:gpt-4o-mini", 0.003, null], ["x:unpriced", null, null]]);
  const c = rawQuery("select client, cost_usd from cells where run_id = '20260911T000000-cost' order by client");
  assert.equal(c.length, 2);
  assert.ok(Math.abs(c[0].cost_usd - 0.004) < 1e-12);
  assert.equal(c[1].cost_usd, null);
  closeStore();
});

test("effort: the levels, their translation per provider, and the two ways to ask for one", () => {
  assert.deepEqual(EFFORT_LEVELS, ["none", "minimal", "low", "medium", "high"]);
  assert.deepEqual(parseEffortSuffix("local:ornith-1.5:9b@effort:none"), { base: "local:ornith-1.5:9b", how: "none" });
  assert.deepEqual(parseEffortSuffix("openai:gpt-5-mini@effort"), { base: "openai:gpt-5-mini", how: "none" });
  assert.deepEqual(parseEffortSuffix("openai:gpt-5-mini"), { base: "openai:gpt-5-mini", how: null });
  assert.throws(() => parseEffortSuffix("x@effort:max"), /unknown effort level "max"/);
  assert.deepEqual(effortParams("openai", "low"), { reasoning_effort: "low" });
  assert.deepEqual(effortParams("anthropic", "high"), { reasoning_effort: "high" });
  assert.deepEqual(effortParams("local", "none"), { reasoning: { effort: "none" } });
  assert.deepEqual(effortParams("local", "low"), { reasoning: { effort: "low" } });
  assert.deepEqual(effortParams("mistral", "low"), {}, "no such parameter on that route: nothing sent");
  assert.deepEqual(effortParams("openai", null), {});
  assert.throws(() => effortParams("openai", "max"), /unknown effort level/);
  assert.match(describeEffort("local", "none"), /none → reasoning=\{"effort":"none"\}/);
  assert.match(describeEffort("mistral", "low"), /nothing sent/);
  // The variant: the same client, the level's parameters added to every call, paired by baseName.
  const calls = [];
  const base = { name: "local:m", provider: "local", model: "m", chat: async (messages, tools, opts) => { calls.push(["chat", opts]); return { text: "x" }; }, runWithTools: async (p, t, s, opts) => { calls.push(["run", opts]); return { text: "y" }; } };
  const v = withEffort(base, "none");
  assert.deepEqual([v.name, v.baseName, v.effort, v.effortParams], ["local:m@effort:none", "local:m", "none", { reasoning: { effort: "none" } }]);
  assert.throws(() => withEffort(base, "max"), /unknown effort level/);
  return Promise.all([v.chat([], [], { signal: "s" }), v.runWithTools("p", [], null, { maxRounds: 2 })]).then(() => {
    assert.deepEqual(calls[0], ["chat", { signal: "s", extraParams: { reasoning: { effort: "none" } } }]);
    assert.deepEqual(calls[1], ["run", { maxRounds: 2, extraParams: { reasoning: { effort: "none" } } }]);
  });
});

test("effort through the client spec and the run-level knob: @effort resolves to a paired variant, --effort is translated when the client is built", () => {
  assert.deepEqual(parseClientSpec("local:ornith-1.5:9b@effort:none"), { provider: "local", model: "ornith-1.5:9b", effort: "none" });
  assert.throws(() => parseClientSpec("local:m@format:work@effort:none"), /one variant per client/);
  const [plain, variant] = resolveClients("local:ornith-1.5:9b,local:ornith-1.5:9b@effort:none");
  assert.equal(plain.name, "local:ornith-1.5:9b");
  assert.equal(variant.name, "local:ornith-1.5:9b@effort:none");
  assert.equal(variant.baseName, "local:ornith-1.5:9b");
  assert.deepEqual(variant.effortParams, { reasoning: { effort: "none" } });
  assert.deepEqual(modelParamsFrom({ temperature: 0, effort: "low" }), { temperature: 0, effort: "low" });
  const built = buildClient({ provider: "local", model: "ornith-1.5:9b", modelParams: { temperature: 0, effort: "none" } });
  assert.deepEqual(built.modelParams, { temperature: 0, reasoning: { effort: "none" } }, "the knob is translated; the raw word is not sent");
  const graded = buildClient({ provider: "openai", model: "gpt-5-mini", modelParams: { effort: "high" } });
  assert.deepEqual(graded ? graded.modelParams : { reasoning_effort: "high" }, { reasoning_effort: "high" });
});

test("a run with an effort variant pairs it against the base, with the reasoning characters", () => {
  const rows = [
    ...[1, 2, 3, 4].map((i) => ({ task: "health", mode: "harness", client: "local:m", model: "m", index: i, correct: i !== 4, latencyMs: 10, usage: null, reasoningChars: 400 })),
    ...[1, 2, 3, 4].map((i) => ({ task: "health", mode: "harness", client: "local:m@effort:none", baseClient: "local:m", model: "m", index: i, correct: i !== 1 && i !== 2, latencyMs: 5, usage: null, reasoningChars: 0, effort: { how: "none", applied: true, params: { reasoning: { effort: "none" } } } })),
  ];
  const s = summarize(rows);
  assert.ok(s.delta.effort?.none, "pooled by level");
  assert.equal(s.delta.effort.none.reasoningCharsMean, 0);
  assert.equal(s.delta.byEffort["health|harness|local:m@effort:none"].baseClient, "local:m");
  assert.equal(s.delta.effort.none.deltaPp, -25);
  assert.deepEqual(s.cost.map((c) => [c.client, c.reasoningCharsMean]), [["local:m", 400], ["local:m@effort:none", 0]]);
  const lines = [];
  printSummary(s, { log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /-- effort variants[\s\S]*@effort:none[\s\S]*reasoning 0 chars/);
});
