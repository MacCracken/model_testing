// Task family: lineup — linear ordering puzzles, minted per trial and unique by construction.
//
// n people stand in one line: a race's finishing order, a queue, or a row of houses (the scene is
// drawn per instance and only changes the words). Clues are true statements about the hidden
// order — before / after, immediately after, two places ahead, first or last, not in a given
// place, not next to each other, between — added until exactly one order satisfies them all
// (checked by enumeration) and pruned so no clue is redundant. The question asks who holds a
// place, which place someone holds, or who is right after someone. lineup4 has four people,
// lineup6 six. No tools — like logicgrid, its harness is the structured mode. The unanswerable
// variant drops clues until the asked cell is no longer determined: an abstention here is a
// deduction, not a missing number.

import { labelModel } from "../providers/index.js";
import { typos } from "../perturb.js";
import { dice, numberIn, wordIn } from "./gen.js";
import { permutations } from "./logicgrid.js";

const NAMES = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Grace", "Hank"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
const SCENES = {
  race: { noun: "runners", setup: (names) => `${names.length} runners — ${names.join(", ")} — finished a race, one after another with no ties.` },
  queue: { noun: "people", setup: (names) => `${names.length} people — ${names.join(", ")} — are standing in a queue, one behind another.` },
  houses: { noun: "neighbours", setup: (names) => `${names.length} neighbours — ${names.join(", ")} — live in a row of ${names.length} houses, one each, along one side of a street.` },
};

// A clue is a predicate over an order (pos[i] = the 1-based place of person i) plus its structure;
// the words come from the scene at render time, so a paraphrase re-renders the same clue.
function clueSet(n, sol) {
  const out = [];
  const pos = (i) => sol[i];
  for (let a = 0; a < n; a++) {
    if (pos(a) === 1) out.push({ kind: "end", a, end: "first", test: (p) => p[a] === 1 });
    if (pos(a) === n) out.push({ kind: "end", a, end: "last", test: (p) => p[a] === n });
    for (let place = 1; place <= n; place++) if (pos(a) !== place) out.push({ kind: "notAt", a, place, test: (p) => p[a] !== place });
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      if (pos(a) < pos(b)) out.push({ kind: "before", a, b, test: (p) => p[a] < p[b] });
      if (pos(b) === pos(a) + 1) out.push({ kind: "next", a, b, test: (p) => p[b] === p[a] + 1 });
      if (pos(b) === pos(a) + 2) out.push({ kind: "gap", a, b, k: 2, test: (p) => p[b] === p[a] + 2 });
      if (Math.abs(pos(a) - pos(b)) > 1 && a < b) out.push({ kind: "apart", a, b, test: (p) => Math.abs(p[a] - p[b]) > 1 });
      for (let c = b + 1; c < n; c++) {
        if (c === a) continue;
        const lo = Math.min(pos(b), pos(c)), hi = Math.max(pos(b), pos(c));
        if (pos(a) > lo && pos(a) < hi) out.push({ kind: "between", a, b, c, test: (p) => (p[a] > p[b] && p[a] < p[c]) || (p[a] < p[b] && p[a] > p[c]) });
      }
    }
  }
  return out;
}

const ordinal = (place) => ORDINALS[place - 1];

