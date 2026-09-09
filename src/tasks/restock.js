// Task family: restock — a multi-step job against an isolated inventory scenario.
//
//   list the items → for every item with qty below its min: update it (qty = target, status =
//   "reordered"); each update returns a ticket → confirm with the complete set of tickets → report
//   the ids changed and the total quantity across all items afterwards.
//
// The number of low items is the knob (restock3 / restock6 / restock12 / restock30 — the last in an
// inventory of 60, the scenario cap), so success can be drawn against the length of the dependent chain. Each trial creates its own scenario in `setup`, so
// parallel trials never share state; prompts, goal and truth are functions of that context. Truth is
// the server's **end state**, read after the model answers — a right-looking report over an
// unchanged inventory scores wrong. Free-form mode has no tools and cannot act: it is the control.

import { labelModel } from "../providers/index.js";
import { BASE, unwrapList } from "./util.js";
import { summarizeOps } from "../stress.js";

const STATUS = "reordered";
const enc = (v) => encodeURIComponent(String(v ?? ""));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}${data?.error ? `: ${data.error}` : ""}`);
  return data;
}

const tools = [
  {
    name: "list_items",
    description: "List every item in an inventory scenario. Each item is { id, name, qty, min, target, status }.",
    parameters: { type: "object", properties: { scenario: { type: "string", description: "The scenario id." } }, required: ["scenario"] },
    impl: async ({ scenario }) => api("GET", `/api/scenarios/${enc(scenario)}/items`),
  },
  {
    name: "update_item",
    description: "Update one item's qty and/or status. Returns the updated item and a ticket for the change.",
    parameters: {
      type: "object",
      properties: {
        scenario: { type: "string", description: "The scenario id." },
        id: { type: "string", description: "The item id (sku-…)." },
        qty: { type: "integer", description: "The new quantity." },
        status: { type: "string", description: "The new status." },
      },
      required: ["scenario", "id"],
    },
    impl: async ({ scenario, id, qty, status }) => api("PATCH", `/api/scenarios/${enc(scenario)}/items/${enc(id)}`, {
      ...(qty !== undefined ? { qty } : {}),
      ...(status !== undefined ? { status } : {}),
    }),
  },
  {
    name: "get_summary",
    description: "Current totals for a scenario: { items, totalQty, low, confirmed } — low is how many items are still below their minimum.",
    parameters: { type: "object", properties: { scenario: { type: "string", description: "The scenario id." } }, required: ["scenario"] },
    impl: async ({ scenario }) => api("GET", `/api/scenarios/${enc(scenario)}/summary`),
  },
  {
    name: "confirm_restock",
    description: "Close the restock job by confirming every ticket that update_item returned in this scenario. Fails while any item is still below its minimum, or if the ticket set is incomplete.",
    parameters: {
      type: "object",
      properties: { scenario: { type: "string" }, tickets: { type: "array", items: { type: "string" }, description: "All tickets returned by update_item." } },
      required: ["scenario", "tickets"],
    },
    impl: async ({ scenario, tickets }) => api("POST", `/api/scenarios/${enc(scenario)}/confirm`, { tickets: Array.isArray(tickets) ? tickets : [tickets] }),
  },
];

// The "distractors" stress profile adds tools that look relevant and are not. reorder_all is the
// trap: it marks every item reordered without fixing a quantity, which the end state scores as
// collateral edits plus unrestocked items.
const distractorTools = [
  {
    name: "get_item_history",
    description: "Recent stock counts for one item: { id, history: [{ at, qty }] }.",
    parameters: { type: "object", properties: { scenario: { type: "string" }, id: { type: "string" } }, required: ["scenario", "id"] },
    impl: async ({ scenario, id }) => api("GET", `/api/scenarios/${enc(scenario)}/items/${enc(id)}/history`),
  },
  {
    name: "set_item_price",
    description: "Set one item's unit price. Returns the updated item.",
    parameters: { type: "object", properties: { scenario: { type: "string" }, id: { type: "string" }, price: { type: "number" } }, required: ["scenario", "id", "price"] },
    impl: async ({ scenario, id, price }) => api("PATCH", `/api/scenarios/${enc(scenario)}/items/${enc(id)}/price`, { price }),
  },
  {
    name: "reorder_all",
    description: "Mark every item in the scenario as reordered in one call.",
    parameters: { type: "object", properties: { scenario: { type: "string" } }, required: ["scenario"] },
    impl: async ({ scenario }) => api("POST", `/api/scenarios/${enc(scenario)}/reorder-all`),
  },
];
const DISTRACTOR_TOOLS = new Set(distractorTools.map((t) => t.name));
// The tools a trial gets depend on its scenario's stress profile.
const toolsFor = (ctx) => (ctx?.stress === "distractors" ? [...tools, ...distractorTools] : tools);

const schema = {
  type: "object",
  properties: {
    changed: { type: "array", items: { type: "string" }, description: "Ids of the items you updated." },
    totalQty: { type: "integer", description: "The scenario's totalQty after your changes, as the summary reports it." },
  },
  required: ["changed", "totalQty"],
};

// What the inventory must look like when the job is done, from its initial items.
export function expectedFrom(items) {
  const low = items.filter((i) => i.qty < i.min);
  const after = {};
  let totalQty = 0;
  for (const i of items) {
    const isLow = i.qty < i.min;
    after[i.id] = { qty: isLow ? i.target : i.qty, status: isLow ? STATUS : i.status };
    totalQty += after[i.id].qty;
  }
  return { changed: low.map((i) => i.id).sort(), totalQty, after };
}

// Why the server's end state is not the finished job — or null when it is.
export function endStateVerdict(ground) {
  if (!ground?.state) return `the scenario's end state could not be read${ground?.error ? ` (${ground.error})` : ""}`;
  const wanted = new Set(ground.changed);
  const missed = [];
  const collateral = [];
  for (const item of ground.state.items) {
    const want = ground.after[item.id];
    if (!want) continue;
    if (item.qty === want.qty && item.status === want.status) continue;
    (wanted.has(item.id) ? missed : collateral).push(item.id);
  }
  const brief = (ids) => ids.slice(0, 3).join(", ") + (ids.length > 3 ? ", …" : "");
  if (missed.length === ground.changed.length && !collateral.length && !ground.state.confirmed) return "nothing was changed on the server";
  if (missed.length) return `${missed.length}/${ground.changed.length} low items not restocked correctly (${brief(missed)})`;
  if (collateral.length) return `${collateral.length} item(s) that were not low got modified (${brief(collateral)})`;
  if (!ground.state.confirmed) return "every low item was restocked but the job was never confirmed with its tickets";
  return null;
}

