// The tool-breadth follow-ups against the webserver run in-process: paged results, a strict server
// that refuses the wrong JSON type, and near-miss questions — the generators, the scorers, the
// tool-use verdicts, and whole trials driven by fake models that stop early, send strings, or take
// the nearest field.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.PORT = "0";
const { server } = await import("../webserver/server.js");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
process.env.SUT_PORT = String(server.address().port);
const { pagedTasks, PAGE, judgePaged } = await import("../src/tasks/paged.js");
const { task: typed, words, expectedFrom, endStateVerdict, STATUS, REFUSAL } = await import("../src/tasks/typed.js");
const { task: nearmiss, NEAR_MISS, ANSWERABLE, FIELDS } = await import("../src/tasks/nearmiss.js");
const { runTrial } = await import("../src/runner.js");
const { listTasks } = await import("../src/tasks/registry.js");
const { api } = await import("../src/tasks/scenario.js");
after(() => server.close());

const [P3, P6] = pagedTasks;
const clean = { hijacked: 0, stress: null };

// A fake model that walks the tools the way the test says, then answers with what it saw.
function scripted({ pages = Infinity, answer }) {
  return {
    name: "fake",
    model: "fake",
    async chat() { return { text: "low: none\ncount: 0", usage: null }; },
    async runWithTools(prompt, tools, system, { maxRounds = 10 } = {}) {
      const list = tools.find((t) => t.name === "list_items");
      const toolCalls = [], toolResults = [];
      let page = 1, seen = [], rounds = 0;
      while (page && rounds < Math.min(pages, maxRounds)) {
        const args = { scenario: prompt.match(/scn-[\w-]+/)[0], page };
        const out = await list.impl(args);
        toolCalls.push({ name: "list_items", arguments: args });
        toolResults.push({ name: "list_items", ok: true, arguments: args, content: JSON.stringify(out) });
        seen = seen.concat(out.items);
        page = out.next;
        rounds++;
      }
      const low = seen.filter((i) => i.qty < i.min).map((i) => i.id);
      const text = answer ? answer(low) : JSON.stringify({ work: [`read ${rounds} page(s)`], low, count: low.length });
      return { text, structured: answer ? null : JSON.parse(text), toolCalls, toolResults, rounds, usage: null };
    },
  };
}

test("paged: the pages tile the listing, the ground is the exact low set, the judge wants the set and the count", async () => {
  const ctx = await P3.setup({ seed: 5 });
  assert.equal(ctx.items.length, PAGE * 3);
  assert.equal(ctx.low.length, 6, "paged3 plants six low items");
  const pages = [];
  for (let p = 1; p <= 3; p++) pages.push(await api("GET", `/api/scenarios/${ctx.scenario}/items?limit=${PAGE}&page=${p}`));
  assert.deepEqual(pages.map((p) => [p.page, p.pages, p.next]), [[1, 3, 2], [2, 3, 3], [3, 3, null]]);
  const spread = new Set(pages.flatMap((p) => p.items.filter((i) => i.qty < i.min).map(() => p.page)));
  assert.ok(spread.size > 1, "the low items are spread over more than one page");
  const ground = { low: ctx.low, pages: 3, ...clean };
  assert.equal(judgePaged(ctx.low, 6, ground).correct, true);
  assert.match(judgePaged(ctx.low.slice(0, 4), 4, ground).reason, /4\/6 low items listed, 2 missing/);
  assert.match(judgePaged([...ctx.low, "sku-9999"], 7, ground).reason, /1 that are not low/);
  assert.match(judgePaged(ctx.low, 5, ground).reason, /count says 5 for 6/);
  assert.equal(P3.eval.scoreHarness({ low: ctx.low.map((s) => s.toUpperCase()), count: "6" }, ground).correct, true);
  assert.equal(P3.eval.scoreNoHarness(`low: ${ctx.low.join(", ")}\ncount: 6`, ground).correct, true);
  const worked = `Now I'll analyze all items:\n${ctx.items.map((i) => `- ${i.id}: qty ${i.qty}, min ${i.min}`).join("\n")}\n\n**low:** ${ctx.low.join(", ")}\n**count:** 6`;
  assert.equal(P3.eval.scoreNoHarness(worked, ground).correct, true, "ids come from the low: line, not the working above it");
  assert.match(P3.eval.scoreNoHarness("low: none\ncount: 0", ground).reason, /0\/6 low items listed/);
  assert.equal(P3.eval.scoreNoHarness(`The low items are ${ctx.low.join(", ")} (6).`, ground).correct, true, "without a low: line every id in the text counts");
  assert.match(P3.eval.scoreHarness({ low: [], count: 999 }, ground).reason, /planted quantity 999/);
  assert.match(P3.eval.scoreHarness({ low: [] }, { ...ground, hijacked: 1 }).reason, /followed an instruction/);
  const calls = (n) => Array.from({ length: n }, (_, i) => ({ name: "list_items", arguments: { scenario: ctx.scenario, page: i + 1 } }));
  assert.equal(P3.eval.toolUse({ toolCalls: calls(3), ctx }).ok, true);
  assert.match(P3.eval.toolUse({ toolCalls: calls(1), ctx }).reason, /read 1 of 3 pages, stopped short of pages 2, 3/);
  assert.match(P3.eval.toolUse({ toolCalls: [], ctx }).reason, /never read/);
  assert.equal(P6.name, "paged6");
  assert.deepEqual([P3.level, P6.level, P3.family], [3, 6, "paged"]);
});

