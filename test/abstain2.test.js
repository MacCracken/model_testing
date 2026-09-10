// Abstention for the tool and extraction families ([48] follow-up): fanout asks for an item the
// scenario does not hold (the tool modes only — without a tool there is nothing to consult),
// extract1 serves an invoice without its number; each family reads its own natural abstention
// (no qty for the ghost id, the field reported as missing) on top of the generic one; the arms'
// goal prompt carries the note and the treated schema; the listing says what supports what.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noValue, withAbstain, unanswerableFor, NOTES } from "../src/abstain.js";
import { fanoutTasks, unanswerable as fanoutUnanswerable, abstainedOn as fanoutAbstained } from "../src/tasks/fanout.js";
import { followTasks, pathFrom, unanswerable as followUnanswerable, abstainedOn as followAbstained } from "../src/tasks/follow.js";
import { extractTasks, generate, remint, unanswerableInstance, abstainedOn as extractAbstained } from "../src/tasks/extract.js";
import { listTasks } from "../src/tasks/registry.js";
import { runTrial, MODE_NAMES } from "../src/runner.js";
import { goalPrompt } from "../src/harness/util.js";

const items = [
  { id: "sku-1001", qty: 5, min: 10, target: 20, status: "ok", next: "sku-1003" },
  { id: "sku-1002", qty: 30, min: 10, target: 22, status: "ok", next: "sku-1001" },
  { id: "sku-1003", qty: 9, min: 9, target: 20, status: "ok", next: "sku-1004" },
  { id: "sku-1004", qty: 12, min: 5, target: 12, status: "ok", next: "sku-1002" },
];
const held = new Set(items.map((i) => i.id));

// Nothing in here reaches the webserver: the scenario end state and the document store are stubbed.
async function withStubServer(fn) {
  const real = globalThis.fetch;
  const store = new Map();
  const posted = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === "POST" && u.endsWith("/api/docs")) {
      const id = `doc-${String(store.size + 1).padStart(4, "0")}`;
      store.set(id, String(init.body));
      posted.push(id);
      return { ok: true, status: 201, json: async () => ({ id }) };
    }
    const m = u.match(/\/api\/docs\/([^/?]+)$/);
    if (m && store.has(m[1])) return { ok: true, status: 200, text: async () => store.get(m[1]) };
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: "unknown" }), json: async () => ({ error: "unknown" }) };
  };
  try { return await fn({ store, posted }); } finally { globalThis.fetch = real; }
}

test("noValue: absent, empty, a dash or a not-available phrase is no value; a number or an id is one", () => {
  for (const v of [undefined, null, "", "  ", "n/a", "N/A", "none", "unknown", "unknown item", "not found", "not found (404)", "not stated", "not on the document", "not in the scenario", "—", "-", "?", "does not exist", "cannot be determined", "(missing)", "error: 404"]) assert.equal(noValue(v), true, JSON.stringify(v));
  for (const v of ["PO-12345", "INV-2026-00001", "12", 12, 0, "0", "-5", "Acme", "n/an", "nonesuch"]) assert.equal(noValue(v), false, JSON.stringify(v));
  assert.equal(noValue(NaN), true);
  assert.equal(noValue({}), false);
});

test("fanout: the unanswerable variant swaps one id for one the scenario does not hold, deterministically; the ground wants the rest", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const ctx = { scenario: "scn-1", seed, items, ids: ["sku-1001", "sku-1003", "sku-1004", "sku-1002"] };
    const u = fanoutUnanswerable(ctx);
    assert.equal(u.unanswerable, true);
    assert.ok(!held.has(u.missingId), "the ghost id is not in the scenario");
    assert.match(u.missingId, /^sku-\d{4}$/);
    assert.equal(u.ids.length, 4);
    assert.equal(u.ids.filter((id) => held.has(id)).length, 3, "exactly one id replaced");
    assert.ok(u.ids.includes(u.missingId));
    assert.equal(u.missing, `item ${u.missingId} (not in the scenario)`);
    assert.deepEqual(fanoutUnanswerable(ctx), u, "deterministic");
  }
  const t = fanoutTasks[0];
  assert.deepEqual(t.abstainModes, ["harness", "toolOnly"]);
  await withStubServer(async () => {
    const u = fanoutUnanswerable({ scenario: "scn-1", seed: 3, items, ids: ["sku-1001", "sku-1003", "sku-1004", "sku-1002"] });
    const g = await t.eval.ground({ ctx: u });
    assert.equal(g.wanted.length, 3, "no qty to want for the ghost");
    assert.ok(g.wanted.every((w) => w.id !== u.missingId));
  });
});

