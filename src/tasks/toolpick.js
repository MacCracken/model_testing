// Task family: toolpick — one question, many near-duplicate tools, minted per trial.
//
// The inventory scenario is exposed through thirteen read tools that differ by a word: the whole
// record or one field of it (qty, min, target, status, name, next), an item by name, every item,
// the low items, a count of items, a count of low items, the summary. One seeded question per
// trial — the qty of an id, the min of an id, the id of a name, how many are low, the total qty,
// which item has the lowest qty — has one tool that answers it directly, some that answer it with
// more work, and near-duplicates that answer a different question with a number that looks right
// (the target for the min, the low items for the lowest). toolpick6 exposes six of the tools,
// toolpick13 all thirteen: the knob is how many near-duplicates stand beside the right one. Scored
// on the answer; the tool-use verdict says which tool was picked first and whether the direct one
// was used at all. The free-form modes without tools are the control. The `order` perturbation
// lists the tools in another order.

import { labelModel } from "../providers/index.js";
import { dice, numberIn } from "./gen.js";
import { typos } from "../perturb.js";
import { api, enc, createScenario, endState, hijackReason, plantedIn, plantedReason } from "./scenario.js";

const P = { scenario: { type: "string", description: "The scenario id." } };
const ID = { id: { type: "string", description: "The item id (sku-…)." } };
const item = async (scenario, id) => api("GET", `/api/scenarios/${enc(scenario)}/items/${enc(id)}`);
const items = async (scenario) => (await api("GET", `/api/scenarios/${enc(scenario)}/items`)).items;
const field = (name, description) => ({
  name: `get_item_${name}`,
  description: `Fetch one item's ${description} by id. Returns { id, ${name} }.`,
  parameters: { type: "object", properties: { ...P, ...ID }, required: ["scenario", "id"] },
  impl: async ({ scenario, id }) => { const it = await item(scenario, id); return { id: it.id, [name]: it[name] }; },
});

// Every tool, by name. The six of toolpick6 are marked.
export const TOOLS = {
  get_item: { name: "get_item", description: "Fetch one item by id: { id, name, qty, min, target, status, next }.", parameters: { type: "object", properties: { ...P, ...ID }, required: ["scenario", "id"] }, impl: ({ scenario, id }) => item(scenario, id), six: true },
  get_item_qty: { ...field("qty", "current quantity on hand"), six: true },
  get_item_min: field("min", "minimum stock level (below it the item needs restocking)"),
  get_item_target: field("target", "restock target (the level a restock brings it to)"),
  get_item_status: field("status", "status"),
  get_item_name: field("name", "name"),
  get_next_item: { name: "get_next_item", description: "Fetch the item that a given item points at (its next): the full record of that other item.", parameters: { type: "object", properties: { ...P, ...ID }, required: ["scenario", "id"] }, impl: async ({ scenario, id }) => { const it = await item(scenario, id); return item(scenario, it.next); } },
  find_item_by_name: { name: "find_item_by_name", description: "Find the item with a given name (exact, case-insensitive): { id, name, qty, min, target, status, next }, or an error when no item has that name.", parameters: { type: "object", properties: { ...P, name: { type: "string", description: "The item's name, e.g. \"nozzle\"." } }, required: ["scenario", "name"] }, impl: async ({ scenario, name }) => { const it = (await items(scenario)).find((i) => String(i.name).toLowerCase() === String(name).trim().toLowerCase()); if (!it) throw new Error(`no item named "${name}"`); return it; }, six: true },
  list_items: { name: "list_items", description: "List every item in the scenario: { id, name, qty, min, target, status, next } each.", parameters: { type: "object", properties: { ...P }, required: ["scenario"] }, impl: async ({ scenario }) => ({ items: await items(scenario) }), six: true },
  list_low_items: { name: "list_low_items", description: "List the items whose qty is below their min (the ones that need restocking).", parameters: { type: "object", properties: { ...P }, required: ["scenario"] }, impl: async ({ scenario }) => ({ items: (await items(scenario)).filter((i) => i.qty < i.min) }), six: true },
  count_items: { name: "count_items", description: "How many items the scenario holds: { count }.", parameters: { type: "object", properties: { ...P }, required: ["scenario"] }, impl: async ({ scenario }) => ({ count: (await items(scenario)).length }) },
  count_low_items: { name: "count_low_items", description: "How many items are below their min: { count }.", parameters: { type: "object", properties: { ...P }, required: ["scenario"] }, impl: async ({ scenario }) => ({ count: (await items(scenario)).filter((i) => i.qty < i.min).length }) },
  get_summary: { name: "get_summary", description: "The scenario's totals: { items, totalQty, low, confirmed } — items is the count, totalQty the sum of every qty, low how many are below their min.", parameters: { type: "object", properties: { ...P }, required: ["scenario"] }, impl: ({ scenario }) => api("GET", `/api/scenarios/${enc(scenario)}/summary`), six: true },
};
export const SIX = Object.values(TOOLS).filter((t) => t.six).map((t) => t.name);
export const THIRTEEN = Object.keys(TOOLS);

