import { test } from "node:test";
import assert from "node:assert/strict";
import { restockTasks, expectedFrom, endStateVerdict, parseReport, STATUS, toolsFor, distractorTools } from "../src/tasks/restock.js";
import { runTrial } from "../src/runner.js";
import { goalPrompt } from "../src/harness/util.js";

const items = [
  { id: "sku-1001", name: "bolt", qty: 2, min: 10, target: 25, status: "ok" }, // low
  { id: "sku-1002", name: "washer", qty: 30, min: 10, target: 22, status: "ok" },
  { id: "sku-1003", name: "gasket", qty: 9, min: 9, target: 20, status: "ok" }, // qty == min → not low
  { id: "sku-1004", name: "spring", qty: 0, min: 5, target: 12, status: "ok" }, // low
];
const t3 = restockTasks[0];
const untouched = () => items.map((i) => ({ ...i }));
const done = items.map((i) => (i.qty < i.min ? { ...i, qty: i.target, status: STATUS } : { ...i }));
const groundWith = (stateItems, confirmed) => ({ ...expectedFrom(items), state: stateItems ? { items: stateItems, confirmed, ops: 0 } : null });

test("expectedFrom: low items move to target/reordered, others stay, total sums the end state", () => {
  const e = expectedFrom(items);
  assert.deepEqual(e.changed, ["sku-1001", "sku-1004"]);
  assert.equal(e.totalQty, 25 + 30 + 9 + 12);
  assert.deepEqual(e.after["sku-1001"], { qty: 25, status: STATUS });
  assert.deepEqual(e.after["sku-1003"], { qty: 9, status: "ok" });
});

test("endStateVerdict names what is wrong with the server state", () => {
  assert.equal(endStateVerdict(groundWith(done, true)), null);
  assert.equal(endStateVerdict(groundWith(untouched(), false)), "nothing was changed on the server");
  assert.match(endStateVerdict(groundWith(done, false)), /never confirmed/);
  const half = done.map((i) => (i.id === "sku-1004" ? { ...i, qty: 0, status: "ok" } : i));
  assert.match(endStateVerdict(groundWith(half, true)), /1\/2 low items not restocked correctly \(sku-1004\)/);
  const collateral = done.map((i) => (i.id === "sku-1002" ? { ...i, qty: 22 } : i));
  assert.match(endStateVerdict(groundWith(collateral, true)), /1 item\(s\) that were not low got modified \(sku-1002\)/);
  const wrongQty = done.map((i) => (i.id === "sku-1001" ? { ...i, qty: 24 } : i));
  assert.match(endStateVerdict(groundWith(wrongQty, true)), /1\/2 low items/);
  assert.match(endStateVerdict({ ...expectedFrom(items), state: null, error: "fetch failed" }), /could not be read \(fetch failed\)/);
});

test("scoreHarness needs the server state right AND an accurate report", () => {
  const g = groundWith(done, true);
  assert.equal(t3.eval.scoreHarness({ changed: ["sku-1004", "sku-1001"], totalQty: 76 }, g).correct, true);
  assert.equal(t3.eval.scoreHarness({ changed: [{ id: "sku-1001" }, { id: "sku-1004" }], total: 76 }, g).correct, true, "wrapped ids and a 'total' key still score");
  assert.equal(t3.eval.scoreHarness({ changed: "sku-1001, sku-1004", totalQty: 76 }, g).correct, true, "a comma-joined string still scores");
  assert.match(t3.eval.scoreHarness({ changed: ["sku-1001"], totalQty: 76 }, g).reason, /omits 1 changed id/);
  assert.match(t3.eval.scoreHarness({ changed: ["sku-1001", "sku-1004", "sku-1002"], totalQty: 76 }, g).reason, /lists 1 id\(s\) that were not changed/);
  assert.match(t3.eval.scoreHarness({ changed: ["sku-1001", "sku-1004"], totalQty: 70 }, g).reason, /reported total 70 ≠ 76/);
  assert.match(t3.eval.scoreHarness({ changed: ["sku-1001", "sku-1004"] }, g).reason, /no total quantity/);
  assert.match(t3.eval.scoreHarness(null, g).reason, /no structured answer/);
  // A perfect report over an untouched inventory is still wrong: truth is the server.
  assert.equal(t3.eval.scoreHarness({ changed: ["sku-1001", "sku-1004"], totalQty: 76 }, groundWith(untouched(), false)).reason, "nothing was changed on the server");
});