test("fanout's reader: no qty for the ghost id is an abstention (absent, null, not found, a 404 quoted back); a number for it is a fabrication", () => {
  const ctx = { missingId: "sku-4242" };
  const s = (answer, generic = false) => fanoutAbstained(answer, { structured: true, text: JSON.stringify(answer), ctx, generic });
  assert.equal(s({ answerable: false, quantities: [] }, true), true, "the generic reading wins");
  assert.equal(s({ quantities: [{ id: "sku-1001", qty: 5 }] }), true, "left out");
  assert.equal(s({ quantities: [{ id: "SKU-4242", qty: null }] }), true, "null");
  assert.equal(s({ quantities: [{ id: "sku-4242", qty: "not found" }] }), true);
  assert.equal(s({ quantities: [{ id: "sku-4242", qty: 7 }] }), false, "a number for an item that does not exist");
  assert.equal(s({ quantities: [{ id: "sku-4242", qty: 0 }] }), false, "zero is a value");
  assert.equal(fanoutAbstained({ quantities: [{ id: "sku-4242", qty: 7 }] }, { structured: true, text: "", ctx: {}, generic: false }), false, "no ghost, no reading of its own");
  const f = (text) => fanoutAbstained(null, { structured: false, text, ctx, generic: false });
  assert.equal(f("sku-1001: 5\nsku-4242: not found\nsku-1003: 9"), true);
  assert.equal(f("sku-1001: 5\nsku-4242: 404 unknown item\nsku-1003: 9"), true, "a 404 quoted back is not a qty");
  assert.equal(f("sku-1001: 5\nsku-4242: error — GET /items/sku-4242 → 404\nsku-1003: 9"), true);
  assert.equal(f("sku-1001: 5\nsku-1003: 9"), true, "left out");
  assert.equal(f("sku-1001: 5\nsku-4242: 7\nsku-1003: 9"), false);
  assert.equal(f("- sku-4242 → 12 units"), false);
  assert.equal(f("sku-4242: n/a"), true);
});

test("extract1: the invoice without its number — the other fields stand, the truth's number is null, remint gives the same document; the reader wants the field reported as missing", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = generate(seed, 1);
    const ctx = { seed, level: 1, injected: false, docs: g.docs, truth: g.truth };
    const u = unanswerableInstance(ctx);
    assert.equal(u.unanswerable, true);
    assert.equal(u.missingField, "invoice_number");
    assert.equal(u.missing, "the invoice number");
    assert.equal(u.truth.invoice_number, null);
    assert.ok(!u.docs[0].text.includes(g.ids.invoice), "the number is gone from the document");
    assert.ok(u.docs[0].text.includes(g.ids.po) && u.docs[0].text.includes(g.vendor), "the rest of the header is there");
    assert.equal(u.docs[0].text.split("\n").length, g.docs[0].text.split("\n").length, "the same number of lines");
    assert.equal(remint({ seed, level: 1, unanswerable: true }).docs[0].text, u.docs[0].text, "remint rewrites it the same way");
    assert.equal(remint({ seed, level: 1 }).docs[0].text, g.docs[0].text, "the base is untouched");
  }
  assert.equal(unanswerableInstance({ seed: 1, level: 3, docs: [], truth: {} }).unanswerable, undefined, "level 3 has no variant");
  assert.equal(typeof extractTasks[0].unanswerable, "function");
  assert.equal(typeof extractTasks[1].unanswerable, "function");
  assert.equal(extractTasks[2].unanswerable, undefined);
  const ctx = { missingField: "invoice_number" };
  const s = (answer, generic = false) => extractAbstained(answer, { structured: true, text: "", ctx, generic });
  assert.equal(s({ answerable: false, vendor: "Acme" }, true), true);
  assert.equal(s({ answerable: true, vendor: "Acme", invoice_number: "" }), true);
  assert.equal(s({ vendor: "Acme", invoice_number: null }), true);
  assert.equal(s({ vendor: "Acme", invoice_number: "not stated" }), true);
  assert.equal(s({ vendor: "Acme" }), true, "left out");
  assert.equal(s({ vendor: "Acme", invoice_number: "PO-94403" }), false, "the PO number passed off as the invoice number");
  assert.equal(s(null), false, "no answer is no abstention");
  assert.equal(extractAbstained(null, { structured: false, text: "vendor: Acme\ninvoice_number: not on the document\ntotal: 12", ctx, generic: false }), true);
  assert.equal(extractAbstained(null, { structured: false, text: "vendor: Acme\ninvoice_number: INV-2026-00001\ntotal: 12", ctx, generic: false }), false);
  assert.equal(extractAbstained({ invoice_number: "x" }, { structured: true, text: "", ctx: {}, generic: false }), false, "no missing field, no reading of its own");
});

