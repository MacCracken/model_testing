// The ordering-puzzle family ([48] follow-up): unique by construction and minimal, three scenes
// with the same structure, the question kinds and their readers, the hooks (a paraphrase from the
// clue structure, the clues shuffled, one per line, typos with the names intact, clues dropped
// until the asked cell is free), every mode through the runner, and the listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, perturb, unanswerable, lineupTasks, placeIn, clueText, NAMES, ORDINALS } from "../src/tasks/lineup.js";
import { permutations } from "../src/tasks/logicgrid.js";
import { seedFor } from "../src/tasks/gen.js";
import { runTrial, summarize } from "../src/runner.js";
import { withPerturb } from "../src/perturb.js";
import { withAbstain, unanswerableFor } from "../src/abstain.js";
import { listTasks } from "../src/tasks/registry.js";

// The predicate of a recorded clue, for the tests' own enumeration.
function holds(c, p) {
  switch (c.kind) {
    case "end": return c.end === "first" ? p[c.a] === 1 : p[c.a] === Math.max(...p);
    case "notAt": return p[c.a] !== c.place;
    case "before": return p[c.a] < p[c.b];
    case "next": return p[c.b] === p[c.a] + 1;
    case "gap": return p[c.b] === p[c.a] + 2;
    case "apart": return Math.abs(p[c.a] - p[c.b]) > 1;
    case "between": return (p[c.a] > p[c.b] && p[c.a] < p[c.c]) || (p[c.a] < p[c.b] && p[c.a] > p[c.c]);
    default: throw new Error(`unknown clue kind ${c.kind}`);
  }
}
const answerOf = (g, p) => (g.q.kind === "who" ? g.names[p.indexOf(g.q.place)] : g.q.kind === "place" ? String(p[g.q.a]) : g.names[p.indexOf(p[g.q.a] + 1)]);

test("the generator: deterministic, every clue true of the solution, exactly one order satisfies the clues, none is redundant, the answer is that order's cell; all three scenes and question kinds occur", () => {
  const scenes = new Set(), kinds = new Set(), clueKinds = new Set();
  for (const n of [4, 6]) for (let i = 1; i <= 40; i++) {
    const seed = seedFor(2026, `lineup${n}`, i);
    const g = generate(seed, n);
    assert.deepEqual(generate(seed, n), g, "deterministic");
    scenes.add(g.scene); kinds.add(g.q.kind);
    for (const c of g.clueObjs) clueKinds.add(c.kind);
    const all = permutations(g.names.map((_, k) => k + 1));
    const ok = all.filter((p) => g.clueObjs.every((c) => holds(c, p)));
    assert.equal(ok.length, 1, `${g.clues.join(" ")} → ${ok.length} orders`);
    assert.deepEqual(ok[0], g.solution.places);
    assert.equal(answerOf(g, ok[0]), g.answer);
    for (let k = 0; k < g.clueObjs.length; k++) {
      const without = g.clueObjs.filter((_, j) => j !== k);
      assert.ok(all.filter((p) => without.every((c) => holds(c, p))).length > 1, `clue ${k + 1} is needed: ${g.clues[k]}`);
    }
    assert.equal(g.clues.length, g.clueObjs.length);
    assert.ok(g.clues.every((c) => /\.$/.test(c)));
    assert.equal(g.names.length, n);
    if (g.q.kind === "place") { assert.equal(g.candidates, null); assert.match(g.answer, /^\d$/); } else assert.ok(g.candidates.includes(g.answer));
    if (g.q.kind === "after") assert.notEqual(g.solution.places[g.q.a], n, "nobody is after the last");
  }
  assert.deepEqual([...scenes].sort(), ["houses", "queue", "race"]);
  assert.deepEqual([...kinds].sort(), ["after", "place", "who"]);
  for (const k of ["before", "next", "gap", "end", "notAt", "apart", "between"]) assert.ok(clueKinds.has(k), k);
  assert.throws(() => generate(1, 3), /unknown size/);
});