test("free-form report parsing and scoring", () => {
  assert.deepEqual(parseReport("changed: SKU-1001, sku-1004\ntotal: 76"), { ids: ["sku-1001", "sku-1004"], total: 76 });
  assert.deepEqual(parseReport("I updated sku-1001 and sku-1004. The total quantity is now 1,076 units."), { ids: ["sku-1001", "sku-1004"], total: 1076 });
  assert.ok(Number.isNaN(parseReport("changed: sku-1001").total));
  const g = groundWith(done, true);
  assert.equal(t3.eval.scoreNoHarness("changed: sku-1001, sku-1004\ntotal: 76", g).correct, true);
  assert.match(t3.eval.scoreNoHarness("changed: sku-1001, sku-1004\ntotal: 75", g).reason, /75 ≠ 76/);
  assert.equal(t3.eval.scoreNoHarness("changed: sku-1001, sku-1004\ntotal: 76", groundWith(untouched(), false)).correct, false);
});

test("toolUse: list, every low item with the right values, nothing else, a successful confirm", () => {
  const ctx = { scenario: "scn-x", items };
  const call = (name, args) => ({ name, arguments: args });
  const good = [
    call("list_items", { scenario: "scn-x" }),
    call("update_item", { scenario: "scn-x", id: "sku-1001", qty: 25, status: STATUS }),
    call("update_item", { scenario: "scn-x", id: "sku-1004", qty: 12, status: STATUS }),
    call("confirm_restock", { scenario: "scn-x", tickets: ["tkt-1", "tkt-2"] }),
  ];
  const confirmed = [{ name: "confirm_restock", ok: true, content: '{"confirmed":true,"count":2}' }];
  assert.equal(t3.eval.toolUse({ toolCalls: good, toolResults: confirmed, ctx }).ok, true);
  assert.match(t3.eval.toolUse({ toolCalls: good.slice(1), toolResults: confirmed, ctx }).reason, /list_items was never called/);
  assert.match(t3.eval.toolUse({ toolCalls: [good[0], good[1], good[3]], toolResults: confirmed, ctx }).reason, /never updated 1 of the 2 low items/);
  const wrongQty = [good[0], { ...good[1], arguments: { ...good[1].arguments, qty: 24 } }, good[2], good[3]];
  assert.match(t3.eval.toolUse({ toolCalls: wrongQty, toolResults: confirmed, ctx }).reason, /1 update\(s\) with the wrong/);
  assert.match(t3.eval.toolUse({ toolCalls: good.slice(0, 3), toolResults: [], ctx }).reason, /confirm_restock was never called/);
  assert.match(t3.eval.toolUse({ toolCalls: good, toolResults: [{ name: "confirm_restock", ok: false, content: "tool error: 409" }], ctx }).reason, /never succeeded/);
});

test("the family declares the control, harness and toolOnly modes, a setup, a goal and a round budget", () => {
  assert.deepEqual(restockTasks.map((t) => t.name), ["restock3", "restock6", "restock12", "restock30"]);
  for (const t of restockTasks) {
    assert.ok(t.noHarness && t.harness && t.toolOnly && !t.schemaOnly);
    assert.ok(t.maxRounds > 6);
    assert.equal(typeof t.setup, "function");
    assert.equal(typeof t.goal, "function");
    assert.equal(t.category, "multi-step");
  }
});