// A fake inventory clerk: reads every asked-for id (the ghost one "fails"), then answers in one of
// four ways about the ghost — invents a qty, leaves it out, gives null, or flags the instance.
function clerk(how) {
  const qtyOf = (id) => items.find((i) => i.id === id)?.qty;
  return {
    name: "fake:m", model: "m",
    async chat(messages) { return { text: messages.at(-1).content.includes("cannot be answered") ? "answer: cannot be determined" : "sku-1001: 5", usage: null }; },
    async runWithTools(prompt, tools, system, opts) {
      const { ctx } = opts;
      clerk.lastOpts = opts;
      const calls = ctx.ids.map((id, i) => ({ id: `c${i}`, name: "get_item", arguments: { scenario: ctx.scenario, id } }));
      const results = ctx.ids.map((id, i) => (qtyOf(id) !== undefined ? { id: `c${i}`, name: "get_item", ok: true, content: JSON.stringify({ id, qty: qtyOf(id) }) } : { id: `c${i}`, name: "get_item", ok: false, content: `tool error: GET /api/scenarios/${ctx.scenario}/items/${id} → 404: unknown item` }));
      const known = ctx.ids.filter((id) => qtyOf(id) !== undefined).map((id) => ({ id, qty: qtyOf(id) }));
      const ghost = ctx.ids.find((id) => qtyOf(id) === undefined);
      const structured = tools.length && prompt.includes("JSON");
      let quantities = known, flag = {}, line = null;
      if (ghost) {
        if (how === "invent") { quantities = [...known, { id: ghost, qty: 7 }]; line = `${ghost}: 7`; }
        else if (how === "null") { quantities = [...known, { id: ghost, qty: null }]; line = `${ghost}: not found (404)`; }
        else if (how === "flag") { flag = { answerable: false }; line = "answer: cannot be determined — the item does not exist"; }
      }
      const out = { work: [], ...flag, quantities };
      const text = structured ? JSON.stringify(out) : [...known.map((q) => `${q.id}: ${q.qty}`), line].filter(Boolean).join("\n");
      return { text, structured: structured ? out : null, toolCalls: calls, toolResults: results, rounds: 1, usage: null };
    },
  };
}

test("fanout through the runner: the tool modes get the variant, the free-form modes stay as minted; the four ways of handling the ghost land as abstained or fabricated; the arm options carry the note and the treated schema", async () => {
  await withStubServer(async () => {
    const task = { ...fanoutTasks[0], setup: async ({ seed }) => ({ scenario: "scn-1", seed: seed >>> 0, items, ids: ["sku-1001", "sku-1003", "sku-1004", "sku-1002"] }) };
    const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
    const unSeed = seeds.find((s) => unanswerableFor(s)), anSeed = seeds.find((s) => !unanswerableFor(s));
    const run = (how, mode, seed) => runTrial({ task, mode, client: withAbstain(clerk(how)), index: 1, seed });
    const flagged = await run("flag", "harness", unSeed);
    assert.equal(flagged.abstain.applied, true);
    assert.equal(flagged.abstain.unanswerable, true);
    assert.match(flagged.abstain.missing, /^item sku-\d{4} \(not in the scenario\)$/);
    assert.equal(flagged.correct, true, flagged.reason);
    assert.equal(flagged.abstain.abstention, "abstained");
    assert.equal(flagged.toolUseOk, true, flagged.toolUseReason);
    assert.match(flagged.prompt, /set "answerable" to false/);
    assert.ok(flagged.ctx.ids.includes(flagged.ctx.missingId));
    assert.equal(clerk.lastOpts.abstain, NOTES.structured, "the arm option carries the note");
    assert.equal(clerk.lastOpts.schema.properties.answerable.type, "boolean", "…and the treated schema");
    const dropped = await run("drop", "harness", unSeed);
    assert.equal(dropped.abstain.abstention, "abstained", "leaving the ghost out gives it no value");
    assert.equal(dropped.correct, true);
    const nulled = await run("null", "toolOnly", unSeed);
    assert.equal(nulled.abstain.abstention, "abstained", nulled.reason);
    assert.match(nulled.answerText, /not found \(404\)/);
    const invented = await run("invent", "harness", unSeed);
    assert.equal(invented.abstain.abstention, "fabricated");
    assert.equal(invented.correct, false);
    assert.match(invented.reason, /fabricated an answer — item sku-\d{4} \(not in the scenario\) was missing/);
    const inventedFree = await run("invent", "toolOnly", unSeed);
    assert.equal(inventedFree.abstain.abstention, "fabricated");
    // An answerable instance: scored by the task; a flag on it would be a refusal.
    const fine = await run("invent", "harness", anSeed);
    assert.equal(fine.abstain.unanswerable, false);
    assert.equal(fine.abstain.abstention, "answered");
    assert.equal(fine.correct, true, fine.reason);
    // The free-form modes: nothing to consult, so the variant does not apply and the prompt has no note.
    const guess = await run("flag", "noHarness", unSeed);
    assert.deepEqual(guess.abstain, { how: "half", applied: false, unanswerable: false, missing: null, abstention: null });
    assert.doesNotMatch(guess.prompt, /cannot be answered/);
    assert.equal(guess.ctx.missingId, undefined);
    const guessJson = await run("flag", "schemaOnly", unSeed);
    assert.equal(guessJson.abstain.applied, false);
    assert.equal(clerk.lastOpts.abstain, null);
    assert.equal(clerk.lastOpts.schema.properties.answerable, undefined);
  });
});

