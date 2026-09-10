// Calibration ([28]): the @confidence treatment, reading the stated probability, Brier and ECE,
// the calibration view, the paired delta, and the suffix through the client spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConfidence, readConfidence, toProbability, calibration, calibrationView, describeCalibration, withConfidence, parseConfidenceSuffix, NOTES } from "../src/confidence.js";
import { summarize, runTrial } from "../src/runner.js";
import { printSummary } from "../src/report.js";
import { parseClientSpec, resolveClients } from "../src/providers/index.js";
import { goalPrompt } from "../src/harness/util.js";
import { task as health } from "../src/tasks/health.js";
import { task as reason } from "../src/tasks/reason.js";
import { wordmathTasks } from "../src/tasks/wordmath.js";

test("the request: an object schema gains an optional confidence field and the note; an array schema only gets the free-form note", () => {
  const obj = { prompt: "p", schema: { type: "object", properties: { work: { type: "array" }, answer: { type: "integer" } }, required: ["answer"] } };
  const a = applyConfidence(obj, { structured: true });
  assert.equal(a.applied, true);
  assert.deepEqual(Object.keys(a.spec.schema.properties), ["work", "answer", "confidence"]);
  assert.deepEqual(a.spec.schema.required, ["answer"], "not required: validity is unchanged");
  assert.match(a.spec.prompt, /"confidence" field after the answer/);
  const arr = applyConfidence({ prompt: "p", schema: { type: "array", items: {} } }, { structured: true });
  assert.equal(arr.applied, false);
  const free = applyConfidence({ prompt: "p" }, { structured: false });
  assert.equal(free.applied, true);
  assert.equal(free.spec.prompt, `p\n\n${NOTES.free}`);
});

test("reading the number: a probability, a percentage, a 0–100 scale, the last confidence line; nothing otherwise", () => {
  assert.equal(readConfidence({ answer: 3, confidence: 0.8 }, ""), 0.8);
  assert.equal(readConfidence({ confidence: "80%" }, ""), 0.8);
  assert.equal(readConfidence({ confidence: 80 }, ""), 0.8);
  assert.equal(readConfidence({ confidence: 1 }, ""), 1);
  assert.equal(readConfidence({ confidence: "sure" }, ""), null);
  assert.equal(readConfidence({ confidence: 1.7 }, ""), null, "above 1 and above 100 is nothing");
  assert.equal(readConfidence(null, "The answer is 12.\nconfidence: 0.7"), 0.7);
  assert.equal(readConfidence(null, "Confidence: 85%"), 0.85);
  assert.equal(readConfidence(null, "confidence: 0.3\n…\nConfidence: 0.9"), 0.9, "the last line wins");
  assert.equal(readConfidence(null, "**Confidence:** 0.6"), 0.6);
  assert.equal(readConfidence(null, "I am fairly confident."), null);
  assert.equal(readConfidence([{ confidence: 0.5 }], "confidence: 0.4"), 0.4, "an array answer has no field; the text is read");
  assert.equal(toProbability("0.25"), 0.25);
  assert.equal(toProbability(null), null);
});

const row = (p, correct, over = {}) => ({ task: "t", mode: "harness", client: "c", model: "m", index: 1, correct, latencyMs: 1, confidence: p === null ? { how: "asked", applied: true, value: null } : { how: "asked", applied: true, value: p }, ...over });

test("calibration: Brier, ECE over ten bins and the confidence–accuracy gap; overconfidence reads as a positive gap", () => {
  // Four rows at 0.9 all right, four at 0.9 all wrong: accuracy 50 %, confidence 90 %, gap +40.
  const c = calibration([...[1, 2, 3, 4].map(() => row(0.9, true)), ...[1, 2, 3, 4].map(() => row(0.9, false))]);
  assert.equal(c.n, 8);
  assert.equal(c.accuracyPct, 50);
  assert.ok(Math.abs(c.meanConfidencePct - 90) < 1e-9);
  assert.ok(Math.abs(c.overconfidencePp - 40) < 1e-9);
  assert.ok(Math.abs(c.brier - (4 * 0.01 + 4 * 0.81) / 8) < 1e-12);
  assert.ok(Math.abs(c.ece - 0.4) < 1e-9, "one bin, |0.9 − 0.5|");
  assert.equal(c.bins.length, 1);
  assert.deepEqual([c.bins[0].lo, c.bins[0].hi, c.bins[0].n], [0.9, 1, 8]);
  // Perfect calibration in two bins: 0.2 right one in five, 1.0 always right.
  const good = calibration([...[1, 2, 3, 4, 5].map((i) => row(0.2, i === 1)), ...[1, 2].map(() => row(1, true))]);
  assert.ok(Math.abs(good.ece) < 1e-9);
  assert.ok(good.brier < 0.12);
  assert.equal(good.bins.length, 2);
  assert.equal(calibration([row(null, true)]), null, "no stated confidence: nothing to calibrate");
  assert.equal(calibration([row(0.9, true, { error: "x" })]), null, "error rows do not count");
  assert.match(describeCalibration(c), /8 stated · accuracy 50% · mean confidence 90% \(overconfident by 40pp\) · Brier 0\.410 · ECE 0\.400/);
  assert.equal(describeCalibration(null), "no stated confidence");
});