// The words for a clue in a scene — the base wording, or the alternative a paraphrase uses.
export function clueText(c, names, scene, alt = false) {
  const A = names[c.a], B = names[c.b], C = names[c.c];
  const t = {
    race: {
      before: [`${A} finished before ${B}.`, `${B} finished after ${A}.`],
      next: [`${B} finished immediately after ${A}.`, `${A} finished just ahead of ${B}, with nobody between them.`],
      gap: [`${A} finished two places ahead of ${B}.`, `${B} finished two places behind ${A}.`],
      first: [`${A} finished first.`, `${A} won the race.`],
      last: [`${A} finished last.`, `${A} came in last.`],
      notAt: [`${A} did not finish ${ordinal(c.place)}.`, `${ordinal(c.place)} place was not ${A}'s.`],
      apart: [`${A} and ${B} did not finish next to each other.`, `At least one runner finished between ${A} and ${B}.`],
      between: [`${A} finished somewhere between ${B} and ${C}.`, `${B} and ${C} finished on either side of ${A}, not necessarily next to ${A}.`],
    },
    queue: {
      before: [`${A} is ahead of ${B} in the queue.`, `${B} is somewhere behind ${A}.`],
      next: [`${B} is directly behind ${A}.`, `${A} is directly in front of ${B}.`],
      gap: [`${A} is two places ahead of ${B}.`, `${B} is two places behind ${A}.`],
      first: [`${A} is at the front of the queue.`, `${A} is first in the queue.`],
      last: [`${A} is at the back of the queue.`, `${A} is last in the queue.`],
      notAt: [`${A} is not ${ordinal(c.place)} in the queue.`, `The ${ordinal(c.place)} place in the queue is not ${A}'s.`],
      apart: [`${A} and ${B} are not next to each other.`, `Somebody stands between ${A} and ${B}.`],
      between: [`${A} is somewhere between ${B} and ${C}.`, `${B} and ${C} are on either side of ${A}, not necessarily next to ${A}.`],
    },
    houses: {
      before: [`${A} lives somewhere to the left of ${B}.`, `${B}'s house is to the right of ${A}'s.`],
      next: [`${B} lives immediately to the right of ${A}.`, `${A} lives next door to ${B}, on ${B}'s left.`],
      gap: [`${A} lives two doors to the left of ${B}.`, `${B}'s house is two to the right of ${A}'s.`],
      first: [`${A} lives in the leftmost house.`, `${A}'s house is the first from the left.`],
      last: [`${A} lives in the rightmost house.`, `${A}'s house is the last on the right.`],
      notAt: [`${A} does not live in the ${ordinal(c.place)} house from the left.`, `The ${ordinal(c.place)} house from the left is not ${A}'s.`],
      apart: [`${A} and ${B} are not next-door neighbours.`, `At least one house stands between ${A}'s and ${B}'s.`],
      between: [`${A} lives somewhere between ${B} and ${C}.`, `${B}'s and ${C}'s houses are on either side of ${A}'s, not necessarily next to it.`],
    },
  }[scene];
  const key = c.kind === "end" ? c.end : c.kind;
  return t[key][alt ? 1 : 0];
}

// The question about one cell of the order: who holds a place, which place someone holds, or
// who comes right after someone. The words come from the scene.
function questionText(q, names, scene, alt = false) {
  const A = names[q.a];
  const t = {
    race: {
      who: [`Who finished ${ordinal(q.place)}?`, `Which runner came ${ordinal(q.place)}?`],
      place: [`In which place did ${A} finish? Answer with a number (1 = first).`, `What was ${A}'s finishing position? Answer with a number (1 = first).`],
      after: [`Who finished immediately after ${A}?`, `Which runner came in right behind ${A}?`],
    },
    queue: {
      who: [`Who is ${ordinal(q.place)} in the queue?`, `Which person holds the ${ordinal(q.place)} place in the queue?`],
      place: [`What position is ${A} in the queue? Answer with a number (1 = the front).`, `Counting from the front, where does ${A} stand? Answer with a number (1 = the front).`],
      after: [`Who is directly behind ${A}?`, `Which person stands immediately behind ${A}?`],
    },
    houses: {
      who: [`Who lives in the ${ordinal(q.place)} house from the left?`, `Which neighbour's house is ${ordinal(q.place)} from the left?`],
      place: [`Which house from the left is ${A}'s? Answer with a number (1 = leftmost).`, `Counting from the left, which house is ${A}'s? Answer with a number (1 = leftmost).`],
      after: [`Who lives immediately to the right of ${A}?`, `Which neighbour lives next door to ${A}, on the right?`],
    },
  }[scene];
  return t[q.kind][alt ? 1 : 0];
}

export function generate(seed, n) {
  if (![4, 5, 6, 7].includes(n)) throw new Error(`lineup: unknown size ${n}`);
  const d = dice(seed);
  for (let k = 0; k < 2; k++) d.rand();
  const scene = d.pick(Object.keys(SCENES));
  const names = d.shuffle(NAMES).slice(0, n).sort();
  const sol = d.shuffle(names.map((_, i) => i + 1)); // sol[i] = the place of person i
  const all = permutations(names.map((_, i) => i + 1));
  const consistent = (clues) => all.filter((p) => clues.every((c) => c.test(p)));

  // Add shuffled true clues while they narrow the set, until the order is unique; then drop any
  // clue the rest can do without.
  const pool = d.shuffle(clueSet(n, sol));
  const clues = [];
  for (const c of pool) {
    if (consistent(clues).length === 1) break;
    if (consistent([...clues, c]).length < consistent(clues).length) clues.push(c);
  }
  for (let i = clues.length - 1; i >= 0; i--) {
    const without = clues.filter((_, j) => j !== i);
    if (consistent(without).length === 1) clues.splice(i, 1);
  }

  // The question: a cell of the order.
  const kind = d.pick(["who", "place", "after"]);
  const byPlace = (place) => names[sol.indexOf(place)];
  let q, answer, candidates;
  if (kind === "who") { const place = d.int(1, n); q = { kind, place }; answer = byPlace(place); candidates = names; }
  else if (kind === "place") { const a = d.int(0, n - 1); q = { kind, a }; answer = String(sol[a]); candidates = null; }
  else { const a = d.int(0, n - 1); const i = sol[a] === n ? names.indexOf(byPlace(n - 1)) : a; q = { kind, a: i }; answer = byPlace(sol[i] + 1); candidates = names; }

  const clueObjs = d.shuffle(clues).map(({ test: _test, ...c }) => c);
  const ctx = { seed, n, scene, names, setup: SCENES[scene].setup(names), clueObjs, clues: clueObjs.map((c) => clueText(c, names, scene)), q, question: questionText(q, names, scene), answer, candidates, solution: { names, places: sol } };
  return ctx;
}

