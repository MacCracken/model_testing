import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summarize, normalCDF, twoPropZTest, wilsonInterval, fisherExact, deltaFor, describeSignificance,
} from "../src/runner.js";

const close = (got, want, eps, what = "") =>
  assert.ok(Math.abs(got - want) < eps, `${what} got ${got}, expected ${want} (±${eps})`);

// --- normalCDF: pinned to the standard normal table, not merely "roughly right" -----------------

test("normalCDF(0) is exactly 0.5", () => {
  assert.equal(normalCDF(0), 0.5);
});

test("normalCDF matches the standard normal table to 1e-6", () => {
  const table = [[0.5, 0.691462], [1, 0.841345], [1.645, 0.950015], [1.96, 0.975002], [2.576, 0.995002], [3, 0.998650]];
  for (const [z, p] of table) {
    close(normalCDF(z), p, 1e-6, `Φ(${z})`);
    close(normalCDF(-z), 1 - p, 1e-6, `Φ(${-z})`);
  }
});

// --- twoPropZTest: known reference values -----------------------------------------------------

// A 50% vs 60% gap over a large sample: the pooled two-proportion z-test gives z ≈ 14.21.
test("twoPropZTest reproduces the 50% vs 60% reference gap", () => {
  const res = twoPropZTest(10000, 5000, 10000, 6000);
  close(res.z, 14.21, 0.05, "z");
  assert.ok(res.pValue < 1e-6, `p=${res.pValue}`);
});

test("twoPropZTest flags a 1pp gap as non-significant", () => {
  const res = twoPropZTest(10000, 5000, 10000, 5001);
  assert.ok(res.pValue > 0.9, `p=${res.pValue}`);
  assert.ok(Math.abs(res.z) < 0.1, `z=${res.z}`);
});

test("twoPropZTest returns z = 0, p = 1 for equal rates", () => {
  const res = twoPropZTest(1000, 500, 1000, 500);
  assert.equal(res.z, 0);
  assert.equal(res.pValue, 1);
});

// --- fisherExact: exact at the sample sizes this bench actually runs ---------------------------

test("fisherExact: 0/3 vs 3/3 is p = 0.10 — three trials per side can never be significant", () => {
  close(fisherExact(3, 0, 3, 3), 0.1, 1e-12);
});

test("fisherExact: 0/4 vs 4/4 is p = 2/70, the first sample size that can reach p < 0.05", () => {
  close(fisherExact(4, 0, 4, 4), 2 / 70, 1e-12);
});

test("fisherExact matches R's fisher.test on the lady-tasting-tea table", () => {
  // matrix(c(3,1,1,3), 2): two-sided p = 34/70 = 0.4857
  close(fisherExact(4, 3, 4, 1), 34 / 70, 1e-12);
});

test("fisherExact: identical rates give p = 1", () => {
  close(fisherExact(10, 5, 10, 5), 1, 1e-9);
});

test("fisherExact is symmetric in the two groups", () => {
  close(fisherExact(5, 1, 7, 6), fisherExact(7, 6, 5, 1), 1e-12);
});

test("fisherExact stays finite on large tables (log space)", () => {
  const p = fisherExact(10000, 5000, 10000, 6000);
  assert.ok(Number.isFinite(p) && p > 0 && p < 1e-20, `p=${p}`);
});

// --- wilsonInterval: honest near the extremes -------------------------------------------------

test("wilsonInterval stays honest near the extremes", () => {
  assert.deepEqual(wilsonInterval(0, 10), { low: 0, high: 0.27753279986288837 }, "all-failures band");
  assert.deepEqual(wilsonInterval(10, 10), { low: 0.7224672001371115, high: 1 }, "all-successes band");
  const single = wilsonInterval(1, 10);
  assert.ok(single.low > 0.01 && single.low < 0.05, `low=${single.low}`);
  assert.ok(single.high > 0.4 && single.high < 0.45, `high=${single.high}`);
});

test("wilsonInterval brackets the observed rate", () => {
  const w = wilsonInterval(500, 1000);
  assert.ok(w.low <= 0.5 && w.high >= 0.5);
  assert.ok(w.high - w.low > 0);
});

// --- deltaFor / describeSignificance: what the headline actually says ---------------------------

const rowsFor = (n1, x1, n2, x2) => [
  ...Array.from({ length: n1 }, (_, i) => ({ mode: "noHarness", correct: i < x1 })),
  ...Array.from({ length: n2 }, (_, i) => ({ mode: "harness", correct: i < x2 })),
];

test("deltaFor: 50/100 vs 100/100 is significant and carries counts, bands, and the test's name", () => {
  const d = deltaFor(rowsFor(100, 50, 100, 100));
  assert.equal(d.noHarnessCorrect, 50);
  assert.equal(d.harnessCorrect, 100);
  assert.equal(d.deltaPp, 50);
  assert.equal(d.test, "fisher-exact");
  assert.ok(d.pValue < 1e-6, `p=${d.pValue}`);
  assert.equal(d.significant, true);
  assert.ok(d.harnessWilson.low > 0.95 && d.harnessWilson.high >= 1 - 1e-9);
  assert.ok(d.noHarnessWilson.low < 0.5 && d.noHarnessWilson.high > 0.5);
  assert.match(describeSignificance(d), /^significant · p<0.001 · 100 vs 100 trials$/);
});

test("deltaFor: 0/3 vs 3/3 is inconclusive — and says so instead of claiming significance", () => {
  const d = deltaFor(rowsFor(3, 0, 3, 3));
  close(d.pValue, 0.1, 1e-12);
  close(d.minPValue, 0.1, 1e-12);
  assert.equal(d.significant, false);
  assert.match(describeSignificance(d), /^inconclusive · p=0.10 · 3 vs 3 trials — too few trials/);
});

test("deltaFor: 0/4 vs 4/4 is significant", () => {
  const d = deltaFor(rowsFor(4, 0, 4, 4));
  assert.equal(d.significant, true);
  assert.match(describeSignificance(d), /^significant · p=0.03 · 4 vs 4 trials$/);
});

test("deltaFor: a real but unproven gap reads 'not significant', not 'inconclusive'", () => {
  const d = deltaFor(rowsFor(10, 4, 10, 7));
  assert.equal(d.significant, false);
  assert.ok(d.minPValue < 0.05, "ten per side could have been significant");
  assert.match(describeSignificance(d), /^not significant · p=0\.\d\d · 10 vs 10 trials$/);
});

test("deltaFor returns null without both modes, and describeSignificance explains", () => {
  assert.equal(deltaFor([{ mode: "noHarness", correct: true }]), null);
  assert.match(describeSignificance(null), /needs both noHarness and harness/);
});

test("summarize: identical rates are non-significant (p = 1)", () => {
  const s = summarize(rowsFor(50, 50, 50, 50));
  close(s.delta.overall.pValue, 1, 1e-9);
  assert.equal(s.delta.overall.significant, false);
  assert.ok(s.delta.overall.harnessWilson.low <= 1 && s.delta.overall.harnessWilson.high >= 1);
});