test("the summary carries a calibration view and pairs the variant against its base; the report prints both", () => {
  const rows = [
    ...[1, 2, 3, 4].map((i) => ({ task: "t", mode: "harness", client: "c", model: "m", index: i, correct: i !== 4, latencyMs: 1 })),
    ...[1, 2, 3, 4].map((i) => row(i === 4 ? 0.4 : 0.9, i !== 3, { client: "c@confidence", baseClient: "c", index: i })),
    row(0.5, true, { client: "d", mode: "noHarness" }),
  ];
  const s = summarize(rows);
  assert.deepEqual(s.calibration.map((c) => [c.client, c.mode, c.n]), [["c@confidence", "harness", 4], ["d", "noHarness", 1]]);
  assert.deepEqual(calibrationView([]), []);
  const d = s.delta.confidence.asked;
  assert.equal(d.stated, 4);
  assert.equal(d.baseClient ?? "c", "c");
  assert.equal(d.calibration.n, 4);
  assert.equal(d.deltaPp, 0, "one right answer lost, one gained");
  assert.ok(s.delta.byConfidence["t|harness|c@confidence"]);
  const lines = [];
  printSummary(s, { log: (l) => lines.push(l) });
  const text = lines.join("\n");
  assert.match(text, /-- calibration \(rows that stated a confidence/);
  assert.match(text, /c@confidence\s+harness\s+4 stated · accuracy 75%/);
  assert.match(text, /-- confidence delta[\s\S]*asked[\s\S]*stated in 4\/4/);
});

test("the treatment through the runner: the field on a structured answer, the line on a free-form one, an arm's goal note", async () => {
  const seen = [];
  const client = {
    name: "fake:m", model: "m",
    async chat(messages) { seen.push(messages.at(-1).content); return { text: "1. 42\n2. no\n3. Tuesday\nconfidence: 0.75", usage: null }; },
    async runWithTools(prompt, tools, system) { seen.push(prompt); return { text: JSON.stringify({ status: "ok", uptimeSec: 5, confidence: 0.6 }), structured: { status: "ok", uptimeSec: 5, confidence: 0.6 }, toolCalls: [{ name: "health", arguments: {} }], toolResults: [{ name: "health", ok: true, content: "{}" }], rounds: 1, usage: null };
    },
  };
  const c = withConfidence(client);
  assert.deepEqual([c.name, c.baseName, c.confidence], ["fake:m@confidence", "fake:m", "asked"]);
  // reason needs no server: its truth is fixed and its free-form mode has no tools.
  const free = await runTrial({ task: reason, mode: "noHarness", client: c, index: 1 });
  assert.equal(free.error, null);
  assert.deepEqual(free.confidence, { how: "asked", applied: true, value: 0.75 });
  assert.match(seen[0], /confidence: <number from 0 to 1>/);
  const wm = wordmathTasks[0];
  const structured = await runTrial({ task: wm, mode: "harness", client: { ...c, async runWithTools(prompt, tools, system) { seen.push(system); return { text: JSON.stringify({ work: [], answer: 1, confidence: 0.7 }), structured: { work: [], answer: 1, confidence: 0.7 }, toolCalls: [], toolResults: [], rounds: 1, usage: null }; } }, index: 1, seed: 3 });
  assert.equal(structured.confidence.applied, true);
  assert.equal(structured.confidence.value, 0.7);
  assert.match(seen[1], /"confidence"/, "the schema hint carries the field");
  assert.equal(structured.schemaValid, true, "the field is optional: validity is unchanged");
  const plain = await runTrial({ task: reason, mode: "noHarness", client, index: 1 });
  assert.equal(plain.confidence, null);
  // An arm gets the note in its goal prompt.
  assert.match(goalPrompt(health, "harness", "fallback", null, null, null, NOTES.structured), /"confidence" field after the answer/);
  assert.doesNotMatch(goalPrompt(health, "harness", "fallback"), /confidence/);
});

test("the suffix: @confidence parses alone, resolves to a paired variant, and refuses to stack", () => {
  assert.deepEqual(parseConfidenceSuffix("openai:gpt-4o-mini@confidence"), { base: "openai:gpt-4o-mini", how: "asked" });
  assert.deepEqual(parseConfidenceSuffix("openai:gpt-4o-mini"), { base: "openai:gpt-4o-mini", how: null });
  assert.deepEqual(parseClientSpec("local:m@confidence"), { provider: "local", model: "m", confidence: "asked" });
  assert.throws(() => parseClientSpec("local:m@format:work@confidence"), /one variant per client/);
  const [base, variant] = resolveClients("local:ornith-1.5:9b,local:ornith-1.5:9b@confidence");
  assert.equal(variant.name, "local:ornith-1.5:9b@confidence");
  assert.equal(variant.baseName, base.name);
});