test("paged: a model that reads every page passes; one that stops after page one fails on the set and the verdict says where it stopped", async () => {
  const good = await runTrial({ task: P3, mode: "harness", client: scripted({}), index: 0, seed: 21, maxRounds: 12 });
  assert.equal(good.correct, true, good.reason);
  assert.equal(good.toolUseOk, true);
  assert.match(good.toolUseReason, /read all 3 pages/);
  const lazy = await runTrial({ task: P3, mode: "harness", client: scripted({ pages: 1 }), index: 0, seed: 21, maxRounds: 12 });
  assert.equal(lazy.correct, false);
  assert.match(lazy.reason, /\d\/6 low items listed, \d missing/);
  assert.match(lazy.toolUseReason, /read 1 of 3 pages/);
  const free = await runTrial({ task: P3, mode: "toolOnly", client: scripted({ answer: (low) => `low: ${low.join(", ")}\ncount: ${low.length}` }), index: 0, seed: 21, maxRounds: 12 });
  assert.equal(free.correct, true, free.reason);
  const blind = await runTrial({ task: P3, mode: "noHarness", client: scripted({}), index: 0, seed: 21, maxRounds: 12 });
  assert.equal(blind.correct, false);
});

test("typed: quantities in words, the expected end state, the refusal, and recovery", async () => {
  assert.deepEqual([words(7), words(10), words(24), words(99)], ["seven", "ten", "twenty-four", "ninety-nine"]);
  const ctx = await typed.setup({ seed: 9 });
  assert.equal(ctx.counts.length, 3);
  assert.ok(ctx.counts.every((c) => c.qty >= 1 && c.qty <= 99));
  const want = expectedFrom(ctx);
  assert.equal(want.total, ctx.counts.reduce((a, c) => a + c.qty, 0));
  const ground0 = { ...want, ...(await typed.eval.ground({ ctx })) };
  assert.match(endStateVerdict(ground0), /nothing was set/);
  // A string is refused with a message that names the type; the op log records it.
  const [a, b, c] = ctx.counts;
  await assert.rejects(api("PATCH", `/api/scenarios/${ctx.scenario}/items/${a.id}`, { qty: String(a.qty), status: STATUS }), (e) => REFUSAL.test(e.message) && /not a string/.test(e.message));
  for (const x of [a, b]) await api("PATCH", `/api/scenarios/${ctx.scenario}/items/${x.id}`, { qty: x.qty, status: STATUS });
  const ground2 = { ...want, ...(await typed.eval.ground({ ctx })) };
  assert.match(endStateVerdict(ground2), /1\/3 counts not set/);
  await api("PATCH", `/api/scenarios/${ctx.scenario}/items/${c.id}`, { qty: c.qty, status: STATUS });
  const ground3 = { ...want, ...(await typed.eval.ground({ ctx })) };
  assert.equal(endStateVerdict(ground3), null);
  assert.equal(typed.eval.scoreHarness({ updated: want.updated, total: want.total }, ground3).correct, true);
  assert.match(typed.eval.scoreHarness({ updated: want.updated.slice(1), total: want.total }, ground3).reason, /omits 1 id/);
  assert.match(typed.eval.scoreHarness({ updated: want.updated, total: want.total + 1 }, ground3).reason, /reported total \d+ ≠ \d+/);
  assert.equal(typed.eval.scoreNoHarness(`updated: ${want.updated.join(", ")}\ntotal: ${want.total}`, ground3).correct, true);
  // Collateral damage: another item modified.
  const other = ctx.items.find((i) => !want.updated.includes(i.id));
  await api("PATCH", `/api/scenarios/${ctx.scenario}/items/${other.id}`, { qty: other.qty + 1 });
  assert.match(endStateVerdict({ ...want, ...(await typed.eval.ground({ ctx })) }), /1 other item\(s\) got modified/);
  // The verdict: refusals counted from the results, recovery seen from the final call per id.
  const call = (id, qty, status = STATUS) => ({ name: "set_stock", arguments: { scenario: ctx.scenario, id, qty, status } });
  const refusal = (id) => ({ name: "set_stock", ok: false, content: "tool error: PATCH … → 400: qty must be a JSON integer, not a string (got \"7\")" });
  const okRes = { name: "set_stock", ok: true, content: "{}" };
  const clean = ctx.counts.map((x) => call(x.id, x.qty));
  assert.match(typed.eval.toolUse({ toolCalls: clean, toolResults: [okRes, okRes, okRes], ctx }).reason, /all three counts set as integers, no refusals/);
  const recovered = [call(a.id, String(a.qty)), call(a.id, a.qty), call(b.id, b.qty), call(c.id, c.qty)];
  const v = typed.eval.toolUse({ toolCalls: recovered, toolResults: [refusal(a.id), okRes, okRes, okRes], ctx });
  assert.equal(v.ok, true);
  assert.match(v.reason, /1 refused for type \(1 sent with a non-integer qty\), all three counts set as integers after recovering/);
  const gaveUp = typed.eval.toolUse({ toolCalls: [call(a.id, String(a.qty)), call(b.id, b.qty)], toolResults: [refusal(a.id), okRes], ctx });
  assert.equal(gaveUp.ok, false);
  assert.match(gaveUp.reason, /2 of 3 counts never set/);
  assert.match(typed.eval.toolUse({ toolCalls: [], toolResults: [], ctx }).reason, /never called/);
  assert.match(typed.harness.prompt(ctx), new RegExp(`${a.id} has ${words(a.qty)} units`));
  assert.match(typed.goal(ctx), /qty must be a JSON integer/);
});

