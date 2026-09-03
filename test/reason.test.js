import { test } from "node:test";
import assert from "node:assert/strict";

import { getTask } from "../src/tasks/registry.js";

// The reason task is a control: no tools, fixed ground truth. Its scorers are pure functions of
// (answer, ground), so we can drive them without a live server.

test("reason scorers: all answers correct in both modes", () => {
  const t = getTask("reason");
  const ground = t.eval.ground; // ["56", "8", "Thursday"]

  const harness = t.eval.scoreHarness({ answers: [
    { question: "Q1", answer: "56" },
    { question: "Q2", answer: "8" },
    { question: "Q3", answer: "Thursday" },
  ] }, ground);
  assert.equal(harness.correct, true, harness.reason);

  const noH = t.eval.scoreNoHarness("1) 56\n2) 8\n3) Thursday", ground);
  assert.equal(noH.correct, true, noH.reason);
});

test("reason harness scorer: a wrong answer fails", () => {
  const t = getTask("reason");
  const ground = t.eval.ground;
  const r = t.eval.scoreHarness({ answers: [{ question: "Q1", answer: "65" }] }, ground);
  assert.equal(r.correct, false);
  // Only Q1 was answered (wrongly), so 0 of the 3 ground answers are matched.
  assert.match(r.reason, /0\/3/);
});

test("reason harness scorer: missing answer fails", () => {
  const t = getTask("reason");
  const ground = t.eval.ground;
  const r = t.eval.scoreHarness({ answers: [{ question: "Q2", answer: "8" }] }, ground);
  assert.equal(r.correct, false);
  // Q2 is answered, but Q1 and Q3 are missing, so only 1 of 3 matches.
  assert.match(r.reason, /1\/3/);
});

test("reason noHarness scorer: partial answers are not full credit", () => {
  const t = getTask("reason");
  const ground = t.eval.ground;
  const r = t.eval.scoreNoHarness("1) 56\n2) 8", ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /2\/3/);
});

test("reason answer key is arithmetically right (the marbles question is 3 + 5, not the total)", () => {
  const t = getTask("reason");
  assert.deepEqual(t.eval.ground, ["56", "8", "Thursday"]);
});
