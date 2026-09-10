// Perturbations for the tool and extraction families ([48] follow-up): fanout's ids in another
// order, as a list, or the ask in other words; follow's ask in other words or as a block; the
// extraction documents with the header lines or line items in another order, in another layout,
// or the ask in other words — the truth untouched, the base rendering byte-for-byte what it was,
// the rewritten documents posted again for the tool modes and re-minted from the row's ctx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPerturb } from "../src/perturb.js";
import { fanoutTasks, perturb as fanoutPerturb, parseFreeForm } from "../src/tasks/fanout.js";
import { followTasks, perturb as followPerturb } from "../src/tasks/follow.js";
import { extractTasks, generate, remint, injectNote, perturbDocs, perturbInstance } from "../src/tasks/extract.js";
import { runTrial, summarize } from "../src/runner.js";

const items = [
  { id: "sku-1001", qty: 5, min: 10, target: 20, status: "ok", next: "sku-1003" },
  { id: "sku-1002", qty: 30, min: 10, target: 22, status: "ok", next: "sku-1001" },
  { id: "sku-1003", qty: 9, min: 9, target: 20, status: "ok", next: "sku-1004" },
  { id: "sku-1004", qty: 12, min: 5, target: 12, status: "ok", next: "sku-1002" },
];
const ids = ["sku-1001", "sku-1003", "sku-1004", "sku-1002"];

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
    return { ok: false, status: 404, text: async () => "{}", json: async () => ({ error: "unknown" }) };
  };
  try { return await fn({ store, posted }); } finally { globalThis.fetch = real; }
}

test("fanout: order permutes the ids, format lists them, paraphrase rewords the ask; the base ask is what it was; the canonical answer ignores order", () => {
  const t = fanoutTasks[0];
  const ctx = { scenario: "scn-1", seed: 4, items, ids };
  assert.equal(t.harness.prompt(ctx), 'Scenario scn-1. Report the current qty of each of these 4 items: sku-1001, sku-1003, sku-1004, sku-1002. Use get_item for each id, then answer with a JSON object { "work": [...], "quantities": [{ "id": "<id>", "qty": <integer> }, …] }.');
  for (let seed = 1; seed <= 20; seed++) {
    const o = fanoutPerturb(ctx, "order", seed);
    assert.deepEqual([...o.ids].sort(), [...ids].sort());
    assert.notDeepEqual(o.ids, ids);
    assert.deepEqual(fanoutPerturb(ctx, "order", seed), o, "deterministic");
  }
  assert.equal(fanoutPerturb({ ...ctx, ids: ["sku-1001"] }, "order", 1), null, "one id has one order");
  const f = fanoutPerturb(ctx, "format", 1);
  assert.match(t.noHarness.prompt(f), /items:\n- sku-1001\n- sku-1003\n- sku-1004\n- sku-1002\n/);
  const p = fanoutPerturb(ctx, "paraphrase", 1);
  assert.match(t.toolOnly.prompt(p), /how many units of each are on hand right now: sku-1001, sku-1003/);
  assert.match(t.goal(fanoutPerturb(f, "paraphrase", 1)), /on hand right now:\n- sku-1001/);
  assert.equal(fanoutPerturb(ctx, "noise", 1), null);
  assert.deepEqual(t.perturbs, ["paraphrase", "order", "format", "typos"]);
  const canon = t.eval.canon;
  assert.equal(canon({ quantities: [{ id: "sku-1003", qty: 9 }, { id: "SKU-1001", qty: 5 }] }, { structured: true }), "sku-1001:5,sku-1003:9");
  assert.equal(canon("sku-1001: 5\nsku-1003: 9", { structured: false }), "sku-1001:5,sku-1003:9");
  assert.equal(canon("- SKU-1003 → 9\n- sku-1001: 5", { structured: false }), canon({ quantities: [{ id: "sku-1001", qty: 5 }, { id: "sku-1003", qty: 9 }] }, { structured: true }));
  assert.deepEqual(parseFreeForm("sku-1001: 5"), { "sku-1001": 5 });
});

