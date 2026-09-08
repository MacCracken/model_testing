import { test } from "node:test";
import assert from "node:assert/strict";
import { generate as wordmath, wordmathTasks } from "../src/tasks/wordmath.js";
import { generate as datecalc, datecalcTasks, parseDateTime, fmtDate, fmtTime, weekdayOf, tools as dateTools } from "../src/tasks/datecalc.js";
import { generate as logicgrid, logicgridTasks, permutations } from "../src/tasks/logicgrid.js";
import { generate as tally, tallyTasks, runQuery, toolsFor } from "../src/tasks/tally.js";
import { runTrial, runMatrix } from "../src/runner.js";
import { seedFor } from "../src/tasks/gen.js";
import { calc } from "../src/calc.js";

test("wordmath: deterministic, integer truth that the listed operations reproduce", () => {
  for (const steps of [2, 4, 6]) {
    for (let seed = 1; seed <= 40; seed++) {
      const a = wordmath(seed, steps), b = wordmath(seed, steps);
      assert.deepEqual(a, b, "same seed, same problem");
      assert.ok(Number.isInteger(a.answer) && a.answer > 0, `integer answer (seed ${seed})`);
      // Replay the operations the generator recorded and land on the same answer.
      const start = Number(a.story.match(/holds (\d+)/)[1]);
      let v = start;
      for (const op of a.ops) {
        if (op === "÷2") v /= 2;
        else if (op.startsWith("+") && op.includes("×")) { const [x, y] = op.slice(1).split("×").map(Number); v += x * y; }
        else if (op.startsWith("×")) v *= Number(op.slice(1));
        else v += Number(op);
      }
      assert.equal(v, a.answer, `ops replay (seed ${seed}, ${a.ops.join(" ")})`);
      assert.ok(Number.isInteger(v));
    }
  }
  assert.notDeepEqual(wordmath(1, 4).story, wordmath(2, 4).story);
});

test("wordmath: scorers, canon and tool use", () => {
  const t = wordmathTasks[1];
  assert.equal(t.name, "wordmath4");
  assert.deepEqual(t.capabilities, ["arithmetic", "multi-step"]);
  const ground = t.eval.ground({ ctx: { answer: 496 } });
  assert.equal(t.eval.scoreHarness({ answer: 496 }, ground).correct, true);
  assert.equal(t.eval.scoreHarness({ answer: "496" }, ground).correct, true);
  assert.match(t.eval.scoreHarness({ answer: 500 }, ground).reason, /answered 500, expected 496/);
  assert.equal(t.eval.scoreNoHarness("Half of 130 is 65 … answer: 496", ground).correct, true);
  assert.equal(t.eval.scoreNoHarness("I get 495.", ground).correct, false);
  assert.equal(t.eval.canon({ answer: 496 }, { structured: true }), "496");
  assert.equal(t.eval.canon("answer: 496", { structured: false }), "496");
  assert.match(t.eval.toolUse({ toolCalls: [], toolResults: [] }).reason, /never called/);
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "calc", arguments: { expression: "1+1" } }], toolResults: [{ name: "calc", ok: true }] }).ok, true);
  assert.match(t.eval.toolUse({ toolCalls: [{ name: "calc" }], toolResults: [{ name: "calc", ok: false }] }).reason, /did not evaluate/);
  const ctx = wordmath(3, 4);
  assert.match(t.harness.prompt(ctx), /Use calc for each step/);
  assert.match(t.noHarness.prompt(ctx), /answer: <number>/);
  assert.equal(t.harness.tools[0].name, "calc");
  assert.equal(t.schemaOnly.tools.length, 0);
});

