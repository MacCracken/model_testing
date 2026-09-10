// The near-duplicate tool-selection family ([48] follow-up): thirteen read tools that differ by a
// word, one question per trial with a direct tool, roundabout ones and misleading near-duplicates;
// the answer scored, the pick judged; the hooks (a ghost id or name, the tools in another order,
// the ask in other words); every mode through the runner with a stubbed scenario endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, TOOLS, SIX, THIRTEEN, QUESTIONS, toolpickTasks, valueIn, unanswerable, perturb, abstainedOn } from "../src/tasks/toolpick.js";
import { seedFor } from "../src/tasks/gen.js";
import { runTrial, summarize } from "../src/runner.js";
import { withPerturb } from "../src/perturb.js";
import { withAbstain, unanswerableFor } from "../src/abstain.js";
import { listTasks } from "../src/tasks/registry.js";

const NAMES = ["bolt", "washer", "gasket", "bearing", "spring", "valve", "filter", "pulley", "bracket", "hinge", "socket", "flange"];
const items = Array.from({ length: 12 }, (_, i) => ({ id: `sku-${1000 + i * 37}`, name: NAMES[i], qty: i < 3 ? 2 + i : 10 + i * 3, min: 8 + i, target: 30 + i, status: i === 5 ? "hold" : "ok", next: `sku-${1000 + ((i + 1) % 12) * 37}` }));

// The scenario endpoints, stood in for.
async function withScenarioServer(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (init?.method === "POST" && u.endsWith("/api/scenarios")) return json(201, { id: "scn-t", seed: JSON.parse(init.body).seed, items, stress: null, budget: null });
    let m;
    if ((m = u.match(/\/api\/scenarios\/([^/]+)\/items\/([^/?]+)$/))) { const it = items.find((i) => i.id === m[2]); return it ? json(200, it) : json(404, { error: "unknown item", id: m[2] }); }
    if (/\/api\/scenarios\/[^/]+\/items$/.test(u)) return json(200, { items });
    if (/\/api\/scenarios\/[^/]+\/summary$/.test(u)) return json(200, { items: items.length, totalQty: items.reduce((a, i) => a + i.qty, 0), low: items.filter((i) => i.qty < i.min).length, confirmed: false });
    if (/\/api\/scenarios\/[^/]+$/.test(u)) return json(200, { id: "scn-t", items, ops: [], confirmed: false });
    return json(404, { error: "unknown" });
  };
  try { return await fn({ calls }); } finally { globalThis.fetch = real; }
}

test("the tools: thirteen names that differ by a word, six of them the small set; each does what it says over the scenario", async () => {
  assert.equal(THIRTEEN.length, 13);
  assert.deepEqual(SIX, ["get_item", "get_item_qty", "find_item_by_name", "list_items", "list_low_items", "get_summary"]);
  for (const t of Object.values(TOOLS)) { assert.equal(typeof t.impl, "function"); assert.equal(t.parameters.type, "object"); assert.ok(t.parameters.required.includes("scenario")); }
  await withScenarioServer(async () => {
    const it = items[7];
    assert.deepEqual(await TOOLS.get_item_qty.impl({ scenario: "scn-t", id: it.id }), { id: it.id, qty: it.qty });
    assert.deepEqual(await TOOLS.get_item_min.impl({ scenario: "scn-t", id: it.id }), { id: it.id, min: it.min });
    assert.equal((await TOOLS.get_next_item.impl({ scenario: "scn-t", id: it.id })).id, it.next);
    assert.equal((await TOOLS.find_item_by_name.impl({ scenario: "scn-t", name: " Pulley " })).id, it.id);
    await assert.rejects(TOOLS.find_item_by_name.impl({ scenario: "scn-t", name: "manifold" }), /no item named "manifold"/);
    assert.equal((await TOOLS.list_low_items.impl({ scenario: "scn-t" })).items.length, 3);
    assert.deepEqual(await TOOLS.count_items.impl({ scenario: "scn-t" }), { count: 12 });
    assert.deepEqual(await TOOLS.count_low_items.impl({ scenario: "scn-t" }), { count: 3 });
    assert.equal((await TOOLS.get_summary.impl({ scenario: "scn-t" })).low, 3);
    await assert.rejects(TOOLS.get_item_status.impl({ scenario: "scn-t", id: "sku-0000" }), /404/);
  });
});

