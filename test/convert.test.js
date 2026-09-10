// The unit-conversion family ([48] follow-up): the exact factor table against hand-worked values,
// the tool's names and refusals, the rounding rules and the judge, the generator's spread and
// determinism, the renderings, the hooks, every mode through the runner, and the listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, convert, unitOf, convertTool, applyRule, judge, render, perturb, unanswerable, convertTasks, UNITS } from "../src/tasks/convert.js";
import { seedFor } from "../src/tasks/gen.js";
import { runTrial, summarize } from "../src/runner.js";
import { withPerturb } from "../src/perturb.js";
import { withAbstain, unanswerableFor } from "../src/abstain.js";
import { listTasks } from "../src/tasks/registry.js";

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test("the factor table: hand-worked conversions, plurals, symbols and aliases, temperatures affine, dimensions refused", async () => {
  assert.ok(near(convert(47, "pounds", "kg"), 21.31884139));
  assert.ok(near(convert(8.3, "miles", "km"), 13.3575552));
  assert.ok(near(convert(425, "F", "C"), 218.3333333));
  assert.ok(near(convert(100, "C", "F"), 212));
  assert.ok(near(convert(0, "C", "K"), 273.15));
  assert.ok(near(convert(12.5, "US gallons", "litres") * 60, 2839.058838));
  assert.ok(near(convert(2.4, "cubic metres", "L"), 2400));
  assert.ok(near(convert(1, "acre", "ha"), 0.40468564224));
  assert.ok(near(convert(60, "mph", "km/h"), 96.56064));
  assert.ok(near(convert(1, "imp gal", "L"), 4.54609));
  assert.ok(near(convert(16, "oz", "lb"), 1));
  assert.ok(near(convert(3, "h", "min"), 180));
  for (const [name, key] of [["Pounds", "lb"], ["lbs", "lb"], ["US gal", "gal"], ["gallons", "gal"], ["liters", "L"], ["l", "L"], ["m^3", "m3"], ["m³", "m3"], ["°F", "F"], ["fahrenheit", "F"], ["degrees Celsius", "C"], ["kph", "kmh"], ["m/s", "mps"], ["sq ft", "ft2"], ["hectares", "ha"], ["kilometres", "km"], ["kilometers", "km"], ["tonnes", "t"]]) assert.equal(unitOf(name), key, name);
  assert.equal(unitOf("furlong"), null);
  assert.throws(() => convert(1, "kg", "L"), /cannot convert mass \(kg\) to volume \(L\)/);
  assert.throws(() => convert(1, "furlongs", "m"), /unknown unit "furlongs"/);
  assert.throws(() => convert("x", "kg", "lb"), /not a number/);
  const out = await convertTool.impl({ value: 47, from: "pounds", to: "kilograms" });
  assert.deepEqual([out.from, out.to, out.value], ["lb", "kg", 47]);
  assert.ok(near(out.result, 21.31884139));
  await assert.rejects(convertTool.impl({ value: 1, from: "kg", to: "L" }), /cannot convert/);
  assert.ok(Object.values(UNITS).every((u) => u.word.length === 2 && typeof u.sym === "string"));
});

test("rounding rules and the judge: the stated rounding is the answer, the exact value to more places is accepted, another rounding is not, round up and down want the whole number", () => {
  assert.equal(applyRule(21.31884, { kind: "nearest", decimals: 1 }), 21.3);
  assert.equal(applyRule(21.35, { kind: "nearest", decimals: 1 }), 21.4);
  assert.equal(applyRule(188.8889, { kind: "nearest", decimals: 0 }), 189);
  assert.equal(applyRule(70.44, { kind: "ceil" }), 71);
  assert.equal(applyRule(70.999999999999, { kind: "ceil" }), 71);
  assert.equal(applyRule(17.9, { kind: "floor" }), 17);
  const g1 = { answer: 21.3, exact: 21.31884, rule: { kind: "nearest", decimals: 1 } };
  assert.equal(judge(21.3, g1).correct, true);
  assert.equal(judge(21.32, g1).correct, true, "more places, the right value");
  assert.equal(judge(21.31884, g1).correct, true);
  assert.equal(judge(21, g1).correct, false, "rounded to the wrong place");
  assert.match(judge(21, g1).reason, /off by less than 3 %: the factor or the rounding/);
  assert.equal(judge(21.4, g1).correct, false);
  assert.match(judge(23.5, g1).reason, /off by 10 %/);
  assert.equal(judge(NaN, g1).correct, false);
  const g3 = { answer: 71, exact: 70.44, rule: { kind: "ceil" } };
  assert.equal(judge(71, g3).correct, true);
  assert.equal(judge(70.44, g3).correct, false, "round up wants the whole number");
  assert.equal(judge(70, g3).correct, false);
  const g0 = { answer: 189, exact: 188.8889, rule: { kind: "nearest", decimals: 0 } };
  assert.equal(judge(188.89, g0).correct, true);
  assert.equal(judge(188, g0).correct, false);
});

