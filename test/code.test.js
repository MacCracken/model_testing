// The code family: the sandbox's verdicts, the instance generator, the answer readers, the scorers
// and the tool-use verdict — no model, only child Node processes under the permission model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInSandbox, codeIn, describeSandbox } from "../src/sandbox.js";
import { generate, KINDS, LEVELS, codeTasks, codeOf, runTestsTool } from "../src/tasks/code.js";
import { tasks, listTasks } from "../src/tasks/registry.js";

const tests = [{ args: [[1, 2, 3]], expected: 6 }, { args: [[]], expected: 0 }];
const sum = (code, opts = {}) => runInSandbox({ code, name: "sum", tests, ...opts });

test("the sandbox passes a right function in the declaration, ESM, CommonJS and arrow forms", async () => {
  for (const code of ["function sum(xs) { return xs.reduce((a, b) => a + b, 0); }", "export function sum(xs) { return xs.reduce((a, b) => a + b, 0); }", "const f = (xs) => xs.reduce((a, b) => a + b, 0); module.exports = { sum: f };", "const sum = (xs) => xs.reduce((a, b) => a + b, 0);"]) {
    const r = await sum(code);
    assert.equal(r.ok, true, code);
    assert.equal(r.passed, 2);
    assert.equal(r.error, null);
  }
});

test("the sandbox reports a wrong answer with the failing case, and a thrown error as the failure", async () => {
  const r = await sum("function sum(xs) { return xs.length; }");
  assert.equal(r.ok, false);
  assert.equal(r.passed, 1);
  assert.deepEqual(r.failures[0], { i: 0, args: [[1, 2, 3]], expected: 6, got: 3 });
  assert.match(describeSandbox(r), /failed 1\/2 tests \(e\.g\. \[\[1,2,3\]\] → expected 6, got 3\)/);
  const t = await sum("function sum(xs) { throw new Error('boom'); }");
  assert.equal(t.failures[0].error, "boom");
});

test("the sandbox names a syntax error, a missing function, a timeout and an exhausted heap", async () => {
  assert.match((await sum("function sum(xs {")).error, /^syntax error/);
  assert.equal((await sum("function total(xs) { return 0; }")).error, "the code defines no function named sum");
  const loop = await sum("function sum(xs) { while (true) {} }", { timeoutMs: 500 });
  assert.equal(loop.timedOut, true);
  assert.match(loop.error, /timed out after 500 ms/);
  const oom = await sum("function sum(xs) { const a = []; while (true) a.push(new Array(1e6).fill(1)); }", { memoryMb: 64, timeoutMs: 10000 });
  assert.match(oom.error, /ran out of memory \(limit 64 MB\)/);
  assert.equal((await runInSandbox({ code: "", name: "sum", tests })).error, "no code");
});

test("the sandbox gives the candidate no way out: no require, no process, and nothing of the host's realm", async () => {
  const a = await sum("function sum(xs) { return require('fs').readFileSync('/etc/hosts').length; }");
  assert.match(a.failures[0].error, /require is not defined/);
  const b = await sum("function sum(xs) { return typeof process; }");
  assert.equal(b.failures[0].got, "undefined");
  // the classic climbs from an object's constructor reach the candidate's own realm, not the host's
  for (const code of ["function sum(xs) { return xs.constructor.constructor('return typeof process')(); }", "function sum(xs) { return Math.constructor.constructor('return typeof process')(); }", "function sum(xs) { return console.log.constructor('return typeof process')(); }"]) {
    const r = await sum(code);
    assert.equal(r.failures[0].got, "undefined", code);
  }
  // a fresh copy of the arguments for every test: mutation cannot leak between cases
  const m = await runInSandbox({ code: "function sum(xs) { xs.push(1); return xs.length; }", name: "sum", tests: [{ args: [[]], expected: 1 }, { args: [[]], expected: 1 }] });
  assert.equal(m.ok, true);
});

test("codeIn reads a tagged fence first, then any fence, then bare code that defines the function", () => {
  assert.equal(codeIn("Here:\n```js\nfunction f() {}\n```\nand\n```\nnot this\n```"), "function f() {}");
  assert.equal(codeIn("```\nfunction f() {}\n```"), "function f() {}");
  assert.equal(codeIn("```javascript\nconst f = () => 1;\n```"), "const f = () => 1;");
  assert.equal(codeIn("function f() { return 1; }", "f"), "function f() { return 1; }");
  assert.equal(codeIn("const f = () => 1;", "f"), "const f = () => 1;");
  assert.equal(codeIn("I would write a function.", "f"), null);
  assert.equal(codeOf({ code: "```js\nfunction f() {}\n```" }, "f"), "function f() {}");
  assert.equal(codeOf({ code: "function f() {}" }, "f"), "function f() {}");
  assert.equal(codeOf({ work: [] }, "f"), null);
  assert.equal(codeOf("text", "f"), null);
});

