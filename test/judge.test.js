import { test } from "node:test";
import assert from "node:assert/strict";

import { makeJudge } from "../src/judge.js";
import { getTask } from "../src/tasks/registry.js";
import { runTrial, summarize } from "../src/runner.js";

const fakeClient = (reply) => ({ name: "judge:fake", async chat(messages) { fakeClient.last = messages; return { text: reply, toolCalls: [], finishReason: "stop", usage: { total_tokens: 20 } }; } });

test("makeJudge asks for JSON, clamps the score and reports which model judged", async () => {
  const judge = makeJudge(fakeClient('```json\n{"score": 1.4, "reason": "fine"}\n```'));
  const v = await judge({ rubric: "be right", answer: "an answer", ground: { status: "ok" }, task: "explain" });
  assert.equal(v.score, 1);
  assert.equal(v.reason, "fine");
  assert.equal(v.judge, "judge:fake");
  const user = fakeClient.last.find((m) => m.role === "user").content;
  assert.match(user, /Rubric:/);
  assert.match(user, /"status":"ok"/);
  assert.match(user, /an answer/);
  await assert.rejects(makeJudge(fakeClient("no json here"))({ rubric: "r", answer: "a", ground: {} }), /returned no score/);
});

test("explain scorers grade through the judge and refuse to run without one", async () => {
  const t = getTask("explain");
  const ground = { status: "ok", uptimeSec: 7200 };
  const high = async () => ({ score: 1, reason: "all three" });
  const low = async () => ({ score: 0.25, reason: "only the verdict" });
  const good = await t.eval.scoreHarness({ explanation: "It is healthy and has been up about two hours." }, ground, { judge: high });
  assert.equal(good.correct, true);
  assert.match(good.reason, /judge 1\.00/);
  const bad = await t.eval.scoreNoHarness("It is up. 7200 seconds.", ground, { judge: low });
  assert.equal(bad.correct, false);
  assert.equal((await t.eval.scoreHarness({ explanation: "" }, ground, { judge: high })).correct, false);
  await assert.rejects(t.eval.scoreHarness({ explanation: "x" }, ground, {}), /needs a judge/);
});

test("runTrial hands the judge to the scorer and records its verdict; without one the row errors", async () => {
  const t = getTask("explain");
  const task = { ...t, eval: { ...t.eval, ground: async () => ({ status: "ok", uptimeSec: 3600 }) } };
  const client = { name: "c", model: "m", async chat() { return { text: "Healthy, up about an hour.", toolCalls: [], finishReason: "stop", usage: null }; }, async runWithTools() { return { text: "{}", structured: {}, toolCalls: [], toolResults: [], rounds: 1, finishReason: "stop", usage: null }; } };
  const row = await runTrial({ task, mode: "noHarness", client, judge: async () => ({ score: 0.9, reason: "clear and right" }) });
  assert.equal(row.correct, true);
  assert.equal(row.judgeScore, 0.9);
  assert.equal(row.judgeReason, "clear and right");
  const none = await runTrial({ task, mode: "noHarness", client });
  assert.equal(none.correct, false);
  assert.match(none.error, /needs a judge/);
  const s = summarize([row, none]);
  assert.equal(s.byMode.noHarness.judged, 1);
  assert.equal(s.byMode.noHarness.judgeMeanScore, 0.9);
});

test("explain formats uptime in human units", async () => {
  const { humanUptime } = await import("../src/tasks/explain.js");
  assert.equal(humanUptime(90), "about 2 minutes");
  assert.equal(humanUptime(7200), "about 2.0 hours");
  assert.equal(humanUptime(3 * 86400), "about 3.0 days");
});
