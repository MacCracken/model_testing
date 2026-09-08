import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStressSuffix, withStress, summarizeOps, STRESS_MODES } from "../src/stress.js";
import { runTrial, summarize } from "../src/runner.js";
import { resolveClients } from "../src/providers/index.js";

test("parseStressSuffix reads the @stress variant off a client spec", () => {
  assert.deepEqual(STRESS_MODES, ["flaky", "budget", "haystack", "distractors", "injected"]);
  assert.deepEqual(parseStressSuffix("openai:gpt-4o-mini"), { base: "openai:gpt-4o-mini", how: null });
  assert.deepEqual(parseStressSuffix("openai:gpt-4o-mini@stress"), { base: "openai:gpt-4o-mini", how: "flaky" });
  assert.deepEqual(parseStressSuffix("codex:gpt-5.4-mini@stress:budget"), { base: "codex:gpt-5.4-mini", how: "budget" });
  assert.throws(() => parseStressSuffix("x@stress:earthquake"), /unknown stress profile/);
});

test("withStress keeps the client's behaviour and flags; it only names the variant", async () => {
  const client = { name: "arm:x", model: "m", structuredOnly: true, async chat() { return { text: "c" }; }, async runWithTools(p) { return { text: `ran ${p}`, toolCalls: [], toolResults: [] }; } };
  const w = withStress(client, "budget");
  assert.equal(w.name, "arm:x@stress:budget");
  assert.equal(w.baseName, "arm:x");
  assert.equal(w.stress, "budget");
  assert.equal(w.structuredOnly, true);
  assert.equal((await w.runWithTools("p")).text, "ran p");
  assert.equal((await w.chat([])).text, "c");
  assert.throws(() => withStress(client, "nope"), /unknown stress profile/);
});

test("summarizeOps counts what the environment did", () => {
  const ops = [{ op: "list", status: 503 }, { op: "list", status: 200 }, { op: "update", status: 200 }, { op: "history", status: 200 }, { op: "reorder_all", status: 200 }, { op: "confirm", status: 429 }];
  assert.deepEqual(summarizeOps(ops), { requests: 6, failed: 1, rejected: 1, distractorCalls: 2, trap: 1, hijacked: 0 });
  assert.deepEqual(summarizeOps(), { requests: 0, failed: 0, rejected: 0, distractorCalls: 0, trap: 0, hijacked: 0 });
});

test("runTrial hands the client to setup, resolves tools per trial, and records the stress from the ground", async () => {
  const seen = {};
  const task = {
    name: "stressprobe",
    setup: async ({ client }) => { seen.setupClient = client?.name; return { stress: client?.stress ?? null }; },
    harness: {
      prompt: (ctx) => `do ${ctx.stress ?? "plain"}`,
      tools: (ctx) => (ctx.stress === "distractors" ? [{ name: "a", impl: async () => "" }, { name: "trap", impl: async () => "" }] : [{ name: "a", impl: async () => "" }]),
      schema: { type: "object" },
    },
    eval: {
      ground: ({ ctx }) => ({ want: 1, stress: ctx.stress ? { profile: ctx.stress, requests: 5, failed: 2, rejected: 0, distractorCalls: 0, trap: 0 } : null }),
      scoreHarness: () => ({ correct: true, reason: "ok" }),
    },
  };
  let toolsSeen = null;
  const client = { name: "local:m", model: "m", async runWithTools(prompt, tools) { toolsSeen = tools.map((t) => t.name); return { text: "{}", structured: {}, toolCalls: [], toolResults: [], rounds: 1 }; } };
  const plain = await runTrial({ task, mode: "harness", client });
  assert.equal(seen.setupClient, "local:m");
  assert.equal(plain.stress, null);
  assert.deepEqual(toolsSeen, ["a"]);
  const stressed = await runTrial({ task, mode: "harness", client: withStress(client, "distractors") });
  assert.equal(seen.setupClient, "local:m@stress:distractors");
  assert.equal(stressed.prompt, "do distractors");
  assert.deepEqual(toolsSeen, ["a", "trap"], "the tool list follows the trial's context");
  assert.deepEqual(stressed.stress, { how: "distractors", applied: true, profile: "distractors", requests: 5, failed: 2, rejected: 0, distractorCalls: 0, trap: 0 });
  assert.equal(stressed.baseClient, "local:m");
  // A stress variant on a task without the axis: the row says the treatment did not happen.
  const noAxis = { name: "plainprobe", harness: { prompt: "p", tools: [], schema: { type: "object" } }, eval: { ground: () => ({}), scoreHarness: () => ({ correct: true, reason: "" }) } };
  const r = await runTrial({ task: noAxis, mode: "harness", client: withStress(client, "budget") });
  assert.deepEqual(r.stress, { how: "budget", applied: false });
});

test("summarize pairs stress variants with their base client and sums what the environment did", () => {
  const row = (client, correct, i, over = {}) => ({ task: "restock6", mode: "harness", client, model: "m", index: i, correct, toolCalls: [], latencyMs: 1, ...over });
  const st = (rejected) => ({ baseClient: "local:m", stress: { how: "budget", applied: true, profile: "budget", requests: 11, failed: 0, rejected, distractorCalls: 0, trap: 0 } });
  const rows = [
    row("local:m", true, 1), row("local:m", true, 2), row("local:m", true, 3), row("local:m", false, 4),
    row("local:m@stress:budget", true, 1, st(0)), row("local:m@stress:budget", false, 2, st(3)), row("local:m@stress:budget", false, 3, st(5)), row("local:m@stress:budget", true, 4, st(0)),
  ];
  const s = summarize(rows);
  const d = s.delta.byStress["restock6|harness|local:m@stress:budget"];
  assert.equal(d.basePct, 75);
  assert.equal(d.treatPct, 50);
  assert.equal(d.how, "budget");
  assert.equal(d.applied, 4);
  assert.equal(d.rejected, 8);
  assert.equal(d.requests, 44);
  assert.equal(s.delta.stress.budget.deltaPp, -25);
  assert.equal(s.delta.stress.budget.rejected, 8);
  assert.equal(summarize(rows.slice(0, 4)).delta.stress, null);
});

test("resolveClients wraps @stress and keeps one variant per client", () => {
  const [plain, stressed] = resolveClients("local:m,local:m@stress:haystack");
  assert.equal(plain.name, "local:m");
  assert.equal(stressed.name, "local:m@stress:haystack");
  assert.equal(stressed.baseName, "local:m");
  assert.equal(typeof stressed.runWithTools, "function");
  assert.throws(() => resolveClients("local:m@agents@stress:flaky"), /one variant per client/);
});
