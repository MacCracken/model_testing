// A run's holes — the rows that errored and the trials that never started — the fill that runs
// exactly those again on the same seeds, and coverage over indexed rows. No model, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMatrix, planMatrix, trialKey } from "../src/runner.js";
import { holesOf, describeHoles, describeFill, coverage, coverageTable, FILLABLE } from "../src/holes.js";
import { parseArgs } from "../src/args.js";

const task = (name) => ({
  name, seeded: true,
  setup: async ({ seed }) => ({ seed }),
  noHarness: { prompt: (ctx) => `seed ${ctx.seed}` },
  eval: { ground: "ok", scoreNoHarness: (o) => ({ correct: String(o).trim() === "ok", reason: "free" }) },
});
const client = (name, up = () => true) => ({
  name, model: name, calls: 0,
  async chat() { this.calls++; if (!up(this.calls)) throw new Error(`${name}: fetch failed — is http://h reachable?`); return { text: "ok", toolCalls: [], finishReason: "stop", usage: null }; },
});
const saved = (rows, config) => ({ id: "20260919T000000-aaaa", status: "done", config, rows });

test("the holes of a run: error rows worth running again and planned trials with no row; a scored row or a refusal is not one", async () => {
  const tasks = [task("a"), task("b")];
  const c = client("local:m");
  const cells = planMatrix({ tasks, modes: ["noHarness"], clients: [c], count: 3 }).cells;
  const row = (t, index, extra = {}) => ({ task: t, mode: "noHarness", client: "local:m", index, correct: true, error: null, ...extra });
  const run = saved([
    row("a", 1), row("a", 2, { correct: false }), // scored, right or wrong: not holes
    row("a", 3, { correct: false, error: "local:m: fetch failed — is http://h reachable?", errorKind: "transport" }),
    row("b", 1, { correct: false, error: "request timed out" }), // an older row: the kind is read from the message
    row("b", 2, { correct: false, error: "HTTP 400 from local:m: reasoning_effort is not supported", errorKind: "request" }),
    // b#3 never started (a time box)
  ], { tasks: ["a", "b"], modes: ["noHarness"], clients: ["local:m"], count: 3 });
  const holes = holesOf(run, { cells });
  assert.deepEqual(holes.map((h) => [h.task, h.index, h.why]), [["a", 3, "transport"], ["b", 1, "timeout"], ["b", 3, "not run"]]);
  assert.equal(holes[0].key, trialKey({ task: "a", mode: "noHarness", client: "local:m", index: 3 }));
  assert.equal(describeHoles(holes), "1 transport, 1 timeout, 1 not run");
  assert.equal(describeHoles([]), "none");
  assert.ok(!FILLABLE.includes("request"), "a refusal would only repeat");
  assert.deepEqual(holesOf(run, { cells, kinds: ["transport"] }).map((h) => h.why), ["transport", "not run"]);
  // A trial with both an error row and a scored row (a retry inside one file) is answered.
  const twice = saved([row("a", 1, { correct: false, error: "fetch failed" }), row("a", 1)], { count: 1 });
  assert.deepEqual(holesOf(twice, { cells: cells.slice(0, 1), count: 1 }), []);
  // A run that was itself a fill was only ever asked for its `only` list.
  const fill = saved([row("a", 3, { correct: false, error: "fetch failed" })], { count: 3, only: [trialKey({ task: "a", mode: "noHarness", client: "local:m", index: 3 }), trialKey({ task: "b", mode: "noHarness", client: "local:m", index: 3 })] });
  assert.deepEqual(holesOf(fill, { cells }).map((h) => `${h.task}#${h.index}:${h.why}`), ["a#3:transport", "b#3:not run"]);
});

test("a fill runs exactly the holes, on the seeds the first run gave those trials", async () => {
  const tasks = [task("a"), task("b")];
  // The endpoint dies after four trials (breadth first: a#1 b#1 a#2 b#2), so a#3, b#3 fail in transport.
  const first = await runMatrix({ tasks, modes: ["noHarness"], clients: [client("local:m", (n) => n <= 4)], count: 3, instanceSeed: 7 });
  assert.deepEqual(first.rows.filter((r) => r.error).map((r) => `${r.task}#${r.index}`), ["a#3", "b#3"]);
  const run = saved(first.rows, { tasks: ["a", "b"], modes: ["noHarness"], clients: ["local:m"], count: 3, instanceSeed: 7 });
  const c = client("local:m");
  const cells = planMatrix({ tasks, modes: ["noHarness"], clients: [c], count: 3 }).cells;
  const holes = holesOf(run, { cells });
  const events = [];
  const second = await runMatrix({ tasks, modes: ["noHarness"], clients: [c], count: 3, instanceSeed: 7, only: holes.map((h) => h.key), onEvent: (e) => events.push(e) });
  assert.equal(c.calls, 2, "two requests, not six");
  assert.equal(events[0].total, 2, "the plan announces what will run");
  assert.deepEqual(second.rows.map((r) => `${r.task}#${r.index}`), ["a#3", "b#3"]);
  const seedOf = (rows, key) => rows.find((r) => `${r.task}#${r.index}` === key).seed;
  for (const key of ["a#3", "b#3"]) assert.equal(seedOf(second.rows, key), seedOf(first.rows, key), `${key} is the same instance`);
  assert.match(second.rows[0].prompt, new RegExp(`seed ${seedOf(first.rows, "a#3")}$`));
  const filled = { id: "20260919T000001-bbbb", rows: second.rows };
  assert.equal(describeFill(run, filled, holes), "fill of 20260919T000000-aaaa: 2 of 2 hole(s) now have a scored row (2 right)");
  assert.match(describeFill(run, { id: "x", rows: second.rows.slice(0, 1) }, holes), /1 of 2 hole\(s\) now have a scored row \(1 right\); 1 still open — run the same command on x/);
  // An `only` that names nothing runs nothing.
  const none = await runMatrix({ tasks, modes: ["noHarness"], clients: [client("local:m")], count: 3, only: [] });
  assert.equal(none.rows.length, 0);
});