test("the questions: every kind occurs at both sizes, the answer is the scenario's value, the direct tool is exposed, the misleading ones are never the direct one; the six-tool set promotes the best roundabout tool", () => {
  for (const [level, exposed] of [[6, SIX], [13, THIRTEEN]]) {
    const kinds = new Set();
    for (let i = 1; i <= 80; i++) {
      const g = generate(seedFor(2026, `toolpick${level}`, i), exposed, { items });
      assert.deepEqual(generate(seedFor(2026, `toolpick${level}`, i), exposed, { items }), g, "deterministic");
      kinds.add(g.kind);
      assert.ok(g.direct.length, `${g.kind}: a direct tool`);
      assert.ok(g.direct.every((t) => exposed.includes(t)));
      assert.ok(g.roundabout.every((t) => exposed.includes(t)));
      assert.ok(g.misleading.every((t) => exposed.includes(t) && !g.direct.includes(t)));
      assert.notEqual(g.question, g.askAlt);
      assert.ok(typeof g.answer === "string" && g.answer.length);
      const it = items.find((x) => x.id === g.id);
      if (g.kind === "qty") assert.equal(g.answer, String(it.qty));
      if (g.kind === "next-name") assert.equal(g.answer, items.find((x) => x.id === it.next).name);
      if (g.kind === "low-count") assert.equal(g.answer, "3");
      if (g.kind === "lowest") assert.equal(g.answer, items[0].id);
      if (g.kind === "total-qty") assert.equal(g.answer, String(items.reduce((a, x) => a + x.qty, 0)));
    }
    assert.equal(kinds.size, QUESTIONS.length, `every kind at ${level}: ${[...kinds].join(", ")}`);
  }
  const six = generate(seedFor(2026, "toolpick6", 4), SIX, { items });
  for (const q of QUESTIONS) { const g = { ...q }; void g; }
  const nn = Array.from({ length: 200 }, (_, i) => generate(seedFor(1, "toolpick6", i), SIX, { items })).find((g) => g.kind === "next-name");
  assert.deepEqual(nn.direct, ["get_item", "list_items"], "no get_next_item in the six: the roundabout tools become the direct ones");
  assert.deepEqual(nn.roundabout, []);
  void six;
});

test("readers, the judge and the canon: the answer line wins, ids and numbers compare as such, names in lower case", () => {
  assert.equal(valueIn("I looked it up.\nanswer: 42"), "42");
  assert.equal(valueIn('answer: "nozzle".'), "nozzle");
  assert.equal(valueIn("**answer: sku-1037**"), "sku-1037");
  const t = toolpickTasks[1];
  const g = { answer: "42", kind: "qty", direct: ["get_item_qty"], hijacked: 0 };
  assert.equal(t.eval.scoreHarness({ answer: 42 }, g).correct, true);
  assert.equal(t.eval.scoreHarness({ answer: "42 units" }, g).correct, true);
  assert.equal(t.eval.scoreHarness({ answer: 41 }, g).correct, false);
  assert.equal(t.eval.scoreNoHarness("It has 42 on hand.\nanswer: 42", g).correct, true);
  assert.equal(t.eval.scoreHarness({ answer: "Pulley" }, { ...g, answer: "pulley" }).correct, true);
  assert.equal(t.eval.scoreNoHarness("answer: the id is SKU-1037", { ...g, answer: "sku-1037" }).correct, true);
  assert.equal(t.eval.canon({ answer: "Pulley" }, { structured: true }), "pulley");
  assert.equal(t.eval.canon("answer: 42", { structured: false }), "42");
  assert.equal(t.eval.scoreHarness({ answer: 999 }, { ...g, answer: "999" }).hijacked, true, "the planted value is a hijack");
});

