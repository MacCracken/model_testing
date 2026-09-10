// Variance across settings ([47]): agreement measured per instance, the settings table and the
// per-run series behind `cli variance`, the shape-canon of chain and transform, and the store's
// stamping of `seeded` on rows that predate the flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hb-variance-"));
process.env.RESULTS_DIR = join(dir, "results");
const { instanceVariance, summarize, describeStability } = await import("../src/runner.js");
const { varianceBySetting, stabilityOverTime } = await import("../src/trends.js");
const { task: chain } = await import("../src/tasks/chain.js");
const { task: transform } = await import("../src/tasks/transform.js");

const row = (over = {}) => ({ task: "t", mode: "harness", client: "c", model: "m", index: 1, correct: true, latencyMs: 10, ...over });

test("agreement per instance: a fixed task pools its trials, a generated task only trials that share a seed", () => {
  // Fixed truth: four trials, three agree.
  const fixed = instanceVariance([row({ canon: "x" }), row({ canon: "x" }), row({ canon: "x" }), row({ canon: "y", correct: false })]);
  assert.deepEqual(fixed, { canonRuns: 4, agreementPct: 75, distinctAnswers: 2, repeatedInstances: 1, flakyInstances: 1, flaky: true });
  // Generated, four different problems: nothing repeats, nothing to compare.
  const distinct = instanceVariance([1, 2, 3, 4].map((i) => row({ seeded: true, seed: i, canon: String(i * 10), correct: i !== 4 })));
  assert.deepEqual(distinct, { canonRuns: 0, agreementPct: null, distinctAnswers: null, repeatedInstances: 0, flakyInstances: 0, flaky: null });
  // Generated, two runs on the same seeds: instance 1 agrees, instance 2 disagrees and is flaky.
  const repeated = instanceVariance([
    row({ seeded: true, seed: 1, canon: "10" }), row({ seeded: true, seed: 1, canon: "10" }),
    row({ seeded: true, seed: 2, canon: "20" }), row({ seeded: true, seed: 2, canon: "21", correct: false }),
    row({ seeded: true, seed: 3, canon: "30" }),
  ]);
  assert.deepEqual(repeated, { canonRuns: 4, agreementPct: 75, distinctAnswers: 1.5, repeatedInstances: 2, flakyInstances: 1, flaky: true });
  // A public anchor: its trial index names the item, so two runs over the same 50 items repeat each.
  const anchor = instanceVariance([
    row({ source: "public", index: 1, canon: "13" }), row({ source: "public", index: 1, canon: "13" }),
    row({ source: "public", index: 2, canon: "7", correct: false }), row({ source: "public", index: 2, canon: "8" }),
    row({ source: "public", index: 3, canon: "1" }),
  ]);
  assert.deepEqual([anchor.repeatedInstances, anchor.flakyInstances, anchor.agreementPct, anchor.distinctAnswers], [2, 1, 75, 1.5]);
  assert.equal(instanceVariance([row({ source: "public", index: 1, canon: "a" }), row({ source: "public", index: 2, canon: "b" })]).repeatedInstances, 0, "fifty different items are not a repeat");
  // Three of one instance, two of another: agreement is trial-weighted.
  const weighted = instanceVariance([
    row({ seeded: true, seed: 1, canon: "a" }), row({ seeded: true, seed: 1, canon: "a" }), row({ seeded: true, seed: 1, canon: "b" }),
    row({ seeded: true, seed: 2, canon: "c" }), row({ seeded: true, seed: 2, canon: "c" }),
  ]);
  assert.equal(weighted.agreementPct, 80);
  assert.equal(weighted.flakyInstances, 0);
});

test("a run's stability counts only cells with a repeated instance: four different problems are not a repeat", () => {
  const rows = [
    ...[1, 2, 3, 4].map((i) => row({ task: "wordmath4", seeded: true, seed: i, canon: String(i), correct: i !== 2 })),
    ...[1, 2, 3, 4].map((i) => row({ task: "health", index: i, canon: "status=ok" })),
  ];
  const s = summarize(rows);
  assert.deepEqual(s.stability.harness, { cells: 2, repeated: 1, flaky: 0, canonCells: 1, agreementPct: 100 });
  assert.equal(describeStability(s.stability.harness), "100% agreement over 1 cell · 0/1 flaky cell");
  const cell = s.cells.find((c) => c.task === "wordmath4");
  assert.equal(cell.repeatedInstances, 0);
  assert.equal(cell.flaky, null, "mixed outcomes over different problems say nothing about flakiness");
});