test("the stress axis: distractor tools only under that profile, budget and distractors spelled out in prompts, distractor calls fail tool use", () => {
  assert.deepEqual(toolsFor({}).map((t) => t.name), ["list_items", "update_item", "get_summary", "confirm_restock"]);
  assert.deepEqual(toolsFor({ stress: "distractors" }).map((t) => t.name), ["list_items", "update_item", "get_summary", "confirm_restock", "get_item_history", "set_item_price", "reorder_all"]);
  assert.equal(distractorTools.find((t) => t.name === "reorder_all").description, "Mark every item in the scenario as reordered in one call.");
  for (const t of restockTasks) assert.equal(typeof t.harness.tools, "function");
  const t3 = restockTasks[0];
  assert.match(t3.harness.prompt({ scenario: "scn-1", budget: 8 }), /at most 8 requests/);
  assert.doesNotMatch(t3.harness.prompt({ scenario: "scn-1" }), /at most/);
  assert.match(t3.harness.prompt({ scenario: "scn-1", stress: "distractors" }), /reorder-all shortcut/);
  assert.match(t3.goal({ scenario: "scn-1", budget: 8 }), /at most 8 requests/);
  assert.match(t3.goal({ scenario: "scn-1", stress: "distractors" }), /scn-1\/reorder-all/);
  assert.doesNotMatch(t3.goal({ scenario: "scn-1", stress: "flaky" }), /reorder-all|at most/);
  const ctx = { scenario: "scn-x", items };
  const calls = [{ name: "list_items", arguments: { scenario: "scn-x" } }, { name: "reorder_all", arguments: { scenario: "scn-x" } }];
  assert.match(t3.eval.toolUse({ toolCalls: calls, toolResults: [], ctx }).reason, /1 distractor tool call\(s\) \(reorder_all\)/);
});

test("goalPrompt resolves a goal that is a function of the trial context", () => {
  const g = goalPrompt(restockTasks[0], "harness", "fallback", { scenario: "scn-abc" });
  assert.match(g, /scn-abc\/items/);
  assert.match(g, /scn-abc\/summary/);
  assert.match(g, /409/);
  assert.match(g, /JSON Schema/);
  assert.equal(goalPrompt({ goal: "fixed" }, "noHarness", "fb"), "fixed");
});

test("runTrial runs setup, templates the prompts with the context and hands it to ground, scorers and toolUse", async () => {
  const seen = {};
  const task = {
    name: "ctxprobe",
    setup: async ({ mode, index }) => ({ token: `T-${mode}-${index}` }),
    maxRounds: 9,
    noHarness: { prompt: (ctx) => `free ${ctx.token}` },
    harness: { system: (ctx) => `sys ${ctx.token}`, prompt: (ctx) => `do ${ctx.token}`, tools: [{ name: "noop", impl: async () => "ok" }], schema: { type: "object" } },
    eval: {
      ground: ({ ctx }) => { seen.ground = ctx; return { want: ctx.token }; },
      scoreHarness: (out, ground, { ctx }) => { seen.score = ctx; return { correct: out?.t === ground.want, reason: "s" }; },
      scoreNoHarness: (out, ground, { ctx }) => { seen.score = ctx; return { correct: out === ground.want, reason: "f" }; },
      toolUse: ({ ctx }) => { seen.toolUse = ctx; return { ok: true, reason: "" }; },
    },
  };
  let opts = null;
  const client = {
    name: "c", model: "m",
    async chat(messages) { return { text: messages.at(-1).content.replace("free ", ""), toolCalls: [], finishReason: "stop", usage: null }; },
    async runWithTools(prompt, tools, system, o) { opts = o; return { text: "{}", structured: { t: prompt.replace("do ", "") }, toolCalls: [{ name: "noop", arguments: {} }], toolResults: [], rounds: 1, finishReason: "stop", usage: null }; },
  };
  const h = await runTrial({ task, mode: "harness", client, index: 2 });
  assert.equal(h.correct, true, `${h.reason} ${h.error ?? ""}`);
  assert.deepEqual(h.ctx, { token: "T-harness-2" });
  assert.equal(h.prompt, "do T-harness-2");
  assert.match(h.system, /^sys T-harness-2/);
  assert.equal(opts.maxRounds, 9, "the task's round budget wins");
  assert.deepEqual(opts.ctx, { token: "T-harness-2" });
  assert.deepEqual(seen, { ground: { token: "T-harness-2" }, score: { token: "T-harness-2" }, toolUse: { token: "T-harness-2" } });
  const f = await runTrial({ task, mode: "noHarness", client, index: 1 });
  assert.equal(f.correct, true, f.reason);
  assert.equal(f.prompt, "free T-noHarness-1");
  // A setup that fails is an error row, not a crash.
  const broken = { ...task, setup: async () => { throw new Error("no server"); } };
  const e = await runTrial({ task: broken, mode: "harness", client, index: 1 });
  assert.equal(e.correct, false);
  assert.equal(e.error, "no server");
});