test("the generator: deterministic, every kind at every level over the run's seeds, the answer is the rule applied to the exact value, the text carries the numbers", () => {
  const kinds = { 1: new Set(), 2: new Set(), 3: new Set() };
  for (const level of [1, 2, 3]) for (let i = 1; i <= 60; i++) {
    const seed = seedFor(2026, `convert${level}`, i);
    const g = generate(seed, level);
    assert.deepEqual(generate(seed, level), g, "deterministic");
    assert.equal(g.level, level);
    kinds[level].add(g.parts.kind);
    assert.equal(g.answer, applyRule(g.exact, g.rule));
    assert.ok(Number.isFinite(g.exact) && g.exact > 0, `${g.text} ${g.question}`);
    assert.match(g.question, /\?$|\.$/);
    assert.ok(/\d/.test(g.text), "the quantity is in the text");
    if (g.rule.kind === "nearest") assert.notEqual(Math.abs(g.exact * 10 ** g.rule.decimals - Math.round(g.exact * 10 ** g.rule.decimals)), 0.5, "no exact halves");
    if (level === 3) assert.ok(["ceil", "floor", "nearest"].includes(g.rule.kind));
  }
  assert.deepEqual([...kinds[1]].sort(), ["area", "length", "mass", "temperature", "volume"]);
  assert.deepEqual([...kinds[2]].sort(), ["distance", "flow", "linear"]);
  assert.deepEqual([...kinds[3]].sort(), ["fill", "fuel", "lift", "trip"]);
  assert.throws(() => generate(1, 4), /./);
});

