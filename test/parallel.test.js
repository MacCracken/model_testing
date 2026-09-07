import { test } from "node:test";
import assert from "node:assert/strict";
import { runMatrix } from "../src/runner.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCHEMA = { type: "object", properties: { ok: { type: "string" } }, required: ["ok"] };
const NOOP = { name: "noop", impl: async () => "ok" };
const task = {
  name: "probe",
  noHarness: { prompt: "hi" },
  harness: { system: "s", prompt: "p", tools: [NOOP], schema: SCHEMA },
  eval: {
    ground: async () => ({ ok: "ok" }),
    scoreHarness: (o) => ({ correct: o?.ok === "ok", reason: "structured" }),
    scoreNoHarness: (o) => ({ correct: String(o).trim() === "ok", reason: "free" }),
  },
};

// A client that reports how many trials are in flight when each of its calls begins. `arm` marks
// it as a real-harness arm (structuredOnly), which must never share the wire with anything.
function makeClient(name, gauge, { delay = 15, arm = false } = {}) {
  const enter = () => {
    gauge.now++;
    gauge.max = Math.max(gauge.max, gauge.now);
    if (arm) { if (gauge.now > 1) gauge.violations++; gauge.armIn++; } else if (gauge.armIn > 0) gauge.violations++;
  };
  const leave = () => { gauge.now--; if (arm) gauge.armIn--; };
  const body = async (make) => { enter(); await sleep(delay); leave(); return make(); };
  return {
    name, model: name, structuredOnly: arm || undefined,
    chat: () => body(() => ({ text: "ok", toolCalls: [], finishReason: "stop", usage: null })),
    runWithTools: () => body(() => ({ text: '{"ok":"ok"}', structured: { ok: "ok" }, toolCalls: [], toolResults: [], rounds: 1, finishReason: "stop", usage: null })),
  };
}
const gaugeOf = () => ({ now: 0, max: 0, armIn: 0, violations: 0 });

test("parallel runs up to N trials at once and still delivers every row and event", async () => {
  const gauge = gaugeOf();
  const events = [];
  const { rows, summary } = await runMatrix({ tasks: [task], modes: ["noHarness", "harness"], clients: [makeClient("m", gauge)], count: 6, parallel: 3, onEvent: (e) => events.push(e) });
  assert.equal(rows.length, 12);
  assert.equal(gauge.max, 3, "three trials were in flight at the peak");
  assert.ok(rows.every((r) => r.correct));
  assert.equal(events[0].type, "start");
  assert.equal(events[0].parallel, 3);
  assert.equal(events.filter((e) => e.type === "trial-start").length, 12);
  const completed = events.filter((e) => e.type === "trial").map((e) => e.completed);
  assert.deepEqual(completed, [...Array(12).keys()].map((i) => i + 1), "completed counts are monotonic");
  assert.equal(events.at(-1).type, "done");
  assert.equal(summary.runs, 12);
  // Every planned (mode, index) pair is present exactly once, whatever order it finished in.
  const keys = rows.map((r) => `${r.mode}#${r.index}`).sort();
  assert.deepEqual(keys, ["noHarness", "harness"].flatMap((m) => [1, 2, 3, 4, 5, 6].map((i) => `${m}#${i}`)).sort());
});

test("the default is serial, and rows arrive in plan order", async () => {
  const gauge = gaugeOf();
  const { rows } = await runMatrix({ tasks: [task], modes: ["noHarness", "harness"], clients: [makeClient("m", gauge)], count: 3 });
  assert.equal(gauge.max, 1);
  assert.deepEqual(rows.map((r) => `${r.mode}#${r.index}`), ["noHarness#1", "noHarness#2", "noHarness#3", "harness#1", "harness#2", "harness#3"]);
});

test("a real-harness arm always runs alone, even with parallel > 1", async () => {
  const gauge = gaugeOf();
  const clients = [makeClient("model", gauge), makeClient("arm", gauge, { arm: true })];
  const { rows } = await runMatrix({ tasks: [task], modes: ["noHarness", "harness"], clients, count: 3, parallel: 4 });
  // model: 3 free-form + 3 harness; arm: harness only (structuredOnly skips free-form modes).
  assert.equal(rows.length, 9);
  assert.equal(rows.filter((r) => r.client === "arm").length, 3);
  assert.equal(gauge.violations, 0, "no trial overlapped an arm trial");
  assert.ok(gauge.max >= 2, "the synthetic client's trials did overlap each other");
});

test("cancelling mid-run stops launching new trials", async () => {
  const gauge = gaugeOf();
  const controller = new AbortController();
  let starts = 0;
  const { rows } = await runMatrix({
    tasks: [task], modes: ["noHarness"], clients: [makeClient("m", gauge, { delay: 30 })], count: 8, parallel: 2,
    signal: controller.signal,
    onEvent: (e) => { if (e.type === "trial-start" && ++starts === 2) controller.abort(); },
  });
  assert.ok(rows.length <= 2, `only the trials already in flight finish (got ${rows.length})`);
});