test("the verdict: the direct tool first, the direct tool after a wrong pick, a roundabout answer, a near-duplicate only, nothing", () => {
  const t = toolpickTasks[1];
  const ctx = { direct: ["get_item_qty", "get_item"], roundabout: ["list_items"], misleading: ["get_item_min", "get_item_target"] };
  const v = (names) => t.eval.toolUse({ toolCalls: names.map((n) => ({ name: n, arguments: {} })), ctx });
  assert.match(v(["get_item_qty"]).reason, /picked get_item_qty first — the direct tool/);
  assert.equal(v(["get_item_qty"]).ok, true);
  const late = v(["get_item_min", "get_item_qty"]);
  assert.equal(late.ok, true);
  assert.match(late.reason, /reached get_item_qty after picking get_item_min first \(1 misleading call\(s\)\)/);
  const round = v(["list_items"]);
  assert.equal(round.ok, true);
  assert.equal(round.roundabout, true);
  assert.match(round.reason, /answered through list_items instead of get_item_qty \/ get_item/);
  const wrong = v(["get_item_target"]);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /picked get_item_target, a near-duplicate of the right tool; never called get_item_qty \/ get_item/);
  assert.equal(v([]).ok, false);
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "get_item" }], ctx: { ...ctx, unanswerable: true } }).ok, true);
});

test("the hooks: a ghost id or a name nobody has, the tools in another order, the ask in other words, typos with the field names intact; the reader of an abstention", () => {
  const ctx = { scenario: "scn-t", seed: 4, items, exposed: THIRTEEN, ...generate(seedFor(2026, "toolpick13", 3), THIRTEEN, { items }) };
  const u = unanswerable(ctx);
  assert.equal(u.unanswerable, true);
  assert.equal(u.answer, null);
  assert.ok(u.missingId || u.missingName);
  if (u.missingId) { assert.ok(!items.some((i) => i.id === u.missingId)); assert.ok(u.question.includes(u.missingId)); }
  const byName = unanswerable({ ...ctx, ...generate(seedFor(1, "toolpick13", 7), THIRTEEN, { items }), question: 'What is the id of the item named "pulley"?', askAlt: 'Which id belongs to the item called "pulley"?', kind: "id-by-name" });
  assert.equal(byName.missingName, "manifold");
  assert.match(byName.question, /"manifold"/);
  const o = perturb(ctx, "order", 1);
  assert.deepEqual([...o.exposed].sort(), [...THIRTEEN].sort());
  assert.notDeepEqual(o.exposed, THIRTEEN);
  assert.equal(toolpickTasks[1].harness.tools(o)[0].name, o.exposed[0], "the tool list follows the order");
  assert.match(toolpickTasks[1].harness.prompt(o), new RegExp(`Your tools: ${o.exposed[0]}, ${o.exposed[1]}`));
  assert.equal(perturb(ctx, "paraphrase", 1).question, ctx.askAlt);
  const ty = perturb(ctx, "typos", 1);
  if (ty) assert.ok(/sku-\d{4}/.test(ty.question) || !/sku-\d{4}/.test(ctx.question));
  assert.equal(perturb(ctx, "format", 1), null);
  assert.deepEqual(toolpickTasks[0].perturbs, ["paraphrase", "order", "typos"]);
  assert.deepEqual(toolpickTasks[0].abstainModes, ["harness", "toolOnly"]);
  const g = { structured: true, text: "", ctx: { missingId: "sku-9999" }, generic: false };
  assert.equal(abstainedOn({ answer: null }, g), true);
  assert.equal(abstainedOn({ answer: "not found" }, g), true);
  assert.equal(abstainedOn({ answer: 12 }, g), false);
  assert.equal(abstainedOn(null, { ...g, structured: false, text: "answer: unknown item" }), true);
  assert.equal(abstainedOn(null, { ...g, structured: false, text: "answer: 12" }), false);
  assert.equal(abstainedOn({ answer: 12 }, { ...g, ctx: {} }), false);
});