test("the generator is deterministic per seed, draws every kind at its level, and its references pass their own hidden tests", async () => {
  assert.deepEqual(generate(11, 2), generate(11, 2));
  assert.notDeepEqual(generate(11, 2).params, generate(12, 2).params === undefined ? null : generate(19, 2).params);
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    for (const level of LEVELS) {
      const g = generate(seed, level);
      seen.add(g.name);
      assert.equal(g.level, level);
      assert.equal(g.visible.length, 3, "three examples");
      assert.ok(g.hidden.length >= 11, "eight random cases plus the edges");
      assert.match(g.spec, new RegExp(`^Write a JavaScript function \`${g.name}\\(`));
      assert.ok(g.examples.every((e) => e.startsWith(`${g.name}(`) && e.includes(" → ")));
      assert.equal(KINDS.find((k) => k.name === g.name).level, level);
      if (seed <= 6) {
        const r = await runInSandbox({ code: g.ref, name: g.name, tests: g.hidden });
        assert.equal(r.ok, true, `${g.name} seed ${seed}: ${JSON.stringify(r).slice(0, 300)}`);
      }
    }
  }
  assert.equal(seen.size, KINDS.length, "every kind is drawn within forty seeds");
});

test("the scorers run the hidden tests: the reference passes, a near miss fails with the case named, no code is no answer", async () => {
  const task = codeTasks[1];
  const ctx = generate(3, 2);
  const ground = task.eval.ground({ ctx });
  assert.equal(ground.name, ctx.name);
  const right = await task.eval.scoreNoHarness(`Sure:\n\`\`\`js\n${ctx.ref}\n\`\`\``, ground);
  assert.equal(right.correct, true, right.reason);
  assert.match(right.reason, /passed \d+\/\d+ hidden tests/);
  const structured = await task.eval.scoreHarness({ work: ["…"], code: ctx.ref }, ground);
  assert.equal(structured.correct, true);
  const miss = await task.eval.scoreNoHarness(`\`\`\`js\nfunction ${ctx.name}() { return []; }\n\`\`\``, ground);
  assert.equal(miss.correct, false);
  assert.match(miss.reason, /failed \d+\/\d+ hidden tests \(e\.g\./);
  assert.deepEqual(await task.eval.scoreNoHarness("I cannot write code.", ground), { correct: false, reason: "no code in the answer" });
  assert.equal((await task.eval.scoreHarness(null, ground)).reason, "no structured output");
});

test("run_tests runs the examples only and reports the failures; the verdict wants it called", async () => {
  const ctx = generate(5, 1);
  const tool = runTestsTool(ctx);
  assert.equal(tool.name, "run_tests");
  const ok = await tool.impl({ code: ctx.ref });
  assert.equal(ok.passed, ctx.visible.length);
  assert.equal(ok.total, ctx.visible.length);
  assert.match(ok.summary, /passed 3\/3 example tests/);
  const bad = await tool.impl({ code: `\`\`\`js\nfunction ${ctx.name}() { return -1; }\n\`\`\`` });
  assert.ok(bad.failures.length >= 1);
  assert.equal(bad.total, 3);
  assert.ok(runTestsTool({}).description.includes("example"), "the tool can be named with no context (the registry lists tools that way)");
  const task = codeTasks[0];
  assert.equal(task.eval.toolUse({ toolCalls: [], toolResults: [] }).ok, false);
  const v = task.eval.toolUse({ toolCalls: [{ name: "run_tests", arguments: { code: "x" } }], toolResults: [{ name: "run_tests", ok: true, result: { passed: 3, total: 3 } }] });
  assert.equal(v.ok, true);
  assert.match(v.reason, /passed them all/);
  const w = task.eval.toolUse({ toolCalls: [{ name: "run_tests", arguments: { code: "x" } }], toolResults: [{ name: "run_tests", ok: true, result: { passed: 1, total: 3 } }] });
  assert.match(w.reason, /did not pass \(1\/3\)/);
});

test("code1/2/3 are registered with the four modes, the family knob and the code capability", () => {
  const listed = listTasks().filter((t) => t.family === "code");
  assert.deepEqual(listed.map((t) => t.name), ["code1", "code2", "code3"]);
  assert.deepEqual(listed.map((t) => t.level), [1, 2, 3]);
  for (const t of listed) {
    assert.deepEqual(t.modes, ["noHarness", "harness", "schemaOnly", "toolOnly"]);
    assert.deepEqual(t.capabilities, ["code"]);
    assert.deepEqual(t.tools, ["run_tests"]);
    assert.equal(t.generated, true);
    assert.equal(t.skill, "code");
  }
  assert.ok(tasks.find((t) => t.name === "code3").harness.schema.properties.work, "the working field comes before the code");
});
