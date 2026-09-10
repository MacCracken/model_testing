// The typos perturbation (@perturb:typos): typing errors in the words — never in a number, an id,
// a date word, a code or an entity the family scores on — deterministic from the seed, with at
// least one change when any word is eligible; every family's hook, the extraction documents
// re-minted, the suffix, the listing and the runner path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { typos, DATE_WORDS, PERTURB_KINDS, parsePerturbSuffix, withPerturb, describePerturbation } from "../src/perturb.js";
import { generate as wordmathGen, perturb as wordmathPerturb, wordmathTasks } from "../src/tasks/wordmath.js";
import { generate as tallyGen, perturb as tallyPerturb, runQuery } from "../src/tasks/tally.js";
import { generate as datecalcGen, perturb as datecalcPerturb } from "../src/tasks/datecalc.js";
import { generate as logicgridGen, perturb as logicgridPerturb } from "../src/tasks/logicgrid.js";
import { fanoutTasks, perturb as fanoutPerturb } from "../src/tasks/fanout.js";
import { followTasks, perturb as followPerturb } from "../src/tasks/follow.js";
import { generate as extractGen, perturbInstance, remint, extractTasks } from "../src/tasks/extract.js";
import { listTasks } from "../src/tasks/registry.js";
import { runTrial, summarize } from "../src/runner.js";
import { parseClientSpec } from "../src/providers/index.js";

const numbers = (t) => (String(t).match(/\d[\d.,:-]*/g) ?? []);
const ids = (t) => (String(t).match(/\b(?:sku|ITM|INV|PO|Q|C)-[\dA-Z-]+/gi) ?? []).sort();
const untouched = (a, b, re) => assert.deepEqual((String(b).match(re) ?? []).sort(), (String(a).match(re) ?? []).sort());

test("typos: deterministic, at least one change, ~a quarter of the eligible words, first and last letters kept; numbers, ids, codes, date words and protected words untouched", () => {
  const text = "On Monday the warehouse holds 120 crates of apples. Invoice No.: INV-2026-90578, PO ref.: PO-47416, Currency: USD, issued 18-Feb-2026 in Portland. Item sku-1234 has qty 12 and points at sku-5678.";
  let changedWords = 0, eligible = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const out = typos(text, seed, { protect: ["warehouse"] });
    assert.equal(typos(text, seed, { protect: ["warehouse"] }), out, "deterministic");
    assert.notEqual(out, text, "at least one change");
    assert.deepEqual(numbers(out), numbers(text), "every number as it was");
    assert.deepEqual(ids(out), ids(text), "every id as it was");
    assert.match(out, /Monday/); assert.match(out, /warehouse/); assert.match(out, /USD/);
    assert.match(out, /18-Feb-2026/);
    const a = text.match(/[A-Za-z]{3,}/g), b = out.match(/[A-Za-z]{3,}/g);
    assert.equal(a.length, b.length, "the same number of words");
    for (let k = 0; k < a.length; k++) {
      if (a[k] === b[k]) continue;
      changedWords++;
      assert.equal(b[k][0], a[k][0], `${a[k]} → ${b[k]} keeps its first letter`);
      assert.equal(b[k].at(-1), a[k].at(-1), `${a[k]} → ${b[k]} keeps its last letter`);
      assert.ok(Math.abs(b[k].length - a[k].length) <= 1);
    }
    eligible += a.filter((w) => w.length >= 4 && !["Monday", "warehouse"].includes(w) && w !== w.toUpperCase()).length;
  }
  const rate = changedWords / eligible;
  assert.ok(rate > 0.15 && rate < 0.4, `about a quarter of the eligible words: ${rate.toFixed(2)}`);
  assert.equal(typos("The sum is 12.", 5), "The sum is 12.", "no eligible word: unchanged");
  assert.equal(typos("sku-1234 ITM-0001 USD 2026-01-01", 5), "sku-1234 ITM-0001 USD 2026-01-01");
  assert.ok(DATE_WORDS.includes("september") && DATE_WORDS.includes("wed"));
  assert.notEqual(typos("Alice has the dog and Bob drinks juice.", 3, { protect: ["Alice", "Bob", "juice"] }).indexOf("drinks"), 0);
  for (let seed = 1; seed <= 30; seed++) assert.match(typos("Alice has the dog and Bob drinks juice.", seed, { protect: ["Alice", "Bob", "juice"] }), /^Alice has the dog and Bob d\w+s juice\.$/);
  assert.deepEqual(PERTURB_KINDS, ["paraphrase", "order", "format", "typos"]);
  assert.match(describePerturbation("typos"), /typing errors/);
});

