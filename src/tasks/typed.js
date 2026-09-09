// Task: typed — a strict server that rejects an argument of the wrong JSON type.
//
// Three items are to be set to counted quantities given in words ("twenty-four"), with status
// "counted". The tool's schema says the quantity is an integer, and the scenario is strict: a
// quantity sent as a string, a float or a word is refused with 400 and a message that says so. The
// right behaviour is to send integers — and, after a refusal, to read the message and resend.
// Scored on the server's end state (the three quantities and statuses, nothing else touched) and
// the report (the ids and the total of the new quantities); the tool-use verdict counts the type
// refusals and whether every item was set in the end. Free-form mode has no tools: the control.

import { labelModel } from "../providers/index.js";
import { dice } from "./gen.js";
import { BASE } from "./util.js";
import { api, enc, createScenario, endState } from "./scenario.js";
import { parseReport } from "./restock.js";

export const STATUS = "counted";
const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export function words(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
}

const setStockTool = {
  name: "set_stock",
  description: "Set one item's counted quantity and status. Returns the updated item and a ticket. The scenario is strict: qty must be a JSON integer, status a string; anything else is refused with 400 and an explanation.",
  parameters: {
    type: "object",
    properties: {
      scenario: { type: "string", description: "The scenario id." },
      id: { type: "string", description: "The item id (sku-…)." },
      qty: { type: "integer", description: "The counted quantity, as a JSON integer." },
      status: { type: "string", description: "The new status." },
    },
    required: ["scenario", "id", "qty", "status"],
  },
  impl: async ({ scenario, id, qty, status }) => api("PATCH", `/api/scenarios/${enc(scenario)}/items/${enc(id)}`, { qty, status }),
};

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "What you did, before the answer." },
    updated: { type: "array", items: { type: "string" }, description: "The ids you set." },
    total: { type: "integer", description: "The sum of the three counted quantities you set." },
  },
  required: ["updated", "total"],
};

export function expectedFrom(ctx) {
  const after = Object.fromEntries(ctx.items.map((i) => [i.id, { qty: i.qty, status: i.status }]));
  for (const c of ctx.counts) after[c.id] = { qty: c.qty, status: STATUS };
  return { after, updated: ctx.counts.map((c) => c.id).sort(), total: ctx.counts.reduce((a, c) => a + c.qty, 0) };
}

export function endStateVerdict(ground) {
  if (!ground?.state) return `the scenario's end state could not be read${ground?.error ? ` (${ground.error})` : ""}`;
  const wrong = [];
  const collateral = [];
  for (const item of ground.state.items) {
    const want = ground.after[item.id];
    if (!want || (item.qty === want.qty && item.status === want.status)) continue;
    (ground.updated.includes(item.id) ? wrong : collateral).push(`${item.id} is ${item.qty}/${item.status}, wanted ${want.qty}/${want.status}`);
  }
  if (wrong.length === ground.updated.length && !collateral.length) return "nothing was set on the server";
  if (wrong.length) return `${wrong.length}/${ground.updated.length} counts not set: ${wrong.slice(0, 3).join("; ")}`;
  if (collateral.length) return `${collateral.length} other item(s) got modified: ${collateral.slice(0, 3).join("; ")}`;
  return null;
}

