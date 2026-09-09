import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGate, normalizeGate, parseGateFile, gatesFromArgs, evaluateGates, combineVerdicts, describeGates, gateRun, describeRunGates, gateNames } from "../src/gates.js";
import { suiteArgs, SUITES } from "../src/suites.js";
import { runMatrix } from "../src/runner.js";
import { tasks } from "../src/tasks/registry.js";

const names = { tasks: ["health", "restock6"], capabilities: ["tool-use", "arithmetic"], families: ["restock", "wordmath"] };

test("parseGate reads the grammar and resolves the subject: capability, task, family level, breaking point, overall, counts", () => {
  assert.deepEqual(parseGate("tool-use>=80", names), { kind: "capability", subject: "tool-use", level: null, mode: "harness", op: ">=", value: 80, label: "tool-use@harness >= 80%" });
  assert.equal(parseGate("tool-use @ toolOnly >= 75 %", names).mode, "toolOnly");
  assert.equal(parseGate("health>=100", names).kind, "task");
  assert.deepEqual(parseGate("restock:6 >= 50", names), { kind: "family", subject: "restock", level: 6, mode: "harness", op: ">=", value: 50, label: "restock:6@harness >= 50%" });
  assert.deepEqual(parseGate("break:restock>=12", names), { kind: "break", subject: "restock", level: null, mode: "harness", op: ">=", value: 12, label: "break:restock@harness >= 12" });
  assert.equal(parseGate("overall@noHarness>=40", names).kind, "overall");
  assert.deepEqual(parseGate("errors<=0", names), { kind: "errors", subject: "errors", level: null, mode: null, op: "<=", value: 0, label: "errors <= 0" });
  assert.equal(parseGate("errors@harness=0", names).mode, "harness", "= reads as the count's <=");
  assert.equal(parseGate("regressions<=0", names).kind, "regressions");
  assert.equal(parseGate("anything>=1").kind, "capability", "with no names to check against, a bare word is a capability");
  assert.throws(() => parseGate("nope>=1", names), /unknown gate subject "nope"/);
  assert.throws(() => parseGate("tally:20>=1", names), /unknown family "tally"/);
  assert.throws(() => parseGate("tool-use>80", names), /inclusive/);
  assert.throws(() => parseGate("tool-use<=80", names), /rate to reach/);
  assert.throws(() => parseGate("errors>=1", names), /count to stay under/);
  assert.throws(() => parseGate("tool-use@nomode>=1", names), /unknown mode/);
  assert.throws(() => parseGate("tool-use", names), /cannot read gate/);
});

test("a gate file takes objects or strings, a default mode and minTrials; the command line adds to it", () => {
  const file = parseGateFile(JSON.stringify({ name: "n", minTrials: 4, mode: "toolOnly", strict: true, gates: [
    { capability: "tool-use", min: 80 }, { task: "health", min: 100, mode: "harness" }, { family: "restock", level: 6, min: 50 },
    { family: "restock", noBreakBelow: 12 }, { overall: true, min: 70 }, { errors: 0 }, { regressions: { max: 1 } }, "arithmetic >= 75",
  ] }), names);
  assert.equal(file.name, "n"); assert.equal(file.minTrials, 4); assert.equal(file.strict, true);
  assert.deepEqual(file.gates.map((g) => g.label), ["tool-use@toolOnly >= 80%", "health@harness >= 100%", "restock:6@toolOnly >= 50%", "break:restock@toolOnly >= 12", "overall@toolOnly >= 70%", "errors <= 0", "regressions <= 1", "arithmetic@toolOnly >= 75%"]);
  assert.deepEqual(parseGateFile("[\"tool-use>=1\"]", names).gates.map((g) => g.label), ["tool-use@harness >= 1%"], "a bare array works too");
  assert.throws(() => parseGateFile("{", names), /not JSON/);
  assert.throws(() => parseGateFile("{}", names), /"gates" array/);
  assert.throws(() => normalizeGate({ capability: "tool-use" }, names), /needs "min"/);
  assert.throws(() => normalizeGate({ potato: 1 }, names), /cannot read gate/);
  const fromArgs = gatesFromArgs({ gate: ["overall>=70", "errors<=0"], strict: false, minTrials: 2 }, names);
  assert.deepEqual(fromArgs.gates.map((g) => g.label), ["overall@harness >= 70%", "errors <= 0"]);
  assert.equal(fromArgs.minTrials, 2); assert.equal(fromArgs.file, null);
  assert.equal(gatesFromArgs({ gate: ["overall>=70"] }, names, { fallbackMinTrials: 4 }).minTrials, 4, "the run's trials per cell is the floor when nothing says otherwise");
  assert.equal(gatesFromArgs({ gate: ["overall>=70"] }, names).minTrials, 1);
  assert.equal(parseGateFile("[\"tool-use>=1\"]", names).minTrials, null, "a file without minTrials leaves the floor to the run");
  assert.throws(() => gatesFromArgs({ gates: "/no/such/file.json" }, names), /cannot read gate file/);
  const real = gateNames(tasks);
  assert.ok(real.capabilities.includes("tool-use") && real.tasks.includes("restock6") && real.families.includes("restock"));
  const nightly = gatesFromArgs({ gates: new URL("../gates/nightly.json", import.meta.url).pathname }, real);
  assert.equal(nightly.name, "nightly"); assert.equal(nightly.minTrials, 4); assert.ok(nightly.gates.length >= 10);
});