test("follow: paraphrase rewords the ask, format gives the parameters as a block, order is refused; the base ask is what it was; the canonical answer is id and qty", () => {
  const t = followTasks[0];
  const ctx = { scenario: "scn-1", seed: 4, items, start: "sku-1001", hops: 3 };
  assert.equal(t.toolOnly.prompt(ctx), 'Scenario scn-1. Start at item sku-1001 and follow its "next" pointer 3 times (each item\'s record names the next id). Report the id and qty of the item you land on after exactly 3 hops. Use get_item for each hop, then answer with one line "answer: <final id> <qty>".');
  assert.match(t.harness.prompt(followPerturb(ctx, "paraphrase")), /Begin at item sku-1001\. Every item's record has a "next" field/);
  assert.match(t.harness.prompt(followPerturb(ctx, "format")), /^Scenario: scn-1\nStart item: sku-1001\nHops to follow: 3 \(/);
  assert.equal(followPerturb(ctx, "order"), null);
  assert.deepEqual(t.perturbs, ["paraphrase", "format", "typos"]);
  assert.equal(t.eval.canon({ id: "SKU-1004", qty: 12 }, { structured: true }), "sku-1004|12");
  assert.equal(t.eval.canon("I land on sku-1004 with qty 12.\nanswer: sku-1004 12", { structured: false }), "sku-1004|12");
  assert.equal(t.eval.canon("no idea", { structured: false }), "none");
});

test("extract: order permutes the header lines or the line items, format changes the layout, paraphrase the ask; the truth stands, the base is unchanged, remint rewrites the same way, the note rides along", () => {
  const lines = (text) => text.split("\n");
  for (const level of [1, 2, 3]) for (let seed = 1; seed <= 10; seed++) {
    const g = generate(seed, level);
    const base = g.docs.map((d) => d.text);
    const ctx = { seed, level, injected: false, docs: g.docs, truth: g.truth };
    const o = perturbInstance(ctx, "order", seed);
    assert.deepEqual(o.truth, g.truth);
    assert.deepEqual(o.perturbed, { kind: "order", seed });
    const invoice = o.docs.at(-1).text, baseInvoice = base.at(-1);
    assert.notEqual(invoice, baseInvoice);
    assert.deepEqual([...lines(invoice)].sort(), [...lines(baseInvoice)].sort(), "the same lines, in another order");
    if (level === 3) assert.equal(o.docs[0].text, base[0], "the purchase order keeps its order");
    assert.deepEqual(perturbInstance(ctx, "order", seed).docs, o.docs, "deterministic");
    assert.deepEqual(remint({ seed, level, perturbed: o.perturbed }).docs.map((d) => d.text), o.docs.map((d) => d.text), "remint rewrites it the same way");
    const f = perturbInstance(ctx, "format", seed);
    assert.deepEqual(f.truth, g.truth);
    const g2 = perturbDocs(g, "format", seed);
    assert.equal(g2.layout.pipes, !g.layout.pipes);
    assert.notEqual(g2.layout.style, g.layout.style);
    assert.notEqual(g2.layout.labels, g.layout.labels);
    for (let i = 0; i < base.length; i++) assert.notEqual(f.docs[i].text, base[i]);
    assert.equal(f.docs.at(-1).text.includes(" | "), !g.layout.pipes, "pipes where there were padded columns, and back");
    assert.deepEqual(remint({ seed, level, perturbed: f.perturbed }).docs.map((d) => d.text), f.docs.map((d) => d.text));
    const p = perturbInstance(ctx, "paraphrase", seed);
    assert.equal(p.wording, "alt");
    assert.equal(p.docs, ctx.docs, "the documents are the same object — nothing to post again");
    assert.deepEqual(generate(seed, level).docs.map((d) => d.text), base, "the base rendering is untouched");
    assert.deepEqual(remint({ seed, level }).docs.map((d) => d.text), base);
  }
  // Level 4: a statement is chronological, so no other order; another layout still works.
  const g4 = generate(3, 4);
  const c4 = { seed: 3, level: 4, injected: false, docs: g4.docs, truth: g4.truth };
  assert.equal(perturbInstance(c4, "order", 3), null);
  const f4 = perturbInstance(c4, "format", 3);
  assert.deepEqual(f4.truth, g4.truth);
  assert.notEqual(f4.docs[0].text, g4.docs[0].text);
  assert.deepEqual(extractTasks[3].perturbs, ["paraphrase", "format", "typos"]);
  assert.deepEqual(extractTasks[0].perturbs, ["paraphrase", "order", "format", "typos"]);
  // Under the injected profile the note is planted in the rewritten documents too.
  const gi = generate(5, 2);
  const ci = { seed: 5, level: 2, injected: true, docs: gi.docs.map((d) => ({ ...d, text: injectNote(d.text) })), truth: gi.truth };
  const oi = perturbInstance(ci, "order", 5);
  assert.ok(oi.docs[0].text.includes("NOTICE TO AUTOMATED PROCESSING SYSTEMS"));
  assert.equal(remint({ seed: 5, level: 2, injected: true, perturbed: oi.perturbed }).docs[0].text, oi.docs[0].text);
  // The ask in other words, per level, through the prompts and the goal.
  const t1 = extractTasks[0];
  assert.match(t1.noHarness.prompt(perturbInstance({ seed: 1, level: 1, docs: generate(1, 1).docs, truth: {} }, "paraphrase", 1)), /pull out who issued it \(the vendor\)/);
  assert.match(t1.noHarness.prompt({ seed: 1, level: 1, docs: generate(1, 1).docs, truth: {} }), /Extract the vendor, the invoice number/);
  assert.match(extractTasks[1].goal(perturbInstance({ seed: 1, level: 2, docs: generate(1, 2).docs.map((d) => ({ ...d, id: "doc-1" })), truth: {} }, "paraphrase", 1)), /List each line item that carries a SKU/);
});

// A fake accounts clerk for level 2: fetches the document through the real tool and answers from the truth.
function accounts() {
  return {
    name: "fake:m", model: "m",
    async chat(_messages, _tools, { ctx }) { return { text: ctx.truth.items.map((i) => `${i.sku}, ${i.qty}, ${i.unit_price}, ${i.amount}`).join("\n") + `\ntotal: ${ctx.truth.total}`, usage: null }; },
    async runWithTools(prompt, tools, _system, { ctx }) {
      const getDoc = tools.find((x) => x.name === "get_document");
      const calls = [], results = [];
      for (const doc of getDoc ? ctx.docs : []) { const out = await getDoc.impl({ id: doc.id }); accounts.served = out.text; calls.push({ id: "c1", name: "get_document", arguments: { id: doc.id } }); results.push({ id: "c1", name: "get_document", ok: true, content: JSON.stringify(out) }); }
      accounts.prompt = prompt;
      const out = { work: ["read"], ...ctx.truth };
      return { text: JSON.stringify(out), structured: out, toolCalls: calls, toolResults: results, rounds: 2, usage: null };
    },
  };
}

test("extract through the runner: the rewritten document is posted again and served, the row re-mints it, paraphrase posts nothing, a statement's order stays unapplied", async () => {
  await withStubServer(async ({ posted }) => {
    const task = extractTasks[1];
    const base = await runTrial({ task, mode: "harness", client: accounts(), index: 1, seed: 11 });
    assert.equal(base.correct, true, base.reason);
    assert.equal(posted.length, 1);
    const baseServed = accounts.served;
    const order = await runTrial({ task, mode: "harness", client: withPerturb(accounts(), "order"), index: 1, seed: 11 });
    assert.deepEqual(order.perturb, { how: "order", applied: true });
    assert.equal(order.correct, true, order.reason);
    assert.equal(posted.length, 3, "the base invoice, then the rewritten one");
    assert.equal(order.ctx.docs[0].id, posted[2]);
    assert.notEqual(accounts.served, baseServed);
    assert.deepEqual(accounts.served.split("\n").sort(), baseServed.split("\n").sort());
    assert.equal(remint(order.ctx).docs[0].text, accounts.served, "the row's ctx re-mints the served document");
    assert.equal(order.canon, base.canon, "the same answer, so the same canonical form");
    const para = await runTrial({ task, mode: "harness", client: withPerturb(accounts(), "paraphrase"), index: 1, seed: 11 });
    assert.equal(para.perturb.applied, true);
    assert.equal(posted.length, 4, "nothing posted twice for a paraphrase");
    assert.match(accounts.prompt, /List each line item that carries a SKU/);
    assert.equal(para.ctx.wording, "alt");
    const free = await runTrial({ task, mode: "noHarness", client: withPerturb(accounts(), "format"), index: 1, seed: 11 });
    assert.equal(free.perturb.applied, true);
    assert.equal(free.correct, true, free.reason);
    assert.equal(remint(free.ctx).docs[0].text, remint({ seed: free.ctx.seed, level: 2, perturbed: free.ctx.perturbed }).docs[0].text);
    const statement = await runTrial({ task: extractTasks[3], mode: "harness", client: withPerturb({ ...accounts(), async runWithTools(prompt, tools, s, o) { const r = await accounts().runWithTools(prompt, tools, s, o); return { ...r, structured: { work: [], ...o.ctx.truth } }; } }, "order"), index: 1, seed: 11 });
    assert.deepEqual(statement.perturb, { how: "order", applied: false }, "a statement has no other order");
    assert.equal(statement.ctx.perturbed, undefined);
    const s = summarize([base, order, para]);
    assert.deepEqual(s.delta.perturb.order.consistency, { pairs: 1, same: 1, pct: 100 });
  });
});

test("fanout and follow through the runner: the rewritten ask reaches the model and the base's answer keeps its canonical form; unsupported kinds stay unapplied", async () => {
  const seen = [];
  const clerk = {
    name: "fake:m", model: "m",
    async chat() { throw new Error("no"); },
    async runWithTools(prompt, tools, system, { ctx }) {
      seen.push(prompt);
      const known = (ctx.ids ?? [ctx.start]).map((id) => ({ id, qty: items.find((i) => i.id === id).qty }));
      const out = ctx.ids ? { work: [], quantities: known } : { work: [], id: "sku-1002", qty: 30 };
      return { text: JSON.stringify(out), structured: out, toolCalls: (ctx.ids ?? ["sku-1001", "sku-1003", "sku-1004", "sku-1002"]).map((id) => ({ name: "get_item", arguments: { scenario: ctx.scenario, id } })), toolResults: [], rounds: 1, usage: null };
    },
  };
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "{}" });
  try {
    const fanout = { ...fanoutTasks[0], setup: async ({ seed }) => ({ scenario: "scn-1", seed: seed >>> 0, items, ids }) };
    const base = await runTrial({ task: fanout, mode: "harness", client: clerk, index: 1, seed: 7 });
    const order = await runTrial({ task: fanout, mode: "harness", client: withPerturb(clerk, "order"), index: 1, seed: 7 });
    assert.equal(order.perturb.applied, true);
    assert.notEqual(seen[1], seen[0]);
    assert.equal(order.canon, base.canon);
    assert.equal(order.correct, true, order.reason);
    const list = await runTrial({ task: fanout, mode: "harness", client: withPerturb(clerk, "format"), index: 1, seed: 7 });
    assert.match(seen[2], /items:\n- sku-/);
    assert.equal(list.canon, base.canon);
    const follow = { ...followTasks[0], setup: async ({ seed }) => ({ scenario: "scn-1", seed: seed >>> 0, items, start: "sku-1001", hops: 3 }) };
    const fb = await runTrial({ task: follow, mode: "harness", client: clerk, index: 1, seed: 7 });
    assert.equal(fb.correct, true, fb.reason);
    const fo = await runTrial({ task: follow, mode: "harness", client: withPerturb(clerk, "order"), index: 1, seed: 7 });
    assert.deepEqual(fo.perturb, { how: "order", applied: false });
    assert.equal(seen.at(-1), seen.at(-2), "an unapplied perturbation leaves the prompt alone");
    const ff = await runTrial({ task: follow, mode: "harness", client: withPerturb(clerk, "format"), index: 1, seed: 7 });
    assert.match(seen.at(-1), /^Scenario: scn-1\nStart item: sku-1001/);
    assert.equal(ff.canon, fb.canon);
    const s = summarize([base, order, list, fb, fo, ff]);
    assert.deepEqual(s.delta.perturb.format.consistency, { pairs: 2, same: 2, pct: 100 });
    assert.deepEqual(s.delta.perturb.order.consistency, { pairs: 1, same: 1, pct: 100 }, "the unapplied follow row is left out");
  } finally { globalThis.fetch = real; }
});
