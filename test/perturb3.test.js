// Perturbations for the multi-step and multi-turn families ([48] follow-up): restock's rules in
// other words, as numbered steps or with typos (the goal an arm gets the same way), dialogue's
// opening and scripted turns likewise; a procedure and a conversation have one order; both families
// gain a canonical report; restock's scenario is minted from the trial seed now, and the store's
// stamping of `seeded` leaves the older random-inventory rows alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hb-perturb3-"));
process.env.RESULTS_DIR = join(dir, "results");
const { restockTasks, perturb: restockPerturb, canonOf, STATUS } = await import("../src/tasks/restock.js");
const { dialogueTasks, perturb: dialoguePerturb, userTurns, HOLD } = await import("../src/tasks/dialogue.js");
const { withPerturb } = await import("../src/perturb.js");
const { runTrial, summarize } = await import("../src/runner.js");
const { listTasks } = await import("../src/tasks/registry.js");
const { withSeeded } = await import("../src/store.js");

const ids = (t) => (String(t).match(/sku-\d{4}|scn-[0-9a-f]+/g) ?? []).sort();
const numbers = (t) => (String(t).match(/\b\d+\b/g) ?? []);
const items = [
  { id: "sku-1001", qty: 2, min: 10, target: 20, status: "ok" }, { id: "sku-1002", qty: 3, min: 10, target: 22, status: "ok" }, { id: "sku-1003", qty: 1, min: 9, target: 20, status: "ok" },
  { id: "sku-1004", qty: 12, min: 5, target: 30, status: "ok" }, { id: "sku-1005", qty: 30, min: 5, target: 31, status: "ok" },
];

test("restock: the rules in other words, as steps, or with typos — every mode's prompt and the goal; ids, numbers and the status literal intact; order refused; the base is what it was", () => {
  const t = restockTasks[1];
  const ctx = { scenario: "scn-ab12cd34", seed: 4, items, low: 6, budget: 11, stress: "budget" };
  const base = { harness: t.harness.prompt(ctx), toolOnly: t.toolOnly.prompt(ctx), noHarness: t.noHarness.prompt(ctx), goal: t.goal(ctx) };
  assert.match(base.harness, /^Scenario id: scn-ab12cd34\. An item needs restocking when its qty is below its min\. For every such item/);
  assert.match(base.goal, /^A webserver runs at .*Inventory scenario scn-ab12cd34: GET \/api\/scenarios\/scn-ab12cd34\/items lists/);
  const para = restockPerturb(ctx, "paraphrase", 4);
  assert.match(t.harness.prompt(para), /due for restocking\. Bring each such item up to its target qty/);
  assert.match(t.harness.prompt(para), /Your budget is 11 requests/);
  assert.match(t.goal(para), /due for restocking: bring each one up to its target/);
  const steps = restockPerturb(ctx, "format", 4);
  assert.match(t.toolOnly.prompt(steps), /^Scenario id: scn-ab12cd34\.\n1\. An item needs restocking[\s\S]*\n4\. Then report[\s\S]*\n5\. You have at most 11 requests/);
  assert.match(t.goal(steps), /\n1\. GET \/api\/scenarios\/scn-ab12cd34\/items[\s\S]*\n4\. GET \/api\/scenarios\/scn-ab12cd34\/summary/);
  for (let seed = 1; seed <= 15; seed++) {
    const typo = restockPerturb(ctx, "typos", seed);
    for (const [mode, text] of [["harness", t.harness.prompt(typo)], ["noHarness", t.noHarness.prompt(typo)], ["goal", t.goal(typo)]]) {
      assert.notEqual(text, base[mode], `${mode} ${seed}: changed`);
      assert.deepEqual(ids(text), ids(base[mode]), `${mode}: the ids`);
      assert.deepEqual(numbers(text), numbers(base[mode]), `${mode}: the numbers`);
      assert.equal(text.split(`"${STATUS}"`).length, base[mode].split(`"${STATUS}"`).length, `${mode}: the status literal`);
      assert.equal(text.split("/api/scenarios/").length, base[mode].split("/api/scenarios/").length, `${mode}: the endpoint`);
      if (mode !== "goal") assert.match(text, /list_items, update_item, confirm_restock and get_summary|changed: <comma-separated ids>/, "the mode's own template is untouched");
    }
  }
  for (const [mode, text] of Object.entries(base)) assert.equal(mode === "goal" ? t.goal(ctx) : t[mode].prompt(ctx), text, "the base is unchanged");
  assert.equal(restockPerturb(ctx, "order", 1), null, "a procedure has one order");
  assert.equal(restockPerturb(ctx, "noise", 1), null);
  assert.deepEqual(t.perturbs, ["paraphrase", "format", "typos"]);
  assert.equal(t.seeded, true);
  // The distractors sentence in both wordings, without a budget.
  const d = { scenario: "scn-1", stress: "distractors" };
  assert.match(t.harness.prompt(d), /The scenario also offers per-item history/);
  assert.match(t.harness.prompt(restockPerturb(d, "paraphrase", 1)), /Per-item history, price updates and a reorder-all shortcut are also on offer/);
  assert.match(t.harness.prompt(restockPerturb(d, "format", 1)), /\n5\. The scenario also offers/);
});

