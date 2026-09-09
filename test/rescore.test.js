import { test } from "node:test";
import assert from "node:assert/strict";

import { rescoreRun, describeRescore } from "../src/rescore.js";
import { runTrial, scoreRecord } from "../src/runner.js";
import { getTask } from "../src/tasks/registry.js";

// A task whose scorer can be swapped between "versions": what a re-score is for.
const makeTask = (accept) => ({
  name: "fake",
  category: "test",
  capabilities: ["tool-use"],
  noHarness: { prompt: "p" },
  harness: {
    prompt: "p",
    tools: [{ name: "t", description: "", parameters: { type: "object", properties: {} }, impl: async () => "x" }],
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  },
  eval: {
    ground: "alpha",
    scoreHarness: (out, ground) => ({ correct: accept(out?.answer, ground), reason: accept(out?.answer, ground) ? "matches" : "differs" }),
    scoreNoHarness: (out, ground) => ({ correct: accept(out, ground), reason: accept(out, ground) ? "matches" : "differs" }),
    toolUse: ({ toolCalls }) => ({ ok: toolCalls.length === 1, reason: `${toolCalls.length} call(s)` }),
    canon: (a) => (typeof a === "string" ? a.trim().toLowerCase() : a?.answer ?? null),
  },
});

const row = (over = {}) => ({
  index: 1, task: "fake", mode: "noHarness", client: "c", model: "m", correct: true, reason: "matches", error: null,
  toolCalls: [], toolResults: [], rounds: 0, answerText: "Alpha", structured: null, schemaValid: null, schemaErrors: [],
  toolUseOk: null, toolUseReason: "", judgeScore: null, judgeReason: "", canon: "alpha", ground: "alpha", ctx: null,
  latencyMs: 1, usage: null, startedAt: "2026-09-09T00:00:00.000Z", ...over,
});
const run = (rows) => ({
  id: "20260909T000000-test", createdAt: "2026-09-09T00:00:00.000Z", finishedAt: "2026-09-09T00:00:01.000Z", status: "done", source: "cli",
  config: { tasks: ["fake"], modes: ["noHarness", "harness"], clients: ["c"], count: 1 }, versions: { bench: "0.1.0", git: "abc" }, warnings: [], rows,
});

