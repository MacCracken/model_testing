import { test } from "node:test";
import assert from "node:assert/strict";

import { replayArgs, describeReplay } from "../src/bench.js";
import { withParentDefaults } from "../src/web/server.js";
import { traceEvents, traceJsonl } from "../src/export.js";
import { trialTimeline } from "../src/report.js";

const parent = {
  id: "20260909T000000-par1",
  config: { tasks: ["health", "wordmath2"], modes: ["noHarness", "harness"], clients: ["openai:gpt-4o-mini"], count: 4, parallel: 2, instanceSeed: 2026, modelParams: { temperature: 0 }, judge: "openai:gpt-4o-mini" },
  rows: [],
};

test("replayArgs takes the parent's configuration wherever the command line is silent, and its knobs under any given", () => {
  const all = replayArgs(parent, {});
  assert.deepEqual(all, { replayParams: { temperature: 0 }, task: "health,wordmath2", mode: "noHarness,harness", clients: "openai:gpt-4o-mini", count: 4, parallel: 2, instanceSeed: 2026, judge: "openai:gpt-4o-mini" });
  const some = replayArgs(parent, { clients: "anthropic:claude-haiku-4-5", count: 2, judge: undefined });
  assert.equal(some.clients, undefined, "an explicit --clients wins");
  assert.equal(some.count, undefined);
  assert.equal(some.instanceSeed, 2026, "the same instances");
  assert.equal(some.task, "health,wordmath2");
  assert.deepEqual(replayArgs({ id: "bare", config: {} }, {}), { replayParams: {} });
});

test("withParentDefaults fills a web launch from the parent run's config, body first", () => {
  const filled = withParentDefaults({ replayOf: parent.id }, parent);
  assert.deepEqual(filled.tasks, ["health", "wordmath2"]);
  assert.deepEqual(filled.modes, ["noHarness", "harness"]);
  assert.deepEqual(filled.clients, ["openai:gpt-4o-mini"]);
  assert.equal(filled.count, 4);
  assert.equal(filled.parallel, 2);
  assert.equal(filled.instanceSeed, 2026);
  assert.equal(filled.temperature, 0);
  assert.equal(filled.seed, undefined);
  assert.equal(filled.judge, "openai:gpt-4o-mini");
  const over = withParentDefaults({ replayOf: parent.id, clients: ["local:ornith-1.5:9b"], count: 1, instanceSeed: "" }, parent);
  assert.deepEqual(over.clients, ["local:ornith-1.5:9b"]);
  assert.equal(over.count, 1);
  assert.equal(over.instanceSeed, 2026, "an empty field means: the parent's");
});

const trial = (task, index, correct, client = "openai:gpt-4o-mini", mode = "harness") => ({ task, index, correct, client, mode, error: null });

test("describeReplay pairs the replay with its parent by task and index and reads the discordant pairs", () => {
  const p = { ...parent, rows: [trial("health", 1, true), trial("health", 2, true), trial("health", 3, false), trial("health", 4, false)] };
  const r = { id: "20260909T000001-rep1", rows: [trial("health", 1, true), trial("health", 2, false), trial("health", 3, true), trial("health", 4, true)] };
  const text = describeReplay(p, r);
  assert.match(text, /replay of 20260909T000000-par1: 4 paired trial\(s\) \(0 parent-only, 0 replay-only\)/);
  assert.match(text, /health\s+50%\s+75%\s+1\s+1\s+2\s+0\s+p=1\.000/);
  assert.match(text, /overall: parent 50\.0% → replay 75\.0%/);
  // Another model on the same instances pairs too — by task and index, since the clients differ.
  const other = { id: "r2", rows: r.rows.map((x) => ({ ...x, client: "anthropic:claude-haiku-4-5" })) };
  assert.match(describeReplay(p, other), /4 paired trial\(s\)/);
  // Nothing in common: say so, and how to narrow.
  assert.match(describeReplay(p, { id: "r3", rows: [trial("reason", 1, true)] }), /0 paired trial\(s\)[\s\S]*nothing pairs/);
});