test("the generated families: the prose gets typos, the numbers, dates, entities and the truth do not", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const w = wordmathGen(seed, 4), wt = wordmathPerturb(w, "typos", seed);
    assert.equal(wt.answer, w.answer);
    assert.notEqual(wt.story, w.story);
    assert.deepEqual(numbers(wt.story), numbers(w.story));
    untouched(w.story, wt.story, /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g);
    assert.equal(wt.lines.length, w.lines.length);
    assert.equal(wordmathGen(seed, 4).story, w.story, "the base rendering is untouched");
    const t = tallyGen(seed, 20), tt = tallyPerturb(t, "typos", seed);
    assert.deepEqual(tt.rows, t.rows, "the table is the same");
    assert.deepEqual(tt.query, t.query);
    assert.notEqual(tt.question, t.question);
    untouched(t.question, tt.question, /north|south|east|west|open|closed|overdue|amount|days_open|days/g);
    assert.equal(runQuery(tt.rows, tt.query).result, t.answer);
    const d = datecalcGen(seed, 3), dt = datecalcPerturb(d, "typos", seed);
    assert.deepEqual([dt.date, dt.time, dt.weekday], [d.date, d.time, d.weekday]);
    assert.notEqual(dt.text, d.text);
    assert.deepEqual(numbers(dt.text), numbers(d.text));
    untouched(d.text, dt.text, /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g);
    const l = logicgridGen(seed, 3), lt = logicgridPerturb(l, "typos", seed);
    assert.equal(lt.answer, l.answer);
    assert.equal(lt.clues.length, l.clues.length);
    assert.ok(lt.clues.some((c, i) => c !== l.clues[i]) || lt.question !== l.question, "something changed");
    const entities = [...l.solution.names, ...l.solution.pet, ...l.solution.drink];
    for (const e of entities) assert.equal((lt.clues.join(" ") + " " + lt.question).split(e).length, (l.clues.join(" ") + " " + l.question).split(e).length, `${e} appears as often as before`);
  }
  assert.equal(tallyPerturb({ ...tallyGen(1, 20), question: "Sum it." }, "typos", 1), null, "nothing eligible: unapplied");
  for (const t of [wordmathTasks[1], extractTasks[3], followTasks[0], fanoutTasks[0]]) assert.ok(t.perturbs.includes("typos"), t.name);
});