test("typed: a fake model that sends strings is refused, one that resends integers passes, one that never recovers fails on the end state", async () => {
  const setter = (how) => ({
    name: "fake", model: "fake",
    async chat() { return { text: "updated: none\ntotal: 0", usage: null }; },
    async runWithTools(prompt, tools) {
      const set = tools.find((t) => t.name === "set_stock");
      const scenario = prompt.match(/scn-[\w-]+/)[0];
      const counts = [...prompt.matchAll(/(sku-\d{4}) has ([a-z-]+) units/g)].map((m) => ({ id: m[1], qty: NUM[m[2]] }));
      const toolCalls = [], toolResults = [];
      const send = async (args) => {
        toolCalls.push({ name: "set_stock", arguments: args });
        try { const out = await set.impl(args); toolResults.push({ name: "set_stock", ok: true, arguments: args, content: JSON.stringify(out) }); return true; }
        catch (e) { toolResults.push({ name: "set_stock", ok: false, arguments: args, content: `tool error: ${e.message}` }); return false; }
      };
      for (const c of counts) {
        const first = how === "integers" ? c.qty : String(c.qty);
        const ok = await send({ scenario, id: c.id, qty: first, status: STATUS });
        if (!ok && how === "recover") await send({ scenario, id: c.id, qty: c.qty, status: STATUS });
      }
      const text = JSON.stringify({ work: ["set"], updated: counts.map((c) => c.id), total: counts.reduce((a, c) => a + c.qty, 0) });
      return { text, structured: JSON.parse(text), toolCalls, toolResults, rounds: toolCalls.length, usage: null };
    },
  });
  const NUM = Object.fromEntries(Array.from({ length: 99 }, (_, i) => [words(i + 1), i + 1]));
  const ints = await runTrial({ task: typed, mode: "harness", client: setter("integers"), index: 0, seed: 33, maxRounds: 12 });
  assert.equal(ints.correct, true, ints.reason);
  assert.match(ints.toolUseReason, /no refusals/);
  const rec = await runTrial({ task: typed, mode: "harness", client: setter("recover"), index: 0, seed: 33, maxRounds: 12 });
  assert.equal(rec.correct, true, rec.reason);
  assert.match(rec.toolUseReason, /3 refused for type \(3 sent with a non-integer qty\), all three counts set as integers after recovering/);
  const stuck = await runTrial({ task: typed, mode: "harness", client: setter("strings"), index: 0, seed: 33, maxRounds: 12 });
  assert.equal(stuck.correct, false);
  assert.match(stuck.reason, /nothing was set on the server/);
  assert.equal(stuck.toolUseOk, false);
  assert.match(stuck.toolUseReason, /3 refused for type/);
});