const capabilitiesOf = { health: ["tool-use"], wordmath4: ["arithmetic"], restock3: ["multi-step"], restock6: ["multi-step"], restock12: ["multi-step"] };
const levelsOf = { restock3: { family: "restock", level: 3 }, restock6: { family: "restock", level: 6 }, restock12: { family: "restock", level: 12 } };
const row = (task, correct, i, over = {}) => ({ task, mode: "harness", client: "c", index: i, correct, error: null, reason: correct ? "ok" : "no", ...over });
const many = (task, n, k, over) => Array.from({ length: n }, (_, i) => row(task, i < k, i + 1, over));

test("evaluateGates: pass on the rate, fail when the band tops out under the bar, inconclusive in between, incomplete below minTrials", () => {
  const rows = [...many("health", 16, 14), ...many("wordmath4", 16, 9), ...many("restock6", 8, 5), ...many("restock3", 4, 4), ...many("restock12", 4, 0)];
  const g = (s) => parseGate(s, { tasks: Object.keys(capabilitiesOf), capabilities: ["tool-use", "arithmetic", "multi-step"], families: ["restock"] });
  const r = evaluateGates([g("tool-use>=80"), g("arithmetic>=90"), g("multi-step>=75"), g("health>=100"), g("restock:6>=50"), g("restock:12>=50"), g("break:restock>=12"), g("break:restock>=30"), g("overall>=50"), g("errors<=0")], { rows, capabilitiesOf, levelsOf, minTrials: 4 });
  const by = Object.fromEntries(r.results.map((x) => [x.label, x]));
  assert.equal(by["tool-use@harness >= 80%"].verdict, "pass");
  assert.equal(by["tool-use@harness >= 80%"].pct, 87.5);
  assert.equal(by["arithmetic@harness >= 90%"].verdict, "fail", "9/16 has a band that tops out well under 90");
  assert.match(by["arithmetic@harness >= 90%"].reason, /tops out under 90%/);
  assert.equal(by["multi-step@harness >= 75%"].verdict, "inconclusive", "9/16 against 75: the band reaches the bar");
  assert.equal(by["health@harness >= 100%"].verdict, "fail", "14/16 cannot be 100%");
  assert.equal(by["restock:6@harness >= 50%"].verdict, "pass");
  assert.equal(by["restock:12@harness >= 50%"].verdict, "fail", "0/4 has a band under 50");
  assert.equal(by["break:restock@harness >= 12"].verdict, "pass", "it breaks at 12, not below");
  assert.match(by["break:restock@harness >= 12"].reason, /breaks at 12/);
  assert.equal(by["break:restock@harness >= 30"].verdict, "fail");
  assert.equal(by["overall@harness >= 50%"].verdict, "pass");
  assert.equal(by["errors <= 0"].verdict, "pass");
  assert.equal(r.verdict, "fail"); assert.equal(r.exitCode, 1);
  assert.deepEqual(r.counts, { pass: 5, fail: 4, inconclusive: 1, incomplete: 0 });

  // Too few trials: incomplete, exit 2; error rows leave the rates and feed the errors gate; cancelled rows count for nothing.
  const thin = evaluateGates([g("tool-use>=80"), g("errors<=0")], { rows: [...many("health", 2, 2), row("health", false, 3, { error: "HTTP 500", reason: "exception" }), row("health", false, 4, { error: "cancelled before completing", reason: "cancelled" })], capabilitiesOf, levelsOf, minTrials: 4 });
  assert.equal(thin.results[0].verdict, "incomplete"); assert.match(thin.results[0].reason, /2 trial\(s\), the gate needs 4/);
  assert.equal(thin.results[1].verdict, "fail"); assert.match(thin.results[1].reason, /1 error row\(s\) of 3/);
  assert.equal(thin.trials, 3); assert.equal(thin.cancelled, 1);
  assert.equal(thin.verdict, "fail", "a failure outranks an incomplete gate");
  assert.equal(evaluateGates([g("tool-use>=80")], { rows: [], capabilitiesOf, levelsOf }).exitCode, 2);
  // Strict: inconclusive becomes a failure at the top level only.
  const strict = evaluateGates([g("multi-step>=75")], { rows, capabilitiesOf, levelsOf, minTrials: 4, strict: true });
  assert.equal(strict.results[0].verdict, "inconclusive"); assert.equal(strict.verdict, "fail"); assert.equal(strict.exitCode, 1);
  assert.match(describeGates(strict, { client: "c" }), /gates for c: FAIL \(strict: inconclusive counts as a failure\)/);
  // The regressions gate reads the count it is handed, and is incomplete without one.
  assert.equal(evaluateGates([g("regressions<=0")], { rows, regressions: { flags: 2, compared: 6, detail: "tool-use@harness 90%→60%" } }).results[0].verdict, "fail");
  assert.equal(evaluateGates([g("regressions<=0")], { rows, regressions: { flags: 0, compared: 3 } }).verdict, "pass");
  assert.equal(evaluateGates([g("regressions<=0")], { rows }).verdict, "incomplete");
  // Modes are honoured: a noHarness gate sees only noHarness rows.
  const modes = evaluateGates([g("overall@noHarness>=50")], { rows: [...many("health", 4, 4), ...many("health", 4, 0, { mode: "noHarness" })], capabilitiesOf, levelsOf, minTrials: 4 });
  assert.equal(modes.results[0].verdict, "fail");
  assert.deepEqual(combineVerdicts(["pass", "inconclusive"]), { verdict: "inconclusive", exitCode: 0 });
  assert.deepEqual(combineVerdicts(["incomplete", "inconclusive"]), { verdict: "incomplete", exitCode: 2 });
  assert.deepEqual(combineVerdicts([]), { verdict: "pass", exitCode: 0 });
});

