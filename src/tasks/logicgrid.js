// Task family: logicgrid — small deduction puzzles, minted per trial and unique by construction.
//
// n people each have one pet and one drink. Clues are true statements drawn from the hidden
// solution (direct, negative, and links between the two attributes), added until exactly one
// assignment satisfies them all (checked by enumeration), then pruned so no clue is redundant. The
// question asks for one cell of the grid. logicgrid3 has three people, logicgrid4 four. No tools —
// like `reason`, its harness is the structured mode.

import { labelModel } from "../providers/index.js";
import { dice, wordIn } from "./gen.js";

const NAMES = ["Alice", "Bob", "Carol", "Dave"];
const PETS = ["dog", "cat", "fish", "parrot"];
const DRINKS = ["tea", "coffee", "juice", "water"];

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
}

// A clue is a predicate over an assignment { pet: [...by person], drink: [...by person] } plus its text.
function clueSet(names, pets, drinks, solution) {
  const out = [];
  names.forEach((name, i) => {
    out.push({ text: `${name} has the ${solution.pet[i]}.`, test: (a) => a.pet[i] === solution.pet[i] });
    out.push({ text: `${name} drinks ${solution.drink[i]}.`, test: (a) => a.drink[i] === solution.drink[i] });
    for (const p of pets) if (p !== solution.pet[i]) out.push({ text: `${name} does not have the ${p}.`, test: (a) => a.pet[i] !== p });
    for (const dr of drinks) if (dr !== solution.drink[i]) out.push({ text: `${name} does not drink ${dr}.`, test: (a) => a.drink[i] !== dr });
    out.push({ text: `The person with the ${solution.pet[i]} drinks ${solution.drink[i]}.`, test: (a) => a.drink[a.pet.indexOf(solution.pet[i])] === solution.drink[i] });
    for (const dr of drinks) if (dr !== solution.drink[i]) out.push({ text: `The person with the ${solution.pet[i]} does not drink ${dr}.`, test: (a) => a.drink[a.pet.indexOf(solution.pet[i])] !== dr });
  });
  return out;
}

export function generate(seed, n) {
  const d = dice(seed);
  const names = NAMES.slice(0, n);
  const pets = d.shuffle(PETS).slice(0, n);
  const drinks = d.shuffle(DRINKS).slice(0, n);
  const solution = { pet: d.shuffle(pets), drink: d.shuffle(drinks) };
  const all = [];
  for (const p of permutations(pets)) for (const dr of permutations(drinks)) all.push({ pet: p, drink: dr });
  const consistent = (clues) => all.filter((a) => clues.every((c) => c.test(a)));

  // Add shuffled true clues until the solution is unique, then drop any clue that is not needed.
  const pool = d.shuffle(clueSet(names, pets, drinks, solution));
  const clues = [];
  for (const c of pool) {
    if (consistent(clues).length === 1) break;
    if (consistent([...clues, c]).length < consistent(clues).length) clues.push(c);
  }
  for (let i = clues.length - 1; i >= 0; i--) {
    const without = clues.filter((_, j) => j !== i);
    if (consistent(without).length === 1) clues.splice(i, 1);
  }

  const i = d.int(0, n - 1);
  const kind = d.pick(["who-drinks", "pet-of", "drink-of-pet"]);
  let question, answer, candidates;
  if (kind === "who-drinks") { question = `Who drinks ${solution.drink[i]}?`; answer = names[i]; candidates = names; }
  else if (kind === "pet-of") { question = `Which pet does ${names[i]} have?`; answer = solution.pet[i]; candidates = pets; }
  else { question = `What does the person with the ${solution.pet[i]} drink?`; answer = solution.drink[i]; candidates = drinks; }

  const setup = `${names.length} people — ${names.join(", ")} — each have exactly one pet (${pets.join(", ")}) and one drink (${drinks.join(", ")}); no two share a pet or a drink.`;
  return { seed, n, setup, clues: d.shuffle(clues).map((c) => c.text), question, answer, candidates, solution: { names, ...solution } };
}

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "Your working, one step per entry, written before the answer." },
    answer: { type: "string", description: "The name, pet or drink asked for." },
  },
  required: ["answer"],
};

function judge(said, ground) {
  const s = String(said ?? "").trim().toLowerCase();
  if (!s) return { correct: false, reason: "no answer given" };
  return s === ground.answer.toLowerCase() || s.startsWith(ground.answer.toLowerCase())
    ? { correct: true, reason: `"${ground.answer}" is right` }
    : { correct: false, reason: `answered "${said}", expected "${ground.answer}"` };
}

function makeLogicgrid(n) {
  const problem = (ctx) => `${ctx.setup} Clues: ${ctx.clues.map((c, i) => `(${i + 1}) ${c}`).join(" ")} ${ctx.question}`;
  const spec = { system: "You are a careful logician. Return the requested JSON.", prompt: (ctx) => `${problem(ctx)} Answer with a JSON object { "work": ["<deduction>", …], "answer": "<one word>" } — write the deductions in "work" first, then the answer.`, tools: [], schema, extract: "structured" };
  return {
    name: `logicgrid${n}`,
    category: "reasoning",
    seeded: true,
    capabilities: ["deduction"],
    description: `A ${n}-person pet-and-drink deduction puzzle, unique by construction, minted per trial. No tools: harness is the structured mode.`,
    model: labelModel,

    setup: async ({ seed }) => generate(seed >>> 0, n),

    goal: (ctx) => `${problem(ctx)} Answer with one word.`,

    noHarness: {
      prompt: (ctx) => `${problem(ctx)} Reason it out and finish with a line of the form "answer: <one word>".`,
      extract: "text",
    },
    harness: spec,
    schemaOnly: spec,

    eval: {
      ground: ({ ctx } = {}) => (ctx ? { answer: ctx.answer, candidates: ctx.candidates } : null),
      scoreHarness: (out, ground) => (out && typeof out === "object" ? judge(out.answer, ground) : { correct: false, reason: "no structured output" }),
      scoreNoHarness: (out, ground) => judge(wordIn(out, ground.candidates), ground),
      canon: (answer, { structured }) => (structured ? String(answer?.answer ?? "none") : String(wordIn(answer, [...NAMES, ...PETS, ...DRINKS]) ?? "none")).toLowerCase(),
    },
  };
}

export const logicgridTasks = [3, 4].map(makeLogicgrid);
export { schema, makeLogicgrid, permutations };