// The report half of the score: the ids and the total the model reported, against expectation.
function judgeReport(ids, total, ground) {
  const want = ground.changed.map((x) => x.toLowerCase());
  const got = [...new Set(ids.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort();
  const missing = want.filter((x) => !got.includes(x));
  const extra = got.filter((x) => !want.includes(x));
  if (missing.length || extra.length) {
    return {
      correct: false,
      reason: `server state is right, but the report ${[missing.length ? `omits ${missing.length} changed id(s)` : "", extra.length ? `lists ${extra.length} id(s) that were not changed` : ""].filter(Boolean).join(" and ")}`,
    };
  }
  if (!Number.isFinite(total)) return { correct: false, reason: "server state is right, but the report has no total quantity" };
  if (total !== ground.totalQty) return { correct: false, reason: `server state is right, but the reported total ${total} ≠ ${ground.totalQty}` };
  return { correct: true, reason: `all ${want.length} low items restocked, confirmed, and reported correctly (total ${total})` };
}

// Free-form report: ids as sku-NNNN anywhere, total as "total … N".
export function parseReport(text) {
  const t = String(text ?? "");
  const ids = t.toLowerCase().match(/sku-\d{4}/g) ?? [];
  const m = t.match(/total[^0-9\n]{0,40}?(\d[\d,]*)/i);
  return { ids, total: m ? Number(m[1].replace(/,/g, "")) : NaN };
}

function makeRestock(low) {
  const name = `restock${low}`;
  const rules = (ctx) =>
    `Scenario id: ${ctx.scenario}. An item needs restocking when its qty is below its min. ` +
    `For every such item, update it so that qty = its target and status = "${STATUS}" (one update per item; every update returns a ticket). ` +
    "When all of them are updated, confirm the restock with the complete list of tickets — the server refuses to confirm while any item is still below its minimum. " +
    "Then report the ids you changed and the total qty across ALL items after your changes, as the server reports it." +
    (ctx.budget ? ` You have at most ${ctx.budget} requests to this scenario in total — listing, updating, confirming and the summary all count — and every request after that is refused.` : "") +
    (ctx.stress === "distractors" ? " The scenario also offers per-item history, price updates and a reorder-all shortcut." : "");
  const system = "You are a careful operations agent working an inventory API. Read before you write, use the values the server gives you, and finish with the requested answer.";

  return {
    name,
    family: "restock",
    level: low,
    skill: "restock", // the family shares skills/restock.md
    category: "multi-step",
    capabilities: ["multi-step","planning","tool-use","state"],
    description:
      `Restock ${low} low items in an inventory of ${Math.min(60, low * 2 + 2)}: list, ${low} dependent updates (each returns a ticket), confirm with the tickets (refused while anything is still low), report the server's total. Scored on the server's end state.`,
    model: labelModel,
    // The synthetic tool loop needs a round per dependent step (models often issue one call at a
    // time), plus room for a second pass after the server refuses an early confirm.
    maxRounds: 2 * low + 8,

    // Each trial gets its own scenario, so trials never share inventory — in parallel included.
    // A client run under a stress profile ("…@stress:<profile>") asks the server for that profile.
    setup: async ({ client } = {}) => {
      const stress = client?.stress ?? null;
      const s = await api("POST", "/api/scenarios", { low, ...(stress ? { stress } : {}) });
      return { scenario: s.id, seed: s.seed, items: s.items, low, size: s.items.length, stress: s.stress ?? null, budget: s.budget ?? null };
    },

    goal: (ctx) =>
      `A webserver runs at ${BASE}. Inventory scenario ${ctx.scenario}: GET /api/scenarios/${ctx.scenario}/items lists the ` +
      "items as { id, name, qty, min, target, status }. An item needs restocking when qty < min. For every such item, " +
      `PATCH /api/scenarios/${ctx.scenario}/items/<id> with JSON { "qty": <its target>, "status": "${STATUS}" } — each PATCH ` +
      `returns a ticket. When every such item is updated, POST /api/scenarios/${ctx.scenario}/confirm with JSON ` +
      "{ \"tickets\": [all the tickets] } — it answers 409 while any item is still below its minimum. " +
      `GET /api/scenarios/${ctx.scenario}/summary returns { items, totalQty, low }. Finally report the ids you changed ` +
      "and totalQty across ALL items after your changes, as the server reports it." +
      (ctx.budget ? ` You have at most ${ctx.budget} requests to this scenario in total — every endpoint above counts — and every request after that is refused.` : "") +
      (ctx.stress === "distractors" ? ` GET /api/scenarios/${ctx.scenario}/items/<id>/history, PATCH /api/scenarios/${ctx.scenario}/items/<id>/price { "price" } and POST /api/scenarios/${ctx.scenario}/reorder-all also exist.` : ""),

    // ---- no-harness mode: the control. No tools, so the inventory cannot change. ----
    noHarness: {
      prompt: (ctx) =>
        `${rules(ctx)} WITHOUT any tools: you cannot reach the server or see the items, so nothing can actually be updated. ` +
        "Report your best attempt anyway, as two lines: `changed: <comma-separated ids>` and `total: <number>`.",
      extract: "text",
    },

    // ---- with-harness mode ----
    harness: {
      system,
      prompt: (ctx) =>
        `${rules(ctx)} Use list_items, update_item, confirm_restock and get_summary. Answer with a JSON object: ` +
        '{ "changed": [ids you updated], "totalQty": <the summary\'s totalQty after your changes> }.',
      tools: toolsFor,
      schema,
      extract: "structured",
    },

    // ---- tools only: the same job, free-form report ----
    toolOnly: {
      system,
      prompt: (ctx) =>
        `${rules(ctx)} Use list_items, update_item, confirm_restock and get_summary. Then answer with exactly two lines: ` +
        "`changed: <comma-separated ids>` and `total: <number>`.",
      tools: toolsFor,
      extract: "text",
    },

    eval: {
      // Tool use: listed first, every low item updated with the right values and nothing else,
      // and a confirm that succeeded.
      toolUse: ({ toolCalls, toolResults, ctx }) => {
        const distract = toolCalls.filter((c) => DISTRACTOR_TOOLS.has(c.name));
        if (distract.length) return { ok: false, reason: `called ${distract.length} distractor tool call(s) (${[...new Set(distract.map((c) => c.name))].join(", ")})` };
        const expected = expectedFrom(ctx?.items ?? []);
        const targets = Object.fromEntries((ctx?.items ?? []).map((i) => [i.id, i.target]));
        if (!toolCalls.some((c) => c.name === "list_items")) return { ok: false, reason: "list_items was never called" };
        const updates = toolCalls.filter((c) => c.name === "update_item");
        const touched = new Set(updates.map((c) => String(c.arguments?.id ?? "")));
        const missing = expected.changed.filter((id) => !touched.has(id));
        if (missing.length) return { ok: false, reason: `never updated ${missing.length} of the ${expected.changed.length} low items` };
        const bad = updates.filter((c) => {
          const id = String(c.arguments?.id ?? "");
          return !expected.changed.includes(id) || Number(c.arguments?.qty) !== targets[id] || String(c.arguments?.status ?? "") !== STATUS;
        });
        if (bad.length) return { ok: false, reason: `${bad.length} update(s) with the wrong item, qty or status` };
        const confirmed = toolResults.some((r) => r.name === "confirm_restock" && r.ok !== false && /"confirmed":\s*true/.test(String(r.content ?? "")));
        if (!confirmed) return { ok: false, reason: toolCalls.some((c) => c.name === "confirm_restock") ? "confirm_restock never succeeded (incomplete ticket set)" : "confirm_restock was never called" };
        return { ok: true, reason: `listed, updated all ${expected.changed.length} low items with the right values, confirmed` };
      },

      // Truth: the expected end state from the scenario's initial items, and the server's actual
      // end state read now (after the model answered).
      ground: async ({ ctx } = {}) => {
        if (!ctx?.scenario) return { changed: [], totalQty: 0, after: {}, state: null, error: "no scenario in the trial context" };
        const expected = expectedFrom(ctx.items);
        try {
          const s = await api("GET", `/api/scenarios/${enc(ctx.scenario)}`);
          // The op log is the record of what the environment did to the model — and what it did back.
          const ops = summarizeOps(s.ops);
          return { ...expected, state: { items: s.items, confirmed: s.confirmed, ops: s.ops.length, requests: ops }, stress: s.stress ? { profile: s.stress, budget: s.budget, ...ops } : null };
        } catch (err) {
          return { ...expected, state: null, error: err.message };
        }
      },

      scoreHarness: (out, ground) => {
        const why = endStateVerdict(ground);
        if (why) return { correct: false, reason: why };
        if (!out || typeof out !== "object") return { correct: false, reason: "server state is right, but there is no structured answer" };
        const raw = out.changed ?? out.ids ?? out;
        const ids = (typeof raw === "string" ? raw.split(/[,\s]+/) : unwrapList(raw, ["changed", "ids"])).map((x) => (x && typeof x === "object" ? x.id : x));
        const total = Number(out.totalQty ?? out.total_qty ?? out.total);
        return judgeReport(ids, total, ground);
      },

      scoreNoHarness: (out, ground) => {
        const why = endStateVerdict(ground);
        if (why) return { correct: false, reason: why };
        const { ids, total } = parseReport(out);
        return judgeReport(ids, total, ground);
      },
    },
  };
}

export const restockTasks = [3, 6, 12, 30].map(makeRestock);
export { tools, distractorTools, toolsFor, schema, STATUS, makeRestock, judgeReport };
