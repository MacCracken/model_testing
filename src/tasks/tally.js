// Task family: tally — counting and summing over an inline table, minted per trial.
//
// A table of support tickets (id, region, status, amount, days open) is given in the prompt; the
// question is one count, sum or maximum under a filter. The row count is the knob (tally20 / 60).
// The harness axis is a query tool that filters and aggregates the same rows, so the model can
// delegate the counting instead of doing it by eye.

import { labelModel } from "../providers/index.js";
import { typos } from "../perturb.js";
import { dice, numberIn } from "./gen.js";

const REGIONS = ["north", "south", "east", "west"];
const STATUSES = ["open", "closed", "overdue"];

export function generate(seed, n) {
  const d = dice(seed);
  const rows = Array.from({ length: n }, (_, i) => ({ id: `T-${1001 + i}`, region: d.pick(REGIONS), status: d.pick(STATUSES), amount: d.int(10, 999), days: d.int(0, 90) }));
  const region = d.pick(REGIONS);
  const status = d.pick(STATUSES);
  const kind = d.pick(["count-region-status", "sum-status", "max-days-region", "count-amount-region"]);
  let question, answer, query;
  if (kind === "count-region-status") {
    question = `How many tickets are from the ${region} region with status ${status}?`;
    answer = rows.filter((r) => r.region === region && r.status === status).length;
    query = { region, status, aggregate: "count" };
  } else if (kind === "sum-status") {
    question = `What is the total amount across all tickets with status ${status}?`;
    answer = rows.filter((r) => r.status === status).reduce((a, r) => a + r.amount, 0);
    query = { status, aggregate: "sum_amount" };
  } else if (kind === "max-days-region") {
    question = `What is the largest number of days open among tickets from the ${region} region?`;
    answer = Math.max(0, ...rows.filter((r) => r.region === region).map((r) => r.days));
    query = { region, aggregate: "max_days" };
  } else {
    const threshold = d.pick([200, 300, 400, 500, 600]);
    question = `How many tickets from the ${region} region have an amount greater than ${threshold}?`;
    answer = rows.filter((r) => r.region === region && r.amount > threshold).length;
    query = { region, amount_gt: threshold, aggregate: "count" };
  }
  return { seed, n, rows, question, answer, query };
}

// The same table with a question it cannot answer: a column it does not have.
const MISSING = [
  (r, s) => [`What is the total refund amount across all tickets with status ${s}?`, "a refund column"],
  (r) => [`How many tickets from the ${r} region are assigned to Priya?`, "an assignee column"],
  (r) => [`What is the average priority level of the tickets from the ${r} region?`, "a priority column"],
  (r, s) => [`How many tickets with status ${s} were opened by customers in the ${r} region who had called before?`, "a call-history column"],
];
export function unanswerable(ctx) {
  const d = dice((ctx.seed >>> 0) ^ 0xab);
  const [question, missing] = d.pick(MISSING)(d.pick(REGIONS), d.pick(STATUSES));
  return { ...ctx, question, answer: null, query: null, unanswerable: true, missing };
}

export function runQuery(rows, { region, status, amount_gt, aggregate }) {
  let sel = rows;
  if (region) sel = sel.filter((r) => r.region === String(region).toLowerCase());
  if (status) sel = sel.filter((r) => r.status === String(status).toLowerCase());
  if (amount_gt !== undefined && amount_gt !== null) sel = sel.filter((r) => r.amount > Number(amount_gt));
  if (aggregate === "count") return { matched: sel.length, result: sel.length };
  if (aggregate === "sum_amount") return { matched: sel.length, result: sel.reduce((a, r) => a + r.amount, 0) };
  if (aggregate === "max_days") return { matched: sel.length, result: sel.length ? Math.max(...sel.map((r) => r.days)) : 0 };
  throw new Error(`unknown aggregate "${aggregate}" — use count, sum_amount or max_days`);
}

const table = (rows, format = "pipes") => (format === "csv"
  ? ["id,region,status,amount,days_open", ...rows.map((r) => `${r.id},${r.region},${r.status},${r.amount},${r.days}`)].join("\n")
  : ["id | region | status | amount | days_open", ...rows.map((r) => `${r.id} | ${r.region} | ${r.status} | ${r.amount} | ${r.days}`)].join("\n"));

