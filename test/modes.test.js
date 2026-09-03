import { test } from "node:test";
import assert from "node:assert/strict";

import { isStructuredMode } from "../src/runner.js";
import { resolveModes } from "../src/bench.js";

// The runner treats a mode by behavior (structured vs free-form), not by name. schemaOnly and
// toolOnly are the two non-baseline decompositions of the harness bundle.

test("isStructuredMode classifies the four modes", () => {
  assert.equal(isStructuredMode("noHarness"), false);
  assert.equal(isStructuredMode("harness"), true);
  assert.equal(isStructuredMode("schemaOnly"), true);
  assert.equal(isStructuredMode("toolOnly"), false);
});

test("resolveModes accepts the new mode names", () => {
  assert.deepEqual(resolveModes("schemaOnly"), ["schemaOnly"]);
  assert.deepEqual(resolveModes("toolOnly"), ["toolOnly"]);
  assert.deepEqual(resolveModes("noHarness,schemaOnly,toolOnly"), ["noHarness", "schemaOnly", "toolOnly"]);
});

test("resolveModes rejects an unknown mode", () => {
  assert.throws(() => resolveModes("bogus"), /must be one of/);
});

test("resolveModes with no spec returns the default two modes", () => {
  assert.deepEqual(resolveModes(), ["noHarness", "harness"]);
});

// The runner's mode selection: a structured mode runs tools + parses JSON, a free-form one runs
// neither. These tasks carry no live ground() that hits the webserver, so we stub the task shape
// and the client, then assert which code path each mode takes.

test("runTrial in structured mode runs tools and scores the parsed JSON", async () => {
  const task = {
    name: "probe",
    harness: {
      prompt: "do it",
      tools: [{ name: "noop", impl: async () => "ok" }],
      schema: { type: "object", properties: { ok: { type: "string" } }, required: ["ok"] },
    },
    noHarness: { prompt: "say hi", extract: "text" },
    eval: {
      ground: async () => ({ ok: "ok" }),
      scoreHarness: (out) => ({ correct: out?.ok === "ok", reason: "structured" }),
      scoreNoHarness: (out) => ({ correct: false, reason: "free text" }),
    },
  };

  // The mock follows the real client contract: runWithTools parses the final message text.
  // Emitting JSON directly (no tool calls) makes runWithTools return immediately with that JSON.
  const client = {
    name: "probe",
    model: "probe",
    async chat() {
      return { text: "", toolCalls: [], finishReason: "stop", usage: null };
    },
    async runWithTools() {
      // The real client returns the final message already parsed as JSON. Mirror that here so
      // runWithTools scores the parsed object rather than raw text.
      return { text: '{"ok":"ok"}', structured: { ok: "ok" }, toolCalls: [], finishReason: "function_call", usage: { total_tokens: 11 } };
    },
  };

  const structured = await import("../src/runner.js").then((r) => r.runTrial({
    task, mode: "harness", client, index: 1,
  }));
  assert.equal(structured.toolCalls.length, 0, "no tool calls expected");
  assert.equal(structured.correct, true, "harness should score the parsed JSON");

  const free = await import("../src/runner.js").then((r) => r.runTrial({
    task, mode: "noHarness", client, index: 1,
  }));
  assert.equal(free.toolCalls.length, 0, "free-form should not call tools");
  assert.equal(free.correct, false, "free-form uses scoreNoHarness");
});

test("schemaOnly scores the parsed JSON even with no tools", async () => {
  const task = {
    name: "probe",
    schemaOnly: {
      prompt: "emit json",
      schema: { type: "object", properties: { ok: { type: "string" } }, required: ["ok"] },
    },
    noHarness: { prompt: "say hi", extract: "text" },
    harness: {
      prompt: "do it",
      tools: [{ name: "noop", impl: async () => "ok" }],
      schema: { type: "object", properties: { ok: { type: "string" } }, required: ["ok"] },
    },
    eval: {
      ground: async () => ({ ok: "ok" }),
      scoreHarness: (out) => ({ correct: out?.ok === "ok", reason: "structured" }),
      scoreNoHarness: (out) => ({ correct: false, reason: "free text" }),
    },
  };

  const client = {
    name: "probe",
    model: "probe",
    async chat() {
      return { text: "", toolCalls: [], finishReason: "stop", usage: null };
    },
    async runWithTools() {
      // The real client returns the final message already parsed as JSON. Mirror that here so
      // runWithTools scores the parsed object rather than raw text.
      return { text: '{"ok":"ok"}', structured: { ok: "ok" }, toolCalls: [], finishReason: "function_call", usage: { total_tokens: 9 } };
    },
  };

  const row = await import("../src/runner.js").then((r) => r.runTrial({
    task, mode: "schemaOnly", client, index: 1,
  }));
  assert.equal(row.toolCalls.length, 0, "schemaOnly should not call tools");
  assert.equal(row.correct, true, "schemaOnly should score the parsed JSON");
  assert.equal(row.schemaValid, true, "schemaOnly should validate against the schema");
});

test("toolOnly scores the raw text even with tools", async () => {
  const task = {
    name: "probe",
    toolOnly: { prompt: "call and answer", tools: [{ name: "noop", impl: async () => "ok" }] },
    noHarness: { prompt: "say hi", extract: "text" },
    harness: {
      prompt: "do it",
      tools: [{ name: "noop", impl: async () => "ok" }],
      schema: { type: "object", properties: { ok: { type: "string" } }, required: ["ok"] },
    },
    eval: {
      ground: async () => "ok",
      scoreHarness: (out) => ({ correct: false, reason: "structured" }),
      scoreNoHarness: (out) => ({ correct: String(out).trim() === "ok", reason: "free text" }),
    },
  };

  const client = {
    name: "probe",
    model: "probe",
    async chat() {
      return { text: "", toolCalls: [], finishReason: "stop", usage: null };
    },
    async runWithTools() {
      // Mirror the real client's internal loop: round 1 requests the tool, round 2 (final) emits
      // prose "ok", which the free-form scorer reads as raw text. The runner calls runWithTools
      // exactly once, so the loop must live inside the mock.
      const calls = [];
      let round = 0;
      while (round < 2) {
        round += 1;
        if (round === 1) {
          calls.push({ name: "noop", arguments: {}, id: "call_1" });
        }
      }
      return { text: "ok", structured: null, toolCalls: calls, finishReason: "function_call", usage: { total_tokens: 3 }, rounds: round };
    },
  };

  const row = await import("../src/runner.js").then((r) => r.runTrial({
    task, mode: "toolOnly", client, index: 1,
  }));
  assert.equal(row.toolCalls.length, 1, "toolOnly should call the tool");
  assert.equal(row.correct, true, "toolOnly should score the raw text");
  assert.equal(row.schemaValid, false, "toolOnly has no schema to validate against");
});