test("renderings and hooks: the base is what it was, paraphrase rewords, format writes symbols, typos leave the numbers and unit words alone, the quantity can go missing", () => {
  for (const level of [1, 2, 3]) for (let i = 1; i <= 12; i++) {
    const g = generate(seedFor(2026, `convert${level}`, i), level);
    const base = `${g.text} ${g.question}`;
    assert.deepEqual(render(g.parts, level), { text: g.text, question: g.question }, "the base rendering is the generator's");
    const p = perturb(g, "paraphrase", i);
    assert.notEqual(`${p.text} ${p.question}`, base);
    assert.deepEqual([p.answer, p.exact], [g.answer, g.exact]);
    assert.deepEqual(base.match(/\d+(?:\.\d+)?/g), `${p.text} ${p.question}`.match(/\d+(?:\.\d+)?/g), "the same numbers");
    const f = perturb(g, "format", i);
    assert.notEqual(`${f.text} ${f.question}`, base);
    assert.ok(/\b(kg|lb|km|mi|L|°C|°F|K|ha|ac|m²|ft²|US gal|imp gal|m\/s|km\/h|mph|min|h|s|cm|in|ft|yd|oz|g|t|ml|m³|qt)\b/.test(f.text + " " + f.question), `symbols: ${f.text} ${f.question}`);
    assert.deepEqual(base.match(/\d+(?:\.\d+)?/g), `${f.text} ${f.question}`.match(/\d+(?:\.\d+)?/g));
    const t = perturb(g, "typos", i);
    if (t) {
      assert.deepEqual(base.match(/\d+(?:\.\d+)?/g), `${t.text} ${t.question}`.match(/\d+(?:\.\d+)?/g));
      for (const w of Object.values(UNITS).flatMap((u) => u.word)) assert.equal((`${t.text} ${t.question}`.split(w).length), base.split(w).length, `${w} intact`);
    }
    assert.equal(perturb(g, "order", i), null, "one sentence has one order");
    const u = unanswerable(g);
    assert.equal(u.answer, null);
    assert.equal(u.unanswerable, true);
    assert.match(u.text, /\bsome\b/);
    assert.equal((u.text.match(/\d+(?:\.\d+)?/g) ?? []).length, (g.text.match(/\d+(?:\.\d+)?/g) ?? []).length - 1, "exactly one number gone");
    assert.match(u.missing, /^the quantity \(/);
  }
  const t = convertTasks[0];
  assert.deepEqual(t.perturbs, ["paraphrase", "format", "typos"]);
  assert.equal(typeof t.unanswerable, "function");
  assert.equal(t.seeded, true);
  assert.deepEqual(t.capabilities, ["arithmetic", "unit-conversion"]);
  assert.deepEqual(convertTasks.map((x) => x.name), ["convert1", "convert2", "convert3"]);
});

// A fake engineer: converts through the real tool, computes from the parts, answers with the rule
// applied — or from a rough factor when told to be sloppy.
function engineer(how = "exact") {
  return {
    name: "fake:m", model: "m",
    async chat(messages, _tools, { ctx }) {
      const v = how === "sloppy" ? ctx.exact * 1.02 : ctx.answer;
      return { text: `The factor is what it is.\nanswer: ${v}`, usage: null };
    },
    async runWithTools(prompt, tools, _system, { ctx }) {
      const conv = tools.find((x) => x.name === "convert");
      const calls = [], results = [];
      if (conv) { const r = await conv.impl({ value: 1, from: "lb", to: "kg" }); calls.push({ id: "c1", name: "convert", arguments: { value: 1, from: "lb", to: "kg" } }); results.push({ id: "c1", name: "convert", ok: true, content: JSON.stringify(r) }); }
      if (tools.some((x) => x.name === "calc")) { calls.push({ id: "c2", name: "calc", arguments: { expression: "1*1" } }); results.push({ id: "c2", name: "calc", ok: true, content: "1" }); }
      const v = how === "sloppy" ? ctx.exact * 1.02 : ctx.answer;
      const structured = prompt.includes("JSON");
      const out = { work: ["factor", "step"], answer: v };
      return { text: structured ? JSON.stringify(out) : `answer: ${v}`, structured: structured ? out : null, toolCalls: calls, toolResults: results, rounds: calls.length + 1, usage: null };
    },
  };
}

test("every mode through the runner: the exact answer is right, a 2 % factor is wrong and named as such, the verdict wants convert (and calc at level 3), the canon is the number, the treatments apply", async () => {
  for (const task of convertTasks) {
    for (const mode of ["noHarness", "schemaOnly", "toolOnly", "harness"]) {
      const r = await runTrial({ task, mode, client: engineer(), index: 1, seed: 11 });
      assert.equal(r.error, null, `${task.name}/${mode}: ${r.error}`);
      assert.equal(r.correct, true, `${task.name}/${mode}: ${r.reason}`);
      assert.equal(r.canon, String(r.ground.answer));
      assert.equal(r.seeded, true);
      if (mode === "harness" || mode === "toolOnly") assert.equal(r.toolUseOk, true, r.toolUseReason);
      else assert.equal(r.toolUseOk, null);
      const bad = await runTrial({ task, mode, client: engineer("sloppy"), index: 1, seed: 11 });
      assert.equal(bad.correct, false, `${task.name}/${mode}`);
      assert.match(bad.reason, /off by less than 3 %|off by \d+ %|expected/);
    }
  }
  const t = convertTasks[2];
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "convert", arguments: {} }], toolResults: [{ name: "convert", ok: true }], ctx: {} }).ok, false, "level 3 wants calc too");
  assert.match(t.eval.toolUse({ toolCalls: [], toolResults: [], ctx: {} }).reason, /convert was never called/);
  assert.match(t.eval.toolUse({ toolCalls: [{ name: "convert" }], toolResults: [{ name: "convert", ok: false }], ctx: {} }).reason, /none of the 1 convert call\(s\) succeeded/);
  assert.equal(t.eval.toolUse({ toolCalls: [], toolResults: [], ctx: { unanswerable: true } }).ok, true);
  // The treatments: a paraphrase keeps the answer and the canon; the abstain variant's seeded half.
  const base = await runTrial({ task: convertTasks[0], mode: "noHarness", client: engineer(), index: 1, seed: 11 });
  const para = await runTrial({ task: convertTasks[0], mode: "noHarness", client: withPerturb(engineer(), "paraphrase"), index: 1, seed: 11 });
  assert.equal(para.perturb.applied, true);
  assert.equal(para.canon, base.canon);
  assert.deepEqual(summarize([base, para]).delta.perturb.paraphrase.consistency, { pairs: 1, same: 1, pct: 100 });
  const unSeed = Array.from({ length: 60 }, (_, i) => i + 1).find((s) => unanswerableFor(s));
  const careful = { ...engineer(), async chat(messages) { return { text: /\bsome\b/.test(messages.at(-1).content) ? "answer: cannot be determined — the quantity is missing" : "answer: 1", usage: null }; } };
  const u = await runTrial({ task: convertTasks[0], mode: "noHarness", client: withAbstain(careful), index: 1, seed: unSeed });
  assert.equal(u.abstain.unanswerable, true);
  assert.equal(u.abstain.abstention, "abstained");
  assert.equal(u.correct, true, u.reason);
});

test("the listing: three levels of one family with the knob, the hooks and the capability", () => {
  const by = Object.fromEntries(listTasks().map((t) => [t.name, t]));
  assert.deepEqual([by.convert1.family, by.convert1.level, by.convert3.level], ["convert", 1, 3]);
  assert.deepEqual(by.convert2.modes, ["noHarness", "harness", "schemaOnly", "toolOnly"]);
  assert.deepEqual(by.convert2.tools, ["convert", "calc"]);
  assert.deepEqual(by.convert1.tools, ["convert"]);
  assert.deepEqual(by.convert3.perturbs, ["paraphrase", "format", "typos"]);
  assert.deepEqual(by.convert3.abstain, by.convert3.modes);
  assert.ok(by.convert1.capabilities.includes("unit-conversion"));
});