test("coverage over indexed rows: scored and right per cell, error rows by kind, and the table marks what is short, lost or never run", () => {
  const r = (task, client, correct, error = null, error_kind = null) => ({ run_id: "r1", task, mode: "harness", client, correct: correct ? 1 : 0, error, error_kind });
  const rows = [
    r("code1", "local:a", 1), r("code1", "local:a", 1), r("code1", "local:a", 0), r("code1", "local:a", 1),
    r("code1", "local:b", 0, "local:b: fetch failed — is http://h reachable?"), r("code1", "local:b", 0, "request timed out", "timeout"),
    r("code2", "local:a", 1), r("code2", "local:a", 0, "fetch failed", "transport"),
  ];
  const cells = coverage(rows, { min: 4 });
  const at = (task, c) => cells.find((x) => x.task === task && x.client === c);
  assert.deepEqual([at("code1", "local:a").scored, at("code1", "local:a").correct, at("code1", "local:a").short], [4, 3, false]);
  assert.deepEqual(at("code1", "local:b").lost, { transport: 1, timeout: 1 }, "an old row's kind is read from its message");
  assert.equal(at("code1", "local:b").short, true);
  assert.deepEqual([at("code2", "local:a").scored, at("code2", "local:a").lostTotal, at("code2", "local:a").short], [1, 1, true]);
  const table = coverageTable(cells, { tasks: ["code1", "code2", "code3"], clients: ["local:a", "local:b"], mode: "harness", min: 4 });
  const line = (name) => table.split("\n").find((l) => l.startsWith(name));
  assert.match(line("code1"), /3\/4\s+lost 2$/);
  assert.match(line("code2"), /1\/1 \+1 !\s+·$/);
  assert.equal(line("code3"), undefined, "a task nobody ran is left out of the table");
});

test("--holes and its alias --errors, the preflight switch and the waits parse", () => {
  assert.equal(parseArgs(["--replay", "r1", "--holes"]).holes, true);
  assert.equal(parseArgs(["--replay", "r1", "--errors"]).holes, true);
  assert.equal(parseArgs(["--no-preflight"]).noPreflight, true);
  assert.deepEqual(parseArgs(["--endpoint-waits", "5, 30,120"]).endpointWaits, [5, 30, 120]);
  assert.deepEqual([parseArgs(["--min", "8", "--fill"]).min, parseArgs(["--min", "8", "--fill"]).fill], [8, true]);
});

test("a hole another run has since scored is closed: the same task, mode, client, trial seed and model knobs", async () => {
  const { stillOpen } = await import("../src/holes.js");
  const { seedFor } = await import("../src/tasks/gen.js");
  const keyOf = ({ task, mode, client, seed, modelParams }) => `${task}|${mode}|${client}|${seed}|${JSON.stringify(modelParams ?? {})}`;
  const run = { config: { instanceSeed: 7, modelParams: { effort: "none" } }, rows: [{ task: "a", mode: "noHarness", client: "local:m", index: 3, seed: 111, error: "fetch failed" }] };
  const holes = [
    { task: "a", mode: "noHarness", client: "local:m", index: 3, key: trialKey({ task: "a", mode: "noHarness", client: "local:m", index: 3 }), why: "transport" },
    { task: "b", mode: "noHarness", client: "local:m", index: 2, key: trialKey({ task: "b", mode: "noHarness", client: "local:m", index: 2 }), why: "not run" },
  ];
  assert.deepEqual(stillOpen(holes, run, new Set(), keyOf), holes, "nothing scored, nothing closed");
  // a#3 was scored elsewhere on its recorded seed; b#2 never started, so its seed comes from the run's.
  const scoredA = new Set([keyOf({ task: "a", mode: "noHarness", client: "local:m", seed: 111, modelParams: { effort: "none" } })]);
  assert.deepEqual(stillOpen(holes, run, scoredA, keyOf).map((h) => h.task), ["b"]);
  const scoredB = new Set([keyOf({ task: "b", mode: "noHarness", client: "local:m", seed: seedFor(7, "b", 2), modelParams: { effort: "none" } })]);
  assert.deepEqual(stillOpen(holes, run, scoredB, keyOf).map((h) => h.task), ["a"]);
  // The same instance under other knobs (thinking on) is another measurement: it closes nothing.
  const otherKnobs = new Set([keyOf({ task: "a", mode: "noHarness", client: "local:m", seed: 111, modelParams: {} })]);
  assert.equal(stillOpen(holes, run, otherKnobs, keyOf).length, 2);
});
