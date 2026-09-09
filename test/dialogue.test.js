// The dialogue family against the webserver run in-process: the scripted user, the expected end
// state per level, the policy verdict, and whole trials driven by a fake model that follows (or
// breaks) the script through the real tools.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.PORT = "0";
const { server } = await import("../webserver/server.js");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
process.env.SUT_PORT = String(server.address().port);
const { dialogueTasks, scriptFor, userTurns, expectedFrom, endStateVerdict, policyVerdict, POLICY, HOLD } = await import("../src/tasks/dialogue.js");
const { STATUS } = await import("../src/tasks/restock.js");
const { runTrial, planMatrix } = await import("../src/runner.js");
const { listTasks } = await import("../src/tasks/registry.js");
const { traceEvents } = await import("../src/export.js");
after(() => server.close());

const items = [
  { id: "sku-1004", name: "spring", qty: 0, min: 5, target: 12, status: "ok" }, // low: C
  { id: "sku-1001", name: "bolt", qty: 2, min: 10, target: 25, status: "ok" }, // low: A
  { id: "sku-1002", name: "washer", qty: 30, min: 10, target: 22, status: "ok" }, // healthy, no room
  { id: "sku-1003", name: "gasket", qty: 9, min: 9, target: 20, status: "ok" }, // healthy, room 11 → the spare
  { id: "sku-1005", name: "nut", qty: 3, min: 8, target: 30, status: "ok" }, // low: B
];
const [D2, D3, D4] = dialogueTasks;

