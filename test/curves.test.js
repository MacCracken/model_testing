import { test } from "node:test";
import assert from "node:assert/strict";
import { curves, summarize } from "../src/runner.js";
import { seriesFor, bandsSeparate, regressionsFor, parentGaps } from "../src/trends.js";
import { listTasks } from "../src/tasks/registry.js";

const levelsOf = { restock3: { family: "restock", level: 3 }, restock6: { family: "restock", level: 6 }, restock12: { family: "restock", level: 12 }, wordmath2: { family: "wordmath", level: 2 } };
const row = (task, client, correct, i, over = {}) => ({ task, client, mode: "harness", model: "m", index: i, correct, toolCalls: [], latencyMs: 1, ...over });

test("curves: one point per level with a band, and the breaking point where the band tops out under 50%", () => {
  const rows = [];
  for (let i = 1; i <= 8; i++) rows.push(row("restock3", "a", true, i), row("restock6", "a", i <= 6, i), row("restock12", "a", false, i), row("restock3", "b", true, i), row("wordmath2", "a", true, i));
  const c = curves(rows, levelsOf);
  assert.deepEqual(Object.keys(c).sort(), ["restock", "wordmath"]);
  assert.deepEqual(c.restock.levels, [3, 6, 12]);
  const a = c.restock.byClient.a.harness;
  assert.deepEqual(a.points.map((p) => [p.level, p.correct, p.runs]), [[3, 8, 8], [6, 6, 8], [12, 0, 8]]);
  assert.equal(a.breakingPoint, 12, "6/8 keeps a band above 50%; 0/8 does not");
  assert.equal(c.restock.byClient.b.harness.breakingPoint, null);
  assert.deepEqual(c.restock.byClient.b.harness.points.map((p) => p.level), [3], "levels a client never ran are not points");
  assert.equal(c.wordmath.byClient.a.harness.breakingPoint, null);
  const s = summarize(rows, { levelsOf });
  assert.equal(s.curves.restock.byClient.a.harness.breakingPoint, 12);
  assert.deepEqual(summarize(rows).curves, {}, "no levels, no curves");
});

test("every family task carries its family and knob", () => {
  const fam = listTasks().filter((t) => t.family);
  assert.ok(fam.length >= 20);
  for (const t of fam) assert.ok(Number.isFinite(t.level), `${t.name} has a level`);
  const restock = fam.filter((t) => t.family === "restock").map((t) => t.level).sort((a, b) => a - b);
  assert.deepEqual(restock, [3, 6, 12, 30]);
  assert.deepEqual(fam.filter((t) => t.family === "needle").map((t) => t.level).sort((a, b) => a - b), [8000, 32000, 100000]);
  assert.ok(listTasks().find((t) => t.name === "health").family === null);
});