const loopRow = {
  task: "hello", mode: "harness", client: "openai:gpt-4o-mini", model: "gpt-4o-mini", index: 2, correct: true, reason: "both greetings match", error: null,
  system: "Return JSON.", prompt: "Greet alice and bob.", latencyMs: 812, rounds: 2, finishReason: "stop", seed: 11, usage: { total_tokens: 321 },
  toolCalls: [{ id: "c1", name: "hello", arguments: { name: "alice" } }, { id: "c2", name: "hello", arguments: { name: "bob" } }],
  toolResults: [{ id: "c2", name: "hello", ok: true, content: "{\"message\":\"Hello, bob!\"}" }, { id: "c1", name: "hello", ok: true, content: "{\"message\":\"Hello, alice!\"}" }],
  turns: [{ round: 1, ms: 240, text: "I will greet both.", calls: ["c1", "c2"], finishReason: "tool_calls" }, { round: 2, ms: 790, text: "{\"greetings\":[]}", calls: [], finishReason: "stop" }],
  answerText: "{\"greetings\":[]}", schemaValid: true, schemaErrors: [], toolUseOk: true, toolUseReason: "two calls, one per name", judgeScore: null,
};

test("traceEvents lays a trial out as the session unfolded — turns, calls and results paired by id — and falls back to calls-then-answer without turns", () => {
  const ev = traceEvents(loopRow);
  assert.deepEqual(ev.map((e) => e.kind), ["system", "user", "assistant", "tool_call", "tool_result", "tool_call", "tool_result", "assistant"]);
  assert.deepEqual(ev.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(ev[2].text, "I will greet both.");
  assert.equal(ev[2].ms, 240);
  assert.equal(ev[2].finish_reason, undefined, "only the final message carries a finish reason");
  assert.deepEqual(ev[3], { seq: 3, kind: "tool_call", id: "c1", name: "hello", args: { name: "alice" } });
  assert.match(ev[4].output, /alice/, "results pair by id, not by position");
  assert.match(ev[6].output, /bob/);
  assert.equal(ev[7].finish_reason, "stop");
  assert.equal(ev[7].text, "{\"greetings\":[]}");

  const arm = { ...loopRow, turns: null, system: null, toolCalls: [{ id: "t1", name: "Bash", arguments: { command: "curl …" } }], toolResults: [{ id: "t1", name: "Bash", ok: false, content: "exit 1" }] };
  const armEvents = traceEvents(arm);
  assert.deepEqual(armEvents.map((e) => e.kind), ["user", "tool_call", "tool_result", "assistant"]);
  assert.equal(armEvents[2].ok, false);
  assert.equal(armEvents[3].finish_reason, "stop");

  const plain = traceEvents({ prompt: "What is 2+2?", answerText: "4", finishReason: "stop" });
  assert.deepEqual(plain.map((e) => e.kind), ["user", "assistant"]);

  const lines = traceJsonl(loopRow).trimEnd().split("\n");
  assert.equal(lines.length, 8);
  assert.deepEqual(JSON.parse(lines[0]), { seq: 0, kind: "system", text: "Return JSON." });
  assert.equal(traceJsonl({ toolCalls: [], turns: [] }).trimEnd().split("\n").length, 2, "one user line, one assistant line");
});

test("trialTimeline prints the trial as a timeline with its verdicts", () => {
  const text = trialTimeline(loopRow);
  const lines = text.split("\n");
  assert.equal(lines[0], "hello · harness · openai:gpt-4o-mini · #2 · pass · both greetings match");
  assert.equal(lines[1], "model gpt-4o-mini · 812 ms · 321 tokens · 2 round(s) · seed 11");
  assert.match(text, /\+240ms  assistant   I will greet both\./);
  assert.match(text, /tool_call   → hello \{"name":"alice"\}/);
  assert.match(text, /tool_result ← hello ok \{"message":"Hello, alice!"\}/);
  assert.match(text, /schema      valid/);
  assert.match(text, /tool use    correct: two calls, one per name/);
  assert.match(text, /verdict     pass · both greetings match/);
  assert.match(trialTimeline({ ...loopRow, error: "HTTP 500", correct: false }), /error: HTTP 500/);
});