// A fake assistant that picks a tool by name — the direct one, a misleading one first, or a
// roundabout one — through the real tool implementations, and answers from what came back.
function assistant(how) {
  return {
    name: "fake:m", model: "m",
    async chat() { return { text: "answer: 1", usage: null }; },
    async runWithTools(prompt, tools, system, { ctx }) {
      const pick = (n) => tools.find((t) => t.name === n);
      const names = how === "misleading-first" ? [ctx.misleading[0] ?? ctx.direct[0], ctx.direct[0]] : how === "roundabout" ? [ctx.roundabout[0] ?? ctx.direct[0]] : [ctx.direct[0]];
      const calls = [], results = [];
      let last = null;
      for (const n of names) {
        const t = pick(n);
        const args = t.parameters.properties.id ? { scenario: ctx.scenario, id: ctx.id } : t.parameters.properties.name ? { scenario: ctx.scenario, name: (ctx.question.match(/"([^"]+)"/) ?? [])[1] ?? "" } : { scenario: ctx.scenario };
        calls.push({ id: `c${calls.length}`, name: n, arguments: args });
        try { last = await t.impl(args); results.push({ id: `c${results.length}`, name: n, ok: true, content: JSON.stringify(last) }); }
        catch (err) { last = null; results.push({ id: `c${results.length}`, name: n, ok: false, content: `tool error: ${err.message}` }); }
      }
      const answer = ctx.unanswerable ? null : ctx.answer;
      const structured = prompt.includes("JSON");
      const out = { work: names, ...(ctx.unanswerable ? { answerable: false } : {}), answer };
      return { text: structured ? JSON.stringify(out) : `answer: ${answer ?? "not found"}`, structured: structured ? out : null, toolCalls: calls, toolResults: results, rounds: names.length + 1, usage: null };
    },
  };
}

test("every mode through the runner: the tool modes answer through the real tools and are judged on the pick; the free-form modes are the control; the treatments apply", async () => {
  await withScenarioServer(async () => {
    for (const task of toolpickTasks) for (const seed of [3, 8, 21]) {
      const h = await runTrial({ task, mode: "harness", client: assistant("direct"), index: 1, seed });
      assert.equal(h.error, null, h.error);
      assert.equal(h.correct, true, `${task.name}: ${h.reason}`);
      assert.equal(h.toolUseOk, true, h.toolUseReason);
      assert.match(h.toolUseReason, /the direct tool/);
      const m = await runTrial({ task, mode: "toolOnly", client: assistant("misleading-first"), index: 1, seed });
      assert.equal(m.correct, true, m.reason);
      if (m.ctx.misleading.length) assert.match(m.toolUseReason, /after picking .* first/);
      const r = await runTrial({ task, mode: "harness", client: assistant("roundabout"), index: 1, seed });
      assert.equal(r.correct, true, r.reason);
      assert.equal(r.toolUseOk, true);
      const n = await runTrial({ task, mode: "noHarness", client: assistant("direct"), index: 1, seed });
      assert.equal(n.toolUseOk, null, "no tools, no verdict");
      assert.equal(n.canon, "1");
    }
    const task = toolpickTasks[1];
    const base = await runTrial({ task, mode: "harness", client: assistant("direct"), index: 2, seed: 5 });
    const order = await runTrial({ task, mode: "harness", client: withPerturb(assistant("direct"), "order"), index: 2, seed: 5 });
    assert.equal(order.perturb.applied, true);
    assert.notDeepEqual(order.ctx.exposed, base.ctx.exposed);
    assert.equal(order.canon, base.canon);
    assert.deepEqual(summarize([base, order]).delta.perturb.order.consistency, { pairs: 1, same: 1, pct: 100 });
    const unSeed = Array.from({ length: 60 }, (_, i) => i + 1).find((s) => unanswerableFor(s));
    const u = await runTrial({ task, mode: "harness", client: withAbstain(assistant("direct")), index: 1, seed: unSeed });
    assert.equal(u.abstain.unanswerable, true);
    assert.equal(u.abstain.abstention, "abstained", u.reason);
    assert.equal(u.correct, true);
    const guess = await runTrial({ task, mode: "noHarness", client: withAbstain(assistant("direct")), index: 1, seed: unSeed });
    assert.equal(guess.abstain.applied, false, "nothing to consult without a tool");
  });
});

test("the listing: two sizes of one family, the tools per size, the hooks and the capabilities", () => {
  const by = Object.fromEntries(listTasks().map((t) => [t.name, t]));
  assert.deepEqual([by.toolpick6.family, by.toolpick6.level, by.toolpick13.level], ["toolpick", 6, 13]);
  assert.equal(by.toolpick6.tools.length, 6);
  assert.equal(by.toolpick13.tools.length, 13);
  assert.deepEqual(by.toolpick13.modes, ["noHarness", "harness", "schemaOnly", "toolOnly"]);
  assert.deepEqual(by.toolpick13.abstain, ["harness", "toolOnly"]);
  assert.deepEqual(by.toolpick6.perturbs, ["paraphrase", "order", "typos"]);
  assert.deepEqual(by.toolpick6.capabilities, ["tool-use", "tool-selection"]);
});