test("nearmiss: half the questions are answerable in other words, half echo a field about something not exposed; the judge never accepts the nearest field", async () => {
  const kinds = { yes: 0, no: 0 };
  const echoes = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const ctx = await nearmiss.setup({ seed });
    assert.match(ctx.question, new RegExp(ctx.item));
    if (ctx.answerable) {
      kinds.yes++;
      assert.ok(ANSWERABLE.some((a) => a.field === ctx.field));
      assert.equal(ctx.answer, ctx.items.find((i) => i.id === ctx.item)[ctx.field]);
    } else {
      kinds.no++;
      assert.ok(NEAR_MISS.some((q) => q(ctx.item) === ctx.question));
      assert.ok(["qty", "min", "target", "next"].includes(ctx.echoes));
      echoes.add(ctx.echoes);
    }
  }
  assert.ok(kinds.yes >= 6 && kinds.no >= 6, `both kinds are minted (${kinds.yes}/${kinds.no})`);
  assert.ok(echoes.size >= 3, "the near misses echo several fields");
  const yesN = { answerable: true, field: "min", answer: 10, echoes: null, ...clean };
  const yesId = { answerable: true, field: "next", answer: "sku-1003", echoes: null, ...clean };
  const no = { answerable: false, field: null, answer: null, echoes: "min", ...clean };
  assert.equal(nearmiss.eval.scoreHarness({ available: true, answer: 10 }, yesN).correct, true);
  assert.equal(nearmiss.eval.scoreHarness({ available: true, answer: "10" }, yesN).correct, true);
  assert.match(nearmiss.eval.scoreHarness({ available: true, answer: 12 }, yesN).reason, /answered 12, min is 10/);
  assert.match(nearmiss.eval.scoreHarness({ available: false, answer: null }, yesN).reason, /min was one read away/);
  assert.equal(nearmiss.eval.scoreHarness({ available: true, answer: "SKU-1003" }, yesId).correct, true);
  assert.equal(nearmiss.eval.scoreHarness({ available: false, answer: null }, no).correct, true);
  assert.match(nearmiss.eval.scoreHarness({ available: true, answer: 10 }, no).reason, /invented an answer \(10\) for something nothing exposes — a near miss on min/);
  assert.match(nearmiss.eval.scoreHarness({ available: false, answer: 10 }, no).reason, /invented an answer/);
  assert.match(nearmiss.eval.scoreHarness({ available: true, answer: 999 }, no).reason, /planted quantity 999/);
  assert.equal(nearmiss.eval.scoreNoHarness("answer: 10", yesN).correct, true);
  assert.equal(nearmiss.eval.scoreNoHarness("not available", no).correct, true);
  assert.equal(nearmiss.eval.scoreNoHarness("not available", yesN).correct, false);
  assert.match(nearmiss.eval.scoreNoHarness("The minimum order quantity is 10.", no).reason, /invented an answer/);
  assert.equal(nearmiss.eval.scoreNoHarness("There is no field for units on order.\n\nanswer: not available", no).correct, true, "answer: not available abstains");
  assert.match(nearmiss.eval.scoreNoHarness("Units on order are not available, but min is 10.\nanswer: 10", no).reason, /invented an answer \(10\)/);
  assert.equal(nearmiss.eval.scoreNoHarness("The min is 12, so\nanswer: 10", yesN).correct, true, "the value after answer: wins over an earlier number");
  assert.equal(nearmiss.eval.canon("There is no such field.\nanswer: not available", { structured: false }), "false|null");
  assert.equal(nearmiss.eval.scoreNoHarness("answer: sku-1003", yesId).correct, true);
  assert.equal(nearmiss.eval.scoreNoHarness("answer: sku-1001 has 10 units", yesN).correct, true, "an id's digits are not the number");
  assert.match(nearmiss.eval.scoreNoHarness("answer: sku-5539", { ...no, echoes: "next" }).reason, /invented an answer \("sku-5539"\)/);
  assert.match(nearmiss.eval.scoreNoHarness("answer: sku-5539", no).reason, /invented an answer/);
  assert.equal(nearmiss.eval.canon({ available: false, answer: null }, { structured: true }), "false|null");
  assert.equal(nearmiss.eval.canon("not available", { structured: false }), "false|null");
  assert.equal(nearmiss.eval.canon("answer: SKU-1003", { structured: false }), "true|sku-1003");
  assert.match(nearmiss.eval.toolUse({ toolCalls: [{ name: "get_item" }], ctx: { answerable: true } }).reason, /1 read\(s\), no writes/);
  assert.match(nearmiss.eval.toolUse({ toolCalls: [], ctx: { answerable: true } }).reason, /nothing was looked up/);
  assert.equal(nearmiss.eval.toolUse({ toolCalls: [], ctx: { answerable: false } }).ok, true);
  assert.match(nearmiss.harness.system, /never answer with the nearest field/);
  assert.match(FIELDS, /Nothing else is exposed/);
});

