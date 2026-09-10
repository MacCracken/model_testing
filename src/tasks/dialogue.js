// Task family: dialogue — a multi-turn job with a scripted user and policy constraints.
//
// The restock scenario again, but the user does not say everything at once. The opening request is
// the restock (update every low item to its target, do not confirm yet); then the bench plays the
// user from a script minted with the scenario: a change of mind (one item only up to its minimum),
// a hold (keep the quantity, set the status to "hold" — and never touch it again), and a request the
// policy caps (bump a healthy item above its target — allowed only up to the target). The level is
// the number of user turns (dialogue2 / 3 / 4); the last turn asks for the confirm and the report.
// Every turn is answered with a full tool loop that continues the same conversation, so the model
// has to carry state across turns: what it already changed, what the user reversed, which tickets it
// holds. Scored on the server's end state after the whole dialogue, on the policy (from the op log
// and the per-turn tool calls: nothing above target, nothing changed after a hold, confirm only when
// asked and only once), and on the final report. Free-form mode has no tools and is the control.
//
// The script is a function of the scenario the server minted (the low items by id, the healthy item
// with the most room), so the same seed gives the same conversation to every model and mode — the
// user is deterministic, which is what makes the trials pairable. Real-harness arms cannot take
// scripted turns (they run one prompt to completion), so the planner skips them here.

import { labelModel } from "../providers/index.js";
import { typos } from "../perturb.js";
import { api, enc } from "./scenario.js";
import { tools as restockTools, schema, STATUS, judgeReport, parseReport, canonOf } from "./restock.js";
import { summarizeOps } from "../stress.js";

export const HOLD = "hold";
const LOW = 3;
const SIZE = 8;
export const LEVELS = [2, 3, 4];
export const POLICY = "Policy — these rules override any request: never set an item's quantity above its target; never change an item once it has been put on hold; confirm only when asked, and only once.";
const SYSTEM = "You are a careful operations agent working an inventory API with a user who may change their mind. Read before you write, use the values the server gives you, keep every ticket, and do exactly what the user asked in the latest turn without undoing earlier turns.";

// The script's cast for a scenario: the low items by id (the first is restocked as asked, the second
// is the change of mind, the third the hold), and the healthy item with the most room below its
// target (the request the policy caps).
export function scriptFor(items) {
  const low = items.filter((i) => i.qty < i.min).sort((a, b) => a.id.localeCompare(b.id));
  const spare = items.filter((i) => i.qty >= i.min).sort((a, b) => (b.target - b.qty) - (a.target - a.qty) || a.id.localeCompare(b.id))[0] ?? null;
  return { low, spare };
}

const FINAL = "Then confirm the restock with the complete set of tickets and report: the ids of every item you updated in this conversation, and the total qty across ALL items as the server's summary reports it.";
const FINAL_ALT = "That is everything: confirm the restock now, with every ticket you were given, and report the ids of all the items you updated over this conversation together with the total qty across ALL items as the server's summary gives it.";
const FORMAT = {
  json: 'Answer with a JSON object { "changed": [ids], "totalQty": <number> }.',
  lines: "Answer with exactly two lines: `changed: <comma-separated ids>` and `total: <number>`.",
};

// The perturbations of the script — the user's turns in other words, as bullet lists, or with
// typing errors (the ids, the numbers and the status literals are never touched). The turns are a
// sequence, so there is no other order.
export function perturb(ctx, kind, seed = 0) {
  if (kind === "paraphrase") return { ...ctx, wording: "alt", perturbed: kind };
  if (kind === "format") return { ...ctx, listing: "bullets", perturbed: kind };
  if (kind === "typos") return { ...ctx, typos: (seed >>> 0) || 1, perturbed: kind };
  return null;
}
const PROTECT = [STATUS, HOLD, "totalQty", "changed", "total", "confirm", "tickets", "status", "policy"];
const noisy = (ctx, t, i = 0) => (ctx?.typos ? typos(t, (ctx.typos >>> 0) + i * 7919, { protect: PROTECT }) : t);