test("restock: the canonical report is the ids sorted and the total, from JSON or the two lines", () => {
  const t = restockTasks[0];
  assert.equal(canonOf(["SKU-1002", "sku-1001", "sku-1001"], 321), "sku-1001,sku-1002|321");
  assert.equal(canonOf([], NaN), "|?");
  assert.equal(t.eval.canon({ changed: ["sku-1002", "SKU-1001"], totalQty: 321 }, { structured: true }), "sku-1001,sku-1002|321");
  assert.equal(t.eval.canon({ changed: "sku-1002, sku-1001", total: 321 }, { structured: true }), "sku-1001,sku-1002|321");
  assert.equal(t.eval.canon("I updated them.\nchanged: sku-1002, sku-1001\ntotal: 321", { structured: false }), "sku-1001,sku-1002|321");
  assert.equal(t.eval.canon(null, { structured: true }), "none");
  const d = dialogueTasks[0];
  assert.equal(d.eval.canon({ changed: ["sku-1003", "sku-1001"], totalQty: 90 }, { structured: true }), "sku-1001,sku-1003|90");
  assert.equal(d.eval.canon("changed: sku-1003, sku-1001\ntotal: 90", { structured: false }), "sku-1001,sku-1003|90");
});

test("dialogue: the opening and the turns in other words, as bullet lists, or with typos — ids, numbers and the status literals intact; the final turn keeps its format line; order refused", () => {
  const d = dialogueTasks[2];
  const ctx = { scenario: "scn-1", seed: 5, items, turns: 4 };
  const base = { prompt: d.harness.prompt(ctx), turns: userTurns(ctx, 4, "json") };
  assert.equal(base.turns.length, 3);
  assert.match(base.turns[0], /^Change of plan for sku-1002: the supplier can only deliver enough/);
  const para = dialoguePerturb(ctx, "paraphrase", 5);
  const pt = userTurns(para, 4, "json");
  assert.match(d.harness.prompt(para), /Please restock whatever is low/);
  assert.match(pt[0], /^A change for sku-1002: the supplier cannot deliver more than takes it to its minimum, so make sku-1002 exactly 10/);
  assert.match(pt[1], /goes on hold: leave its quantity just as it is now and set its status to "hold"/);
  assert.match(pt[2], /raise it to 45 — or to whatever the policy permits[\s\S]*That is everything: confirm the restock now[\s\S]*Answer with a JSON object/);
  const bul = dialoguePerturb(ctx, "format", 5);
  const bt = userTurns(bul, 4, "lines");
  assert.match(d.noHarness.prompt(bul), /Restock what's low:\n- an item needs restocking/);
  assert.match(bt[0], /^Change of plan for sku-1002:\n- the supplier can only deliver enough to reach its minimum\n- so set sku-1002 to 10 \(its minimum\), status still "reordered"\n- everything else stays as it is\.$/);
  assert.match(bt[2], /\n- or as high as the policy allows if that is too much\. Then confirm the restock[\s\S]*exactly two lines/);
  for (let seed = 1; seed <= 15; seed++) {
    const typo = dialoguePerturb(ctx, "typos", seed);
    const tt = userTurns(typo, 4, "json");
    const all = [d.harness.prompt(typo), ...tt].join("\n"), allBase = [base.prompt, ...base.turns].join("\n");
    assert.notEqual(all, allBase);
    assert.deepEqual(ids(all), ids(allBase));
    assert.deepEqual(numbers(all), numbers(allBase));
    assert.equal(all.split(`"${STATUS}"`).length, allBase.split(`"${STATUS}"`).length);
    assert.equal(all.split(`"${HOLD}"`).length, allBase.split(`"${HOLD}"`).length);
    assert.match(tt[2], /\{ "changed": \[ids\], "totalQty": <number> \}/, "the format line is a template, kept as it is");
  }
  assert.deepEqual(userTurns(ctx, 4, "json"), base.turns, "the base is unchanged");
  assert.equal(dialoguePerturb(ctx, "order", 1), null, "a conversation has one order");
  assert.deepEqual(d.perturbs, ["paraphrase", "format", "typos"]);
  const by = Object.fromEntries(listTasks().map((t) => [t.name, t]));
  assert.deepEqual(by.restock6.perturbs, ["paraphrase", "format", "typos"]);
  assert.deepEqual(by.dialogue2.perturbs, ["paraphrase", "format", "typos"]);
});

// The scenario endpoint, stood in for: the same inventory for the same seed, a fresh id each time.
async function withScenarioServer(fn) {
  const real = globalThis.fetch;
  const made = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === "POST" && u.endsWith("/api/scenarios")) {
      const body = JSON.parse(init.body);
      const id = `scn-${made.length + 1}`;
      made.push({ id, body });
      const seed = body.seed ?? Math.floor(Math.random() * 1e9);
      return { ok: true, status: 201, text: async () => JSON.stringify({ id, seed, items: items.map((i) => ({ ...i })), stress: null, budget: null }) };
    }
    const m = u.match(/\/api\/scenarios\/(scn-\d+)$/);
    if (m) return { ok: true, status: 200, text: async () => JSON.stringify({ id: m[1], items: items.map((i) => (i.qty < i.min ? { ...i, qty: i.target, status: STATUS } : i)), confirmed: true, ops: [] }) };
    return { ok: false, status: 404, text: async () => "{}" };
  };
  try { return await fn({ made }); } finally { globalThis.fetch = real; }
}