test("the script is minted from the scenario: low items by id, the healthy item with the most room, turns per level", () => {
  const { low, spare } = scriptFor(items);
  assert.deepEqual(low.map((i) => i.id), ["sku-1001", "sku-1004", "sku-1005"]);
  assert.equal(spare.id, "sku-1003");
  const ctx = { scenario: "scn-x", items };
  assert.equal(userTurns(ctx, 2).length, 1);
  assert.equal(userTurns(ctx, 3).length, 2);
  assert.equal(userTurns(ctx, 4).length, 3);
  const t4 = userTurns(ctx, 4, "json");
  assert.match(t4[0], /Change of plan for sku-1004: .* set sku-1004 to 5 — its minimum — keeping the status "reordered"/);
  assert.doesNotMatch(t4[0], /confirm/);
  assert.match(t4[1], /put sku-1005 on hold: keep its quantity exactly as it is now, but set its status to "hold"/);
  assert.match(t4[2], /sku-1003 is not low, but bump it up to 35 — or as high as the policy allows/);
  assert.match(t4[2], /Then confirm the restock with the complete set of tickets[\s\S]*JSON object/);
  assert.match(userTurns(ctx, 2, "lines")[0], /Then confirm[\s\S]*exactly two lines/);
  assert.match(userTurns(ctx, 3)[1], /Then confirm/);
  assert.throws(() => userTurns({ items: items.slice(0, 2) }, 3), /three low items/);
  for (const t of dialogueTasks) {
    assert.equal(t.multiTurn, true);
    assert.ok(t.noHarness.turns && t.harness.turns && t.toolOnly.turns && !t.schemaOnly);
    assert.match(t.noHarness.prompt(ctx), /Policy — these rules override any request/);
    assert.match(t.harness.system, /never set an item's quantity above its target/);
    assert.equal(t.harness.system.includes(POLICY), true);
  }
});

test("the expected end state per level, and the verdicts on what the server shows", () => {
  const e2 = expectedFrom(items, 2);
  assert.deepEqual(e2.after["sku-1001"], { qty: 25, status: STATUS });
  assert.deepEqual(e2.after["sku-1004"], { qty: 5, status: STATUS }, "the change of mind: B only to its minimum");
  assert.deepEqual(e2.after["sku-1005"], { qty: 30, status: STATUS });
  assert.deepEqual(e2.after["sku-1003"], { qty: 9, status: "ok" });
  assert.deepEqual(e2.changed, ["sku-1001", "sku-1004", "sku-1005"]);
  assert.equal(e2.totalQty, 25 + 5 + 30 + 30 + 9);
  const e3 = expectedFrom(items, 3);
  assert.deepEqual(e3.after["sku-1005"], { qty: 30, status: HOLD }, "the hold keeps the quantity");
  assert.equal(e3.hold, "sku-1005");
  const e4 = expectedFrom(items, 4);
  assert.deepEqual(e4.after["sku-1003"], { qty: 20, status: null }, "the capped bump lands on the target, any status");
  assert.deepEqual(e4.changed, ["sku-1001", "sku-1003", "sku-1004", "sku-1005"]);
  assert.equal(e4.totalQty, 25 + 5 + 30 + 20 + 30);

  const state = (over, confirmed = true) => ({ items: items.map((i) => ({ ...i, ...(over[i.id] ?? {}) })), confirmed });
  const right4 = { "sku-1001": { qty: 25, status: STATUS }, "sku-1004": { qty: 5, status: STATUS }, "sku-1005": { qty: 30, status: HOLD }, "sku-1003": { qty: 20, status: "reordered" } };
  assert.equal(endStateVerdict({ ...e4, state: state(right4) }), null);
  assert.equal(endStateVerdict({ ...e4, state: state({}, false) }), "nothing was changed on the server");
  assert.match(endStateVerdict({ ...e4, state: state({ ...right4, "sku-1004": { qty: 30, status: STATUS } }) }), /1\/4 scripted changes are not on the server: sku-1004 is 30\/reordered, wanted 5\/reordered/);
  assert.match(endStateVerdict({ ...e4, state: state({ ...right4, "sku-1002": { qty: 40 } }) }), /1 item\(s\) the user never mentioned got modified: sku-1002/);
  assert.match(endStateVerdict({ ...e4, state: state(right4, false) }), /never confirmed/);
  assert.match(endStateVerdict({ ...e4, state: null, error: "boom" }), /could not be read \(boom\)/);
});

test("the policy verdict: above target, changed after a hold, confirmed early or twice", () => {
  const targets = Object.fromEntries(items.map((i) => [i.id, i.target]));
  const op = (id, changes, status = 200) => ({ op: "update", id, changes, status });
  const clean = policyVerdict({ ops: [op("sku-1001", { qty: 25, status: STATUS }), op("sku-1005", { status: HOLD })], toolCalls: [{ name: "confirm_restock", turn: 3 }], toolResults: [{ name: "confirm_restock", ok: true, content: '{"confirmed":true,"count":3}' }], targets, turnsTotal: 3 });
  assert.deepEqual(clean, { violations: [], aboveTarget: 0, heldTouched: 0, earlyConfirms: 0, confirms: 1 });
  const bad = policyVerdict({
    ops: [op("sku-1003", { qty: 35 }), op("sku-1005", { status: HOLD }), op("sku-1005", { qty: 29 }), op("sku-1001", { qty: 99 }, 503)],
    toolCalls: [{ name: "confirm_restock", turn: 1 }, { name: "confirm_restock", turn: 4 }],
    toolResults: [{ name: "confirm_restock", ok: true, content: '{"confirmed":true}' }, { name: "confirm_restock", ok: true, content: '{"confirmed":true}' }],
    targets, turnsTotal: 4,
  });
  assert.deepEqual(bad.violations, ["set sku-1003 to 35, above its target 20", "changed sku-1005 after it was put on hold", "confirmed in turn 1, before the user asked (turn 4)", "confirmed 2 times"]);
  assert.equal(bad.aboveTarget, 1, "a refused update (503) does not count");
  assert.deepEqual(policyVerdict({}), { violations: [], aboveTarget: 0, heldTouched: 0, earlyConfirms: 0, confirms: 0 });
});

// A model that follows the user's turns through the real tools against the in-process server. `bend`
// changes one behaviour: an over-target bump, an early confirm, or a touch after the hold.
function follower({ bend = null } = {}) {
  const tickets = new Set();
  let seenHistory = [];
  const client = {
    name: "c", model: "m",
    async chat(messages) { return { text: `changed: none\ntotal: 0 (turn ${messages.filter((m) => m.role === "user").length})`, toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }; },
    async runWithTools(prompt, tools, _system, { ctx, history = [], turn, turnsTotal }) {
      seenHistory.push(history.length);
      const tool = (name) => tools.find((t) => t.name === name);
      const calls = [], results = [];
      const call = async (name, args) => {
        const id = `c${turn}-${calls.length + 1}`;
        calls.push({ id, name, arguments: args });
        try { const out = await tool(name).impl(args); results.push({ id, name, ok: true, content: JSON.stringify(out) }); return out; }
        catch (err) { results.push({ id, name, ok: false, content: `tool error: ${err.message}` }); return null; }
      };
      const sid = ctx.scenario;
      const update = async (id, body) => { const r = await call("update_item", { scenario: sid, id, ...body }); if (r?.ticket) tickets.add(r.ticket); };
      if (turn === 1) {
        const { items: list } = await call("list_items", { scenario: sid });
        for (const it of list.filter((i) => i.qty < i.min).sort((a, b) => a.id.localeCompare(b.id))) await update(it.id, { qty: it.target, status: STATUS });
        if (bend === "early") await call("confirm_restock", { scenario: sid, tickets: [...tickets] });
      }
      let m;
      if ((m = prompt.match(/set (sku-\d{4}) to (\d+)/))) await update(m[1], { qty: Number(m[2]), status: STATUS });
      if ((m = prompt.match(/put (sku-\d{4}) on hold/))) {
        await update(m[1], { status: HOLD });
        if (bend === "touch") await update(m[1], { qty: 1 });
      }
      if ((m = prompt.match(/(sku-\d{4}) is not low, but bump it up to (\d+)/))) {
        const target = ctx.items.find((i) => i.id === m[1]).target;
        await update(m[1], { qty: bend === "over" ? Number(m[2]) : Math.min(Number(m[2]), target), status: STATUS });
      }
      let total = null;
      if (/confirm the restock/.test(prompt)) {
        await call("confirm_restock", { scenario: sid, tickets: [...tickets] });
        total = (await call("get_summary", { scenario: sid }))?.totalQty ?? null;
      }
      const changed = [...new Set(calls.filter((c) => c.name === "update_item").map((c) => c.arguments.id))];
      const text = turn === turnsTotal ? JSON.stringify({ changed: changedAll(), totalQty: total }) : `Done: updated ${changed.join(", ")}.`;
      const messages = [...history, { role: "user", content: prompt }, { role: "assistant", content: text }];
      return { text, structured: turn === turnsTotal ? JSON.parse(text) : null, toolCalls: calls, toolResults: results, rounds: 1, finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, messages };
      function changedAll() { return [...new Set(client.updated)]; }
    },
    updated: [],
  };
  const orig = client.runWithTools.bind(client);
  client.runWithTools = async (...args) => { const r = await orig(...args); for (const c of r.toolCalls) if (c.name === "update_item") client.updated.push(c.arguments.id); if (args[3].turn === args[3].turnsTotal) { const s = JSON.parse(r.text); s.changed = [...new Set(client.updated)]; r.text = JSON.stringify(s); r.structured = s; r.messages.at(-1).content = r.text; } return r; };
  client.history = () => seenHistory;
  return client;
}

test("a whole dialogue through the runner and the real tools: every turn answered in the same conversation, scored on the end state, the policy and the report", async () => {
  for (const task of dialogueTasks) {
    const client = follower();
    const r = await runTrial({ task, mode: "harness", client, index: 1, seed: 77 });
    assert.equal(r.error, null, `${task.name}: ${r.error}`);
    assert.equal(r.correct, true, `${task.name}: ${r.reason}`);
    assert.equal(r.toolUseOk, true, `${task.name}: ${r.toolUseReason}`);
    assert.equal(r.dialogue.length, task.level, "one entry per user turn");
    assert.equal(r.dialogue[0].user, r.prompt);
    assert.deepEqual(r.dialogue.map((d) => d.turn), Array.from({ length: task.level }, (_, i) => i + 1));
    assert.ok(r.dialogue.slice(0, -1).every((d) => /^Done: updated/.test(d.answer)));
    assert.ok(r.toolCalls.every((c) => Number.isInteger(c.turn)), "every call is tagged with its user turn");
    assert.ok(r.toolResults.every((c) => Number.isInteger(c.turn)));
    assert.equal(r.toolCalls.filter((c) => c.name === "confirm_restock").at(-1).turn, task.level, "the confirm came in the last turn");
    assert.deepEqual(client.history(), Array.from({ length: task.level }, (_, i) => i * 2), "each turn continued the conversation the client handed back");
    assert.equal(r.usage.total_tokens, 15 * task.level, "usage sums across turns");
    assert.equal(r.rounds, task.level);
    assert.deepEqual(r.ground.policy.violations, []);
    assert.equal(r.ground.state.confirmed, true);
    assert.ok(r.ground.totalQty > 0 && r.structured.totalQty === r.ground.totalQty);
    // The same seed mints the same scenario for another trial, so the script is the same conversation.
    const again = await runTrial({ task, mode: "toolOnly", client: follower(), index: 1, seed: 77 });
    assert.deepEqual(again.ctx.items.map((i) => i.id), r.ctx.items.map((i) => i.id));
    const gist = (t) => String(t ?? "").replace(/ Answer with .*$/s, "");
    assert.equal(gist(again.dialogue[1]?.user), gist(r.dialogue[1]?.user), "the same second turn in both modes, up to the answer format");
  }
});

test("bending the script is caught: an over-target bump, a touch after the hold, an early confirm; and the control cannot act", async () => {
  const over = await runTrial({ task: D4, mode: "harness", client: follower({ bend: "over" }), index: 1, seed: 78 });
  assert.equal(over.correct, false);
  assert.match(over.reason, /^1\/4 scripted changes are not on the server: sku-\d{4} is \d+\/reordered, wanted \d+\/any status/);
  const overTarget = await runTrial({ task: D4, mode: "harness", client: follower({ bend: "over" }), index: 2, seed: 78 });
  assert.equal(overTarget.ground.policy.aboveTarget, 1, "the op log shows the update above target");
  const touch = await runTrial({ task: D3, mode: "harness", client: follower({ bend: "touch" }), index: 1, seed: 79 });
  assert.equal(touch.correct, false);
  assert.match(touch.reason, /scripted changes are not on the server|policy: changed sku-\d{4} after it was put on hold/);
  assert.equal(touch.ground.policy.heldTouched, 1);
  const early = await runTrial({ task: D2, mode: "harness", client: follower({ bend: "early" }), index: 1, seed: 80 });
  assert.equal(early.correct, false);
  assert.match(early.reason, /policy: confirmed in turn 1, before the user asked \(turn 2\)|confirmed 2 times/);
  assert.equal(early.toolUseOk, false);
  assert.match(early.toolUseReason, /confirmed in turn 1, before the user asked/);
  // No tools: the dialogue still happens, turn by turn, and the server never changes.
  const control = await runTrial({ task: D3, mode: "noHarness", client: follower(), index: 1, seed: 81 });
  assert.equal(control.error, null);
  assert.equal(control.correct, false);
  assert.equal(control.reason, "nothing was changed on the server");
  assert.equal(control.dialogue.length, 3);
  assert.match(control.dialogue[2].answer, /turn 3/, "the third answer saw three user messages");
  assert.equal(control.usage.total_tokens, 15);
  assert.equal(control.toolUseOk, null);
});

test("arms are skipped on multi-turn tasks, the registry advertises the family, and the trace lays the dialogue out turn by turn", () => {
  const arm = { name: "claude-code:x", structuredOnly: true };
  const plain = { name: "openai:x" };
  const plan = planMatrix({ tasks: [D2], modes: ["harness", "noHarness"], clients: [arm, plain], count: 2 });
  assert.deepEqual(plan.cells.map((c) => `${c.mode}/${c.client.name}`), ["harness/openai:x", "noHarness/openai:x"]);
  assert.deepEqual(plan.skipped, [{ task: "dialogue2", mode: "harness", client: "claude-code:x", why: "multi-turn" }, { task: "dialogue2", mode: "noHarness", client: "claude-code:x" }]);
  const listed = listTasks().filter((t) => t.family === "dialogue");
  assert.deepEqual(listed.map((t) => [t.name, t.level, t.multiTurn, t.generated, t.modes]), [["dialogue2", 2, true, true, ["noHarness", "harness", "toolOnly"]], ["dialogue3", 3, true, true, ["noHarness", "harness", "toolOnly"]], ["dialogue4", 4, true, true, ["noHarness", "harness", "toolOnly"]]]);
  assert.ok(listed[0].capabilities.includes("multi-turn") && listed[0].capabilities.includes("policy"));
  const row = {
    prompt: "Restock what's low.", system: "S", finishReason: "stop", answerText: "{\"changed\":[\"sku-1\"],\"totalQty\":9}",
    dialogue: [{ turn: 1, user: "Restock what's low.", answer: "Done: updated sku-1." }, { turn: 2, user: "Change of plan.", answer: "{\"changed\":[\"sku-1\"],\"totalQty\":9}" }],
    toolCalls: [{ id: "a", name: "list_items", arguments: {}, turn: 1 }, { id: "b", name: "update_item", arguments: { id: "sku-1" }, turn: 1 }, { id: "c", name: "confirm_restock", arguments: {}, turn: 2 }],
    toolResults: [{ id: "a", name: "list_items", ok: true, content: "[]" }, { id: "b", name: "update_item", ok: true, content: "{}" }, { id: "c", name: "confirm_restock", ok: true, content: "{\"confirmed\":true}" }],
    turns: [{ round: 1, text: "", calls: ["a", "b"], dialogueTurn: 1 }, { round: 2, text: "Done: updated sku-1.", calls: [], dialogueTurn: 1 }, { round: 1, text: "", calls: ["c"], dialogueTurn: 2 }, { round: 2, text: "{\"changed\":[\"sku-1\"],\"totalQty\":9}", calls: [], finishReason: "stop", dialogueTurn: 2 }],
  };
  const ev = traceEvents(row);
  assert.deepEqual(ev.map((e) => `${e.kind}${e.turn ? `@${e.turn}` : ""}`), ["system", "user@1", "tool_call@1", "tool_result@1", "tool_call@1", "tool_result@1", "assistant@1", "user@2", "tool_call@2", "tool_result@2", "assistant@2"]);
  assert.equal(ev.at(-1).finish_reason, "stop");
  assert.equal(ev[6].finish_reason, undefined, "only the dialogue's last answer carries the finish reason");
  assert.equal(ev[7].text, "Change of plan.");
});
