// Task family: wordmath — multi-step arithmetic word problems, minted per trial.
//
// A stock count moves through a sequence of steps (arrivals, departures, vans × crates, halving);
// the answer is the final count, or a per-item multiple of it. The number of steps is the knob
// (wordmath2 / 4 / 6). The harness axis is a calculator: does a tool fix the arithmetic a model gets
// wrong in prose? Truth is computed while the problem is generated, so scoring is exact.

import { labelModel } from "../providers/index.js";
import { dice, numberIn } from "./gen.js";
import { calcTool } from "../calc.js";

const SCENES = [
  { thing: "crates", one: "crate", place: "the warehouse", in: ["a delivery brings in", "a truck unloads"], out: ["a shipment takes out", "a customer collects"], unit: ["units", "boxes"] },
  { thing: "books", one: "book", place: "the library", in: ["a donation adds", "the returns desk brings back"], out: ["readers borrow", "a school picks up"], unit: ["pages", "chapters"] },
  { thing: "chairs", one: "chair", place: "the hall", in: ["the crew sets out", "a supplier delivers"], out: ["a wedding party takes", "the staff store away"], unit: ["screws", "cushions"] },
  { thing: "tickets", one: "ticket", place: "the box office", in: ["the printer issues", "a batch arrives with"], out: ["a group buys", "the website sells"], unit: ["seats", "coupons"] },
];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const NOISE = ["The manager's name is {name}.", "It rains for most of the day.", "The forklift is painted yellow.", "A radio plays in the background.", "The floor is swept twice.", "{name} brings pastries for the team."];
const NAMES = ["Priya", "Tomasz", "Aiko", "Mateo", "Fatima", "Lars"];

export function generate(seed, steps) {
  const d = dice(seed);
  const scene = d.pick(SCENES);
  let count = d.int(40, 240);
  const lines = [`On ${DAYS[0]} morning ${scene.place} holds ${count} ${scene.thing}.`];
  const ops = [];
  for (let k = 0; k < steps; k++) {
    const day = DAYS[Math.min(k + 1, DAYS.length - 1)];
    const kind = count < 20 ? "in" : d.pick(["in", "out", "in", "out", "vans", "half"]);
    if (kind === "in") {
      const n = d.int(5, 60);
      count += n;
      lines.push(`On ${day} ${d.pick(scene.in)} ${n} more.`);
      ops.push(`+${n}`);
    } else if (kind === "out") {
      const n = d.int(5, Math.min(60, count - 10));
      count -= n;
      lines.push(`On ${day} ${d.pick(scene.out)} ${n} of them.`);
      ops.push(`-${n}`);
    } else if (kind === "vans") {
      const vans = d.int(2, 4);
      const each = d.int(6, 15);
      count += vans * each;
      lines.push(`On ${day} ${vans} vans arrive, each carrying ${each} ${scene.thing}.`);
      ops.push(`+${vans}×${each}`);
    } else {
      if (count % 2) {
        count += 1;
        lines.push(`On ${day} one more ${scene.one} turns up behind a door.`);
        ops.push("+1");
      }
      count /= 2;
      lines.push(`On ${day} exactly half of the ${scene.thing} are moved to storage.`);
      ops.push("÷2");
    }
    if (k % 2 === 1) lines.push(d.pick(NOISE).replace("{name}", d.pick(NAMES)));
  }
  let question = `How many ${scene.thing} are in ${scene.place} at the end?`;
  let answer = count;
  if (steps >= 4 && d.chance(0.5)) {
    const per = d.int(3, 12);
    const unit = d.pick(scene.unit);
    answer = count * per;
    question = `Each ${scene.one} accounts for ${per} ${unit}. How many ${unit} are in ${scene.place} at the end?`;
    ops.push(`×${per}`);
  }
  return { seed, steps, story: lines.join(" "), question, answer, ops };
}

// The structured answer has room to work: "JSON only — no prose" otherwise forbids the reasoning
// the problem needs, and a schema that starts with the answer makes the model commit before it
// has thought. `work` comes first so the working is written first.
const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "Your working, one step per entry, written before the answer." },
    answer: { type: "integer", description: "The final number." },
  },
  required: ["answer"],
};

const answerOf = (out) => Number(out && typeof out === "object" ? (out.answer ?? out.result ?? out.value) : out);

function makeWordmath(steps) {
  const problem = (ctx) => `${ctx.story} ${ctx.question}`;
  return {
    name: `wordmath${steps}`,
    family: "wordmath",
    level: steps,
    category: "reasoning",
    seeded: true,
    capabilities: ["arithmetic", "multi-step"],
    description: `A ${steps}-step stock word problem minted per trial; the answer is one integer. With tools, a calculator.`,
    model: labelModel,
    maxRounds: steps + 4,

    setup: async ({ seed }) => generate(seed >>> 0, steps),

    goal: (ctx) => `${problem(ctx)} Give the final number.`,

    noHarness: {
      prompt: (ctx) => `${problem(ctx)} Work it out and finish with a line of the form "answer: <number>".`,
      extract: "text",
    },
    harness: {
      system: "You are a careful analyst. Use the calc tool for every arithmetic step — never do arithmetic in your head — and return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)} Use calc for each step, then answer with a JSON object { "work": ["<step>", …], "answer": <integer> } — the working first, then the answer.`,
      tools: [calcTool],
      schema,
      extract: "structured",
    },
    schemaOnly: {
      system: "You are a careful analyst. Return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)} Answer with a JSON object { "work": ["<step>", …], "answer": <integer> } — write your working step by step in "work" first, then the answer.`,
      tools: [],
      schema,
      extract: "structured",
    },
    toolOnly: {
      system: "You are a careful analyst. Use the calc tool for every arithmetic step — never do arithmetic in your head.",
      prompt: (ctx) => `${problem(ctx)} Use calc for each step, then finish with a line of the form "answer: <number>".`,
      tools: [calcTool],
      extract: "text",
    },

    eval: {
      ground: ({ ctx } = {}) => ctx?.answer ?? null,
      toolUse: ({ toolCalls, toolResults }) => {
        const calls = toolCalls.filter((c) => c.name === "calc");
        if (!calls.length) return { ok: false, reason: "calc was never called — the arithmetic was done in the head" };
        const failed = toolResults.filter((r) => r.name === "calc" && r.ok === false).length;
        if (failed) return { ok: false, reason: `${failed} of ${calls.length} calc expression(s) did not evaluate` };
        return { ok: true, reason: `calc evaluated ${calls.length} expression(s)` };
      },
      scoreHarness: (out, ground) => {
        if (out === null || out === undefined) return { correct: false, reason: "no structured output" };
        const got = answerOf(out);
        if (!Number.isFinite(got)) return { correct: false, reason: "structured output has no numeric answer" };
        return got === ground ? { correct: true, reason: `answer ${got} is right` } : { correct: false, reason: `answered ${got}, expected ${ground}` };
      },
      scoreNoHarness: (out, ground) => {
        const got = numberIn(out);
        if (!Number.isFinite(got)) return { correct: false, reason: "no number in the answer" };
        return got === ground ? { correct: true, reason: `answer ${got} is right` } : { correct: false, reason: `answered ${got}, expected ${ground}` };
      },
      canon: (answer, { structured }) => {
        const n = structured ? answerOf(answer) : numberIn(answer);
        return Number.isFinite(n) ? String(n) : "none";
      },
    },
  };
}

export const wordmathTasks = [2, 4, 6].map(makeWordmath);
export { schema, makeWordmath };
