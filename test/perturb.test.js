// Robustness perturbations ([29]): each family's hook rewrites the instance without touching the
// truth, the base rendering is untouched, the runner applies the variant and pairs it with
// consistency beside the delta, and the suffix resolves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERTURB_KINDS, parsePerturbSuffix, withPerturb, describePerturbation } from "../src/perturb.js";
import { generate as wordmathGen, perturb as wordmathPerturb, wordmathTasks } from "../src/tasks/wordmath.js";
import { generate as tallyGen, perturb as tallyPerturb, tallyTasks, runQuery } from "../src/tasks/tally.js";
import { generate as datecalcGen, perturb as datecalcPerturb, datecalcTasks } from "../src/tasks/datecalc.js";
import { generate as logicgridGen, perturb as logicgridPerturb, logicgridTasks } from "../src/tasks/logicgrid.js";
import { summarize, runTrial, consistencyOf } from "../src/runner.js";
import { printSummary } from "../src/report.js";
import { parseClientSpec, resolveClients } from "../src/providers/index.js";

const numbers = (t) => (String(t).match(/\b\d+\b/g) ?? []).map(Number).sort((a, b) => a - b);

test("wordmath: paraphrase keeps every number and the answer, changes the words; format lists the days; order is refused; the base is unchanged", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const ctx = wordmathGen(seed, 4);
    assert.equal(ctx.events[0].kind, "open");
    assert.equal(ctx.story, ctx.lines.join(" "), "the base rendering is what it was");
    const p = wordmathPerturb(ctx, "paraphrase", seed);
    assert.equal(p.answer, ctx.answer);
    assert.equal(p.question, ctx.question);
    assert.notEqual(p.story, ctx.story);
    assert.deepEqual(numbers(p.story), numbers(ctx.story), "the same numbers, differently worded");
    assert.deepEqual(wordmathPerturb(ctx, "paraphrase", seed), p, "deterministic");
    const f = wordmathPerturb(ctx, "format", seed);
    assert.match(f.story, /^Stock movements:\n- Monday: /);
    assert.equal(f.lines.filter((l) => /^- /.test(l)).length, ctx.lines.filter((l) => /^On /.test(l)).length);
    assert.equal(f.answer, ctx.answer);
    assert.equal(wordmathPerturb(ctx, "order", seed), null, "a sequence has no other order");
  }
  assert.equal(wordmathGen(7, 2).story, wordmathGen(7, 2).lines.join(" "));
  assert.equal(typeof wordmathTasks[1].perturb, "function");
});

test("tally: order shuffles the rows, format renders CSV, paraphrase rewrites the question; the query still gives the answer", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const ctx = tallyGen(seed, 20);
    const o = tallyPerturb(ctx, "order", seed);
    assert.deepEqual([...o.rows].sort((a, b) => a.id.localeCompare(b.id)), [...ctx.rows].sort((a, b) => a.id.localeCompare(b.id)));
    assert.notDeepEqual(o.rows.map((r) => r.id), ctx.rows.map((r) => r.id));
    assert.equal(runQuery(o.rows, ctx.query).result, ctx.answer);
    const f = tallyPerturb(ctx, "format", seed);
    assert.equal(f.tableFormat, "csv");
    const p = tallyPerturb(ctx, "paraphrase", seed);
    assert.notEqual(p.question, ctx.question);
    assert.equal(p.answer, ctx.answer);
    assert.deepEqual(p.query, ctx.query);
  }
  const t = tallyTasks[0];
  const ctx = tallyGen(3, 20);
  assert.match(t.noHarness.prompt(tallyPerturb(ctx, "format", 3)), /\(CSV\):\n\nid,region,status,amount,days_open\nT-1001,/);
  assert.match(t.noHarness.prompt(ctx), /id \| region \| status \| amount \| days_open/);
  assert.equal(tallyPerturb({ ...ctx, query: null }, "paraphrase", 3), null, "no query to rephrase from");
});

test("datecalc: paraphrase rewrites the sentence, format changes the date's form and drops the weekday; the truth stands", () => {
  for (const level of [1, 3]) for (let seed = 1; seed <= 10; seed++) {
    const ctx = datecalcGen(seed, level);
    assert.ok(ctx.parts && ctx.parts.start, "the parts are kept");
    const p = datecalcPerturb(ctx, "paraphrase", seed);
    assert.notEqual(p.text, ctx.text);
    assert.deepEqual([p.date, p.time, p.weekday], [ctx.date, ctx.time, ctx.weekday]);
    assert.ok(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/.test(p.text), "paraphrase keeps the weekday hint");
    const f = datecalcPerturb(ctx, "format", seed);
    assert.doesNotMatch(f.text.replace(/expires|delivering/g, ""), /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/, "format drops the weekday");
    assert.ok(/\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2}, \d{4}/.test(f.text), "an ISO or month-day-year date");
    assert.deepEqual([f.date, f.weekday], [ctx.date, ctx.weekday]);
    assert.equal(datecalcPerturb(ctx, "order", seed), null);
  }
  assert.equal(typeof datecalcTasks[0].perturb, "function");
});

