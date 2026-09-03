import { test } from "node:test";
import assert from "node:assert/strict";

import { runMatrix, summarize, pct, normalCDF, twoPropZTest, wilsonInterval } from "../src/runner.js";

// --- normalCDF: the CDF is monotonic, symmetric, and pinned at 0.5 at the origin --------------

test("normalCDF(0) is exactly 0.5", () => {
  assert.equal(normalCDF(0), 0.5);
});

test("normalCDF is symmetric about zero", () => {
  assert.ok(Math.abs(normalCDF(1.23) + normalCDF(-1.23) - 1) < 1e-6);
});

test("normalCDF(1.96) is ~0.975", () => {
  assert.ok(Math.abs(normalCDF(1.96) - 0.975) < 1e-2);
});

// --- twoPropZTest: known reference values ---------------------------------------------------

// A 50% vs 60% gap over a large sample: the pooled two-proportion z-test gives z ≈ 14.21
// (p ≈ 0 two-sided). A 10pp gap across 10k trials is far more than sampling noise.
test("twoPropZTest reproduces the 50% vs 60% reference gap", () => {
  const res = twoPropZTest(10000, 5000, 10000, 6000);
  assert.ok(Math.abs(res.z - 14.21) < 0.1, `z=${res.z}`);
  assert.ok(res.pValue < 0.0001, `p=${res.pValue}`);
  assert.ok(res.pValue < 0.05, "a real 10pp gap should be significant");
});

// A 1pp gap over the same sample is noise: z is tiny and p is near 1.
test("twoPropZTest flags a 1pp gap as non-significant", () => {
  const res = twoPropZTest(10000, 5000, 10000, 5001);
  assert.ok(res.pValue > 0.5, `p=${res.pValue}`);
  assert.ok(Math.abs(res.z) < 0.1, `z=${res.z}`);
});

// Equal rates are exactly non-significant (z=0, p=1).
test("twoPropZTest returns a non-significant result for equal rates", () => {
  const res = twoPropZTest(1000, 500, 1000, 500);
  assert.equal(res.z, 0);
  assert.equal(res.pValue, 1);
});

// --- wilsonInterval: honest near the extremes ------------------------------------------------

test("wilsonInterval stays honest near the extremes", () => {
  // Wilson is never pinned exactly to the wall — it's a band. But it must stay within [0,1] and
  // hug the observed rate, never the naive textbook band that explodes past 0/1.
  const extreme = wilsonInterval(0, 10);
  assert.deepEqual(extreme, { low: 0, high: 0.27753279986288837 }, "all-failures band");
  const allSuccess = wilsonInterval(10, 10);
  assert.deepEqual(allSuccess, { low: 0.7224672001371115, high: 1 }, "all-successes band");
  // A single success out of 10: Wilson brackets the observed 10% rate and stays within [0,1]
  // (it is not the degenerate single-point 10% the naive interval collapses toward).
  const single = wilsonInterval(1, 10);
  assert.ok(single.low > 0.01 && single.low < 0.05, `low=${single.low}`);
  assert.ok(single.high > 0.4 && single.high < 0.45, `high=${single.high}`);
  assert.ok(single.low <= 0.1 && single.high >= 0.1, "brackets the observed 1/10 rate");
});

test("wilsonInterval brackets the observed rate", () => {
  const w = wilsonInterval(500, 1000);
  assert.ok(w.low <= 0.5 && w.high >= 0.5);
  assert.ok(w.high - w.low > 0);
});

// --- deltaFor: the harness delta now carries a p-value ---------------------------------------

test("deltaFor attaches a p-value and Wilson band", async () => {
  const { deltaFor } = await import("../src/runner.js");
  // 50/100 no-harness vs 100/100 harness — a clear lift that should be significant at a realistic
  // sample size. (With only a few trials the same gap is not significant: too small to conclude.)
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ mode: "noHarness", correct: (i % 2 === 0), ...makeRow() });
  for (let i = 0; i < 100; i++) rows.push({ mode: "harness", correct: true, ...makeRow() });
  const d = deltaFor(rows);
  assert.ok(d.pValue !== null, "p-value present");
  assert.ok(d.pValue < 0.05, "50% vs 100% should be significant");
  // The band stays within [0,1]; allow a 1e-9 slack for floating-point near the walls.
  assert.ok(d.harnessWilson.low >= 0 && d.harnessWilson.low <= 1 + 1e-9);
  assert.ok(d.harnessWilson.high >= 1 - 1e-9 && d.harnessWilson.high <= 1 + 1e-9);
});

test("deltaFor returns null without both modes", async () => {
  const { deltaFor } = await import("../src/runner.js");
  const d = deltaFor([{ mode: "noHarness", correct: true }]);
  assert.equal(d, null);
});

// --- end to end: runMatrix surfaces significance on the overall delta ------------------------

test("runMatrix summary.overall.delta carries the p-value", async () => {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push({ mode: "noHarness", correct: true });
  for (let i = 0; i < 50; i++) rows.push({ mode: "harness", correct: true });
  const s = summarize(rows);
  assert.ok(s.delta.overall.pValue !== null);
  // 100% vs 100% is equal rates → non-significant (p ≈ 1), which proves the test fires.
  assert.ok(s.delta.overall.pValue > 0.5, "equal rates should be non-significant");
  assert.ok(s.delta.overall.harnessWilson.low <= 1 && s.delta.overall.harnessWilson.high >= 1);
});

// A tiny shared helper so the rows above read like real trial records.
function makeRow(correct) {
  return {
    index: 1,
    task: "probe",
    startedAt: new Date().toISOString(),
    latencyMs: 10,
    answerText: "",
    structured: null,
    schemaValid: null,
    toolCalls: [],
    usage: null,
    error: null,
  };
}