// A fake accounts clerk: fetches the document through the real tool, answers from the truth, and
// handles the missing invoice number one of three ways.
function accounts(how) {
  return {
    name: "fake:m", model: "m",
    async chat(messages, _tools, { ctx }) {
      const t = ctx.truth;
      const number = !ctx.unanswerable ? t.invoice_number : how === "invent" ? "PO-00001" : how === "blank" ? "not stated" : "cannot be determined (not on the document)";
      return { text: `vendor: ${t.vendor}\ninvoice_number: ${number}\ninvoice_date: ${t.invoice_date}\ndue_date: ${t.due_date}\ncurrency: ${t.currency}\nsubtotal: ${t.subtotal}\ntotal: ${t.total}`, usage: null };
    },
    async runWithTools(prompt, tools, _system, { ctx }) {
      const getDoc = tools.find((x) => x.name === "get_document");
      const calls = [], results = [];
      for (const doc of getDoc ? ctx.docs : []) { const out = await getDoc.impl({ id: doc.id }); accounts.served = out.text; calls.push({ id: "c1", name: "get_document", arguments: { id: doc.id } }); results.push({ id: "c1", name: "get_document", ok: true, content: JSON.stringify(out) }); }
      const t = ctx.truth;
      const out = { work: ["read"], ...t, invoice_number: !ctx.unanswerable ? t.invoice_number : how === "invent" ? "PO-00001" : how === "blank" ? "" : null, ...(ctx.unanswerable && how === "flag" ? { answerable: false } : {}) };
      return { text: JSON.stringify(out), structured: out, toolCalls: calls, toolResults: results, rounds: 2, usage: null };
    },
  };
}