test("logicgrid: order shuffles the clues, paraphrase rewrites each clue, format puts one per line; the puzzle is the same", () => {
  for (let seed = 1; seed <= 15; seed++) {
    const ctx = logicgridGen(seed, 3);
    const o = logicgridPerturb(ctx, "order", seed);
    assert.deepEqual([...o.clues].sort(), [...ctx.clues].sort());
    const p = logicgridPerturb(ctx, "paraphrase", seed);
    assert.equal(p.clues.length, ctx.clues.length);
    assert.ok(p.clues.every((c, i) => c !== ctx.clues[i]), "every clue is reworded");
    assert.equal(p.answer, ctx.answer);
    const f = logicgridPerturb(ctx, "format", seed);
    assert.equal(f.clueFormat, "lines");
  }
  const t = logicgridTasks[0];
  const ctx = logicgridGen(2, 3);
  assert.match(t.noHarness.prompt(logicgridPerturb(ctx, "format", 2)), /\nClues:\n- /);
  assert.match(t.noHarness.prompt(ctx), / Clues: \(1\) /);
  const words = logicgridPerturb({ clues: ["Alice has the dog.", "Bob does not drink tea.", "The person with the cat drinks juice."] }, "paraphrase", 1).clues;
  assert.deepEqual(words, ["The dog belongs to Alice.", "Tea is not what Bob drinks.", "Whoever has the cat drinks juice."]);
});

test("consistency: paired instances with the same canonical answer, right or wrong; pooled by summing the cells across modes and clients", () => {
  const row = (client, index, canon, correct = true, over = {}) => ({ task: "t", mode: "harness", client, model: "m", index, canon, correct, latencyMs: 1, ...over });
  const base = [row("c", 1, "10"), row("c", 2, "20"), row("c", 3, "30", false), row("c", 4, null)];
  const treat = [row("c@perturb:paraphrase", 1, "10"), row("c@perturb:paraphrase", 2, "21"), row("c@perturb:paraphrase", 3, "30", false), row("c@perturb:paraphrase", 4, "40")];
  assert.deepEqual(consistencyOf(base, treat), { pairs: 3, same: 2, pct: (200 / 3) });
  assert.deepEqual(consistencyOf([], treat), { pairs: 0, same: 0, pct: null });
  // Two modes and two clients in one run: the pool sums the cells instead of pairing across them.
  const v = (client, mode, index, canon) => row(`${client}@perturb:order`, index, canon, true, { mode, baseClient: client, perturb: { how: "order", applied: true } });
  const rows = [
    row("c", 1, "a"), row("c", 2, "b"), row("c", 1, "a", true, { mode: "noHarness" }), row("c", 2, "b", true, { mode: "noHarness" }),
    row("d", 1, "a"), row("d", 2, "b"),
    v("c", "harness", 1, "a"), v("c", "harness", 2, "x"), v("c", "noHarness", 1, "a"), v("c", "noHarness", 2, "b"), v("d", "harness", 1, "y"), v("d", "harness", 2, "b"),
  ];
  const s = summarize(rows);
  assert.deepEqual(s.delta.perturb.order.consistency, { pairs: 6, same: 4, pct: (400 / 6) });
  assert.deepEqual(s.delta.byPerturb["t|harness|c@perturb:order"].consistency, { pairs: 2, same: 1, pct: 50 });
});

test("the treatment through the runner: the instance is rewritten, the truth kept, unsupported kinds leave the row unapplied; the summary pairs and prints consistency", async () => {
  const seen = [];
  const client = { name: "fake:m", model: "m", async chat(messages) { const t = messages.at(-1).content; seen.push(t); return { text: `answer: ${wordmathGen(7, 2).answer}`, usage: null }; }, async runWithTools() { throw new Error("no"); } };
  const task = wordmathTasks[0];
  const base = await runTrial({ task, mode: "noHarness", client, index: 1, seed: 7 });
  const para = await runTrial({ task, mode: "noHarness", client: withPerturb(client, "paraphrase"), index: 1, seed: 7 });
  assert.equal(para.perturb.applied, true);
  assert.equal(para.correct, true, "the same answer is still right");
  assert.notEqual(seen[1], seen[0], "the prompt was rewritten");
  assert.deepEqual(numbers(seen[1]), numbers(seen[0]));
  assert.equal(para.canon, base.canon);
  const order = await runTrial({ task, mode: "noHarness", client: withPerturb(client, "order"), index: 1, seed: 7 });
  assert.deepEqual(order.perturb, { how: "order", applied: false }, "wordmath has no order to change");
  assert.equal(seen[2], seen[0], "an unapplied perturbation leaves the prompt alone");
  const s = summarize([base, para, order]);
  assert.equal(s.delta.perturb.paraphrase.applied, 1);
  assert.deepEqual(s.delta.perturb.paraphrase.consistency, { pairs: 1, same: 1, pct: 100 });
  assert.equal(s.delta.perturb.order.applied, 0);
  const lines = [];
  printSummary(s, { log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /-- perturbation delta[\s\S]*paraphrase[\s\S]*consistent 1\/1 \(100%\)/);
});

test("the suffix: kinds, default, the spec, the paired variant, no stacking", () => {
  assert.deepEqual(PERTURB_KINDS, ["paraphrase", "order", "format", "typos"]);
  assert.deepEqual(parsePerturbSuffix("local:m@perturb:order"), { base: "local:m", how: "order" });
  assert.deepEqual(parsePerturbSuffix("local:m@perturb"), { base: "local:m", how: "paraphrase" });
  assert.throws(() => parsePerturbSuffix("local:m@perturb:noise"), /unknown perturbation/);
  assert.deepEqual(parseClientSpec("local:m@perturb:format"), { provider: "local", model: "m", perturb: "format" });
  assert.throws(() => parseClientSpec("local:m@abstain@perturb"), /one variant per client/);
  const [b, v] = resolveClients("local:ornith-1.5:9b,local:ornith-1.5:9b@perturb:order");
  assert.equal(v.name, "local:ornith-1.5:9b@perturb:order");
  assert.equal(v.baseName, b.name);
  assert.equal(v.perturb, "order");
  assert.match(describePerturbation("format"), /surface form/);
});