test("the same scorer changes nothing; a stricter one flips the rows it disagrees with, and the run keeps its identity", async () => {
  const lenient = makeTask((a, g) => String(a ?? "").trim().toLowerCase() === g);
  const strict = makeTask((a, g) => a === g);
  const R = run([
    row(), // "Alpha" free-form: the lenient scorer passes it, the strict one does not
    row({ index: 2, mode: "harness", structured: { answer: "alpha" }, answerText: "{\"answer\":\"alpha\"}", schemaValid: true, rounds: 1, toolUseOk: true, toolUseReason: "1 call(s)",
      toolCalls: [{ id: "c1", name: "t", arguments: {} }], toolResults: [{ id: "c1", name: "t", ok: true, content: "x" }] }),
    row({ index: 3, error: "HTTP 500", correct: false, reason: "exception", answerText: null }),
  ]);
  const same = await rescoreRun(R, { taskFor: () => lenient, now: new Date("2026-09-09T01:00:00Z") });
  assert.equal(same.scored, 2);
  assert.deepEqual(same.flips, []);
  assert.equal(same.changed, 0);
  assert.deepEqual(same.skipped, [{ task: "fake", mode: "noHarness", client: "c", index: 3, why: "error row" }]);
  assert.equal(same.run.id, R.id, "a re-score is the same measurement read again, not a second run");
  assert.deepEqual(same.run.rescored, [{ at: "2026-09-09T01:00:00.000Z", from: { bench: "0.1.0", git: "abc" }, scored: 2, flipped: 0, changed: 0, skipped: 1 }]);
  assert.notEqual(same.run.versions.bench, undefined, "the verdicts now carry today's bench version");
  assert.equal(same.run.rows[2].error, "HTTP 500", "an error row is kept as it was");
  assert.ok(same.run.summary.cells.length >= 1, "the summary is recomputed");
  assert.deepEqual(R.rows[0], row(), "the run passed in is untouched");

  const stricter = await rescoreRun(R, { taskFor: () => strict });
  assert.equal(stricter.flips.length, 1);
  assert.deepEqual(stricter.flips[0], { task: "fake", mode: "noHarness", client: "c", index: 1, before: true, after: false, reasonBefore: "matches", reasonAfter: "differs" });
  assert.equal(stricter.run.rows[0].correct, false);
  assert.equal(stricter.run.rows[0].canon, "alpha");
  assert.equal(stricter.run.rows[1].correct, true);
  assert.equal(stricter.run.rows[1].toolUseOk, true);
  assert.equal(stricter.run.rows[1].schemaValid, true);
  assert.equal(stricter.run.rescored.length, 1);
  const text = describeRescore(stricter);
  assert.match(text, /2 row\(s\) scored, 1 flipped, 0 with another verdict changed, 1 skipped \(1 error row\)/);
  assert.match(text, /fake · noHarness · c · #1: pass → fail  differs  \(was: matches\)/);
  assert.doesNotMatch(describeRescore(stricter, { verbose: false }), /#1: pass/);

  // A verdict other than correctness moving counts as "changed", not a flip.
  const noJudge = makeTask((a, g) => String(a ?? "").trim().toLowerCase() === g);
  noJudge.eval.toolUse = () => ({ ok: false, reason: "wrong tool" });
  const other = await rescoreRun(R, { taskFor: () => noJudge });
  assert.deepEqual(other.flips, []);
  assert.equal(other.changed, 1);
  assert.equal(other.run.rows[1].toolUseOk, false);
});

test("rows the scorer cannot judge are kept as recorded: unknown tasks, judged tasks without a judge, a scorer that throws, a spec that is gone", async () => {
  const base = makeTask(() => true);
  const judged = { ...base, eval: { ...base.eval, needsJudge: true } };
  const throwing = { ...base, eval: { ...base.eval, scoreNoHarness: () => { throw new Error("boom"); } } };
  const noSpec = { ...base, noHarness: undefined };
  const taskFor = (name) => {
    if (name === "gone") throw new Error("unknown task: gone");
    return { boom: throwing, nospec: noSpec }[name] ?? judged;
  };
  const R = run([row(), row({ index: 2, task: "gone" }), row({ index: 3, task: "boom" }), row({ index: 4, task: "nospec" })]);
  const r = await rescoreRun(R, { taskFor });
  assert.equal(r.scored, 0);
  assert.deepEqual(r.skipped.map((s) => s.why), ["needs a judge (--judge)", "unknown task", "scorer threw: boom", "no noHarness spec any more"]);
  assert.deepEqual(r.run.rows.map((x) => x.correct), [true, true, true, true]);
  assert.match(describeRescore(r), /0 row\(s\) scored, 0 flipped, 0 with another verdict changed, 4 skipped \(1 needs a judge \(--judge\), 1 unknown task, 1 scorer threw: boom, 1 no noHarness spec any more\)/);

  // With a judge the judged task is scored through it, and the judge's verdict lands on the row.
  const graded = { ...base, eval: { ...base.eval, needsJudge: true, scoreNoHarness: async (out, ground, { judge }) => { const v = await judge({ answer: out }); return { correct: v.score >= 0.5, reason: `judge ${v.score}`, judge: v }; } } };
  const withJudge = await rescoreRun(run([row({ judgeScore: null })]), { taskFor: () => graded, judge: async () => ({ score: 0.9, reason: "fine" }) });
  assert.equal(withJudge.scored, 1);
  assert.equal(withJudge.run.rows[0].judgeScore, 0.9);
  assert.equal(withJudge.run.rows[0].judgeReason, "fine");

  // A running or compacted run is left alone entirely.
  assert.equal((await rescoreRun({ ...R, status: "running" }, { taskFor })).note, "still running");
  assert.match((await rescoreRun({ ...R, compacted: "2026-09-01T00:00:00.000Z" }, { taskFor })).note, /compacted/);
  assert.match(describeRescore(await rescoreRun({ ...R, status: "running" }, { taskFor })), /left alone \(still running\)/);
});

test("scoreRecord over a recorded row lands on the live trial's verdicts — a generated task, both modes, from the row alone", async () => {
  const task = getTask("wordmath2");
  // A client that answers from the instance; in harness mode it calls the calculator once.
  const client = {
    name: "c", model: "m",
    async chat(_messages, _tools, { ctx }) { return { text: `Working it out.\nanswer: ${ctx.answer}`, toolCalls: [], finishReason: "stop", usage: null }; },
    async runWithTools(_prompt, _tools, _system, { ctx }) {
      return { text: `answer: ${ctx.answer}`, structured: { work: ["one step"], answer: ctx.answer }, toolCalls: [{ id: "c1", name: "calc", arguments: { expression: "1+1" } }], toolResults: [{ id: "c1", name: "calc", ok: true, content: "2" }], rounds: 1, finishReason: "stop", usage: null };
    },
  };
  const fields = ["correct", "reason", "canon", "toolUseOk", "toolUseReason", "schemaValid", "schemaErrors", "judgeScore", "judgeReason"];
  for (const mode of ["noHarness", "harness", "schemaOnly", "toolOnly"]) {
    const live = await runTrial({ task, mode, client, index: 1, seed: 5 });
    assert.equal(live.error, null, `${mode}: ${live.error}`);
    assert.equal(live.correct, true, `${mode}: ${live.reason}`);
    const again = structuredClone(live);
    for (const k of fields) again[k] = k === "schemaErrors" ? ["stale"] : k === "reason" ? "stale" : null;
    await scoreRecord(task, again);
    for (const k of fields) assert.deepEqual(again[k], live[k], `${mode}: ${k}`);
    // The row is self-contained: a re-score through rescoreRun agrees too, with nothing flipped.
    const r = await rescoreRun({ id: "x", status: "done", config: {}, rows: [live] });
    assert.equal(r.scored, 1);
    assert.deepEqual(r.flips, []);
    assert.equal(r.changed, 0);
  }
});