function judgeReport(ids, total, ground) {
  const why = endStateVerdict(ground);
  if (why) return { correct: false, reason: why };
  const got = [...new Set(ids.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort();
  const missing = ground.updated.filter((x) => !got.includes(x));
  const extra = got.filter((x) => !ground.updated.includes(x));
  if (missing.length || extra.length) return { correct: false, reason: `server state is right, but the report ${missing.length ? `omits ${missing.length} id(s)` : ""}${missing.length && extra.length ? " and " : ""}${extra.length ? `lists ${extra.length} id(s) that were not set` : ""}` };
  if (Number(total) !== ground.total) return { correct: false, reason: `server state is right, but the reported total ${total} ≠ ${ground.total}` };
  return { correct: true, reason: `all three counts set, statuses "${STATUS}", total ${ground.total} — right` };
}

export const REFUSAL = /must be a JSON (integer|string)/i;

export const task = {
  name: "typed",
  category: "tool-reasoning",
  capabilities: ["tool-use", "argument-types"],
  seeded: true,
  description: "Set three items to counted quantities given in words on a strict server that refuses a quantity sent as a string, a float or a word; recover from any refusal. Scored on the end state and the report. Minted per trial.",
  model: labelModel,
  maxRounds: 8,

  setup: async ({ seed }) => {
    const d = dice((seed >>> 0) ^ 0x7e7e);
    const s = await createScenario({ low: 2, size: 8, seed: seed >>> 0, strict: true });
    const picked = d.shuffle(s.items).slice(0, 3);
    const counts = picked.map((i) => ({ id: i.id, qty: d.int(1, 99) }));
    return { scenario: s.id, items: s.items, counts, strict: true };
  },

  goal: (ctx) => `A webserver runs at ${BASE}. Scenario ${ctx.scenario}: PATCH /api/scenarios/${ctx.scenario}/items/<id> with JSON { "qty": <integer>, "status": "${STATUS}" } sets an item's counted stock — the server is strict: qty must be a JSON integer (not a string, float or word), status a string; anything else is refused with 400 and an explanation. Set ${ctx.counts.map((c) => `${c.id} to ${words(c.qty)}`).join("; ")}, each with status "${STATUS}", then report the ids you set and the total of the three quantities.`,

  noHarness: {
    prompt: (ctx) => `Scenario ${ctx.scenario}. The stock count says: ${ctx.counts.map((c) => `${c.id} has ${words(c.qty)} units`).join("; ")}. Each of these items must be set to that quantity with status "${STATUS}". WITHOUT any tools you cannot reach the server, so nothing can actually be set. Report your best attempt anyway, as two lines: \`updated: <comma-separated ids>\` and \`total: <sum of the three quantities>\`.`,
    extract: "text",
  },
  harness: {
    system: `You are a careful inventory assistant working a strict API: set_stock takes qty as a JSON integer and status as a string, and refuses anything else with a message that says why. Read any refusal and resend correctly.`,
    prompt: (ctx) => `Scenario ${ctx.scenario}. The stock count says: ${ctx.counts.map((c) => `${c.id} has ${words(c.qty)} units`).join("; ")}. Set each of these three items to that quantity with status "${STATUS}" using set_stock, then answer with a JSON object { "work": [...], "updated": [ids], "total": <sum of the three quantities> }.`,
    tools: [setStockTool],
    schema,
    extract: "structured",
  },
  toolOnly: {
    system: `You are a careful inventory assistant working a strict API: set_stock takes qty as a JSON integer and status as a string, and refuses anything else with a message that says why. Read any refusal and resend correctly.`,
    prompt: (ctx) => `Scenario ${ctx.scenario}. The stock count says: ${ctx.counts.map((c) => `${c.id} has ${words(c.qty)} units`).join("; ")}. Set each of these three items to that quantity with status "${STATUS}" using set_stock, then answer with exactly two lines: \`updated: <comma-separated ids>\` and \`total: <sum of the three quantities>\`.`,
    tools: [setStockTool],
    extract: "text",
  },

  eval: {
    ground: async ({ ctx } = {}) => (ctx?.scenario ? { ...expectedFrom(ctx), ...(await endState(ctx)) } : null),
    toolUse: ({ toolCalls, toolResults, ctx }) => {
      const sets = toolCalls.filter((c) => c.name === "set_stock");
      if (!sets.length) return { ok: false, reason: "set_stock was never called" };
      const refused = toolResults.filter((r) => r.name === "set_stock" && r.ok === false && REFUSAL.test(String(r.content ?? ""))).length;
      const wrongType = sets.filter((c) => typeof c.arguments?.qty !== "number" || !Number.isInteger(c.arguments.qty)).length;
      const final = {};
      for (const c of sets) final[String(c.arguments?.id ?? "")] = c.arguments;
      const missed = (ctx?.counts ?? []).filter((w) => !final[w.id] || Number(final[w.id].qty) !== w.qty || typeof final[w.id].qty !== "number" || String(final[w.id].status ?? "") !== STATUS);
      const note = refused ? `${refused} refused for type${wrongType ? ` (${wrongType} sent with a non-integer qty)` : ""}, ` : wrongType ? `${wrongType} sent with a non-integer qty, ` : "";
      if (missed.length) return { ok: false, reason: `${note}${missed.length} of 3 counts never set with the right integer and status` };
      return { ok: true, reason: `${note}all three counts set as integers${refused ? " after recovering" : ", no refusals"}` };
    },
    scoreHarness: (out, ground) => {
      if (!out || typeof out !== "object") { const why = endStateVerdict(ground); return { correct: false, reason: why ?? "server state is right, but there is no structured answer" }; }
      const raw = out.updated ?? out.ids ?? [];
      const ids = typeof raw === "string" ? raw.split(/[,\s]+/) : Array.isArray(raw) ? raw.map((x) => (x && typeof x === "object" ? x.id : x)) : [];
      return judgeReport(ids, Number(out.total), ground);
    },
    scoreNoHarness: (out, ground) => {
      const { ids, total } = parseReport(out);
      return judgeReport(ids, total, ground);
    },
  },
};

export { schema, setStockTool };
