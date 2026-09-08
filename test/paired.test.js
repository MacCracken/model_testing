import { test } from "node:test";
import assert from "node:assert/strict";
import { mcnemarExact, pairRows, pairedOutcome, bootstrapDelta, sampleSizeFor, multipleComparisons, describePaired, describePower, compareRows, capabilityStats, summarize, deltaBetween } from "../src/runner.js";

const row = (over = {}) => ({ task: "t", mode: "harness", client: "c", model: "m", index: 1, correct: true, toolCalls: [], latencyMs: 1, ...over });

test("McNemar exact matches hand-computed values", () => {
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(mcnemarExact(3, 3), 1);
  // 26 up, 2 down: P(X ≤ 2 | n = 28, ½) × 2 = 2 · (1 + 28 + 378) / 2^28
  assert.ok(Math.abs(mcnemarExact(2, 26) - (2 * 407) / 2 ** 28) < 1e-12);
  assert.ok(Math.abs(mcnemarExact(1, 5) - (2 * 7) / 64) < 1e-12);
  assert.ok(Math.abs(mcnemarExact(0, 4) - 0.125) < 1e-12, "four discordant pairs all one way: p = 2/16");
});

test("the smallest split that reaches p < 0.05 is 0 vs 6", () => {
  assert.ok(mcnemarExact(0, 5) > 0.05);
  assert.ok(mcnemarExact(0, 6) < 0.05);
});

test("pairRows pairs by task and index, with the client when both sides share one", () => {
  const base = [row({ mode: "noHarness", index: 1, correct: false }), row({ mode: "noHarness", index: 2, correct: true }), row({ mode: "noHarness", index: 3, correct: false })];
  const treat = [row({ index: 1, correct: true }), row({ index: 2, correct: true }), row({ index: 3, correct: false })];
  const pairs = pairRows(base, treat);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairedOutcome(pairs), { n: 3, both: 1, onlyBase: 0, onlyTreat: 1, neither: 1, pValue: 1, significant: false, test: "mcnemar-exact" });
  // A skilled variant has a different client name: the client is dropped from the key.
  const skilled = treat.map((r) => ({ ...r, client: "c@skill:preload" }));
  assert.equal(pairRows(base, skilled).length, 3);
  // Two clients pooled on one side make task|index ambiguous with the client dropped, so nothing pairs.
  const pooled = [...base, ...base.map((r) => ({ ...r, client: "d" }))];
  assert.equal(pairRows(pooled, skilled).length, 0);
  assert.equal(pairRows([], treat).length, 0);
});

test("bootstrap band contains the observed delta and is reproducible", () => {
  const pairs = Array.from({ length: 40 }, (_, i) => [row({ index: i, correct: i % 4 === 0 }), row({ index: i, correct: i % 4 !== 3 })]);
  const b1 = bootstrapDelta(pairs), b2 = bootstrapDelta(pairs);
  assert.deepEqual(b1, b2);
  const observed = ((30 - 10) / 40) * 100;
  assert.ok(b1.low <= observed && observed <= b1.high, `${b1.low}..${b1.high} around ${observed}`);
  assert.ok(b1.low > 0, "a 50-point paired gap on 40 pairs excludes zero");
  assert.equal(bootstrapDelta([[row(), row()]]), null);
});

test("sample-size guidance reproduces the textbook figure and describes itself", () => {
  assert.equal(sampleSizeFor({ baselinePct: 50, deltaPp: 20 }), 93);
  assert.ok(sampleSizeFor({ baselinePct: 50, deltaPp: 5 }) > 1000);
  assert.equal(sampleSizeFor({ baselinePct: 50, deltaPp: 0 }), Infinity);
  assert.match(describePower({ noHarnessPct: 50, deltaPp: 20, significant: false }), /20 pp gap from 50% at 80% power, run about 93 per side/);
  assert.match(describePower({ noHarnessPct: 50, deltaPp: 1 }), /10 pp gap/);
});