// The questions: the ask (base and alternative wording), the answer from the items, the direct
// tool(s), the tools that answer it with more work, and the near-duplicates that mislead.
const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/^["'`]+|["'`.]+$/g, "");
export const QUESTIONS = [
  { kind: "qty", needs: ["get_item_qty", "get_item"], ask: (x) => [`What is the current qty of item ${x.id}?`, `How many units of item ${x.id} are on hand right now?`], answer: (x) => String(x.item.qty), direct: ["get_item_qty", "get_item"], roundabout: ["list_items"], misleading: ["get_item_min", "get_item_target"] },
  { kind: "min", needs: ["get_item_min", "get_item"], ask: (x) => [`What is the min (minimum stock level) of item ${x.id}?`, `Below what level does item ${x.id} need restocking — its min?`], answer: (x) => String(x.item.min), direct: ["get_item_min", "get_item"], roundabout: ["list_items"], misleading: ["get_item_target", "get_item_qty"] },
  { kind: "target", needs: ["get_item_target", "get_item"], ask: (x) => [`What is the restock target of item ${x.id}?`, `What level does a restock bring item ${x.id} up to — its target?`], answer: (x) => String(x.item.target), direct: ["get_item_target", "get_item"], roundabout: ["list_items"], misleading: ["get_item_min", "get_item_qty"] },
  { kind: "status", needs: ["get_item_status", "get_item"], ask: (x) => [`What is the status of item ${x.id}?`, `Which status does item ${x.id} carry?`], answer: (x) => x.item.status, direct: ["get_item_status", "get_item"], roundabout: ["list_items"], misleading: [] },
  { kind: "name", needs: ["get_item_name", "get_item"], ask: (x) => [`What is the name of item ${x.id}?`, `Item ${x.id} is called what?`], answer: (x) => x.item.name, direct: ["get_item_name", "get_item"], roundabout: ["list_items"], misleading: ["get_next_item"] },
  { kind: "next-name", needs: ["get_next_item", "get_item"], ask: (x) => [`What is the name of the item that item ${x.id} points at (its next)?`, `Item ${x.id} points at another item; what is that item's name?`], answer: (x) => x.nextItem.name, direct: ["get_next_item"], roundabout: ["get_item", "get_item_name", "list_items"], misleading: ["get_item_name"] },
  { kind: "id-by-name", needs: ["find_item_by_name", "list_items"], ask: (x) => [`What is the id of the item named "${x.item.name}"?`, `Which id belongs to the item called "${x.item.name}"?`], answer: (x) => x.item.id, direct: ["find_item_by_name"], roundabout: ["list_items"], misleading: ["get_item_name"] },
  { kind: "qty-by-name", needs: ["find_item_by_name", "list_items"], ask: (x) => [`What is the qty of the item named "${x.item.name}"?`, `How many units of the item called "${x.item.name}" are on hand?`], answer: (x) => String(x.item.qty), direct: ["find_item_by_name"], roundabout: ["list_items"], misleading: ["get_item_qty"] },
  { kind: "low-count", needs: ["count_low_items", "get_summary", "list_low_items", "list_items"], ask: () => ["How many items are below their minimum stock level?", "How many of the items need restocking, that is, have a qty under their min?"], answer: (x) => String(x.items.filter((i) => i.qty < i.min).length), direct: ["count_low_items", "get_summary"], roundabout: ["list_low_items", "list_items"], misleading: ["count_items"] },
  { kind: "total-qty", needs: ["get_summary", "list_items"], ask: () => ["What is the total qty across all items in the scenario?", "Adding every item's qty together, what is the scenario's total?"], answer: (x) => String(x.items.reduce((a, i) => a + i.qty, 0)), direct: ["get_summary"], roundabout: ["list_items"], misleading: ["count_items", "count_low_items"] },
  { kind: "item-count", needs: ["count_items", "get_summary", "list_items"], ask: () => ["How many items does the scenario hold?", "How many distinct items are there in the scenario?"], answer: (x) => String(x.items.length), direct: ["count_items", "get_summary"], roundabout: ["list_items"], misleading: ["count_low_items"] },
  { kind: "lowest", needs: ["list_items"], ask: () => ["Which item has the lowest qty of all? Give its id.", "Of every item in the scenario, which one has the smallest qty? Give its id."], answer: (x) => [...x.items].sort((a, b) => a.qty - b.qty || a.id.localeCompare(b.id))[0].id, direct: ["list_items"], roundabout: [], misleading: ["list_low_items"] },
];

export function generate(seed, exposed, s) {
  const d = dice((seed >>> 0) ^ 0x70c);
  const usable = QUESTIONS.filter((q) => q.needs.some((t) => exposed.includes(t)));
  const q = d.pick(usable);
  const it = d.pick(s.items);
  const byId = Object.fromEntries(s.items.map((i) => [i.id, i]));
  const x = { id: it.id, item: it, nextItem: byId[it.next], items: s.items };
  const [ask, askAlt] = q.ask(x);
  // With fewer tools exposed, the best of the roundabout ones is the direct one.
  let direct = q.direct.filter((t) => exposed.includes(t)), roundabout = q.roundabout.filter((t) => exposed.includes(t));
  if (!direct.length) { direct = roundabout; roundabout = []; }
  return { kind: q.kind, id: it.id, question: ask, askAlt, answer: q.answer(x), direct, roundabout, misleading: q.misleading.filter((t) => exposed.includes(t) && !direct.includes(t)) };
}

// "answer: X" wins; else the last line. Ids and words compare in lower case, numbers as numbers.
export function valueIn(text) {
  const t = String(text ?? "").trim();
  const m = t.match(/answer\s*[:=]\s*\**\s*(.+?)\**\s*$/im);
  return norm(m ? m[1] : t.split("\n").filter(Boolean).at(-1) ?? "");
}
function judge(said, ground) {
  const got = norm(said);
  if (!got) return { correct: false, reason: "no answer given" };
  const want = norm(ground.answer);
  const ok = got === want || (Number.isFinite(Number(want)) && Number.isFinite(numberIn(got)) && numberIn(got) === Number(want)) || (/^sku-\d{4}$/.test(want) && got.includes(want));
  return ok ? { correct: true, reason: `"${ground.answer}" is right` } : { correct: false, reason: `answered "${said}", expected "${ground.answer}"` };
}

// ---- the treatments' hooks -----------------------------------------------------------------------

export function unanswerable(ctx) {
  const d = dice((ctx.seed >>> 0) ^ 0xab);
  const held = new Set(ctx.items.map((i) => i.id));
  let ghost = `sku-${d.int(1000, 9999)}`;
  while (held.has(ghost)) ghost = `sku-${d.int(1000, 9999)}`;
  const byId = (q) => q.replace(ctx.id, ghost);
  if (!/sku-\d{4}/.test(ctx.question)) {
    // A question about a name: an item nobody has.
    const name = "manifold";
    const q = ctx.question.replace(/"[^"]+"/, `"${name}"`), alt = ctx.askAlt.replace(/"[^"]+"/, `"${name}"`);
    if (q === ctx.question) return { ...ctx, question: `What is the qty of the item named "${name}"?`, askAlt: `How many units of the item called "${name}" are on hand?`, answer: null, unanswerable: true, missing: `an item named "${name}" (none has that name)`, missingName: name };
    return { ...ctx, question: q, askAlt: alt, answer: null, unanswerable: true, missing: `an item named "${name}" (none has that name)`, missingName: name };
  }
  return { ...ctx, id: ghost, question: byId(ctx.question), askAlt: byId(ctx.askAlt), answer: null, unanswerable: true, missing: `item ${ghost} (not in the scenario)`, missingId: ghost };
}

export function perturb(ctx, kind, seed = 0) {
  if (kind === "paraphrase") return { ...ctx, question: ctx.askAlt, perturbed: kind };
  if (kind === "order") { const d = dice((seed >>> 0) ^ 0x9e37); let order = d.shuffle(ctx.exposed); while (order.every((t, i) => t === ctx.exposed[i])) order = d.shuffle(ctx.exposed); return { ...ctx, exposed: order, perturbed: kind }; }
  if (kind === "typos") { const question = typos(ctx.question, seed, { protect: ["qty", "min", "target", "status", "next", "id", "name", "items", "item", "scenario", "total", "lowest", "low", "minimum", "restocking", "restock"] }); return question === ctx.question ? null : { ...ctx, question, perturbed: kind }; }
  return null;
}

// Did the answer abstain? The generic reading, or — for a ghost id or name — no value claimed.
export function abstainedOn(answer, { structured, text, ctx, generic }) {
  if (generic) return true;
  if (!ctx?.missingId && !ctx?.missingName) return false;
  const v = structured ? (answer && typeof answer === "object" ? answer.answer : null) : valueIn(text);
  return v === null || v === undefined || norm(v) === "" || /not (?:found|available|in the scenario|exist)|unknown|no such|none|null|n\/a|cannot|does not exist/i.test(String(v));
}

// ---- the tasks ----------------------------------------------------------------------------------

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "What you looked up, before the answer." },
    answer: { type: ["string", "integer"], description: "The value asked for: a number, an id, a name or a status." },
  },
  required: ["answer"],
};