// The clue's predicate again from its structure (the record keeps no functions).
function testOf(c) {
  const { a, b, k, place } = c;
  switch (c.kind) {
    case "end": return c.end === "first" ? (p) => p[a] === 1 : (p) => p[a] === Math.max(...p);
    case "notAt": return (p) => p[a] !== place;
    case "before": return (p) => p[a] < p[b];
    case "next": return (p) => p[b] === p[a] + 1;
    case "gap": return (p) => p[b] === p[a] + (k ?? 2);
    case "apart": return (p) => Math.abs(p[a] - p[b]) > 1;
    case "between": return (p) => (p[a] > p[b] && p[a] < p[c.c]) || (p[a] < p[b] && p[a] > p[c.c]);
    default: return () => true;
  }
}
const answerOfOrder = (q, names, p) => (q.kind === "who" ? names[p.indexOf(q.place)] : q.kind === "place" ? String(p[q.a]) : names[p.indexOf(p[q.a] + 1)]);

// ---- the treatments' hooks -----------------------------------------------------------------------

// The same puzzle in other words, with the clues shuffled, one clue per line, or with typos in
// the connective words (the names and the ordinals are never touched).
export function perturb(ctx, kind, seed = 0) {
  if (!Array.isArray(ctx?.clueObjs)) return null;
  const d = dice((seed >>> 0) ^ 0x9e37);
  if (kind === "order") {
    if (ctx.clueObjs.length < 2) return null;
    let clueObjs = d.shuffle(ctx.clueObjs);
    while (clueObjs.every((c, i) => c === ctx.clueObjs[i])) clueObjs = d.shuffle(ctx.clueObjs);
    return { ...ctx, clueObjs, clues: clueObjs.map((c) => clueText(c, ctx.names, ctx.scene, ctx.wording === "alt")), perturbed: kind };
  }
  if (kind === "format") return { ...ctx, clueFormat: "lines", perturbed: kind };
  if (kind === "paraphrase") return { ...ctx, wording: "alt", clues: ctx.clueObjs.map((c) => clueText(c, ctx.names, ctx.scene, true)), question: questionText(ctx.q, ctx.names, ctx.scene, true), perturbed: kind };
  if (kind === "typos") {
    const protect = [...ctx.names, ...ORDINALS, "queue", "race", "house", "houses", "left", "right", "front", "back", "first", "last", "next", "door", "doors", "places", "place", "ahead", "behind", "before", "after", "between"];
    const clues = ctx.clues.map((c, i) => typos(c, (seed >>> 0) + i * 7919, { protect }));
    const question = typos(ctx.question, (seed >>> 0) + 104729, { protect });
    if (clues.every((c, i) => c === ctx.clues[i]) && question === ctx.question) return null;
    return { ...ctx, clues, question, perturbed: kind };
  }
  return null;
}

// The same puzzle with clues dropped until the asked cell is no longer determined: the honest
// answer is that the clues do not say. `missing` names the clue that went.
export function unanswerable(ctx) {
  const all = permutations(ctx.names.map((_, i) => i + 1));
  const d = dice((ctx.seed >>> 0) ^ 0xab);
  let clueObjs = [...ctx.clueObjs];
  const dropped = [];
  const answers = (objs) => new Set(all.filter((p) => objs.every((c) => testOf(c)(p))).map((p) => answerOfOrder(ctx.q, ctx.names, p)));
  // Drop the clue whose loss frees the asked cell, or keep dropping seeded clues until one does.
  const freeing = clueObjs.map((_, i) => i).filter((i) => answers(clueObjs.filter((_, j) => j !== i)).size > 1);
  const first = freeing.length ? d.pick(freeing) : d.int(0, clueObjs.length - 1);
  dropped.push(clueObjs[first]); clueObjs = clueObjs.filter((_, j) => j !== first);
  while (clueObjs.length && answers(clueObjs).size < 2) { const i = d.int(0, clueObjs.length - 1); dropped.push(clueObjs[i]); clueObjs = clueObjs.filter((_, j) => j !== i); }
  const alt = ctx.wording === "alt";
  return { ...ctx, clueObjs, clues: clueObjs.map((c) => clueText(c, ctx.names, ctx.scene, alt)), answer: null, unanswerable: true, missing: `the clue${dropped.length > 1 ? "s" : ""} "${dropped.map((c) => clueText(c, ctx.names, ctx.scene, alt)).join('" and "')}" (the remaining clues allow ${answers(clueObjs).size} answers)` };
}