test("through the runner: restock's scenario is minted from the trial seed, the rewritten rules reach the model, the base's report keeps its canonical form, and the summary pairs consistency", async () => {
  await withScenarioServer(async ({ made }) => {
    const task = restockTasks[0];
    const seen = [];
    const client = {
      name: "fake:m", model: "m",
      async chat() { throw new Error("no"); },
      async runWithTools(prompt, tools, system, { ctx }) {
        seen.push(prompt);
        const low = ctx.items.filter((i) => i.qty < i.min).map((i) => i.id);
        const out = { changed: low, totalQty: ctx.items.reduce((a, i) => a + (i.qty < i.min ? i.target : i.qty), 0) };
        const calls = [{ name: "list_items", arguments: { scenario: ctx.scenario } }, ...low.map((id) => ({ name: "update_item", arguments: { scenario: ctx.scenario, id, qty: ctx.items.find((i) => i.id === id).target, status: STATUS } })), { name: "confirm_restock", arguments: { scenario: ctx.scenario, tickets: ["t"] } }];
        return { text: JSON.stringify(out), structured: out, toolCalls: calls, toolResults: [{ name: "confirm_restock", ok: true, content: '{"confirmed":true}' }], rounds: 3, usage: null };
      },
    };
    const base = await runTrial({ task, mode: "harness", client, index: 2, seed: 77 });
    assert.equal(base.error, null, base.error);
    assert.equal(base.correct, true, base.reason);
    assert.equal(base.seeded, true);
    assert.deepEqual(made[0].body, { low: 3, seed: 77 }, "the trial seed goes to the server");
    assert.equal(base.ctx.seed, 77, "the row keeps the seed the scenario was minted from");
    const para = await runTrial({ task, mode: "harness", client: withPerturb(client, "paraphrase"), index: 2, seed: 77 });
    assert.deepEqual(para.perturb, { how: "paraphrase", applied: true });
    assert.match(seen[1], /due for restocking/);
    assert.equal(para.canon, base.canon);
    assert.equal(para.correct, true, para.reason);
    const order = await runTrial({ task, mode: "harness", client: withPerturb(client, "order"), index: 2, seed: 77 });
    assert.deepEqual(order.perturb, { how: "order", applied: false });
    const sameButScenario = (t) => t.replace(/scn-\d+/g, "scn-N");
    assert.equal(sameButScenario(seen[2]), sameButScenario(seen[0]), "an unapplied perturbation leaves the prompt alone (each trial mints its own scenario)");
    const typo = await runTrial({ task, mode: "harness", client: withPerturb(client, "typos"), index: 2, seed: 77 });
    assert.equal(typo.perturb.applied, true);
    assert.notEqual(sameButScenario(seen[3]), sameButScenario(seen[0]));
    const s = summarize([base, para, order, typo]);
    assert.deepEqual(s.delta.perturb.paraphrase.consistency, { pairs: 1, same: 1, pct: 100 });
    assert.deepEqual(s.delta.perturb.typos.consistency, { pairs: 1, same: 1, pct: 100 });
    assert.equal(s.delta.perturb.order.applied, 0);
  });
});

test("the store's stamping of `seeded` leaves a row alone whose scenario was minted from another seed than the trial's", () => {
  const old = { task: "restock3", mode: "harness", client: "c", model: "m", index: 1, seed: 11, ctx: { scenario: "scn-x", seed: 928374, items: [] }, correct: true };
  const fresh = { task: "restock3", mode: "harness", client: "c", model: "m", index: 1, seed: 11, ctx: { scenario: "scn-y", seed: 11, items: [] }, correct: true };
  const noCtx = { task: "wordmath4", mode: "harness", client: "c", model: "m", index: 1, seed: 11, correct: true };
  const said = { task: "restock3", mode: "harness", client: "c", model: "m", index: 1, seed: 11, seeded: false, ctx: { seed: 11 }, correct: true };
  assert.deepEqual(withSeeded([old, fresh, noCtx, said]).map((r) => r.seeded), [false, true, true, false]);
});
