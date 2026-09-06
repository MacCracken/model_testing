import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store indexes whatever RESULTS_DIR points at, so point it at a scratch directory before
// importing (results.js resolves the root at import time).
const dir = mkdtempSync(join(tmpdir(), "hb-store-"));
process.env.RESULTS_DIR = dir;
const { saveRun } = await import("../src/results.js");
const store = await import("../src/store.js");

const row = (task, mode, client, correct, i, over = {}) => ({
  index: i, task, mode, client, model: client.split(":").slice(1).join(":"), correct, reason: correct ? "ok" : "nope", error: null,
  toolCalls: mode === "harness" ? [{ name: "x" }] : [], toolUseOk: mode === "harness" ? true : null, schemaValid: mode === "harness" ? true : null,
  latencyMs: 100 + i, ttftMs: 20, ttfaMs: 40, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, rounds: 1, finishReason: "stop",
  startedAt: "2026-09-01T00:00:00.000Z", system: "S".repeat(200), prompt: "P".repeat(200), answerText: "A".repeat(200),
  toolResults: mode === "harness" ? [{ name: "x", ok: true, content: "C".repeat(500) }] : [], ground: { g: 1 }, structured: correct ? { ok: 1 } : null, ...over,
});
const run = (id, createdAt, rows) => ({ id, createdAt, finishedAt: createdAt, status: "done", source: "cli", config: { tasks: [...new Set(rows.map((r) => r.task))], modes: [...new Set(rows.map((r) => r.mode))], clients: [...new Set(rows.map((r) => r.client))], count: 2 }, versions: { bench: "0.1.0" }, warnings: [], rows });

const R1 = run("20260901T000000-aaaa", "2026-09-01T00:00:00.000Z", [
  row("health", "noHarness", "openai:m", false, 1), row("health", "noHarness", "openai:m", true, 2),
  row("health", "harness", "openai:m", true, 1), row("health", "harness", "openai:m", true, 2),
]);
const R2 = run("20260902T000000-bbbb", "2026-09-02T00:00:00.000Z", [
  row("health", "harness", "openai:m", true, 1), row("health", "harness", "openai:m", false, 2),
  row("lookup", "harness", "openai:m", false, 1), row("lookup", "harness", "openai:m", false, 2),
]);

test("saving a run indexes it; queries see runs, trials and cells", () => {
  saveRun(R1);
  saveRun(R2);
  const runs = store.queryRuns();
  assert.deepEqual(runs.map((r) => r.id), [R2.id, R1.id], "newest first");
  assert.deepEqual(runs[1].config.tasks, ["health"]);
  assert.equal(runs[1].rowCount, 4);
  assert.deepEqual(store.queryRuns({ task: "lookup" }).map((r) => r.id), [R2.id]);
  assert.deepEqual(store.queryRuns({ q: "aaaa" }).map((r) => r.id), [R1.id]);
  assert.deepEqual(store.queryRuns({ since: "2026-09-02" }).map((r) => r.id), [R2.id]);

  const t = store.trend({ task: "health", client: "openai:m", mode: "harness" });
  assert.deepEqual(t.map((x) => [x.run_id, x.correct, x.runs]), [[R1.id, 2, 2], [R2.id, 1, 2]]);
  const c = store.cellHistory({ task: "health", client: "openai:m", mode: "harness" });
  assert.equal(c.correct, 3); assert.equal(c.trials, 4); assert.equal(c.runs, 2); assert.equal(c.correctPct, 75);
  const worst = store.worstCells({ minTrials: 2, limit: 5 });
  assert.equal(worst[0].task, "lookup"); assert.equal(worst[0].correct_pct, 0);
  const raw = store.rawQuery("select count(*) as n from trials where tool_use_ok = 1");
  assert.equal(raw[0].n, 6);
});

test("indexRuns is incremental by mtime, re-reads changed files and drops vanished ones", () => {
  let r = store.indexRuns();
  assert.equal(r.indexed, 0); assert.equal(r.skipped, 2); assert.equal(r.removed, 0);
  // Touch a file with new content: it is re-read.
  const p = join(dir, "runs", `${R2.id}.json`);
  const changed = { ...R2, rows: R2.rows.map((x) => ({ ...x, correct: true })) };
  writeFileSync(p, JSON.stringify(changed));
  utimesSync(p, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  r = store.indexRuns();
  assert.equal(r.indexed, 1);
  assert.equal(store.cellHistory({ task: "lookup", client: "openai:m" }).correct, 2);
  // Remove a file: its rows go.
  unlinkSync(p);
  r = store.indexRuns();
  assert.equal(r.removed, 1);
  assert.deepEqual(store.queryRuns().map((x) => x.id), [R1.id]);
  assert.equal(store.trend({ task: "lookup", client: "openai:m" }).length, 0);
});

test("compaction strips bulky text from old runs only when applied, and keeps the scalars indexed", () => {
  const old = run("20260701T000000-cccc", "2026-07-01T00:00:00.000Z", [row("health", "harness", "openai:m", true, 1), row("health", "harness", "openai:m", true, 2)]);
  saveRun(old);
  const p = join(dir, "runs", `${old.id}.json`);
  const before = statSync(p).size;
  const dry = store.compactRuns({ olderThanDays: 30, apply: false, now: Date.parse("2026-09-06T00:00:00Z") });
  assert.deepEqual(dry.files.map((f) => f.id), [old.id], "R1 (Sep 1) is younger than 30 days at Sep 6");
  assert.equal(statSync(p).size, before, "dry run writes nothing");
  const applied = store.compactRuns({ olderThanDays: 30, apply: true, now: Date.parse("2026-09-06T00:00:00Z") });
  assert.equal(applied.files[0].applied, true);
  assert.ok(statSync(p).size < before / 2, "the file shrank");
  const back = JSON.parse(readFileSync(p, "utf8"));
  assert.ok(back.compacted);
  assert.equal(back.rows[0].prompt, null);
  assert.equal(back.rows[0].toolResults[0].content, null);
  assert.equal(back.rows[0].correct, true, "scalars survive");
  assert.equal(store.cellHistory({ task: "health", client: "openai:m" }).trials, 4, "still indexed after compaction (R1 + old; R2 was removed above)");
  assert.ok(store.queryRuns({ q: "cccc" })[0].compacted, "the index records the compaction");
  assert.deepEqual(store.compactRuns({ olderThanDays: 30, apply: false, now: Date.parse("2026-09-06T00:00:00Z") }).files, [], "not compacted twice");
});
