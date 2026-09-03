import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// results.js resolves RESULTS_DIR at import time, so point it at a scratch dir before importing.
const dir = mkdtempSync(join(tmpdir(), "hb-results-"));
process.env.RESULTS_DIR = dir;
const { saveRun, loadRun, listRuns, newRunId } = await import("../src/results.js");

test("listRuns skips malformed run files instead of failing the whole listing", () => {
  const good = { id: newRunId(), createdAt: new Date().toISOString(), status: "done", config: { tasks: ["health"], modes: ["harness"], clients: ["x"], count: 1 }, rows: [] };
  saveRun(good);
  writeFileSync(join(dir, "runs", "20260101T000000-bad1.json"), JSON.stringify({ id: "20260101T000000-bad1", status: "done" }));
  writeFileSync(join(dir, "runs", "20260101T000000-bad2.json"), "{ not json");
  const runs = listRuns();
  assert.deepEqual(runs.map((r) => r.id), [good.id]);
  assert.equal(runs[0].rowCount, 0);
  assert.equal(loadRun("20260101T000000-bad1"), null);
  assert.equal(loadRun("20260101T000000-bad2"), null);
});

test("newRunId sorts by time and is filesystem-safe", () => {
  const a = newRunId(new Date("2026-01-01T00:00:00Z"));
  const b = newRunId(new Date("2026-01-02T00:00:00Z"));
  assert.ok(a < b);
  assert.match(a, /^20260101T000000-[0-9a-f]{4}$/);
});