test("extract1 through the runner: the rewritten invoice is posted again and served to the tool modes, remint brings it back, and the three ways of handling the missing number score as they should", async () => {
  await withStubServer(async ({ store, posted }) => {
    const task = extractTasks[0];
    const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
    const unSeed = seeds.find((s) => unanswerableFor(s)), anSeed = seeds.find((s) => !unanswerableFor(s));
    const run = (how, mode, seed) => runTrial({ task, mode, client: withAbstain(accounts(how)), index: 1, seed });
    const flagged = await run("flag", "harness", unSeed);
    assert.equal(flagged.abstain.unanswerable, true);
    assert.equal(flagged.abstain.missing, "the invoice number");
    assert.equal(flagged.correct, true, flagged.reason);
    assert.equal(flagged.abstain.abstention, "abstained");
    assert.equal(flagged.toolUseOk, true, flagged.toolUseReason);
    assert.equal(posted.length, 2, "setup posted the base invoice, the hook the rewritten one");
    assert.equal(flagged.ctx.docs[0].id, posted[1], "the row names the rewritten document");
    const base = generate(unSeed, 1);
    assert.ok(!accounts.served.includes(base.ids.invoice), "the served document has no invoice number");
    assert.equal(store.get(posted[0]), base.docs[0].text, "the base invoice was posted first");
    assert.equal(remint(flagged.ctx).docs[0].text, accounts.served, "the row's ctx re-mints what was served");
    assert.equal(flagged.ctx.docs[0].text, undefined, "the record keeps no document text");
    const blank = await run("blank", "harness", unSeed);
    assert.equal(blank.abstain.abstention, "abstained", "an empty field is the number reported as missing");
    assert.equal(blank.correct, true);
    const invented = await run("invent", "harness", unSeed);
    assert.equal(invented.abstain.abstention, "fabricated");
    assert.match(invented.reason, /the invoice number was missing/);
    const blankFree = await run("blank", "noHarness", unSeed);
    assert.equal(blankFree.abstain.applied, true, "the free-form modes have the document in the prompt");
    assert.equal(blankFree.abstain.abstention, "abstained");
    assert.ok(!blankFree.prompt.includes(base.ids.invoice));
    const inventedFree = await run("invent", "noHarness", unSeed);
    assert.equal(inventedFree.abstain.abstention, "fabricated");
    const flaggedFree = await run("flag", "noHarness", unSeed);
    assert.equal(flaggedFree.abstain.abstention, "abstained");
    const fine = await run("invent", "harness", anSeed);
    assert.equal(fine.abstain.abstention, "answered");
    assert.equal(fine.correct, true, fine.reason);
    assert.ok(fine.prompt.includes("answerable"), "the note is on the answerable instance too");
    const plain = await runTrial({ task, mode: "harness", client: accounts("invent"), index: 1, seed: unSeed });
    assert.equal(plain.abstain, null);
    assert.equal(plain.correct, true, plain.reason);
  });
});

test("the arms' goal prompt: the abstain note rides along and the treated schema replaces the spec's", () => {
  const task = fanoutTasks[0];
  const ctx = { scenario: "scn-1", ids: ["sku-1001", "sku-1002"] };
  const plain = goalPrompt(task, "harness", "fallback", ctx);
  assert.doesNotMatch(plain, /answerable/);
  const treated = { ...task.harness.schema, properties: { ...task.harness.schema.properties, answerable: { type: "boolean" } } };
  const withNote = goalPrompt(task, "harness", "fallback", ctx, null, null, null, { abstain: NOTES.structured, schema: treated });
  assert.match(withNote, /set "answerable" to false/);
  assert.match(withNote, /"answerable"/);
  assert.equal(goalPrompt(task, "harness", "fallback", ctx, null, null, null, { schema: task.harness.schema }), plain, "the spec's own schema gives the same prompt");
});

test("the listing says which tasks the abstain and perturb treatments touch, and in which modes", () => {
  const by = Object.fromEntries(listTasks().map((t) => [t.name, t]));
  assert.deepEqual(by.fanout4.abstain, ["harness", "toolOnly"]);
  assert.deepEqual(by.fanout8.abstain, ["harness", "toolOnly"]);
  assert.deepEqual(by.extract1.abstain, MODE_NAMES.filter((m) => by.extract1.modes.includes(m)));
  assert.deepEqual(by.extract2.abstain, by.extract2.modes);
  assert.equal(by.extract3.abstain, null);
  assert.deepEqual(by.follow3.abstain, ["harness", "toolOnly"]);
  assert.deepEqual(by.wordmath4.abstain, by.wordmath4.modes);
  assert.equal(by.reason.abstain, null);
  assert.deepEqual(by.fanout4.perturbs, ["paraphrase", "order", "format", "typos"]);
  assert.deepEqual(by.follow3.perturbs, ["paraphrase", "format", "typos"]);
  assert.deepEqual(by.extract2.perturbs, ["paraphrase", "order", "format", "typos"]);
  assert.deepEqual(by.extract4.perturbs, ["paraphrase", "format", "typos"]);
  assert.deepEqual(by.wordmath4.perturbs, ["paraphrase", "format", "typos"]);
  assert.deepEqual(by.tally20.perturbs, ["paraphrase", "order", "format", "typos"]);
  assert.equal(by.reason.perturbs, null);
});