test("the words: every clue kind renders in every scene, base and alternative, naming the right people; ordinals; the readers", () => {
  const names = ["Alice", "Bob", "Carol", "Dave"];
  const c = { kind: "next", a: 0, b: 1 };
  assert.equal(clueText(c, names, "race"), "Bob finished immediately after Alice.");
  assert.equal(clueText(c, names, "houses"), "Bob lives immediately to the right of Alice.");
  assert.equal(clueText(c, names, "queue", true), "Alice is directly in front of Bob.");
  assert.equal(clueText({ kind: "between", a: 2, b: 0, c: 3 }, names, "race"), "Carol finished somewhere between Alice and Dave.");
  assert.equal(clueText({ kind: "notAt", a: 3, place: 3 }, names, "queue"), "Dave is not third in the queue.");
  assert.equal(clueText({ kind: "end", a: 1, end: "last" }, names, "houses", true), "Bob's house is the last on the right.");
  for (const scene of ["race", "queue", "houses"]) for (const k of [{ kind: "before", a: 0, b: 1 }, { kind: "gap", a: 0, b: 1, k: 2 }, { kind: "apart", a: 0, b: 1 }, { kind: "end", a: 0, end: "first" }]) for (const alt of [false, true]) {
    const t = clueText(k, names, scene, alt);
    assert.match(t, /Alice/);
    if (k.b !== undefined) assert.match(t, /Bob/);
  }
  assert.equal(placeIn("answer: third"), 3);
  assert.equal(placeIn("Bob was second.\nanswer: 2"), 2);
  assert.equal(placeIn("So he finished fourth."), 4);
  assert.ok(Number.isNaN(placeIn("answer: Carol")));
  assert.deepEqual(ORDINALS.slice(0, 3), ["first", "second", "third"]);
  assert.equal(NAMES.length, 8);
});

