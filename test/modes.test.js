import { test } from "node:test";
import assert from "node:assert/strict";

import { isStructuredMode, runTrial, runMatrix, planMatrix, MODE_NAMES, DEFAULT_MODES } from "../src/runner.js";
import { resolveModes } from "../src/bench.js";

// The runner treats a mode by behavior (structured vs free-form), not by name. schemaOnly and
// toolOnly are the two non-baseline decompositions of the harness bundle.

test("isStructuredMode classifies the four modes", () => {
  assert.equal(isStructuredMode("noHarness"), false);
  assert.equal(isStructuredMode("harness"), true);
  assert.equal(isStructuredMode("schemaOnly"), true);
  assert.equal(isStructuredMode("toolOnly"), false);
});

test("MODE_NAMES is the one list of modes; DEFAULT_MODES is the headline pair", () => {
  assert.deepEqual(MODE_NAMES, ["noHarness", "harness", "schemaOnly", "toolOnly"]);
  assert.deepEqual(DEFAULT_MODES, ["noHarness", "harness"]);
});

test("resolveModes accepts every mode name and rejects unknown ones", () => {
  assert.deepEqual(resolveModes("schemaOnly"), ["schemaOnly"]);
  assert.deepEqual(resolveModes("noHarness,schemaOnly,toolOnly"), ["noHarness", "schemaOnly", "toolOnly"]);
  assert.throws(() => resolveModes("bogus"), /must be one of/);
});

test("resolveModes with no spec returns the default pair", () => {
  assert.deepEqual(resolveModes(), DEFAULT_MODES);
});

// ---- a fake client that follows the real Client contract ------------------------------------

function fakeClient({ text = "", structured = null, toolCalls = [], toolResults = [] } = {}) {
  return {
    name: "probe",
    model: "probe",
    async chat() {
      return { text, toolCalls: [], finishReason: "stop", usage: null };
    },
    async runWithTools() {
      return { text, structured, toolCalls, toolResults, rounds: toolCalls.length ? 2 : 1, finishReason: "stop", usage: { total_tokens: 11 } };
    },
  };
}

const SCHEMA = { type: "object", properties: { ok: { type: "string" } }, required: ["ok"] };
const NOOP = { name: "noop", impl: async () => "ok" };

function probeTask(extra = {}) {
  return {
    name: "probe",
    noHarness: { prompt: "say hi" },
    harness: { system: "sys", prompt: "do it", tools: [NOOP], schema: SCHEMA },
    eval: {
      ground: async () => ({ ok: "ok" }),
      scoreHarness: (out) => ({ correct: out?.ok === "ok", reason: "structured" }),
      scoreNoHarness: (out) => ({ correct: String(out).trim() === "ok", reason: "free text" }),
    },
    ...extra,
  };
}

test("harness scores the parsed JSON; noHarness scores the raw text", async () => {
  const task = probeTask();
  const structured = await runTrial({ task, mode: "harness", client: fakeClient({ text: '{"ok":"ok"}', structured: { ok: "ok" } }) });
  assert.equal(structured.correct, true);
  assert.equal(structured.schemaValid, true);
  assert.match(structured.system, /instance of this JSON Schema/);
  assert.match(structured.system, /not the schema itself/);

  const free = await runTrial({ task, mode: "noHarness", client: fakeClient({ text: "ok" }) });
  assert.equal(free.correct, true);
  assert.equal(free.schemaValid, null);
  assert.equal(free.toolCalls.length, 0);
});

test("schemaOnly scores the parsed JSON and validates it even with no tools", async () => {
  const task = probeTask({ schemaOnly: { prompt: "emit json", schema: SCHEMA } });
  const row = await runTrial({ task, mode: "schemaOnly", client: fakeClient({ text: '{"ok":"ok"}', structured: { ok: "ok" } }) });
  assert.equal(row.toolCalls.length, 0);
  assert.equal(row.correct, true);
  assert.equal(row.schemaValid, true);
});

test("toolOnly runs tools, scores the raw text, and has no schema verdict", async () => {
  const task = probeTask({ toolOnly: { system: "sys", prompt: "call and answer", tools: [NOOP] } });
  const client = fakeClient({
    text: "ok",
    toolCalls: [{ id: "call_1", name: "noop", arguments: {} }],
    toolResults: [{ id: "call_1", name: "noop", ok: true, content: "ok" }],
  });
  const row = await runTrial({ task, mode: "toolOnly", client });
  assert.equal(row.toolCalls.length, 1);
  assert.equal(row.correct, true);
  assert.equal(row.schemaValid, null, "nothing to validate against, so no verdict");
  assert.equal(row.system, "sys", "no schema is injected for a free-form mode");
});

