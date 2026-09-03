// Task: answer a few unambiguous logic/arithmetic questions.
//
//   - noHarness: model answers free-form, no tools. We look for the right answer(s).
//   - harness:   same questions, asked with an output schema and no tools. Since there are no
//                tools, this isolates the structured-output requirement alone — it should NOT
//                lift the model, which is the control that proves "the harness delta" isn't just
//                "the model gets asked to emit JSON."
//
// No live endpoints are needed: the ground truth is fixed and known, so `eval.ground` is a
// constant rather than a function.

import { labelModel } from "../providers/index.js";
import { unwrapList } from "./util.js";

const PROBLEMS = [
  {
    question: "What is 7 × 8?",
    answer: "56",
  },
  {
    question: "A bag has 3 red, 2 blue, and 5 green marbles. How many marbles are not blue?",
    answer: "8",
  },
  {
    question: "If today is Monday and 3 days from now is X, what day is X?",
    answer: "Thursday",
  },
];

// The harness here carries a schema but deliberately no tools. It is the "schema-only" half of
// the bundle; its job is to prove that simply asking the model to emit JSON does not, on its own,
// change the correctness rate. The delta between this and noHarness should therefore hover near 0.
// Because that is literally what the schemaOnly axis measures, the same spec is declared under
// both names.

const schema = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer: { type: "string", description: "The answer to this question." },
        },
        required: ["question", "answer"],
      },
    },
  },
  required: ["answers"],
};

const structuredSpec = {
  system:
    "You are a precise problem solver. Answer exactly as requested and return only the JSON.",
  prompt:
    `Answer the following questions. Return a JSON object with an "answers" array, one object per question, each carrying the exact question text and its answer.\n` +
    PROBLEMS.map((p) => `- ${p.question}`).join("\n"),
  tools: [],
  schema,
  extract: "structured",
};

export const task = {
  name: "reason",
  category: "pure-reasoning",
  description: "Answer a few unambiguous logic/arithmetic questions. Control task with no tools.",
  model: labelModel,

  goal:
    "Answer the following questions and report the exact question text and its answer for each:\n" +
    PROBLEMS.map((p) => `- ${p.question}`).join("\n"),

  // ---- no-harness mode ----
  noHarness: {
    prompt:
      "Answer the following questions. For each, write a short answer on its own line prefixed " +
      "with the question number (e.g. '1) 56'). No tools are available.\n" +
      PROBLEMS.map((p, i) => `Q${i + 1}) ${p.question}`).join("\n"),
    extract: "text",
  },

  // ---- with-harness mode (schema only, no tools) — the same spec serves the schemaOnly axis ----
  harness: structuredSpec,
  schemaOnly: structuredSpec,

  // ---- evaluation ----
  eval: {
    // Ground truth: the correct answer for each question.
    ground: PROBLEMS.map((p) => p.answer),

    // Harness: every ground answer must appear in the structured answer.
    scoreHarness: (out, ground) => {
      if (out === null || out === undefined) return { correct: false, reason: "no structured output" };
      const answers = unwrapList(out, ["answers"], (o) => o.answer !== undefined);
      // Each answer is an object { question, answer } or a bare string; flatten to the string.
      const got = answers
        .flatMap((a) => (typeof a === "string" ? [a] : [a?.answer ?? ""]))
        .map((a) => String(a).trim().toLowerCase())
        .filter(Boolean);
      if (!got.length) return { correct: false, reason: "structured answer contained no answers" };
      const missing = ground.filter((a) => !got.includes(a.trim().toLowerCase()));
      return {
        correct: missing.length === 0,
        reason: `${ground.length - missing.length}/${ground.length} answers match`,
      };
    },

    // No-harness: the right answers appear in free text.
    scoreNoHarness: (out, ground) => {
      const text = String(out ?? "").replace(/["*`]/g, "").toLowerCase();
      const present = ground.filter((a) => text.includes(a.trim().toLowerCase()));
      return {
        correct: present.length === ground.length,
        reason: `${present.length}/${ground.length} answers present`,
      };
    },
  },
};

export { PROBLEMS };
