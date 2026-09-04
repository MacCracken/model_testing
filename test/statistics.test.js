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

// --- percentiles and per task × client deltas --------------------------------------------------

test("percentile is nearest-rank and bounded", async () => {
  const { percentile } = await import("../src/runner.js");
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([10, 1, 5], 50), 5);
});

test("summarize carries latency percentiles, tool-args hygiene and per task × client deltas", () => {
  const mk = (task, client, mode, correct, latencyMs, toolUseOk = null) => ({ task, client, mode, correct, latencyMs, toolUseOk, toolCalls: toolUseOk === null ? [] : [{}] });
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push(mk("a", "c1", "noHarness", i < 2, 100 + i * 10));
    rows.push(mk("a", "c1", "harness", i < 9, 200 + i * 10, i < 8));
    rows.push(mk("b", "c1", "noHarness", true, 50));
    rows.push(mk("b", "c1", "harness", true, 60, true));
  }
  const s = summarize(rows);
  assert.equal(s.byMode.harness.latencyP50Ms, 60);
  // 20 harness latencies: ten at 60 and 200..290; nearest-rank p95 is the 19th value, 280.
  assert.equal(s.byMode.harness.latencyP95Ms, 280);
  assert.equal(s.byMode.harness.latencyMaxMs, 290);
  assert.equal(s.byMode.harness.toolArgsJudged, 20);
  assert.equal(s.byMode.harness.toolArgsOkPct, 90);
  assert.equal(s.byMode.noHarness.toolArgsJudged, 0);
  assert.equal(s.byMode.noHarness.toolArgsOkPct, 0);
  const a = s.delta.byTaskClient["a|c1"];
  assert.ok(a && a.significant, "2/10 → 9/10 should be significant");
  const b = s.delta.byTaskClient["b|c1"];
  assert.equal(b.deltaPp, 0);
});

// --- the 2×2 decomposition ---------------------------------------------------------------------

test("twoByTwo reads the tools and schema effects off the four modes", async () => {
  const { twoByTwo } = await import("../src/runner.js");
  const rows = [];
  const add = (mode, correct, n) => { for (let i = 0; i < n; i++) rows.push({ mode, correct: i < correct, task: "t", client: "c", latencyMs: 1 }); };
  add("noHarness", 5, 10); add("schemaOnly", 5, 10); add("toolOnly", 10, 10); add("harness", 10, 10);
  const box = twoByTwo(summarize(rows));
  assert.equal(box.toolsEffect, 50);
  assert.equal(box.schemaEffect, 0);
  assert.equal(box.interaction, 0);
  assert.equal(twoByTwo(summarize(rows.filter((r) => r.mode !== "schemaOnly" && r.mode !== "toolOnly"))), null, "two cells are not a 2×2");
  const three = twoByTwo(summarize(rows.filter((r) => r.mode !== "toolOnly")));
  assert.equal(three.toolsEffect, 50, "one available tools contrast");
  assert.equal(three.interaction, null);
});

// --- arm deltas: a harness arm against the free-form baseline of the same model --------------

test("summarize computes an arm's delta against another client's free-form rows for the same model", () => {
  const rows = [];
  const add = (client, model, mode, task, correct, n) => { for (let i = 0; i < n; i++) rows.push({ client, model, mode, task, correct: i < correct, latencyMs: 1 }); };
  add("openai:gpt-4o-mini", "gpt-4o-mini", "noHarness", "lookup", 0, 4);
  add("openai:gpt-4o-mini", "gpt-4o-mini", "harness", "lookup", 4, 4);
  add("pi:openai/gpt-4o-mini", "openai/gpt-4o-mini", "harness", "lookup", 4, 4);
  add("claude-code:claude-haiku-4-5", "claude-haiku-4-5", "harness", "lookup", 4, 4);
  const s = summarize(rows);
  const pi = s.delta.byArm["pi:openai/gpt-4o-mini"];
  assert.ok(pi, "pi arm matched the gpt-4o-mini baseline despite the provider prefix");
  assert.equal(pi.overall.deltaPp, 100);
  assert.deepEqual(pi.baselineClients, ["openai:gpt-4o-mini"]);
  assert.equal(pi.byTask.lookup.harnessRuns, 4);
  assert.equal(s.delta.byArm["claude-code:claude-haiku-4-5"], undefined, "no haiku baseline in this run");
  assert.equal(s.delta.byArm["openai:gpt-4o-mini"], undefined, "a client with its own baseline is not an arm");
});