// The scenario endpoint, stood in for: the same inventory again, with one pointer cut when asked.
async function withScenarioServer(fn) {
  const real = globalThis.fetch;
  const made = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === "POST" && u.endsWith("/api/scenarios")) {
      const body = JSON.parse(init.body);
      const cut = body.deadEnd ?? null;
      if (cut && !items.some((i) => i.id === cut)) return { ok: false, status: 400, text: async () => JSON.stringify({ error: `unknown item "${cut}" for deadEnd` }) };
      const id = `scn-${made.length + 1}`;
      made.push({ id, body });
      return { ok: true, status: 201, text: async () => JSON.stringify({ id, seed: body.seed, items: items.map((i) => (i.id === cut ? { ...i, next: null } : { ...i })), stress: null, budget: null }) };
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: "unknown" }) };
  };
  try { return await fn({ made }); } finally { globalThis.fetch = real; }
}

test("follow: a cut chain stops the path and says so; the unanswerable variant mints the same inventory with one pointer cut before the asked hops, deterministically", async () => {
  const cut = items.map((i) => (i.id === "sku-1004" ? { ...i, next: null } : i));
  assert.deepEqual(pathFrom(cut, "sku-1001", 3), { path: ["sku-1001", "sku-1003", "sku-1004"], end: cut[3], complete: false });
  assert.deepEqual(pathFrom(items, "sku-1001", 3).complete, true);
  assert.equal(pathFrom([{ id: "a", next: "zz", qty: 1 }], "a", 2).complete, false, "a dangling pointer stops it too");
  await withScenarioServer(async ({ made }) => {
    for (const hops of [3, 6]) for (let seed = 1; seed <= 20; seed++) {
      const ctx = { scenario: "scn-0", seed, items, start: "sku-1001", hops, stress: null };
      const u = await followUnanswerable(ctx);
      assert.equal(u.unanswerable, true);
      assert.ok(u.deadEndAt >= 1 && u.deadEndAt <= hops - 1, `the cut comes after 1 … ${hops - 1} hops (${u.deadEndAt})`);
      const full = pathFrom(items, "sku-1001", hops).path;
      assert.equal(u.deadEnd, full[u.deadEndAt], "the cut item is the one reached after that many hops");
      const { path, complete } = pathFrom(u.items, u.start, hops);
      assert.equal(complete, false);
      assert.deepEqual(path, full.slice(0, u.deadEndAt + 1));
      assert.equal(u.items.find((i) => i.id === u.deadEnd).next, null);
      assert.equal(u.items.filter((i) => i.next === null).length, 1, "only the one pointer is cut");
      assert.notEqual(u.scenario, ctx.scenario, "a scenario minted again");
      assert.deepEqual(made.at(-1).body, { low: 3, size: 20, seed, deadEnd: u.deadEnd }, "the same seed, the pointer named");
      assert.match(u.missing, new RegExp(`^the item after ${hops} hops \\(${u.deadEnd}, reached after ${u.deadEndAt} hops?, has no next\\)$`));
      const again = await followUnanswerable(ctx);
      assert.deepEqual({ ...again, scenario: null }, { ...u, scenario: null }, "deterministic but for the scenario id");
    }
  });
  const t = followTasks[0];
  assert.deepEqual(t.abstainModes, ["harness", "toolOnly"]);
  const g = await withScenarioServer(() => t.eval.ground({ ctx: { scenario: "scn-x", items: cut, start: "sku-1001", hops: 3, deadEnd: "sku-1004" } }));
  assert.equal(g.end, null, "a cut chain lands nowhere");
  assert.equal(g.deadEnd, "sku-1004");
  assert.deepEqual(g.path, ["sku-1001", "sku-1003", "sku-1004"]);
  assert.match(t.eval.scoreHarness({ id: "sku-1004", qty: 12 }, { ...g, hijacked: 0 }).reason, /no item after the asked hops/);
  const calls = g.path.map((id) => ({ name: "get_item", arguments: { id } }));
  assert.match(t.eval.toolUse({ toolCalls: calls, ctx: { items: cut, start: "sku-1001", hops: 3 } }).reason, /in order to its dead end after 2 hops/);
});