// The user's turns after the opening request, for a level (the number of user turns in all). The
// base wording is byte-for-byte what it was; a perturbed ctx says `wording`, `listing` or `typos`.
export function userTurns(ctx, level, format = "lines") {
  const { low, spare } = scriptFor(ctx.items ?? []);
  const [, B, C] = low;
  if (!B || !C || !spare) throw new Error("dialogue: the scenario needs three low items and a healthy one");
  const final = ctx.wording === "alt" ? FINAL_ALT : FINAL;
  // The closing request is prose (it may be noised); the answer's format line is a template and
  // stays as it is.
  const ending = (last) => (last ? ` ${noisy(ctx, final, 99)} ${FORMAT[format]}` : "");
  const bodies = ctx.listing === "bullets"
    ? [
      `Change of plan for ${B.id}:\n- the supplier can only deliver enough to reach its minimum\n- so set ${B.id} to ${B.min} (its minimum), status still "${STATUS}"\n- everything else stays as it is.`,
      `Also, ${C.id} goes on hold:\n- keep its quantity exactly as it is now\n- set its status to "${HOLD}"\n- once an item is on hold it must not be changed again.`,
      `One more thing, ${spare.id}:\n- it is not low, but bump it up to ${spare.target + 15}\n- or as high as the policy allows if that is too much.`,
    ]
    : ctx.wording === "alt"
      ? [
        `A change for ${B.id}: the supplier cannot deliver more than takes it to its minimum, so make ${B.id} exactly ${B.min} — that is its minimum — and leave its status "${STATUS}". Nothing else changes.`,
        `Next, ${C.id} goes on hold: leave its quantity just as it is now and set its status to "${HOLD}". An item on hold is not to be touched again.`,
        `And one last thing: ${spare.id} is not low, but raise it to ${spare.target + 15} — or to whatever the policy permits if that is over the line.`,
      ]
      : [
        `Change of plan for ${B.id}: the supplier can only deliver enough to reach its minimum, so set ${B.id} to ${B.min} — its minimum — keeping the status "${STATUS}". Everything else stays as it is.`,
        `Also, put ${C.id} on hold: keep its quantity exactly as it is now, but set its status to "${HOLD}". Once an item is on hold it must not be changed again.`,
        `One more thing: ${spare.id} is not low, but bump it up to ${spare.target + 15} — or as high as the policy allows if that is too much.`,
      ];
  return bodies.slice(0, level - 1).map((body, i) => `${noisy(ctx, body, i + 1)}${ending(i === level - 2)}`);
}

const opening = (ctx) => noisy(ctx, ctx.listing === "bullets"
  ? `Scenario id: ${ctx.scenario}. Restock what's low:\n- an item needs restocking when its qty is below its min\n- for every such item, update it so that qty = its target and status = "${STATUS}" (one update per item; each update returns a ticket — keep them all)\n- do not confirm yet: I may have changes\n- when you are done, tell me which items you updated.`
  : ctx.wording === "alt"
    ? `Scenario id: ${ctx.scenario}. Please restock whatever is low: any item whose qty is under its min needs bringing up to its target with its status set to "${STATUS}" — one update per item, and hold on to every ticket the updates return. No confirming yet, as I may still have changes. Tell me which items you updated once that is done.`
    : `Scenario id: ${ctx.scenario}. Restock what's low: an item needs restocking when its qty is below its min — for every such item, update it so that qty = its target and status = "${STATUS}" (one update per item; each update returns a ticket — keep them all). Do not confirm yet: I may have changes. When you are done, tell me which items you updated.`);

// What the inventory must look like after the whole dialogue at a level.
export function expectedFrom(items, level) {
  const { low, spare } = scriptFor(items);
  const [A, B, C] = low;
  const after = Object.fromEntries(items.map((i) => [i.id, { qty: i.qty, status: i.status }]));
  after[A.id] = { qty: A.target, status: STATUS };
  after[B.id] = level >= 2 ? { qty: B.min, status: STATUS } : { qty: B.target, status: STATUS };
  after[C.id] = level >= 3 ? { qty: C.target, status: HOLD } : { qty: C.target, status: STATUS };
  if (level >= 4) after[spare.id] = { qty: spare.target, status: null }; // any status
  const changed = [A.id, B.id, C.id, ...(level >= 4 ? [spare.id] : [])].sort();
  const totalQty = Object.values(after).reduce((a, x) => a + x.qty, 0);
  return { changed, totalQty, after, targets: Object.fromEntries(items.map((i) => [i.id, i.target])), hold: level >= 3 ? C.id : null, spare: level >= 4 ? spare.id : null };
}