test("trends: series per run, and a regression only when the bands separate", () => {
  const caps = { wordmath4: ["arithmetic"], tally20: ["counting"] };
  const trial = (runId, createdAt, task, correct) => ({ runId, createdAt, task, mode: "harness", client: "c", correct });
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(trial("r1", "2026-09-01", "wordmath4", true), trial("r2", "2026-09-02", "wordmath4", true), trial("r3", "2026-09-03", "wordmath4", i < 2), trial("r3", "2026-09-03", "tally20", true));
  const series = seriesFor(rows, caps);
  assert.deepEqual(series.map((s) => s.runId), ["r1", "r2", "r3"]);
  assert.equal(series[2].byCapability.arithmetic.harness.correct, 2);
  assert.equal(series[2].byCapability.counting.harness.runs, 10);
  assert.equal(series[0].byCapability.counting, undefined);
  const reg = regressionsFor(rows, caps);
  assert.deepEqual(reg.latestRuns, ["r3"]);
  assert.equal(reg.flags.length, 1);
  assert.deepEqual(reg.flags[0].latestRuns, ["r3"]);
  assert.equal(reg.flags[0].latestAt, "2026-09-03");
  assert.equal(reg.flags[0].capability, "arithmetic");
  assert.equal(reg.flags[0].earlierRuns, 1, "balanced against the ten most recent earlier trials, all from r2");
  assert.ok(reg.flags[0].dropPp > 70);
  assert.ok(reg.flags[0].delta.pValue < 0.001);
  assert.equal(reg.compared, 1, "counting has no earlier trials to compare against");
  assert.deepEqual(reg.flags[0].tasks, ["wordmath4"]);
  assert.deepEqual(reg.flags[0].perTask, [{ task: "wordmath4", n: 10, earlier: 10, later: 2 }]);
  assert.equal(reg.flags[0].earlier.runs, 10, "balanced: ten of the twenty earlier trials, the most recent");
  // Balancing: a later side heavy in the hard task is not a regression when each task holds.
  const lop = [];
  for (let i = 0; i < 12; i++) lop.push(trial("r1", "2026-09-01", "wordmath4", true), trial("r1", "2026-09-01", "tally20", i < 3));
  for (let i = 0; i < 4; i++) lop.push(trial("r2", "2026-09-02", "wordmath4", true));
  for (let i = 0; i < 12; i++) lop.push(trial("r2", "2026-09-02", "tally20", i < 3));
  const lopsided = regressionsFor(lop, { wordmath4: ["x"], tally20: ["x"] });
  assert.deepEqual(lopsided.flags, [], "12/24 earlier vs 7/16 later unbalanced; balanced both sides are 7/16");
  // A harder task under the same capability in the latest run is a change of mix, not a regression.
  const mix = rows.map((r) => (r.runId === "r3" && r.task === "wordmath4" ? { ...r, task: "wordmath6", correct: false } : r));
  const capsMix = { ...caps, wordmath6: ["arithmetic"] };
  assert.deepEqual(regressionsFor(mix, capsMix).flags, []);
  assert.equal(regressionsFor(mix, capsMix).compared, 1, "wordmath4's latest run (r2) against r1; wordmath6 ran once and drops out");
  // One family at a time: the latest run of wordmath4 is r2 when r3 ran something else, and a
  // collapse there is still found.
  const staggered = [...mix.filter((r) => r.runId !== "r2"), ...Array.from({ length: 10 }, (_, i) => trial("r2", "2026-09-02", "wordmath4", i < 2))];
  const st = regressionsFor(staggered, capsMix);
  assert.deepEqual(st.flags.map((f) => [f.capability, f.latestRuns, f.earlierRuns]), [["arithmetic", ["r2"], 1]]);
  // A dip that stays inside the band is not a regression.
  const mild = rows.map((r) => (r.runId === "r3" && r.task === "wordmath4" ? { ...r, correct: true } : r));
  mild[2].correct = false;
  assert.deepEqual(regressionsFor(mild, caps).flags, []);
  assert.equal(bandsSeparate({ wilson: { low: 0.7, high: 0.95 } }, { wilson: { low: 0.1, high: 0.4 } }), true);
  assert.equal(bandsSeparate({ wilson: { low: 0.7, high: 0.95 } }, { wilson: { low: 0.5, high: 0.8 } }), false);
  assert.equal(bandsSeparate(null, { wilson: { low: 0.1, high: 0.4 } }), false);
});

test("parentGaps: a checkpoint against its parent, pooled per capability", () => {
  const caps = { follow6: ["dependent-calls"], fanout8: ["parallel-calls"] };
  const mk = (client, task, correct, n) => Array.from({ length: n }, () => ({ runId: "x", createdAt: "2026-09-01", task, mode: "harness", client, correct }));
  const parent = [...mk("p", "follow6", true, 10), ...mk("p", "fanout8", true, 10)];
  const child = [...mk("k", "follow6", false, 8), ...mk("k", "follow6", true, 2), ...mk("k", "fanout8", true, 10)];
  const g = parentGaps(child, parent, caps);
  assert.equal(g.compared, 2);
  assert.deepEqual(g.flags.map((f) => f.capability), ["dependent-calls"]);
  assert.equal(g.flags[0].child.correct, 2);
  assert.deepEqual(g.flags[0].tasks, ["follow6"]);
  assert.deepEqual(g.flags[0].perTask, [{ task: "follow6", n: 10, earlier: 10, later: 2 }]);
  // The parent ran a task the child never did: it drops out of the comparison rather than tilting it.
  assert.equal(parentGaps(child, [...parent, ...mk("p", "follow3", true, 10)], { ...caps, follow3: ["dependent-calls"] }).flags[0].parent.runs, 10);
  assert.deepEqual(parentGaps(child, parent, caps, { minTrials: 20 }).flags, []);
});