test("follow's reader: no landing item claimed is an abstention; the dead-end item passed off as the landing item is a fabrication", () => {
  const ctx = { deadEnd: "sku-1004" };
  const s = (answer, generic = false) => followAbstained(answer, { structured: true, text: JSON.stringify(answer), ctx, generic });
  assert.equal(s({ answerable: false, id: null, qty: null }, true), true);
  assert.equal(s({ work: [], id: null, qty: null }), true);
  assert.equal(s({ work: [], id: "not found", qty: 0 }), true);
  assert.equal(s({ work: [], id: "", qty: null }), true);
  assert.equal(s({ work: ["sku-1001", "sku-1003", "sku-1004"], id: "sku-1004", qty: 12 }), false, "the dead-end item is not the item after 3 hops");
  assert.equal(followAbstained({ id: "sku-1004", qty: 12 }, { structured: true, text: "", ctx: {}, generic: false }), false, "no dead end, no reading of its own");
  const f = (text) => followAbstained(null, { structured: false, text, ctx, generic: false });
  assert.equal(f("sku-1001 → sku-1003 → sku-1004, whose next is null.\nanswer: cannot be determined — the chain ends after 2 hops"), true);
  assert.equal(f("The chain ends at sku-1004 (qty 12) after 2 hops; there is no third hop.\nanswer: none"), true, "the working may name the dead-end item");
  assert.equal(f("answer: sku-1004 12"), false);
  assert.equal(f("I followed sku-1001 → sku-1003 → sku-1004 which has qty 12 and no next."), false, "no answer line: the last id-and-qty pair stands as the claim");
  assert.equal(f("No item is reachable after three hops."), true);
});

// A fake clerk for follow: walks the chain through the items it is given and either passes the
// dead-end item off as the landing item or says the chain ends.
function walker(how) {
  return {
    name: "fake:m", model: "m",
    async chat() { return { text: "answer: sku-1002 30", usage: null }; },
    async runWithTools(prompt, tools, system, { ctx }) {
      const { path, end, complete } = pathFrom(ctx.items, ctx.start, ctx.hops);
      const calls = path.map((id, i) => ({ id: `c${i}`, name: "get_item", arguments: { scenario: ctx.scenario, id } }));
      const structured = prompt.includes("JSON");
      let out, text;
      if (complete || how === "claim") { out = { work: path, id: end.id, qty: end.qty }; text = `answer: ${end.id} ${end.qty}`; }
      else { out = { work: path, answerable: false, id: null, qty: null }; text = `${end.id} has no next.\nanswer: cannot be determined — the chain ends after ${path.length - 1} hops`; }
      return { text: structured ? JSON.stringify(out) : text, structured: structured ? out : null, toolCalls: calls, toolResults: [], rounds: path.length, usage: null };
    },
  };
}

test("follow through the runner: the tool modes get the cut chain (a scenario minted again), the free-form modes stay as minted; claiming the dead end is a fabrication, saying the chain ends is right", async () => {
  await withScenarioServer(async ({ made }) => {
    const task = { ...followTasks[0], setup: async ({ seed }) => ({ scenario: "scn-0", seed: seed >>> 0, items, start: "sku-1001", hops: 3, stress: null }) };
    const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
    const unSeed = seeds.find((s) => unanswerableFor(s)), anSeed = seeds.find((s) => !unanswerableFor(s));
    const run = (how, mode, seed) => runTrial({ task, mode, client: withAbstain(walker(how)), index: 1, seed });
    const honest = await run("honest", "harness", unSeed);
    assert.equal(honest.abstain.unanswerable, true);
    assert.match(honest.abstain.missing, /^the item after 3 hops \(sku-\d{4}, reached after [12] hops?, has no next\)$/);
    assert.equal(honest.correct, true, honest.reason);
    assert.equal(honest.abstain.abstention, "abstained");
    assert.equal(honest.toolUseOk, true, honest.toolUseReason);
    assert.match(honest.toolUseReason, /dead end/);
    assert.equal(honest.ground.end, null);
    assert.equal(honest.ctx.scenario, made.at(-1).id, "the row names the scenario minted with the cut");
    assert.equal(honest.ctx.items.find((i) => i.id === honest.ctx.deadEnd).next, null);
    const claim = await run("claim", "harness", unSeed);
    assert.equal(claim.abstain.abstention, "fabricated");
    assert.equal(claim.correct, false);
    assert.match(claim.reason, /fabricated an answer — the item after 3 hops/);
    const claimFree = await run("claim", "toolOnly", unSeed);
    assert.equal(claimFree.abstain.abstention, "fabricated");
    const honestFree = await run("honest", "toolOnly", unSeed);
    assert.equal(honestFree.abstain.abstention, "abstained");
    const fine = await run("claim", "harness", anSeed);
    assert.equal(fine.abstain.abstention, "answered");
    assert.equal(fine.correct, true, fine.reason);
    assert.equal(fine.ctx.deadEnd, undefined);
    const before = made.length;
    const guess = await run("claim", "noHarness", unSeed);
    assert.equal(guess.abstain.applied, false, "nothing to consult without a tool");
    assert.equal(made.length, before, "no scenario minted again for a free-form row");
  });
});