test("ground() receives what the trial's tools returned", async () => {
  const task = probeTask({
    eval: {
      ground: ({ toolResults }) => JSON.parse(toolResults[0].content).v,
      scoreHarness: (out, ground) => ({ correct: out?.v === ground, reason: "" }),
      scoreNoHarness: () => ({ correct: false, reason: "" }),
    },
  });
  const client = fakeClient({
    structured: { v: 7 },
    toolCalls: [{ id: "c", name: "noop", arguments: {} }],
    toolResults: [{ id: "c", name: "noop", ok: true, content: '{"v":7}' }],
  });
  const row = await runTrial({ task, mode: "harness", client });
  assert.equal(row.ground, 7);
  assert.equal(row.correct, true);
});

test("a constant ground is accepted as-is", async () => {
  const task = probeTask({
    eval: {
      ground: ["fixed"],
      scoreHarness: (out, ground) => ({ correct: ground[0] === "fixed", reason: "" }),
      scoreNoHarness: () => ({ correct: false, reason: "" }),
    },
  });
  const row = await runTrial({ task, mode: "harness", client: fakeClient({ structured: {} }) });
  assert.deepEqual(row.ground, ["fixed"]);
  assert.equal(row.correct, true);
});

test("planMatrix skips (task, mode) pairs a task does not declare and keeps execution order", () => {
  const probe = probeTask();
  const other = { ...probeTask(), name: "other", schemaOnly: { prompt: "x", schema: SCHEMA } };
  const plan = planMatrix({ tasks: [probe, other], modes: ["noHarness", "schemaOnly"], clients: [{ name: "c1" }, { name: "c2" }], count: 3 });
  assert.deepEqual(plan.skipped, [{ task: "probe", mode: "schemaOnly" }]);
  assert.equal(plan.total, 3 * 2 * 3);
  assert.deepEqual(
    plan.cells.map((c) => `${c.task.name}/${c.mode}/${c.client.name}`),
    ["probe/noHarness/c1", "probe/noHarness/c2", "other/noHarness/c1", "other/noHarness/c2", "other/schemaOnly/c1", "other/schemaOnly/c2"],
  );
});

test("runMatrix reports skipped pairs and never emits an unsupported-mode row", async () => {
  const events = [];
  const { rows, skipped } = await runMatrix({
    tasks: [probeTask()],
    modes: ["noHarness", "harness", "toolOnly"],
    clients: [fakeClient({ text: "ok", structured: { ok: "ok" } })],
    count: 2,
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(skipped, [{ task: "probe", mode: "toolOnly" }]);
  assert.equal(events[0].type, "start");
  assert.equal(events[0].total, 4);
  assert.deepEqual(events[0].skipped, skipped);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => !r.error && r.correct));
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).summary.runs, 4);
});

test("an aborted signal stops the matrix without inventing exception rows", async () => {
  const controller = new AbortController();
  controller.abort();
  const events = [];
  const { rows } = await runMatrix({
    tasks: [probeTask()], modes: ["noHarness"], clients: [fakeClient({ text: "ok" })], count: 3,
    signal: controller.signal, onEvent: (e) => events.push(e),
  });
  assert.equal(rows.length, 0);
  assert.equal(events.at(-1).cancelled, true);
});

test("toolUseOk is judged only when the spec carries tools and the task defines a judge", async () => {
  const judge = { toolUse: ({ toolCalls }) => ({ ok: toolCalls.length === 1, reason: toolCalls.length === 1 ? "one call" : "wrong count" }) };
  const task = probeTask({ eval: { ...probeTask().eval, ...judge } });
  const withCall = fakeClient({ text: '{"ok":"ok"}', structured: { ok: "ok" }, toolCalls: [{ id: "c", name: "noop", arguments: {} }], toolResults: [{ id: "c", name: "noop", ok: true, content: "ok" }] });
  const good = await runTrial({ task, mode: "harness", client: withCall });
  assert.equal(good.toolUseOk, true);
  assert.equal(good.toolUseReason, "one call");
  const bad = await runTrial({ task, mode: "harness", client: fakeClient({ text: '{"ok":"ok"}', structured: { ok: "ok" } }) });
  assert.equal(bad.toolUseOk, false);
  const free = await runTrial({ task, mode: "noHarness", client: fakeClient({ text: "ok" }) });
  assert.equal(free.toolUseOk, null, "no tools in the spec → no verdict");
  const noJudge = await runTrial({ task: probeTask(), mode: "harness", client: withCall });
  assert.equal(noJudge.toolUseOk, null, "no judge on the task → no verdict");
});