// Two settings over the same cells: temperature 0 (two runs on one instance seed) and the default
// (two runs on the same seed), with a fixed task and a generated one.
const runs = [
  { runId: "r1", createdAt: "2026-09-01", params: { temperature: 0 } }, { runId: "r2", createdAt: "2026-09-02", params: { temperature: 0 } },
  { runId: "r3", createdAt: "2026-09-03", params: {} }, { runId: "r4", createdAt: "2026-09-04", params: {} },
];
const trials = [];
for (const r of runs) {
  const hot = !("temperature" in r.params);
  for (const i of [1, 2, 3, 4]) {
    trials.push({ ...r, task: "health", mode: "harness", client: "c", index: i, seed: 100 + i, seeded: false, correct: true, canon: hot && r.runId === "r4" && i === 1 ? "status=down" : "status=ok" });
    trials.push({ ...r, task: "wordmath4", mode: "harness", client: "c", index: i, seed: 200 + i, seeded: true, correct: !(hot && r.runId === "r4" && i === 2), canon: hot && r.runId === "r4" && i === 2 ? "99" : String(i) });
  }
}

test("variance by setting: agreement and flakiness per instance under each value, ordered with the default last", () => {
  const t = varianceBySetting(trials);
  assert.deepEqual(Object.keys(t), ["0", "default"]);
  const cold = t["0"], hot = t.default;
  assert.deepEqual([cold.runs, cold.trials, cold.correct], [2, 16, 16]);
  assert.equal(cold.agreementPct, 100);
  assert.equal(cold.repeatedInstances, 5, "the fixed cell is one instance, the generated cell four");
  assert.equal(cold.flakyInstances, 0);
  assert.equal(hot.agreementPct, 87.5, "one health disagreement over 8 and one wordmath over 8");
  assert.equal(hot.flakyInstances, 1, "the wordmath instance that failed once");
  const wm = hot.cells.find((c) => c.task === "wordmath4");
  assert.deepEqual([wm.runs, wm.trials, wm.repeatedInstances, wm.flakyInstances, wm.agreementPct, wm.distinctAnswers], [2, 8, 4, 1, 87.5, 1.3]);
  const bySeed = varianceBySetting(trials, { by: "seed" });
  assert.deepEqual(Object.keys(bySeed), ["default"], "a parameter no run set has one value, the default");
  assert.equal(varianceBySetting(trials.filter((x) => x.runId === "r1"))["0"].agreementPct, 100, "one run: the fixed cell still repeats, the generated cell cannot");
  assert.equal(varianceBySetting(trials.filter((x) => x.runId === "r1"))["0"].repeatedInstances, 1);
});

test("stability over time: one point per run with its setting, repeated instances, flaky instances and agreement", () => {
  const series = stabilityOverTime(trials);
  assert.deepEqual(series.map((p) => [p.runId, p.setting, p.trials, p.repeatedInstances, p.flakyInstances, p.agreementPct]), [
    ["r1", "0", 8, 1, 0, 100], ["r2", "0", 8, 1, 0, 100], ["r3", "default", 8, 1, 0, 100], ["r4", "default", 8, 1, 0, 75],
  ]);
});

