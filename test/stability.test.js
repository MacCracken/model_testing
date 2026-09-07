import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, describeStability } from "../src/runner.js";
import { task as health } from "../src/tasks/health.js";
import { task as reason } from "../src/tasks/reason.js";
import { task as regex, STRINGS } from "../src/tasks/regex.js";

const row = (over = {}) => ({ task: "t", mode: "harness", client: "c", model: "m", index: 1, correct: true, reason: "", toolCalls: [], latencyMs: 10, ...over });

test("cells carry agreement, distinct answers and flakiness; modes aggregate them", () => {
  const rows = [
    // Cell A: four trials, three agree, one fails → 75% agreement, 2 distinct, flaky.
    row({ task: "a", index: 1, canon: "x" }), row({ task: "a", index: 2, canon: "x" }), row({ task: "a", index: 3, canon: "x" }), row({ task: "a", index: 4, canon: "y", correct: false }),
    // Cell B: no canonical answer, all pass → outcome-only, not flaky.
    row({ task: "b", index: 1 }), row({ task: "b", index: 2 }), row({ task: "b", index: 3 }),
    // Cell C: a single trial → nothing to compare.
    row({ task: "c", index: 1, canon: "z" }),
    // A free-form cell with two trials that disagree and both fail → 50% agreement, not flaky (no passes).
    row({ task: "a", mode: "noHarness", index: 1, canon: "p", correct: false }), row({ task: "a", mode: "noHarness", index: 2, canon: "q", correct: false }),
  ];
  const s = summarize(rows);
  const cell = (task, mode = "harness") => s.cells.find((c) => c.task === task && c.mode === mode);
  assert.equal(cell("a").agreementPct, 75);
  assert.equal(cell("a").distinctAnswers, 2);
  assert.equal(cell("a").flaky, true);
  assert.equal(cell("b").agreementPct, null);
  assert.equal(cell("b").distinctAnswers, null);
  assert.equal(cell("b").flaky, false);
  assert.equal(cell("c").agreementPct, null);
  assert.equal(cell("c").flaky, null);
  assert.equal(cell("a", "noHarness").agreementPct, 50);
  assert.equal(cell("a", "noHarness").flaky, false);

  assert.deepEqual(s.stability.harness, { cells: 3, repeated: 2, flaky: 1, canonCells: 1, agreementPct: 75 });
  assert.deepEqual(s.stability.noHarness, { cells: 1, repeated: 1, flaky: 0, canonCells: 1, agreementPct: 50 });
  assert.equal(describeStability(s.stability.harness), "75% agreement over 1 cell · 1/2 flaky cells");
  assert.equal(describeStability(s.stability.noHarness), "50% agreement over 1 cell · 0/1 flaky cell");
  assert.equal(describeStability({ cells: 2, repeated: 2, flaky: 1, canonCells: 0, agreementPct: null }), "1/2 flaky cells · outcome-only (no task with a canonical answer)");
  assert.equal(describeStability({ cells: 2, repeated: 0, flaky: 0, canonCells: 0, agreementPct: null }), "single trials — repeat a cell to measure variance");
  assert.equal(describeStability(undefined), "single trials — repeat a cell to measure variance");
});

test("health: canonical answer is the committed status, uptime ignored", () => {
  const c = health.eval.canon;
  assert.equal(c({ status: "OK", uptimeSec: 5 }, { structured: true }), "status=ok");
  assert.equal(c({ status: "ok", uptimeSec: 9999 }, { structured: true }), "status=ok");
  assert.equal(c({ uptimeSec: 1 }, { structured: true }), "status=(missing)");
  assert.equal(c(null, { structured: true }), "none");
  assert.equal(c("The service is healthy and running.", { structured: false }), "ok");
  assert.equal(c("It is down.", { structured: false }), "down");
  assert.equal(c("I can't tell if it is OK or DOWN.", { structured: false }), "hedged");
  assert.equal(c("", { structured: false }), "none");
  // The free-form scorer still agrees with the verdict it is built on.
  assert.equal(health.eval.scoreNoHarness("It is down.", { status: "ok" }).correct, false);
  assert.equal(health.eval.scoreNoHarness("healthy", { status: "ok" }).correct, true);
  assert.equal(health.eval.scoreNoHarness("OK or DOWN, unsure", { status: "ok" }).reason.startsWith("hedged"), true);
});

test("reason: canonical answer is the sorted answer list, or the presence pattern in free text", () => {
  const c = reason.eval.canon;
  const ground = reason.eval.ground;
  assert.equal(c({ answers: [{ answer: "x" }, { answer: "8" }] }, { structured: true }), "8|x");
  assert.equal(c(["8", "x"], { structured: true }), "8|x");
  assert.equal(c({ answers: [] }, { structured: true }), "none");
  assert.equal(c(null, { structured: true }), "none");
  assert.equal(c(ground.join(" and "), { structured: false }), "1".repeat(ground.length));
  assert.equal(c("", { structured: false }), "0".repeat(ground.length));
  assert.equal(c(`the answer is ${ground[0]}`, { structured: false }), "1" + "0".repeat(ground.length - 1));
  // The structured scorer still reads the same answers.
  assert.equal(reason.eval.scoreHarness({ answers: ground.map((a) => ({ answer: a })) }, ground).correct, true);
});

test("regex: canonical answer is the per-string verdict pattern in either mode", () => {
  const c = regex.eval.canon;
  const ground = regex.eval.ground();
  const structured = ground.map((g) => ({ string: g.string, matched: g.matched }));
  const expectStructured = ground.map((g) => `${g.string}=${g.matched ? "y" : "n"}`).sort().join("|");
  assert.equal(c(structured, { structured: true }), expectStructured);
  assert.equal(c({ results: [...structured].reverse() }, { structured: true }), expectStructured, "order does not matter");
  assert.equal(c(null, { structured: true }), "none");
  const labelled = ground.map((g) => `${g.string}: ${g.matched ? "yes" : "no"}`).join("\n");
  const pattern = ground.map((g) => (g.matched ? "y" : "n")).join("");
  assert.equal(c(labelled, { structured: false }), pattern);
  assert.equal(c(ground.map((g) => (g.matched ? "yes" : "no")).join("\n"), { structured: false }), pattern, "positional reading");
  assert.equal(c("", { structured: false }), "?".repeat(STRINGS.length));
  assert.equal(regex.eval.scoreNoHarness(labelled, ground).correct, true);
  assert.match(regex.eval.scoreNoHarness(ground.map((g) => (g.matched ? "yes" : "no")).join("\n"), ground).reason, /read positionally/);
});