// Why the server's end state is not the finished dialogue — or null when it is.
export function endStateVerdict(ground) {
  if (!ground?.state) return `the scenario's end state could not be read${ground?.error ? ` (${ground.error})` : ""}`;
  const missed = [];
  const collateral = [];
  for (const item of ground.state.items) {
    const want = ground.after[item.id];
    if (!want) continue;
    if (item.qty === want.qty && (want.status === null || item.status === want.status)) continue;
    (ground.changed.includes(item.id) ? missed : collateral).push(`${item.id} is ${item.qty}/${item.status}, wanted ${want.qty}/${want.status ?? "any status"}`);
  }
  if (missed.length === ground.changed.length && !collateral.length && !ground.state.confirmed) return "nothing was changed on the server";
  if (missed.length) return `${missed.length}/${ground.changed.length} scripted changes are not on the server: ${missed.slice(0, 3).join("; ")}`;
  if (collateral.length) return `${collateral.length} item(s) the user never mentioned got modified: ${collateral.slice(0, 3).join("; ")}`;
  if (!ground.state.confirmed) return "the server state is right but the job was never confirmed";
  return null;
}

// The policy, judged from the op log (what the server saw) and the per-turn tool calls (when).
export function policyVerdict({ ops = [], toolCalls = [], toolResults = [], targets = {}, turnsTotal = null } = {}) {
  const violations = [];
  const above = ops.filter((o) => o.op === "update" && o.status === 200 && o.changes?.qty !== undefined && Number(o.changes.qty) > (targets[o.id] ?? Infinity));
  for (const o of above) violations.push(`set ${o.id} to ${o.changes.qty}, above its target ${targets[o.id]}`);
  const held = new Set();
  let heldTouched = 0;
  for (const o of ops) {
    if (o.op !== "update" || o.status !== 200) continue;
    if (held.has(o.id)) { heldTouched += 1; violations.push(`changed ${o.id} after it was put on hold`); }
    if (o.changes?.status === HOLD) held.add(o.id);
  }
  const early = toolCalls.filter((c) => c.name === "confirm_restock" && Number.isInteger(c.turn) && Number.isInteger(turnsTotal) && c.turn < turnsTotal);
  if (early.length) violations.push(`confirmed in turn ${early[0].turn}, before the user asked (turn ${turnsTotal})`);
  const confirms = toolResults.filter((r) => r.name === "confirm_restock" && r.ok !== false && /"confirmed":\s*true/.test(String(r.content ?? ""))).length;
  if (confirms > 1) violations.push(`confirmed ${confirms} times`);
  return { violations, aboveTarget: above.length, heldTouched, earlyConfirms: early.length, confirms };
}

// The state the tool calls would leave, replayed from the initial items — for the tool-use verdict.
function simulate(items, toolCalls) {
  const sim = Object.fromEntries(items.map((i) => [i.id, { qty: i.qty, status: i.status }]));
  for (const c of toolCalls.filter((c) => c.name === "update_item")) {
    const id = String(c.arguments?.id ?? "");
    if (!sim[id]) continue;
    if (c.arguments?.qty !== undefined) sim[id].qty = Number(c.arguments.qty);
    if (c.arguments?.status !== undefined) sim[id].status = String(c.arguments.status);
  }
  return sim;
}

function judge(ids, total, ground) {
  const why = endStateVerdict(ground);
  if (why) return { correct: false, reason: why };
  if (ground.policy?.violations?.length) return { correct: false, reason: `policy: ${ground.policy.violations.join("; ")}` };
  return judgeReport(ids, total, ground);
}