// ---- scoring ------------------------------------------------------------------------------------

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "Your deductions, one per entry, written before the answer." },
    answer: { type: ["string", "integer"], description: "The name asked for, or the place as a number." },
  },
  required: ["answer"],
};

// A place said in words ("third") or as a number; a name by the candidates.
export function placeIn(text) {
  const t = String(text ?? "").toLowerCase();
  const m = t.match(/answer\s*[:=]?\s*\**\s*([a-z]+|\d+)/i);
  const word = m ? m[1] : null;
  if (word && ORDINALS.includes(word)) return ORDINALS.indexOf(word) + 1;
  const n = numberIn(text);
  if (Number.isFinite(n)) return n;
  const last = [...t.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth)\b/g)].at(-1);
  return last ? ORDINALS.indexOf(last[1]) + 1 : NaN;
}

function judge(said, ground) {
  if (said === null || said === undefined || said === "") return { correct: false, reason: "no answer given" };
  const want = String(ground.answer);
  if (ground.candidates) {
    const s = String(said).trim().toLowerCase();
    return s === want.toLowerCase() || s.startsWith(want.toLowerCase()) ? { correct: true, reason: `"${want}" is right` } : { correct: false, reason: `answered "${said}", expected "${want}"` };
  }
  const n = typeof said === "number" ? said : placeIn(`answer: ${said}`);
  return Number(n) === Number(want) ? { correct: true, reason: `place ${want} is right` } : { correct: false, reason: `answered ${Number.isFinite(n) ? n : JSON.stringify(said)}, expected ${want}` };
}

function makeLineup(n) {
  const problem = (ctx) => (ctx.clueFormat === "lines"
    ? `${ctx.setup}\nClues:\n${ctx.clues.map((c) => `- ${c}`).join("\n")}\n${ctx.question}`
    : `${ctx.setup} Clues: ${ctx.clues.map((c, i) => `(${i + 1}) ${c}`).join(" ")} ${ctx.question}`);
  const spec = { system: "You are a careful logician. Return the requested JSON.", prompt: (ctx) => `${problem(ctx)} Answer with a JSON object { "work": ["<deduction>", …], "answer": <the name, or the place as a number> } — write the deductions in "work" first, then the answer.`, tools: [], schema, extract: "structured" };
  return {
    name: `lineup${n}`,
    family: "lineup",
    level: n,
    category: "reasoning",
    seeded: true,
    capabilities: ["deduction", "ordering"],
    description: `A ${n}-person ordering puzzle — a race, a queue or a row of houses — unique by construction, minted per trial: before and after, next to, two places apart, first or last, between. No tools: harness is the structured mode.`,
    model: labelModel,

    setup: async ({ seed }) => generate(seed >>> 0, n),
    unanswerable,
    perturb,
    perturbs: ["paraphrase", "order", "format", "typos"],

    goal: (ctx) => `${problem(ctx)} Answer with the name, or the place as a number.`,

    noHarness: {
      prompt: (ctx) => `${problem(ctx)} Reason it out and finish with a line of the form "answer: <the name, or the place as a number>".`,
      extract: "text",
    },
    harness: spec,
    schemaOnly: spec,

    eval: {
      ground: ({ ctx } = {}) => (ctx ? { answer: ctx.answer, candidates: ctx.candidates } : null),
      scoreHarness: (out, ground) => (out && typeof out === "object" ? judge(out.answer, ground) : { correct: false, reason: "no structured output" }),
      scoreNoHarness: (out, ground) => (ground.candidates ? judge(wordIn(out, ground.candidates), ground) : judge(placeIn(out), ground)),
      canon: (answer, { structured }) => {
        if (structured) return String(answer?.answer ?? "none").toLowerCase();
        const name = wordIn(answer, NAMES);
        const place = placeIn(answer);
        return (name ?? (Number.isFinite(place) ? String(place) : "none")).toLowerCase();
      },
    },
  };
}

export const lineupTasks = [4, 6].map(makeLineup);
export { schema, makeLineup, NAMES, ORDINALS, SCENES };
