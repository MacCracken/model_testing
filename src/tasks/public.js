// Task family: public anchors — public benchmark sets run through the same client, against the
// same endpoint, scored by dependency-free reimplementations of their official checks (see
// src/anchors.js for the sets and the cache, src/ifeval.js and src/bfcl.js for the checkers).
//
//   gsm8k         grade-school word problems; the final number. noHarness is zero-shot chain of
//                 thought; harness adds the calculator and the {work, answer} schema — our harness
//                 delta on a public set.
//   ifeval        541 prompts with verifiable formatting instructions; strict prompt-level pass
//                 (every instruction followed), the loose verdict in the reason. noHarness only:
//                 the response format is the test, a schema would be the answer.
//   bfclsimple    one function, one call; bfclmultiple: pick the right function of several.
//                 noHarness is BFCL's prompting mode (the call written as text, parsed here);
//                 toolOnly and harness are native tool calling, scored on the call itself.
//
// Every row is tagged `source: "public"` and its capabilities are `public:<capability>`, so the
// anchors never pool with the generated families in a scorecard, a gate or a trend — `cli anchors
// <client>` puts the two side by side. The trial's index picks the item from one fixed
// permutation of the set (the same subset for every model and run); the row records which copy
// of the set it read and the contamination caveat.

import { labelModel } from "../providers/index.js";
import { calcTool } from "../calc.js";
import { loadAnchor, anchorItem, anchorProvenance, SOURCES, CAVEAT } from "../anchors.js";
import { checkPrompt } from "../ifeval.js";
import { toolsFrom, toolName, scoreCalls, parseCalls } from "../bfcl.js";

function needSet(name) {
  const set = loadAnchor(name);
  if (!set) throw new Error(`anchor ${name} is not fetched — run: node src/cli.js anchors fetch ${name}`);
  return set;
}
const common = (name) => ({
  category: "public-anchor",
  source: "public",
  caveat: CAVEAT,
  capabilities: [`public:${SOURCES[name].capability}`],
  model: labelModel,
});