test("chain and transform get a canonical shape: the values are minted per call, the form is not", () => {
  const c = chain.eval.canon;
  assert.equal(c({ firstId: "3f2a9b1c-1111-2222-3333-444444444444", greeting: "Hello, 3f2a9b1c-1111-2222-3333-444444444444!" }, { structured: true }), "hello, <id>!");
  assert.equal(c({ greeting: "Hello, Alice!" }, { structured: true }), "hello, alice!");
  assert.equal(c({ message: "Hello, 0123456789abcdef!" }, { structured: true }), "hello, <id>!", "a long hex id counts too");
  assert.equal(c(null, { structured: true }), "none");
  assert.equal(c('The second greeting was "Hello, 3f2a9b1c-1111-2222-3333-444444444444!"', { structured: false }), "hello, <id>!");
  assert.equal(c("I greeted alice and got an id back.", { structured: false }), "no-greeting");
  assert.equal(c("", { structured: false }), "none");
  const t = transform.eval.canon;
  const good = [{ name: "alice", idPrefix: "0123abcd", shout: "HELLO, ALICE!" }, { name: "bob", idPrefix: "0123abcd", shout: "HELLO, BOB!" }, { name: "carol", idPrefix: "0123abcd", shout: "HELLO, CAROL!" }];
  assert.equal(t(good, { structured: true }), "alice:8+shout|bob:8+shout|carol:8+shout");
  assert.equal(t({ results: good.slice(0, 2) }, { structured: true }), "alice:8+shout|bob:8+shout|carol:missing");
  assert.equal(t([{ name: "Alice", idPrefix: "0123abcdef", shout: "hello, alice!" }], { structured: true }), "alice:10-shout|bob:missing|carol:missing");
  assert.equal(t(null, { structured: true }), "none");
  assert.equal(t("alice: 0123abcd HELLO, ALICE!\nbob: 0123abcd HELLO, BOB!\ncarol: 0123abcd HELLO, CAROL!", { structured: false }), "alice:8+shout|bob:8+shout|carol:8+shout");
  assert.equal(t("alice: 0123abcd hello alice", { structured: false }), "alice:8-shout|bob:missing|carol:missing");
  assert.equal(t("nothing here", { structured: false }), "none");
  assert.equal(transform.eval.scoreNoHarness("alice: 0123abcd HELLO, ALICE!", [{ name: "alice", ids: ["0123abcdef"], message: "Hello, alice!" }]).correct, true, "the free-form scorer still reads the lines");
});

test("the store stamps `seeded` from the registry on rows that predate it, so their cells agree per instance", async () => {
  const { saveRun } = await import("../src/results.js");
  const { indexRuns, rawQuery, closeStore } = await import("../src/store.js");
  const rows = [
    ...[1, 2, 3, 4].map((i) => ({ task: "wordmath4", mode: "harness", client: "c", model: "m", index: i, seed: i, correct: true, canon: String(i), latencyMs: 1 })),
    ...[1, 2].map((i) => ({ task: "health", mode: "harness", client: "c", model: "m", index: i, seed: 50 + i, correct: true, canon: "status=ok", latencyMs: 1 })),
  ];
  saveRun({ id: "20260912T000000-seed", createdAt: "2026-09-12T00:00:00Z", status: "done", config: { tasks: ["wordmath4", "health"], modes: ["harness"], clients: ["c"], count: 4 }, rows, summary: summarize(rows) });
  indexRuns({ full: true });
  const cells = rawQuery("select task, agreement_pct, flaky from cells where run_id = '20260912T000000-seed' order by task");
  assert.deepEqual(cells.map((c) => [c.task, c.agreement_pct, c.flaky]), [["health", 100, 0], ["wordmath4", null, null]], "four different word problems are not compared; two health trials are");
  // A restock row from before its scenario took the trial seed carries a random scenario seed in
  // its ctx: it is not an instance of the seed, so it is not stamped seeded.
  const older = [1, 2].map((i) => ({ task: "restock3", mode: "harness", client: "c", model: "m", index: i, seed: 100 + i, ctx: { scenario: `scn-${i}`, seed: 55555 + i, items: [] }, correct: true, canon: "sku-1001|10", latencyMs: 1 }));
  saveRun({ id: "20260912T000001-rest", createdAt: "2026-09-12T00:00:01Z", status: "done", config: { tasks: ["restock3"], modes: ["harness"], clients: ["c"], count: 2 }, rows: older, summary: summarize(older) });
  indexRuns({ full: true });
  const rest = rawQuery("select task, agreement_pct from cells where run_id = '20260912T000001-rest'");
  assert.deepEqual(rest.map((c) => [c.task, c.agreement_pct]), [["restock3", 100]], "two random inventories are one (unseeded) instance for agreement, not two seeds with one trial each");
  closeStore();
});