test("datecalc: truth matches UTC arithmetic; tools and readers agree with it", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const one = datecalc(seed, 1);
    const m = one.text.match(/on \w+ (\d+) (\w+) (\d{4}) and expires (\d+) days later/);
    assert.ok(m, one.text);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const start = Date.UTC(+m[3], months.indexOf(m[2]), +m[1]);
    const end = start + Number(m[4]) * 86_400_000;
    assert.equal(one.date, fmtDate(end));
    assert.equal(one.weekday, weekdayOf(end));
    const three = datecalc(seed, 3);
    assert.match(three.time, /^\d{2}:\d{2}$/);
    assert.equal(weekdayOf(parseDateTime(`${three.date} ${three.time}`)), three.weekday);
  }
  const add = dateTools.find((t) => t.name === "add_time");
  assert.deepEqual(await add.impl({ datetime: "2024-01-28 15:30", days: 3, hours: 22, minutes: 30 }), { datetime: "2024-02-01 14:00", date: "2024-02-01", time: "14:00", weekday: "Thursday" });
  const between = dateTools.find((t) => t.name === "days_between");
  assert.deepEqual(await between.impl({ from: "2026-01-01", to: "2026-03-01" }), { days: 59 });
  await assert.rejects(() => add.impl({ datetime: "yesterday" }), /expected "YYYY-MM-DD"/);
  const t3 = datecalcTasks[1];
  const ground = t3.eval.ground({ ctx: { date: "2024-02-04", time: "14:00", weekday: "Sunday", wantsTime: true } });
  assert.equal(t3.eval.scoreHarness({ date: "2024-02-04", time: "14:00", weekday: "sunday" }, ground).correct, true);
  assert.match(t3.eval.scoreHarness({ date: "2024-02-04", time: "13:00", weekday: "Sunday" }, ground).reason, /time 13:00 ≠ 14:00/);
  assert.equal(t3.eval.scoreNoHarness("It arrives 2024-02-04 at 14:00, a Sunday. answer: 2024-02-04 14:00 Sunday", ground).correct, true);
  assert.match(t3.eval.scoreNoHarness("2024-02-04 14:00 Saturday", ground).reason, /weekday Saturday ≠ Sunday/);
  const t1 = datecalcTasks[0];
  const g1 = t1.eval.ground({ ctx: { date: "2025-05-01", time: null, weekday: "Thursday", wantsTime: false } });
  assert.equal(t1.eval.scoreHarness({ date: "2025-05-01", weekday: "Thursday" }, g1).correct, true, "no time asked, none needed");
  assert.equal(t1.eval.canon({ date: "2025-05-01", weekday: "Thursday" }, { structured: true }), "2025-05-01 thursday");
});

test("logicgrid: unique by construction, minimal clues, right answer, sensible scorers", () => {
  for (const n of [3, 4]) {
    for (let seed = 1; seed <= 25; seed++) {
      const p = logicgrid(seed, n);
      assert.deepEqual(p, logicgrid(seed, n));
      // Re-derive uniqueness from the clue texts by brute force against every assignment.
      const { names, pet, drink } = p.solution;
      const pets = [...pet].sort(), drinks = [...drink].sort();
      const holds = (a, clue) => {
        let m;
        if ((m = clue.match(/^(\w+) has the (\w+)\.$/))) return a.pet[names.indexOf(m[1])] === m[2];
        if ((m = clue.match(/^(\w+) drinks (\w+)\.$/))) return a.drink[names.indexOf(m[1])] === m[2];
        if ((m = clue.match(/^(\w+) does not have the (\w+)\.$/))) return a.pet[names.indexOf(m[1])] !== m[2];
        if ((m = clue.match(/^(\w+) does not drink (\w+)\.$/))) return a.drink[names.indexOf(m[1])] !== m[2];
        if ((m = clue.match(/^The person with the (\w+) drinks (\w+)\.$/))) return a.drink[a.pet.indexOf(m[1])] === m[2];
        if ((m = clue.match(/^The person with the (\w+) does not drink (\w+)\.$/))) return a.drink[a.pet.indexOf(m[1])] !== m[2];
        throw new Error(`unparsed clue: ${clue}`);
      };
      const all = [];
      for (const pp of permutations(pets)) for (const dd of permutations(drinks)) all.push({ pet: pp, drink: dd });
      const ok = all.filter((a) => p.clues.every((c) => holds(a, c)));
      assert.equal(ok.length, 1, `unique (n=${n}, seed ${seed})`);
      assert.deepEqual(ok[0], { pet, drink });
      for (let i = 0; i < p.clues.length; i++) {
        const rest = p.clues.filter((_, j) => j !== i);
        assert.ok(all.filter((a) => rest.every((c) => holds(a, c))).length > 1, `clue ${i} is needed (n=${n}, seed ${seed})`);
      }
      assert.ok(p.candidates.includes(p.answer));
    }
  }
  const t = logicgridTasks[1];
  const ground = t.eval.ground({ ctx: { answer: "cat", candidates: ["dog", "cat", "fish", "parrot"] } });
  assert.equal(t.eval.scoreHarness({ answer: "Cat" }, ground).correct, true);
  assert.equal(t.eval.scoreNoHarness("Bob cannot have the dog, so … answer: cat", ground).correct, true);
  assert.equal(t.eval.scoreNoHarness("It is the fish.", ground).correct, false);
  assert.equal(t.harness, t.schemaOnly, "no tools: the harness is the structured mode");
  assert.equal(t.toolOnly, undefined);
});