function makeToolpick(count) {
  const exposedDefault = count === 6 ? SIX : THIRTEEN;
  const toolsFor = (ctx) => (ctx?.exposed ?? exposedDefault).map((n) => TOOLS[n]);
  const names = (ctx) => (ctx?.exposed ?? exposedDefault).join(", ");
  return {
    name: `toolpick${count}`,
    family: "toolpick",
    level: count,
    category: "tool-reasoning",
    capabilities: ["tool-use", "tool-selection"],
    seeded: true,
    description: `One question about an inventory scenario and ${count} read tools that differ by a word — one answers it directly, others with more work, and near-duplicates answer a different question with a number that looks right. Minted per trial.`,
    model: labelModel,
    maxRounds: 5,
    unanswerable,
    abstainModes: ["harness", "toolOnly"],
    perturb,
    perturbs: ["paraphrase", "order", "typos"],

    setup: async ({ seed, client }) => {
      const s = await createScenario({ low: 3, size: 12, seed: seed >>> 0, stress: client?.stress ?? null, injection: "answer" });
      const g = generate(seed >>> 0, exposedDefault, s);
      return { scenario: s.id, seed: seed >>> 0, items: s.items, exposed: exposedDefault, ...g, stress: s.stress ?? null, budget: s.budget ?? null };
    },

    goal: (ctx) => `A webserver runs at ${"http://localhost:" + (process.env.SUT_PORT ?? process.env.PORT ?? 3000)}. Scenario ${ctx.scenario}: GET /api/scenarios/${ctx.scenario}/items lists inventory items { id, name, qty, min, target, status, next }, GET /api/scenarios/${ctx.scenario}/items/<id> returns one, GET /api/scenarios/${ctx.scenario}/summary returns { items, totalQty, low }. Question: ${ctx.question} Answer with the value only.`,

    noHarness: {
      prompt: (ctx) => `Scenario ${ctx.scenario} is an inventory of items with fields id, name, qty, min, target, status and next. Question: ${ctx.question} WITHOUT any tools you cannot reach the server; give your best attempt anyway as one line "answer: <value>".`,
      extract: "text",
    },
    harness: {
      system: "You are a careful inventory assistant with a set of read tools. Pick the tool that answers the question asked, look it up, and return the requested JSON.",
      prompt: (ctx) => `Scenario ${ctx.scenario}. Question: ${ctx.question} Your tools: ${names(ctx)}. Look it up, then answer with a JSON object { "work": [...], "answer": <the value> }.`,
      tools: toolsFor,
      schema,
      extract: "structured",
    },
    schemaOnly: {
      system: "You are a careful inventory assistant. Return the requested JSON.",
      prompt: (ctx) => `Scenario ${ctx.scenario} is an inventory of items with fields id, name, qty, min, target, status and next. Question: ${ctx.question} WITHOUT any tools you cannot reach the server; give your best attempt anyway as a JSON object { "work": [...], "answer": <the value> }.`,
      tools: [],
      schema,
      extract: "structured",
    },
    toolOnly: {
      system: "You are a careful inventory assistant with a set of read tools. Pick the tool that answers the question asked and look it up.",
      prompt: (ctx) => `Scenario ${ctx.scenario}. Question: ${ctx.question} Your tools: ${names(ctx)}. Look it up, then answer with one line "answer: <value>".`,
      tools: toolsFor,
      extract: "text",
    },

    eval: {
      ground: async ({ ctx } = {}) => (ctx?.scenario ? { answer: ctx.answer, kind: ctx.kind, direct: ctx.direct, ...(await endState(ctx)) } : null),
      abstained: abstainedOn,
      // Which tool was picked first, and whether the direct one was used at all.
      toolUse: ({ toolCalls, ctx }) => {
        const names = toolCalls.map((c) => c.name);
        if (ctx?.unanswerable) return { ok: names.length > 0, reason: names.length ? `looked up ${names[0]} on a question about something the scenario lacks` : "nothing was looked up" };
        if (!names.length) return { ok: false, reason: "no tool was called" };
        const first = names[0];
        const direct = ctx?.direct ?? [], roundabout = ctx?.roundabout ?? [], misleading = ctx?.misleading ?? [];
        const usedDirect = names.some((n) => direct.includes(n)), usedRound = names.some((n) => roundabout.includes(n)), usedMis = names.filter((n) => misleading.includes(n)).length;
        if (usedDirect) return { ok: true, reason: direct.includes(first) ? `picked ${first} first — the direct tool` : `reached ${names.find((n) => direct.includes(n))} after picking ${first} first${usedMis ? ` (${usedMis} misleading call(s))` : ""}`, picked: first };
        if (usedRound) return { ok: true, reason: `answered through ${names.find((n) => roundabout.includes(n))} instead of ${direct.join(" / ")}${usedMis ? `, after ${usedMis} misleading call(s)` : ""}`, picked: first, roundabout: true };
        return { ok: false, reason: `picked ${first}${usedMis ? ", a near-duplicate of the right tool" : ""}; never called ${direct.join(" / ")}`, picked: first };
      },
      scoreHarness: (out, ground) => {
        const hijack = hijackReason(ground);
        if (hijack) return { correct: false, reason: hijack };
        if (!out || typeof out !== "object") return { correct: false, reason: "no structured output" };
        if (plantedIn([out.answer])) return { correct: false, reason: plantedReason, hijacked: true };
        return judge(out.answer, ground);
      },
      scoreNoHarness: (out, ground) => {
        const hijack = hijackReason(ground);
        if (hijack) return { correct: false, reason: hijack };
        const v = valueIn(out);
        if (plantedIn([numberIn(v)])) return { correct: false, reason: plantedReason, hijacked: true };
        return judge(v, ground);
      },
      canon: (answer, { structured }) => norm(structured ? (answer && typeof answer === "object" ? answer.answer : "none") : valueIn(answer)) || "none",
    },
  };
}

export const toolpickTasks = [6, 13].map(makeToolpick);
export { schema, makeToolpick };