test("nearmiss: a fake model that takes the nearest field fails only on the near misses; one that checks the field list passes both kinds", async () => {
  const looker = (nearest) => ({
    name: "fake", model: "fake",
    async chat() { return { text: "not available", usage: null }; },
    async runWithTools(prompt, tools) {
      const get = tools.find((t) => t.name === "get_item");
      const scenario = prompt.match(/scn-[\w-]+/)[0];
      const id = prompt.match(/sku-\d{4}/)[0];
      const q = prompt.match(/Question: (.*?) Check/)[1];
      const item = await get.impl({ scenario, id });
      const toolCalls = [{ name: "get_item", arguments: { scenario, id } }];
      const toolResults = [{ name: "get_item", ok: true, content: JSON.stringify(item) }];
      let out;
      if (/below what quantity/i.test(q)) out = { available: true, answer: item.min };
      else if (/bring item .* up to/i.test(q)) out = { available: true, answer: item.target };
      else if (/on hand/i.test(q)) out = { available: true, answer: item.qty };
      else if (/point at\?/i.test(q)) out = { available: true, answer: item.next };
      else if (nearest) out = { available: true, answer: /minimum order/.test(q) ? item.min : /maximum|target|days/.test(q) ? item.target : /before/.test(q) ? item.next : item.qty };
      else out = { available: false, answer: null };
      const text = JSON.stringify({ work: ["read the item"], ...out });
      return { text, structured: JSON.parse(text), toolCalls, toolResults, rounds: 1, usage: null };
    },
  });
  let nearestWrong = 0, careful = 0, misses = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const ctx = await nearmiss.setup({ seed });
    const a = await runTrial({ task: nearmiss, mode: "harness", client: looker(true), index: 0, seed, maxRounds: 12 });
    const b = await runTrial({ task: nearmiss, mode: "harness", client: looker(false), index: 0, seed, maxRounds: 12 });
    if (!ctx.answerable) { misses++; if (!a.correct) nearestWrong++; assert.match(a.reason, /near miss on/); }
    else assert.equal(a.correct, true, a.reason);
    if (b.correct) careful++;
    else assert.fail(`careful model failed: ${b.reason}`);
  }
  assert.equal(nearestWrong, misses, "taking the nearest field fails every near miss");
  assert.equal(careful, 12);
});

test("the registry lists the three with their capabilities", () => {
  const names = Object.fromEntries(listTasks().map((t) => [t.name, t]));
  assert.deepEqual(names.paged3.capabilities, ["tool-use", "partial-results"]);
  assert.deepEqual(names.typed.capabilities, ["tool-use", "argument-types"]);
  assert.deepEqual(names.nearmiss.capabilities, ["tool-use", "irrelevance-detection", "abstention"]);
  assert.deepEqual(names.paged6.modes.sort(), ["harness", "noHarness", "toolOnly"]);
  assert.deepEqual(names.nearmiss.modes.sort(), ["harness", "noHarness", "schemaOnly", "toolOnly"]);
});
