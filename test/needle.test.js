import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, needleTasks, linesFor } from "../src/tasks/needle.js";
import { runTrial } from "../src/runner.js";

test("the log is deterministic, sized to the token target, and its truth is recomputable from the lines", () => {
  assert.equal(linesFor(8000), 190);
  for (let seed = 1; seed <= 12; seed++) {
    const g = generate(seed, 8000);
    assert.deepEqual(g, generate(seed, 8000));
    assert.equal(g.lines, 190);
    assert.ok(Math.abs(g.approxTokens - 8000) < 100, `≈8k tokens (got ${g.approxTokens})`);
    const lines = g.text.split("\n");
    assert.equal(lines.length, g.lines);
    assert.equal(g.kind, ["single", "multi", "agg"][seed % 3]);
    if (g.kind === "single") {
      const hits = lines.filter((l) => l.includes(`req=${g.key[0]}`));
      assert.equal(hits.length, 1, "the request id is unique");
      assert.match(hits[0], new RegExp(`latency=${g.answer}ms`));
      assert.ok([0.1, 0.5, 0.9].includes(g.depth));
    } else if (g.kind === "multi") {
      const crit = lines.filter((l) => l.includes("level=CRITICAL"));
      assert.equal(crit.length, 3);
      assert.deepEqual(crit.map((l) => l.match(/host-\d+/)[0]).sort(), g.answer);
    } else {
      const [svc] = g.key;
      assert.equal(lines.filter((l) => l.includes(`svc=${svc}`) && l.includes("level=ERROR")).length, g.answer);
    }
  }
  assert.equal(generate(7, 8000, { kind: 1 }).kind, "multi");
  assert.equal(generate(7, 8000, { kind: 2 }).kind, "agg");
  assert.equal(generate(7, 8000, { kind: 0 }).question.slice(0, 12), "What latency");
  const big = generate(5, 100000);
  assert.ok(big.lines > 2000 && big.approxTokens >= 99000 && big.approxTokens <= 101000);
});

test("scorers and verdicts per question kind", () => {
  const t = needleTasks[0];
  assert.equal(t.name, "needle8k");
  const single = { kind: "single", answer: 897, depth: 0.5 };
  assert.equal(t.eval.scoreHarness({ answer: 897 }, single).correct, true);
  assert.equal(t.eval.scoreNoHarness("The line shows latency=897ms.\nanswer: 897", single).correct, true);
  assert.match(t.eval.scoreNoHarness("answer: 900", single).reason, /answered 900, expected 897/);
  const multi = { kind: "multi", answer: ["host-29", "host-30", "host-8"] };
  assert.equal(t.eval.scoreHarness({ answer: ["Host-8", "host-29", "host-30"] }, multi).correct, true);
  assert.equal(t.eval.scoreNoHarness("answer: host-8, host-29, host-30", multi).correct, true);
  assert.match(t.eval.scoreNoHarness("answer: host-8, host-29", multi).reason, /missing host-30/);
  assert.match(t.eval.scoreHarness({ answer: ["host-8", "host-29", "host-30", "host-1"] }, multi).reason, /extra host-1/);
  const agg = { kind: "agg", answer: 5 };
  assert.equal(t.eval.scoreHarness({ answer: 5 }, agg).correct, true);
  assert.equal(t.eval.scoreNoHarness("I count 5 such lines.\nanswer: 5", agg).correct, true);
  assert.equal(t.eval.scoreHarness({ answer: ["x"] }, agg).correct, false);
  const ctx = { key: ["billing", "ERROR"] };
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "count_log", arguments: { pattern: "svc=billing.*level=ERROR" } }], ctx }).ok, true);
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "grep_log", arguments: { pattern: "svc=billing" } }, { name: "grep_log", arguments: { pattern: "level=error" } }], ctx }).ok, true, "keys may be found across calls");
  assert.match(t.eval.toolUse({ toolCalls: [{ name: "grep_log", arguments: { pattern: "WARN" } }], ctx }).reason, /none for billing and ERROR/);
  assert.match(t.eval.toolUse({ toolCalls: [], ctx }).reason, /never searched/);
  assert.equal(t.eval.canon({ answer: ["host-30", "host-8"] }, { structured: true }), "host-30,host-8");
  assert.equal(t.eval.canon("answer: 42", { structured: false }), "42");
  assert.match(t.noHarness.prompt({ lines: 3, kind: "single", text: "L1\nL2\nL3", question: "Q?" }), /L1\nL2\nL3\n\nQuestion: Q\?$/);
  assert.match(t.harness.prompt({ log: "log-1", lines: 3, kind: "agg", question: "Q?" }), /Log id log-1/);
  assert.doesNotMatch(t.harness.prompt({ log: "log-1", lines: 3, kind: "agg", question: "Q?", text: "L1" }), /L1/, "the tool modes never inline the log");
});

test("the run record keeps a capped prompt while the model receives the whole log", async () => {
  const task = { name: "cap", noHarness: { prompt: "x".repeat(50_000) }, eval: { ground: () => 1, scoreNoHarness: () => ({ correct: true, reason: "" }) } };
  let sent = 0;
  const client = { name: "c", model: "m", async chat(messages) { sent = messages.at(-1).content.length; return { text: "ok", toolCalls: [], finishReason: "stop", usage: null }; } };
  const r = await runTrial({ task, mode: "noHarness", client });
  assert.equal(sent, 50_000);
  assert.ok(r.prompt.length < 20_200);
  assert.match(r.prompt, /truncated in the record: 50000 characters/);
});