test("the tool families: the ask's prose gets typos, the ids and the field name do not; the extraction documents get OCR-like noise with the numbers, ids, dates, codes and names intact, re-minted from the row's ctx", () => {
  const f = fanoutTasks[0];
  const ctx = { scenario: "scn-1", seed: 4, ids: ["sku-1001", "sku-1003", "sku-1004", "sku-1002"] };
  for (let seed = 1; seed <= 15; seed++) {
    const p = f.harness.prompt(fanoutPerturb(ctx, "typos", seed));
    assert.notEqual(p, f.harness.prompt(ctx));
    assert.deepEqual(ids(p), ids(f.harness.prompt(ctx)));
    assert.match(p, /Use get_item for each id, then answer with a JSON object/, "the mode's template is not the instance");
    const fo = followTasks[0];
    const fctx = { scenario: "scn-1", seed: 4, start: "sku-1001", hops: 3 };
    const q = fo.toolOnly.prompt(followPerturb(fctx, "typos", seed));
    assert.notEqual(q, fo.toolOnly.prompt(fctx));
    assert.equal(q.split("next").length, fo.toolOnly.prompt(fctx).split("next").length, '"next" is protected');
    assert.match(q, /sku-1001/);
    assert.equal((q.match(/\b3\b/g) ?? []).length, 2, "the hop count is intact, twice");
  }
  assert.equal(fanoutPerturb(ctx, "typos", 0).typos, 1, "a zero seed still marks the ctx");
  for (const level of [1, 2, 3, 4]) for (let seed = 1; seed <= 8; seed++) {
    const g = extractGen(seed, level);
    const c = { seed, level, injected: false, docs: g.docs, truth: g.truth };
    const t = perturbInstance(c, "typos", seed);
    assert.deepEqual(t.truth, g.truth);
    assert.deepEqual(t.perturbed, { kind: "typos", seed });
    for (let i = 0; i < g.docs.length; i++) {
      const a = g.docs[i].text, b = t.docs[i].text;
      assert.notEqual(b, a);
      assert.deepEqual(numbers(b), numbers(a), `${level}/${seed}: every number as it was`);
      assert.deepEqual(ids(b), ids(a));
      untouched(a, b, /\b[A-Z]{3,}\b/g);
      untouched(a, b, /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g);
      for (const name of [g.vendor, g.customer, g.holder].filter(Boolean)) assert.equal(b.split(name).length, a.split(name).length, `${name} is intact`);
      assert.equal(b.split("\n").length, a.split("\n").length);
    }
    assert.deepEqual(remint({ seed, level, perturbed: t.perturbed }).docs.map((d) => d.text), t.docs.map((d) => d.text), "remint rewrites it the same way");
  }
  const gi = extractGen(5, 2);
  const ti = perturbInstance({ seed: 5, level: 2, injected: true, docs: gi.docs, truth: gi.truth }, "typos", 5);
  assert.ok(ti.docs[0].text.includes("NOTICE TO AUTOMATED PROCESSING SYSTEMS"), "the planted note is intact");
});

test("the suffix, the listing and the runner: @perturb:typos resolves, every family lists it, the treatment applies and consistency is measured", async () => {
  assert.deepEqual(parsePerturbSuffix("local:m@perturb:typos"), { base: "local:m", how: "typos" });
  assert.deepEqual(parseClientSpec("local:m@perturb:typos"), { provider: "local", model: "m", perturb: "typos" });
  const by = Object.fromEntries(listTasks().map((t) => [t.name, t]));
  for (const n of ["wordmath4", "tally20", "datecalc1", "logicgrid3", "fanout4", "follow3", "extract1", "extract4"]) assert.ok(by[n].perturbs.includes("typos"), n);
  assert.deepEqual(by.follow3.perturbs, ["paraphrase", "format", "typos"]);
  assert.equal(by.reason.perturbs, null);
  const seen = [];
  const client = { name: "fake:m", model: "m", async chat(messages) { seen.push(messages.at(-1).content); return { text: `answer: ${wordmathGen(7, 2).answer}`, usage: null }; }, async runWithTools() { throw new Error("no"); } };
  const task = wordmathTasks[0];
  const base = await runTrial({ task, mode: "noHarness", client, index: 1, seed: 7 });
  const noisy = await runTrial({ task, mode: "noHarness", client: withPerturb(client, "typos"), index: 1, seed: 7 });
  assert.deepEqual(noisy.perturb, { how: "typos", applied: true });
  assert.equal(noisy.correct, true);
  assert.notEqual(seen[1], seen[0]);
  assert.deepEqual(numbers(seen[1]), numbers(seen[0]));
  assert.equal(noisy.canon, base.canon);
  const s = summarize([base, noisy]);
  assert.deepEqual(s.delta.perturb.typos.consistency, { pairs: 1, same: 1, pct: 100 });
});
