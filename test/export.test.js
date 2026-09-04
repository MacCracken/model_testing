import { test } from "node:test";
import assert from "node:assert/strict";

import { rowsToCsv, cellsToCsv, ROW_COLUMNS, CELL_COLUMNS } from "../src/export.js";
import { summarize } from "../src/runner.js";

const row = (over = {}) => ({
  task: "health", mode: "harness", client: "openai:gpt-4o-mini", model: "gpt-4o-mini", index: 1,
  correct: true, reason: 'status "ok", matches', error: null, toolCalls: [{ name: "health" }], toolUseOk: true,
  toolUseReason: "called", schemaValid: true, latencyMs: 1234, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  rounds: 2, finishReason: "stop", startedAt: "2026-09-03T00:00:00.000Z", ...over,
});

test("rowsToCsv writes one header and one line per trial, quoting as needed", () => {
  const csv = rowsToCsv({ id: "run1", rows: [row(), row({ index: 2, correct: false, reason: 'said "no",\nreally', error: null, toolUseOk: null })] });
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], ROW_COLUMNS.join(","));
  assert.match(lines[1], /^run1,health,harness,openai:gpt-4o-mini,gpt-4o-mini,1,true,"status ""ok"", matches",,1,true,called,true,1234,,,10,5,15,2,stop,2026/);
  // The embedded newline stays inside its quoted field, so the record spans two physical lines.
  assert.ok(csv.includes('"said ""no"",\nreally"'));
  assert.ok(csv.endsWith("\n"));
});

test("cellsToCsv writes the summary cells; whole-number percentages stay whole, fractions get two decimals", () => {
  const summary = summarize([row(), row({ index: 2, correct: false, latencyMs: 2000 }), row({ mode: "noHarness", toolCalls: [], toolUseOk: null, schemaValid: null })]);
  const csv = cellsToCsv("run1", summary);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], CELL_COLUMNS.join(","));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^run1,health,openai:gpt-4o-mini,harness,2,1,50,100,100,100,0,1617,1234,2000,,,30$/);
  assert.match(lines[2], /^run1,health,openai:gpt-4o-mini,noHarness,1,1,100,0,,0,0,1234,1234,1234,,,15$/);
  const thirds = cellsToCsv("r", summarize([row(), row({ index: 2, correct: false }), row({ index: 3, correct: false })]));
  assert.match(thirds, /,3,1,33\.33,/);
});