test("the hooks: paraphrase re-renders from the structure, order shuffles, format lists, typos leave names and ordinals, the unanswerable variant frees the asked cell", () => {
  for (const n of [4, 6]) for (let i = 1; i <= 15; i++) {
    const g = generate(seedFor(2026, `lineup${n}`, i), n);
    const p = perturb(g, "paraphrase", i);
    assert.equal(p.clues.length, g.clues.length);
    assert.ok(p.clues.every((c, k) => c !== g.clues[k]), "every clue reworded");
    assert.notEqual(p.question, g.question);
    assert.deepEqual(p.clueObjs, g.clueObjs);
    assert.equal(p.answer, g.answer);
    const o = perturb(g, "order", i);
    assert.deepEqual([...o.clues].sort(), [...g.clues].sort());
    if (g.clues.length > 1) assert.notDeepEqual(o.clues, g.clues);
    const f = perturb(g, "format", i);
    assert.equal(f.clueFormat, "lines");
    assert.match(lineupTasks[0].noHarness.prompt(f), /\nClues:\n- /);
    assert.match(lineupTasks[0].noHarness.prompt(g), / Clues: \(1\) /);
    const t = perturb(g, "typos", i);
    if (t) for (const name of g.names) assert.equal(t.clues.join(" ").split(name).length, g.clues.join(" ").split(name).length, `${name} intact`);
    const u = unanswerable(g);
    assert.equal(u.unanswerable, true);
    assert.equal(u.answer, null);
    assert.ok(u.clueObjs.length < g.clueObjs.length);
    const all = permutations(g.names.map((_, k) => k + 1));
    const answers = new Set(all.filter((q) => u.clueObjs.every((c) => holds(c, q))).map((q) => answerOf(g, q)));
    assert.ok(answers.size > 1, `the asked cell is free: ${[...answers].join(", ")}`);
    assert.match(u.missing, /^the clues? "/);
    assert.deepEqual(unanswerable(g), u, "deterministic");
  }
  assert.equal(perturb(generate(1, 4), "noise", 1), null);
  assert.deepEqual(lineupTasks[0].perturbs, ["paraphrase", "order", "format", "typos"]);
});

// A fake logician: enumerates the orders itself and answers the asked cell, or abstains when the
// clues allow more than one.
function logician(how = "solve") {
  const answerFor = (ctx) => {
    const all = permutations(ctx.names.map((_, k) => k + 1));
    const ok = all.filter((p) => ctx.clueObjs.every((c) => holds(c, p)));
    const answers = new Set(ok.map((p) => answerOf(ctx, p)));
    if (how === "wrong") return ctx.candidates ? ctx.candidates.find((c) => c !== ctx.answer) : String((Number(ok[0] ? answerOf(ctx, ok[0]) : 1) % ctx.n) + 1);
    return answers.size === 1 ? [...answers][0] : null;
  };
  return {
    name: "fake:m", model: "m",
    async chat(messages, _tools, { ctx }) { const a = answerFor(ctx); return { text: a === null ? "answer: cannot be determined — the clues allow more than one order" : `answer: ${a}`, usage: null }; },
    async runWithTools(prompt, tools, _system, { ctx }) { const a = answerFor(ctx); const out = a === null ? { work: ["two orders fit"], answerable: false, answer: null } : { work: ["enumerated"], answer: /^\d+$/.test(a) ? Number(a) : a }; return { text: JSON.stringify(out), structured: out, toolCalls: [], toolResults: [], rounds: 1, usage: null }; },
  };
}

test("every mode through the runner: right, wrong, the canon, a paraphrase paired with consistency, and the abstain variant's freed cell", async () => {
  for (const task of lineupTasks) for (const mode of ["noHarness", "schemaOnly", "harness"]) for (const seed of [3, 11, 27]) {
    const r = await runTrial({ task, mode, client: logician(), index: 1, seed });
    assert.equal(r.error, null, `${task.name}/${mode}: ${r.error}`);
    assert.equal(r.correct, true, `${task.name}/${mode}/${seed}: ${r.reason}`);
    assert.equal(r.canon, String(r.ground.answer).toLowerCase());
    const w = await runTrial({ task, mode, client: logician("wrong"), index: 1, seed });
    assert.equal(w.correct, false);
  }
  assert.equal(lineupTasks[0].toolOnly, undefined, "no tools: harness is the structured mode");
  const base = await runTrial({ task: lineupTasks[0], mode: "noHarness", client: logician(), index: 1, seed: 5 });
  const para = await runTrial({ task: lineupTasks[0], mode: "noHarness", client: withPerturb(logician(), "paraphrase"), index: 1, seed: 5 });
  assert.equal(para.perturb.applied, true);
  assert.equal(para.canon, base.canon);
  assert.deepEqual(summarize([base, para]).delta.perturb.paraphrase.consistency, { pairs: 1, same: 1, pct: 100 });
  const unSeed = Array.from({ length: 60 }, (_, i) => i + 1).find((s) => unanswerableFor(s));
  const u = await runTrial({ task: lineupTasks[1], mode: "harness", client: withAbstain(logician()), index: 1, seed: unSeed });
  assert.equal(u.abstain.unanswerable, true);
  assert.equal(u.abstain.abstention, "abstained", u.reason);
  assert.equal(u.correct, true);
  assert.match(u.abstain.missing, /^the clues? "/);
  const anSeed = Array.from({ length: 60 }, (_, i) => i + 1).find((s) => !unanswerableFor(s));
  const a = await runTrial({ task: lineupTasks[1], mode: "harness", client: withAbstain(logician()), index: 1, seed: anSeed });
  assert.equal(a.abstain.abstention, "answered");
  assert.equal(a.correct, true, a.reason);
});

test("the listing: two sizes of one family, no tools, the hooks and the capabilities", () => {
  const by = Object.fromEntries(listTasks().map((t) => [t.name, t]));
  assert.deepEqual([by.lineup4.family, by.lineup4.level, by.lineup6.level], ["lineup", 4, 6]);
  assert.deepEqual(by.lineup4.modes, ["noHarness", "harness", "schemaOnly"]);
  assert.deepEqual(by.lineup4.tools, []);
  assert.deepEqual(by.lineup6.perturbs, ["paraphrase", "order", "format", "typos"]);
  assert.deepEqual(by.lineup6.abstain, by.lineup6.modes);
  assert.deepEqual(by.lineup4.capabilities, ["deduction", "ordering"]);
});