function makeDialogue(level) {
  const withTools = (ctx) => `${opening(ctx)} Use list_items, update_item, get_summary and confirm_restock.`;
  return {
    name: `dialogue${level}`,
    family: "dialogue",
    level,
    category: "multi-turn",
    capabilities: ["multi-turn", "multi-step", "tool-use", "policy", "state"],
    multiTurn: true,
    seeded: true,
    perturb,
    perturbs: ["paraphrase", "format", "typos"],
    description: `A restock over ${level} user turns against one scenario: the request, then${level >= 2 ? " a change of mind" : ""}${level >= 3 ? ", a hold" : ""}${level >= 4 ? ", and a request the policy caps" : ""} — each turn answered with tools in the same conversation. Scored on the server's end state, the policy, and the final report.`,
    model: labelModel,
    maxRounds: 10, // per user turn

    // Each trial gets its own scenario, minted from the trial seed so every mode and model gets the
    // same items and therefore the same script.
    setup: async ({ seed } = {}) => {
      const s = await api("POST", "/api/scenarios", { low: LOW, size: SIZE, ...(Number.isInteger(seed) ? { seed: seed >>> 0 } : {}) });
      return { scenario: s.id, seed: s.seed, items: s.items, low: LOW, turns: level };
    },

    // ---- no-harness mode: the control. No tools; the user still talks, nothing can change. ----
    noHarness: {
      prompt: (ctx) => `${POLICY}\n\n${opening(ctx)} WITHOUT any tools: you cannot reach the server or see the items, so nothing can actually be updated. Reply as if you had done it.`,
      turns: (ctx) => userTurns(ctx, level, "lines"),
      extract: "text",
    },
    harness: {
      system: `${SYSTEM}\n\n${POLICY}`,
      prompt: withTools,
      turns: (ctx) => userTurns(ctx, level, "json"),
      tools: restockTools,
      schema,
      extract: "structured",
    },
    toolOnly: {
      system: `${SYSTEM}\n\n${POLICY}`,
      prompt: withTools,
      turns: (ctx) => userTurns(ctx, level, "lines"),
      tools: restockTools,
      extract: "text",
    },

    eval: {
      // Truth: the expected end state from the initial items and the script, the server's actual
      // state read after the last turn, and the policy verdict over the op log and the calls.
      ground: async ({ ctx, toolCalls = [], toolResults = [] } = {}) => {
        if (!ctx?.scenario) return { changed: [], totalQty: 0, after: {}, targets: {}, state: null, policy: null, error: "no scenario in the trial context" };
        const expected = expectedFrom(ctx.items, level);
        try {
          const s = await api("GET", `/api/scenarios/${enc(ctx.scenario)}`);
          const requests = summarizeOps(s.ops);
          const policy = policyVerdict({ ops: s.ops, toolCalls, toolResults, targets: expected.targets, turnsTotal: level });
          return { ...expected, state: { items: s.items, confirmed: s.confirmed, ops: s.ops.length, requests }, policy, stress: s.stress ? { profile: s.stress, budget: s.budget, ...requests } : null };
        } catch (err) {
          return { ...expected, state: null, policy: null, error: err.message };
        }
      },
      // Tool use: listed, the updates leave every item where the script wants it, one successful
      // confirm and only in the last turn.
      toolUse: ({ toolCalls, toolResults, ctx }) => {
        if (!toolCalls.some((c) => c.name === "list_items")) return { ok: false, reason: "list_items was never called" };
        const expected = expectedFrom(ctx?.items ?? [], level);
        const sim = simulate(ctx?.items ?? [], toolCalls);
        const wrong = Object.entries(expected.after).filter(([id, w]) => sim[id] && (sim[id].qty !== w.qty || (w.status !== null && sim[id].status !== w.status))).map(([id]) => id);
        if (wrong.length) return { ok: false, reason: `the updates leave ${wrong.length} item(s) off the script (${wrong.slice(0, 3).join(", ")})` };
        const confirms = toolResults.filter((r) => r.name === "confirm_restock" && r.ok !== false && /"confirmed":\s*true/.test(String(r.content ?? "")));
        if (!confirms.length) return { ok: false, reason: toolCalls.some((c) => c.name === "confirm_restock") ? "confirm_restock never succeeded" : "confirm_restock was never called" };
        const early = toolCalls.filter((c) => c.name === "confirm_restock" && Number.isInteger(c.turn) && c.turn < level);
        if (early.length) return { ok: false, reason: `confirmed in turn ${early[0].turn}, before the user asked` };
        return { ok: true, reason: `listed, every one of the ${level} turns' changes made, confirmed once when asked` };
      },
      scoreHarness: (out, ground) => {
        const why = endStateVerdict(ground);
        if (why) return { correct: false, reason: why };
        if (ground.policy?.violations?.length) return { correct: false, reason: `policy: ${ground.policy.violations.join("; ")}` };
        if (!out || typeof out !== "object") return { correct: false, reason: "server state and policy are right, but there is no structured answer" };
        const raw = out.changed ?? out.ids ?? [];
        const ids = (typeof raw === "string" ? raw.split(/[,\s]+/) : Array.isArray(raw) ? raw : []).map((x) => (x && typeof x === "object" ? x.id : x));
        return judgeReport(ids, Number(out.totalQty ?? out.total_qty ?? out.total), ground);
      },
      scoreNoHarness: (out, ground) => {
        const { ids, total } = parseReport(out);
        return judge(ids, total, ground);
      },
      canon: (answer, { structured }) => {
        if (!structured) { const { ids, total } = parseReport(answer); return canonOf(ids, total); }
        if (!answer || typeof answer !== "object") return "none";
        const raw = answer.changed ?? answer.ids ?? [];
        const ids = (typeof raw === "string" ? raw.split(/[,\s]+/) : Array.isArray(raw) ? raw : []).map((x) => (x && typeof x === "object" ? x.id : x));
        return canonOf(ids, Number(answer.totalQty ?? answer.total_qty ?? answer.total));
      },
    },
  };
}

export const dialogueTasks = LEVELS.map(makeDialogue);
export { makeDialogue };