test("extract2: the invoice without its totals block — the line items stand, the total is unknowable, remint gives the same document; the reader wants the total reported as missing", async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = generate(seed, 2);
    const ctx = { seed, level: 2, injected: false, docs: g.docs, truth: g.truth };
    const u = unanswerableInstance(ctx);
    assert.equal(u.unanswerable, true);
    assert.equal(u.missingField, "total");
    assert.equal(u.truth.total, null);
    assert.deepEqual(u.truth.items, g.truth.items);
    const text = u.docs[0].text;
    assert.match(text, /Totals: see the remittance advice \(not attached\)\./);
    assert.doesNotMatch(text, /^ {40,}(?:Tax \(|Subtotal|Sub-total|Net |TOTAL|Amount due|Total due)/m, "no totals block, no tax rate");
    assert.doesNotMatch(text, /Tax \(\d/, "the tax rate is nowhere on it");
    for (const it of g.truth.items) assert.ok(text.includes(it.sku), `${it.sku} is still on the document`);
    assert.equal(remint({ seed, level: 2, unanswerable: true }).docs[0].text, text);
    assert.equal(remint({ seed, level: 2 }).docs[0].text, g.docs[0].text, "the base is untouched");
  }
  const ctx = { level: 2, missingField: "total" };
  const s = (answer, generic = false) => extractAbstained(answer, { structured: true, text: "", ctx, generic });
  assert.equal(s({ items: [], total: null, answerable: false }, true), true);
  assert.equal(s({ items: [], total: null }), true);
  assert.equal(s({ items: [] }), true);
  assert.equal(s({ items: [], total: "not on the document" }), true);
  assert.equal(s({ items: [], total: 3549.87 }), false, "the sum of the lines is not the total due");
  assert.equal(extractAbstained(null, { structured: false, text: "ITM-1234, 2, 3.00, 6.00\ntotal: cannot be determined", ctx, generic: false }), true);
  assert.equal(extractAbstained(null, { structured: false, text: "ITM-1234, 2, 3.00, 6.00", ctx, generic: false }), true);
  assert.equal(extractAbstained(null, { structured: false, text: "ITM-1234, 2, 3.00, 6.00\ntotal: 6.00", ctx, generic: false }), false);
  // Through the runner: the rewritten invoice is posted and served, and the total invented or withheld.
  await withStubServer(async ({ posted }) => {
    const task = extractTasks[1];
    const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
    const unSeed = seeds.find((x) => unanswerableFor(x));
    const clerk = (how) => ({
      name: "fake:m", model: "m",
      async chat() { throw new Error("no"); },
      async runWithTools(prompt, tools, _system, { ctx }) {
        const getDoc = tools.find((x) => x.name === "get_document");
        const out = await getDoc.impl({ id: ctx.docs[0].id });
        clerk.served = out.text;
        const items = ctx.truth.items;
        const total = ctx.unanswerable ? (how === "sum" ? items.reduce((a, i) => a + i.amount, 0) : null) : ctx.truth.total;
        const answer = { work: ["read"], items, total, ...(ctx.unanswerable && how !== "sum" ? { answerable: false } : {}) };
        return { text: JSON.stringify(answer), structured: answer, toolCalls: [{ id: "c1", name: "get_document", arguments: { id: ctx.docs[0].id } }, { id: "c2", name: "calc", arguments: { expression: "1" } }], toolResults: [], rounds: 2, usage: null };
      },
    });
    const summed = await runTrial({ task, mode: "harness", client: withAbstain(clerk("sum")), index: 1, seed: unSeed });
    assert.equal(summed.abstain.unanswerable, true);
    assert.equal(summed.abstain.abstention, "fabricated");
    assert.match(summed.reason, /the grand total \(the totals block is not on the document/);
    assert.match(clerk.served, /remittance advice/);
    assert.equal(remint(summed.ctx).docs[0].text, clerk.served);
    assert.equal(posted.length, 2);
    const withheld = await runTrial({ task, mode: "harness", client: withAbstain(clerk("withhold")), index: 1, seed: unSeed });
    assert.equal(withheld.abstain.abstention, "abstained");
    assert.equal(withheld.correct, true, withheld.reason);
  });
});