// ---- GSM8K -----------------------------------------------------------------------------------
export const gsm8kAnswer = (solution) => { const m = String(solution).match(/####\s*(-?[\d,]*\.?\d+)/); return m ? Number(m[1].replace(/,/g, "")) : NaN; };
// The official strict match wants "#### <number>"; the flexible one takes the last number.
export function gsm8kRead(text) {
  const t = String(text ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const strict = t.match(/####\s*\$?\s*(-?\d+(?:\.\d+)?)/);
  if (strict) return { value: Number(strict[1]), how: "strict" };
  const all = t.match(/-?\d+(?:\.\d+)?/g);
  return all ? { value: Number(all[all.length - 1]), how: "last number" } : { value: NaN, how: "no number" };
}
const gsmSchema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "The steps, before the answer." },
    answer: { type: "number", description: "The final numeric answer." },
  },
  required: ["work", "answer"],
};
const sameNumber = (got, want) => Number.isFinite(got) && Number.isFinite(want) && Math.abs(got - want) < 1e-6;

export const gsm8k = {
  name: "gsm8k",
  ...common("gsm8k"),
  description: "GSM8K test problems (public anchor, MIT): grade-school word problems with one numeric answer. Free-form is zero-shot chain of thought; the harness adds the calculator and the work-then-answer schema.",
  maxRounds: 12,
  setup: async ({ index }) => {
    const set = needSet("gsm8k");
    const { item, position } = anchorItem(set, index);
    return { position, question: item.question, answer: gsm8kAnswer(item.answer), provenance: anchorProvenance(set) };
  },
  goal: (ctx) => `Solve this grade-school problem and give the final number: ${ctx.question}`,
  noHarness: {
    prompt: (ctx) => `${ctx.question}\n\nSolve the problem step by step. Then give the final answer on its own last line as "#### <number>".`,
    extract: "text",
  },
  toolOnly: {
    system: "You are a careful analyst. Use the calc tool for every arithmetic step — never do arithmetic in your head.",
    prompt: (ctx) => `${ctx.question}\n\nUse calc for each step. Then give the final answer on its own last line as "#### <number>".`,
    tools: [calcTool],
    extract: "text",
  },
  harness: {
    system: "You are a careful analyst. Use the calc tool for every arithmetic step — never do arithmetic in your head — and return the requested JSON.",
    prompt: (ctx) => `${ctx.question}\n\nUse calc for each step, then answer with a JSON object { "work": ["<step>", …], "answer": <number> } — the working first, then the answer.`,
    tools: [calcTool],
    schema: gsmSchema,
    extract: "structured",
  },
  schemaOnly: {
    system: "You are a careful analyst. Return the requested JSON.",
    prompt: (ctx) => `${ctx.question}\n\nAnswer with a JSON object { "work": ["<step>", …], "answer": <number> } — the working first, then the answer.`,
    tools: [],
    schema: gsmSchema,
    extract: "structured",
  },
  eval: {
    ground: ({ ctx } = {}) => ({ answer: ctx?.answer ?? NaN }),
    scoreHarness: (out, ground) => {
      const got = out && typeof out === "object" ? Number(out.answer) : NaN;
      return sameNumber(got, ground.answer) ? { correct: true, reason: `${ground.answer} — right` } : { correct: false, reason: `answered ${Number.isFinite(got) ? got : "nothing numeric"}, expected ${ground.answer}` };
    },
    scoreNoHarness: (text, ground) => {
      const { value, how } = gsm8kRead(text);
      return sameNumber(value, ground.answer) ? { correct: true, reason: `${ground.answer} — right (${how})` } : { correct: false, reason: `answered ${Number.isFinite(value) ? value : "nothing numeric"} (${how}), expected ${ground.answer}` };
    },
    toolUse: ({ toolCalls }) => (toolCalls.some((c) => c.name === "calc") ? { ok: true, reason: `${toolCalls.filter((c) => c.name === "calc").length} calc call(s)` } : { ok: false, reason: "calc was never called" }),
    canon: (answer, { structured }) => { const v = structured ? Number(answer?.answer) : gsm8kRead(answer).value; return Number.isFinite(v) ? String(v) : null; },
  },
};

// ---- IFEval ----------------------------------------------------------------------------------
export const ifeval = {
  name: "ifeval",
  ...common("ifeval"),
  description: "IFEval prompts (public anchor, Apache-2.0): verifiable formatting instructions checked by code — strict prompt-level pass, the loose verdict in the reason. Free-form only: the format is the test.",
  setup: async ({ index }) => {
    const set = needSet("ifeval");
    const { item, position } = anchorItem(set, index);
    return { position, key: item.key, prompt: item.prompt, instruction_id_list: item.instruction_id_list, kwargs: item.kwargs, provenance: anchorProvenance(set) };
  },
  goal: (ctx) => ctx.prompt,
  noHarness: {
    prompt: (ctx) => ctx.prompt,
    extract: "text",
  },
  eval: {
    ground: ({ ctx } = {}) => ({ instruction_id_list: ctx?.instruction_id_list ?? [], kwargs: ctx?.kwargs ?? [] }),
    scoreHarness: () => ({ correct: false, reason: "ifeval runs free-form only" }),
    scoreNoHarness: (text, ground) => {
      const r = checkPrompt(ground, text);
      const failed = r.instructions.filter((x) => !x.strict).map((x) => x.id);
      const n = r.instructions.length;
      const strictN = r.instructions.filter((x) => x.strict).length;
      const looseN = r.instructions.filter((x) => x.loose).length;
      const approx = r.approximate ? "; an approximate checker took part" : "";
      return r.strict
        ? { correct: true, reason: `all ${n} instruction(s) followed (strict)${approx}` }
        : { correct: false, reason: `${strictN}/${n} instruction(s) followed strictly, ${looseN}/${n} loosely (failed: ${failed.join(", ")})${approx}` };
    },
  },
};

// ---- BFCL ------------------------------------------------------------------------------------
const BFCL_SYSTEM = (functions) => `You are an expert in composing functions. You are given a question and a set of possible functions. Based on the question, you will need to make one function call to achieve the purpose. If none of the functions can be used, point it out. If the given question lacks the parameters required by the function, also point it out. You should only return the function call in your response. If you decide to invoke a function, you MUST put it in the format of [func_name1(params_name1=params_value1, params_name2=params_value2...)]. You SHOULD NOT include any other text in the response.\n\nHere is a list of functions in JSON format that you can invoke.\n${JSON.stringify(functions)}`;
const bfclSchema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "What you decided, before the answer." },
    called: { type: "string", description: "The name of the function you called." },
  },
  required: ["called"],
};
function makeBfcl(name, label) {
  return {
    name,
    ...common(name),
    description: `${label} (public anchor, Apache-2.0): the call scored against the possible answers — free-form is BFCL's prompting mode (the call written as text), the tool modes are native tool calling.`,
    maxRounds: 4,
    setup: async ({ index }) => {
      const set = needSet(name);
      const { item, position, answer } = anchorItem(set, index);
      const question = item.question.flat().filter((m) => m.role === "user").map((m) => m.content).join("\n");
      return { position, id: item.id, question, functions: item.function, groundTruth: answer?.ground_truth ?? [], provenance: anchorProvenance(set) };
    },
    goal: (ctx) => `Given these functions ${JSON.stringify(ctx.functions.map((f) => f.name))}, make the one call that answers: ${ctx.question}`,
    noHarness: {
      system: (ctx) => BFCL_SYSTEM(ctx.functions),
      prompt: (ctx) => ctx.question,
      extract: "text",
    },
    toolOnly: {
      system: "Use the tools to fulfil the request: make the one function call that answers it, with the parameters the request gives. When the call has been made, reply with the word done.",
      prompt: (ctx) => ctx.question,
      tools: (ctx) => toolsFrom(ctx.functions),
      extract: "text",
    },
    harness: {
      system: "Use the tools to fulfil the request: make the one function call that answers it, with the parameters the request gives. Then return the requested JSON.",
      prompt: (ctx) => `${ctx.question}\n\nAfter the call, answer with a JSON object { "work": [...], "called": "<function name>" }.`,
      tools: (ctx) => toolsFrom(ctx.functions),
      schema: bfclSchema,
      extract: "structured",
    },
    eval: {
      // Truth includes what the trial actually called: in the tool modes the call is the answer.
      ground: ({ toolCalls = [], ctx } = {}) => ({
        groundTruth: ctx?.groundTruth ?? [],
        functions: ctx?.functions ?? [],
        calls: toolCalls.map((c) => ({ name: (ctx?.functions ?? []).find((f) => toolName(f.name) === c.name)?.name ?? c.name, arguments: c.arguments ?? {} })),
      }),
      scoreHarness: (_out, ground) => { const r = scoreCalls(ground.calls, ground.groundTruth, ground.functions); return { correct: r.ok, reason: r.reason }; },
      scoreNoHarness: (text, ground, { mode } = {}) => {
        const calls = mode === "noHarness" ? parseCalls(text) : ground.calls;
        const r = scoreCalls(calls, ground.groundTruth, ground.functions);
        return { correct: r.ok, reason: mode === "noHarness" && !calls.length ? "no function call could be read from the text" : r.reason };
      },
      toolUse: ({ toolCalls, ctx }) => {
        const calls = toolCalls.map((c) => ({ name: (ctx?.functions ?? []).find((f) => toolName(f.name) === c.name)?.name ?? c.name, arguments: c.arguments ?? {} }));
        const r = scoreCalls(calls, ctx?.groundTruth ?? [], ctx?.functions ?? []);
        return { ok: r.ok, reason: r.reason };
      },
    },
  };
}

export const bfclsimple = makeBfcl("bfclsimple", "BFCL v4 simple: one function, one call");
export const bfclmultiple = makeBfcl("bfclmultiple", "BFCL v4 multiple: several functions, the right one called");
export const publicTasks = [gsm8k, ifeval, bfclsimple, bfclmultiple];