// The same table and question, rewritten: rows in another order, a CSV table, or the question in
// other words (derived from the query behind it).
const REPHRASE = (q) => {
  if (q.aggregate === "count" && q.amount_gt !== undefined) return `How many ${q.region}-region tickets have an amount above ${q.amount_gt}?`;
  if (q.aggregate === "count") return `Count the tickets from the ${q.region} region whose status is ${q.status}.`;
  if (q.aggregate === "sum_amount") return `Add up the amounts of every ticket with status ${q.status}. What is the total?`;
  if (q.aggregate === "max_days") return `Among the ${q.region} region's tickets, what is the highest days_open value?`;
  return null;
};
export function perturb(ctx, kind, seed = 0) {
  if (!Array.isArray(ctx?.rows)) return null;
  if (kind === "order") return { ...ctx, rows: dice((seed >>> 0) ^ 0x9e37).shuffle(ctx.rows), perturbed: kind };
  if (kind === "format") return { ...ctx, tableFormat: "csv", perturbed: kind };
  if (kind === "paraphrase") { const q = ctx.query ? REPHRASE(ctx.query) : null; return q ? { ...ctx, question: q, perturbed: kind } : null; }
  if (kind === "typos") {
    // Typing errors in the question; the table, the regions and the statuses it names are untouched.
    const question = typos(ctx.question, seed, { protect: [...REGIONS, ...STATUSES, "amount", "days", "days_open"] });
    return question === ctx.question ? null : { ...ctx, question, perturbed: kind };
  }
  return null;
}

// The query tool works on this trial's rows, so it is built per trial.
export const toolsFor = (ctx) => [{
  name: "query_rows",
  description: "Filter the ticket table and aggregate: count matching rows, sum their amount, or take the largest days_open. Filters are optional and combine with AND.",
  parameters: {
    type: "object",
    properties: {
      region: { type: "string", enum: REGIONS },
      status: { type: "string", enum: STATUSES },
      amount_gt: { type: "integer", description: "keep rows with amount strictly greater than this" },
      aggregate: { type: "string", enum: ["count", "sum_amount", "max_days"] },
    },
    required: ["aggregate"],
  },
  impl: async (args) => runQuery(ctx?.rows ?? [], args),
}];

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "Your working, one step per entry, written before the answer." },
    answer: { type: "integer" },
  },
  required: ["answer"],
};
const answerOf = (out) => Number(out && typeof out === "object" ? (out.answer ?? out.result ?? out.value) : out);

function makeTally(n) {
  const problem = (ctx) => `Here is a table of ${ctx.rows.length} support tickets${ctx.tableFormat === "csv" ? " (CSV)" : ""}:\n\n${table(ctx.rows, ctx.tableFormat)}\n\n${ctx.question}`;
  return {
    name: `tally${n}`,
    family: "tally",
    level: n,
    category: "reasoning",
    seeded: true,
    capabilities: ["counting", "attention"],
    description: `One count, sum or maximum over an inline table of ${n} tickets, minted per trial. With tools, a query over the same rows.`,
    model: labelModel,
    maxRounds: 5,

    setup: async ({ seed }) => generate(seed >>> 0, n),
    unanswerable,
    perturb,
    perturbs: ["paraphrase", "order", "format", "typos"],

    goal: (ctx) => `${problem(ctx)} Give the number.`,

    noHarness: {
      prompt: (ctx) => `${problem(ctx)}\n\nCount carefully and finish with a line of the form "answer: <number>".`,
      extract: "text",
    },
    harness: {
      system: "You are a careful analyst. Use the query_rows tool to compute the answer instead of counting by eye, and return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)}\n\nUse query_rows, then answer with a JSON object { "work": ["<step>", …], "answer": <integer> }.`,
      tools: toolsFor,
      schema,
      extract: "structured",
    },
    schemaOnly: {
      system: "You are a careful analyst. Return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)}\n\nAnswer with a JSON object { "work": ["<step>", …], "answer": <integer> } — list the matching rows in "work" first, then the answer.`,
      tools: [],
      schema,
      extract: "structured",
    },
    toolOnly: {
      system: "You are a careful analyst. Use the query_rows tool to compute the answer instead of counting by eye.",
      prompt: (ctx) => `${problem(ctx)}\n\nUse query_rows, then finish with a line of the form "answer: <number>".`,
      tools: toolsFor,
      extract: "text",
    },

    eval: {
      ground: ({ ctx } = {}) => ctx?.answer ?? null,
      toolUse: ({ toolCalls, toolResults, ctx }) => {
        const calls = toolCalls.filter((c) => c.name === "query_rows");
        if (ctx?.unanswerable) return { ok: true, reason: calls.length ? `${calls.length} query call(s) on a question the table cannot answer` : "nothing to compute: the table lacks the column" };
        if (!calls.length) return { ok: false, reason: "query_rows was never called — counted by eye" };
        const failed = toolResults.filter((r) => r.name === "query_rows" && r.ok === false).length;
        if (failed) return { ok: false, reason: `${failed} query_rows call(s) failed` };
        const right = calls.some((c) => { try { return runQuery(ctx?.rows ?? [], c.arguments ?? {}).result === ctx?.answer; } catch { return false; } });
        return right ? { ok: true, reason: "a query computed the asked-for figure" } : { ok: false, reason: `${calls.length} query call(s), none matched the question's filter` };
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
      canon: (answer, { structured }) => { const v = structured ? answerOf(answer) : numberIn(answer); return Number.isFinite(v) ? String(v) : "none"; },
    },
  };
}

export const tallyTasks = [20, 60].map(makeTally);
export { schema, makeTally, REGIONS, STATUSES };