test("describeGates and gateRun: one block per client, marks per verdict, the run's verdict is the worst client's", async () => {
  const rows = [...many("health", 8, 8), ...many("health", 8, 2, { client: "d" })];
  const g = [parseGate("tool-use>=80"), parseGate("regressions<=0")];
  const run = { config: { clients: ["c", "d"] }, rows };
  const seen = [];
  const res = await gateRun(run, { gates: g, minTrials: 4, capabilitiesOf, levelsOf, regressionsFor: async (client) => { seen.push(client); return client === "c" ? { flags: 0, compared: 2 } : { flags: 1, compared: 2, detail: "tool-use@harness 80%→25%" }; } });
  assert.deepEqual(seen, ["c", "d"]);
  assert.equal(res.byClient.c.verdict, "pass");
  assert.equal(res.byClient.d.verdict, "fail");
  assert.equal(res.verdict, "fail"); assert.equal(res.exitCode, 1);
  assert.deepEqual(res.specs, ["tool-use@harness >= 80%", "regressions <= 0"]);
  const text = describeRunGates(res);
  assert.match(text, /gates for c: PASS — 2 pass, 0 fail, 0 inconclusive, 0 incomplete over 8 trial\(s\)\n  ✓ tool-use@harness >= 80%  8\/8 = 100% \(band/);
  assert.match(text, /gates for d: FAIL[\s\S]*✗ tool-use@harness >= 80%  2\/8 = 25%: the band[\s\S]*✗ regressions <= 0\s+1 flag\(s\) over 2 comparison\(s\) — tool-use@harness 80%→25%/);
  assert.match(text, /verdict: FAIL \(exit 1\)$/);
  const one = await gateRun(run, { gates: [parseGate("tool-use>=80")], clients: ["c"], capabilitiesOf, levelsOf });
  assert.deepEqual(Object.keys(one.byClient), ["c"]);
  assert.equal(one.verdict, "pass");
});

test("the nightly suite carries a time box and the gate file unless the command line gives its own", () => {
  assert.ok(SUITES.nightly);
  const argv = suiteArgs("nightly", ["--clients", "vllm:ckpt"]);
  const at = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(at("--time-box"), String(SUITES.nightly.timeBox));
  assert.match(at("--gates"), /gates[\\/]nightly\.json$/);
  const own = suiteArgs("nightly", ["--clients", "vllm:ckpt", "--time-box", "5", "--gate", "overall>=1"]);
  assert.equal(own.filter((a) => a === "--time-box").length, 1); assert.equal(at.call(null, "--time-box"), String(SUITES.nightly.timeBox));
  assert.equal(own[own.indexOf("--time-box") + 1], "5");
  assert.ok(!own.includes("--gates"), "a --gate on the command line replaces the file");
  assert.ok(!suiteArgs("smoke", []).includes("--time-box"), "the other presets are unchanged");
});

test("a time box aborts the matrix: what completed is returned, the rest is cancelled or never started", async () => {
  const task = { name: "slow", capabilities: ["tool-use"], noHarness: { prompt: "p" }, eval: { ground: 1, scoreNoHarness: () => ({ correct: true, reason: "ok" }) } };
  const client = { name: "c", model: "m", async chat(_m, _t, { signal }) { await new Promise((res, rej) => { const t = setTimeout(res, 40); signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true }); }); return { text: "1", toolCalls: [], finishReason: "stop", usage: null }; } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const r = await runMatrix({ tasks: [task], modes: ["noHarness"], clients: [client], count: 20, parallel: 1, signal: controller.signal });
  clearTimeout(timer);
  const done = r.rows.filter((x) => !x.error);
  assert.ok(done.length >= 1 && done.length < 20, `completed ${done.length} of 20`);
  assert.ok(r.rows.every((x) => !x.error || x.reason === "cancelled"));
  const gated = evaluateGates([parseGate("tool-use>=50")], { rows: r.rows, capabilitiesOf: { slow: ["tool-use"] }, minTrials: 20 });
  assert.equal(gated.verdict, "incomplete"); assert.equal(gated.exitCode, 2);
});