test("multiple comparisons: Bonferroni counts survivors", () => {
  const deltas = { a: { pValue: 0.01 }, b: { pValue: 0.04 }, c: { pValue: 0.2 }, d: null };
  assert.deepEqual(multipleComparisons(deltas), { comparisons: 3, bonferroniAlpha: 0.05 / 3, expectedFalsePositives: 0.15000000000000002, significantRaw: 2, significantBonferroni: 1 });
  assert.equal(multipleComparisons({ a: { pValue: 0.01 } }), null);
});

test("deltaBetween carries the paired view; summarize exposes multiple comparisons", () => {
  const rows = [];
  for (let i = 1; i <= 8; i++) rows.push(row({ mode: "noHarness", index: i, correct: i <= 2 }), row({ mode: "harness", index: i, correct: i <= 7 }));
  const s = summarize(rows);
  const d = s.delta.overall;
  assert.equal(d.paired.n, 8);
  assert.equal(d.paired.onlyTreat, 5);
  assert.equal(d.paired.onlyBase, 0);
  assert.ok(d.paired.bootstrap.low > 0);
  assert.match(describePaired(d.paired), /paired 8: 5 up · 0 down · McNemar p=0\.06 · 95% band \+/);
  assert.equal(s.delta.byTaskClient["t|c"].paired.bootstrap, null, "per-cell deltas skip the bootstrap");
  assert.equal(deltaBetween([row({ task: "x" })], [row({ task: "y" })]).paired, null, "nothing pairs across different tasks");
  assert.equal(s.multiple, null, "one cell, no multiplicity");
});

test("capabilityStats pools tasks by tag; summarize splits it per client when given the tags", () => {
  const tags = { wordmath4: ["arithmetic", "multi-step"], tally20: ["counting"], restock6: ["multi-step", "tool-use"] };
  const rows = [
    row({ task: "wordmath4", client: "a", mode: "noHarness", correct: false }), row({ task: "wordmath4", client: "a", mode: "harness", correct: true }),
    row({ task: "restock6", client: "a", mode: "noHarness", correct: false }), row({ task: "restock6", client: "a", mode: "harness", correct: true }),
    row({ task: "tally20", client: "b", mode: "harness", correct: true }),
  ];
  const card = capabilityStats(rows, tags);
  assert.deepEqual(Object.keys(card).sort(), ["arithmetic", "counting", "multi-step", "tool-use"]);
  assert.equal(card["multi-step"].byMode.harness.runs, 2);
  assert.equal(card["multi-step"].byMode.harness.correctPct, 100);
  assert.deepEqual(card["multi-step"].tasks, ["wordmath4", "restock6"]);
  assert.ok(card["multi-step"].byMode.harness.wilson.low < 1 && card["multi-step"].byMode.harness.wilson.high === 1);
  assert.equal(card["multi-step"].delta.deltaPp, 100);
  const s = summarize(rows, { capabilitiesOf: tags });
  assert.deepEqual(Object.keys(s.capabilities["multi-step"].byClient), ["a"]);
  assert.deepEqual(Object.keys(s.capabilities.counting.byClient), ["b"]);
  assert.deepEqual(summarize(rows).capabilities, {}, "no tags, no scorecard");
});

test("compareRows: two clients on the same instances, per task and overall", () => {
  const a = [1, 2, 3, 4].flatMap((i) => [row({ task: "x", client: "A", index: i, correct: i <= 3 }), row({ task: "y", client: "A", index: i, correct: i === 1 })]);
  const b = [1, 2, 3, 4].flatMap((i) => [row({ task: "x", client: "B", index: i, correct: true }), row({ task: "y", client: "B", index: i, correct: i <= 3 })]);
  const c = compareRows(a, b, { mode: "harness" });
  assert.equal(c.pairs, 8);
  assert.equal(c.byTask.x.onlyTreat, 1);
  assert.equal(c.byTask.y.onlyTreat, 2);
  assert.equal(c.byTask.y.aPct, 25);
  assert.equal(c.byTask.y.bPct, 75);
  assert.equal(c.overall.onlyTreat, 3);
  assert.equal(c.overall.onlyBase, 0);
  assert.ok(c.overall.bootstrap);
  assert.equal(compareRows(a, b, { mode: "noHarness" }).pairs, 0);
});