test("tally: truth equals the recorded query; the per-trial tool answers it", async () => {
  for (const n of [20, 60]) {
    for (let seed = 1; seed <= 25; seed++) {
      const p = tally(seed, n);
      assert.equal(p.rows.length, n);
      assert.equal(runQuery(p.rows, p.query).result, p.answer, `query reproduces the answer (n=${n}, seed ${seed})`);
      const [tool] = toolsFor(p);
      assert.equal((await tool.impl(p.query)).result, p.answer);
    }
  }
  assert.throws(() => runQuery([], { aggregate: "median" }), /unknown aggregate/);
  const t = tallyTasks[0];
  const p = tally(9, 20);
  assert.match(t.harness.prompt(p), /id \| region \| status \| amount \| days_open/);
  assert.equal(typeof t.harness.tools, "function");
  assert.equal(t.harness.tools(p)[0].name, "query_rows");
  const ground = t.eval.ground({ ctx: p });
  assert.equal(t.eval.scoreNoHarness(`answer: ${p.answer}`, ground).correct, true);
  const good = t.eval.toolUse({ toolCalls: [{ name: "query_rows", arguments: p.query }], toolResults: [{ name: "query_rows", ok: true }], ctx: p });
  assert.equal(good.ok, true);
  const wrong = t.eval.toolUse({ toolCalls: [{ name: "query_rows", arguments: { aggregate: "count" } }], toolResults: [{ name: "query_rows", ok: true }], ctx: p });
  assert.equal(wrong.ok, p.query.aggregate === "count" && !p.query.region && !p.query.status && p.query.amount_gt === undefined);
});

test("runTrial mints the instance from the seed; runMatrix pairs every mode and client on the same instance", async () => {
  const seen = [];
  const client = {
    name: "local:m", model: "m",
    async chat(messages) { seen.push(messages.at(-1).content); return { text: "answer: 1", toolCalls: [], finishReason: "stop", usage: null }; },
    async runWithTools(prompt) { seen.push(prompt); return { text: '{"answer":1}', structured: { answer: 1 }, toolCalls: [], toolResults: [], rounds: 1, finishReason: "stop", usage: null }; },
  };
  const task = wordmathTasks[0];
  const r = await runTrial({ task, mode: "schemaOnly", client, seed: 123 });
  assert.equal(r.seed, 123);
  assert.equal(r.ctx.story, wordmath(123, 2).story);
  assert.equal(r.ground, wordmath(123, 2).answer);
  const other = { ...client, name: "local:n" };
  const { rows, instanceSeed } = await runMatrix({ tasks: [task], modes: ["noHarness", "schemaOnly"], clients: [client, other], count: 2, instanceSeed: 77 });
  assert.equal(instanceSeed, 77);
  assert.equal(rows.length, 8);
  for (const row of rows) assert.equal(row.seed, seedFor(77, "wordmath2", row.index));
  const byIndex = (i) => rows.filter((row) => row.index === i);
  for (const i of [1, 2]) assert.equal(new Set(byIndex(i).map((row) => row.ctx.story)).size, 1, `index ${i}: one instance across modes and clients`);
  assert.notEqual(byIndex(1)[0].ctx.story, byIndex(2)[0].ctx.story);
  const again = await runMatrix({ tasks: [task], modes: ["noHarness"], clients: [client], count: 1, instanceSeed: 77 });
  assert.equal(again.rows[0].ctx.story, byIndex(1)[0].ctx.story, "the same run seed re-mints the same problem");
  const fresh = await runMatrix({ tasks: [task], modes: ["noHarness"], clients: [client], count: 1 });
  assert.ok(Number.isInteger(fresh.instanceSeed));
  // The calculator: a real expression through the real tool from a generated problem.
  const ctx = wordmath(5, 6);
  assert.equal(calc(`${ctx.answer} - 0`), ctx.answer);
});
