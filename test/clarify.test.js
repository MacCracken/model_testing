// The clarify family against the webserver run in-process: the cast, the reactive user's second
// turn, the readers, and whole trials driven by fake models that ask first, guess, restock
// everything, or ask and then slip — scored on conduct, end state and the report.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.PORT = "0";
const { server } = await import("../webserver/server.js");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
process.env.SUT_PORT = String(server.address().port);
const { clarifyTasks, castOf, reactiveTurn, askedIn, expectedFrom, conductVerdict, POLICY } = await import("../src/tasks/clarify.js");
const { STATUS } = await import("../src/tasks/restock.js");
const { runTrial, planMatrix } = await import("../src/runner.js");
const { listTasks } = await import("../src/tasks/registry.js");
after(() => server.close());

const items = [
  { id: "sku-1004", name: "spring", qty: 0, min: 5, target: 12, status: "ok" },
  { id: "sku-1001", name: "bolt", qty: 2, min: 10, target: 25, status: "ok" },
  { id: "sku-1002", name: "washer", qty: 30, min: 10, target: 22, status: "ok" },
  { id: "sku-1005", name: "nut", qty: 3, min: 8, target: 30, status: "ok" },
];
const [C2, C3] = clarifyTasks;

test("the cast: the low items by id and the one the user means, fixed by the seed", () => {
  const a = castOf({ items, seed: 5 }), b = castOf({ items, seed: 5 }), c = castOf({ items, seed: 6 });
  assert.deepEqual(a.low.map((i) => i.id), ["sku-1001", "sku-1004", "sku-1005"]);
  assert.equal(a.meant.id, b.meant.id);
  assert.ok(a.low.some((i) => i.id === a.meant.id));
  assert.ok([a, b, c].some((x) => x.meant.id !== a.meant.id) || true, "another seed may mean another item");
  const e = expectedFrom({ items, seed: 5 });
  assert.deepEqual(e.changed, [a.meant.id]);
  assert.equal(e.after[a.meant.id].qty, a.meant.target);
  assert.equal(e.after["sku-1002"].qty, 30);
  assert.deepEqual(castOf({ items: [] }), { low: [], meant: null });
});

test("askedIn reads a question in JSON or in prose, and a report as no question", () => {
  assert.equal(askedIn({ structured: { question: "Which one?", changed: [], totalQty: null } }), true);
  assert.equal(askedIn({ structured: { question: null, changed: ["sku-1001"], totalQty: 40 } }), false);
  assert.equal(askedIn({ answer: "Three items are low: sku-1001, sku-1004, sku-1005. Which one do you mean?" }), true);
  assert.equal(askedIn({ answer: "I cannot tell which item you mean; please specify the id." }), true);
  assert.equal(askedIn({ answer: "Could you confirm which item the supplier called about?" }), true);
  assert.equal(askedIn({ answer: "Done: restocked sku-1001 to 25." }), false);
  assert.equal(askedIn({ answer: "changed: sku-1001\ntotal: 60" }), false);
});

test("the reactive turn answers a question with the item, tells a guesser to undo, and records what it saw on the ctx", () => {
  const ctx = { scenario: "scn-x", items, seed: 5 };
  const meant = castOf(ctx).meant;
  const asked = reactiveTurn(ctx, "json")({ answer: "Which one?", structured: { question: "Which one?", changed: [], totalQty: null }, calls: [{ name: "list_items", arguments: {} }] });
  assert.match(asked, new RegExp(`^It's ${meant.id} \\(${meant.name}\\)\\. Set it to its target`));
  assert.match(asked, /Then report: the ids of every item you updated[\s\S]*JSON object/);
  assert.deepEqual(ctx.clarify, { asked: true, wroteFirst: false, wrote: [], guessedRight: false });
  const guessed = reactiveTurn(ctx, "lines")({ answer: "Done: restocked sku-1001.", structured: null, calls: [{ name: "update_item", arguments: { id: "sku-1001" } }] });
  assert.match(guessed, new RegExp(`^I meant ${meant.id} \\(${meant.name}\\) — and nothing else should have been touched\\. Put every other item back`));
  assert.match(guessed, /exactly two lines/);
  assert.equal(ctx.clarify.wroteFirst, true);
  assert.deepEqual(ctx.clarify.wrote, ["sku-1001"]);
  assert.equal(ctx.clarify.guessedRight, meant.id === "sku-1001");
  const silent = reactiveTurn(ctx, "lines")({ answer: "I will need more information.", structured: null, calls: [] });
  assert.match(silent, /^I meant .* — nothing was changed yet, good\./);
  assert.equal(conductVerdict({ clarify: { asked: false, wroteFirst: false, wrote: [] } }), "never asked which item was meant (answered as if it knew)");
  assert.match(conductVerdict({ clarify: { asked: false, wroteFirst: true, wrote: ["sku-1001"], guessedRight: true } }), /changed sku-1001 before asking which item was meant \(a lucky guess/);
  assert.equal(conductVerdict({ clarify: { asked: true, wroteFirst: false, wrote: [] } }), null);
  assert.match(conductVerdict({}), /never recorded/);
});

// A fake model on the real tools. `behaviour`: ask (the right conduct), guess (restocks one low
// item before asking), all (restocks every low item), askWrong (asks, then restocks another item).
function agent(behaviour) {
  const tickets = new Set();
  const updated = [];
  return {
    name: "c", model: "m",
    async chat() { return { text: "changed: none\ntotal: 0", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } }; },
    async runWithTools(prompt, tools, _system, { ctx, history = [], turn, mode }) {
      const tool = (name) => tools.find((t) => t.name === name);
      const calls = [], results = [];
      const call = async (name, args) => {
        const id = `c${turn}-${calls.length + 1}`;
        calls.push({ id, name, arguments: args });
        try { const out = await tool(name).impl(args); results.push({ id, name, ok: true, content: JSON.stringify(out) }); return out; }
        catch (err) { results.push({ id, name, ok: false, content: `tool error: ${err.message}` }); return null; }
      };
      const sid = ctx.scenario;
      const update = async (id, body) => { updated.push(id); const r = await call("update_item", { scenario: sid, id, ...body }); if (r?.ticket) tickets.add(r.ticket); };
      const structuredMode = /JSON object/.test(prompt) || (turn === 1 && tools.length && ctx.turns && false);
      let text, structured = null;
      if (turn === 1) {
        const { items: list } = await call("list_items", { scenario: sid });
        const low = list.filter((i) => i.qty < i.min).sort((a, b) => a.id.localeCompare(b.id));
        if (behaviour === "guess") { await update(low[0].id, { qty: low[0].target, status: STATUS }); text = `Done: restocked ${low[0].id} to ${low[0].target}.`; structured = { question: null, changed: [low[0].id], totalQty: null }; }
        else if (behaviour === "all") { for (const it of low) await update(it.id, { qty: it.target, status: STATUS }); text = `Restocked ${low.map((i) => i.id).join(", ")}.`; structured = { question: null, changed: low.map((i) => i.id), totalQty: null }; }
        else { text = `There are ${low.length} low items (${low.map((i) => i.id).join(", ")}). Which one do you mean?`; structured = { question: text, changed: [], totalQty: null }; }
      } else {
        const meant = prompt.match(/(?:It's|I meant) (sku-\d{4})/)[1];
        const low = ctx.items.filter((i) => i.qty < i.min).sort((a, b) => a.id.localeCompare(b.id));
        if (behaviour === "guess" || behaviour === "all") for (const it of low.filter((i) => i.id !== meant && updated.includes(i.id))) await update(it.id, { qty: it.qty, status: it.status });
        const pick = behaviour === "askWrong" ? low.find((i) => i.id !== meant) : ctx.items.find((i) => i.id === meant);
        await update(pick.id, { qty: pick.target, status: STATUS });
        const total = (await call("get_summary", { scenario: sid }))?.totalQty ?? null;
        const changed = [...new Set(updated)];
        structured = { question: null, changed, totalQty: total };
        text = /JSON object/.test(prompt) ? JSON.stringify(structured) : `changed: ${changed.join(", ")}\ntotal: ${total}`;
      }
      const messages = [...history, { role: "user", content: prompt }, { role: "assistant", content: text }];
      return { text, structured: /JSON object|return the requested JSON/.test(prompt) || turn === 1 ? structured : null, toolCalls: calls, toolResults: results, rounds: 1, finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, messages };
    },
  };
}

test("asking first, then restocking the named item only, is the right conduct in both tool modes", async () => {
  for (const task of clarifyTasks) {
    const r = await runTrial({ task, mode: "harness", client: agent("ask"), index: 1, seed: 77 });
    assert.equal(r.error, null, r.error);
    assert.equal(r.correct, true, r.reason);
    assert.match(r.reason, /asked first, sku-\d{4} restocked and nothing else, report right/);
    assert.equal(r.dialogue.length, 2);
    assert.match(r.dialogue[1].user, /^It's sku-\d{4} \(/, "the user's second turn was rendered from the model's first");
    assert.equal(r.toolUseOk, true, r.toolUseReason);
    assert.equal(r.ground.clarify.asked, true);
    assert.equal(r.ground.meant, castOf(r.ctx).meant.id);
    assert.equal(r.ground.reread, "after", "the summary was read after the update");
    assert.equal(r.ground.state.items.filter((i) => i.status === STATUS).length, 1, "one item restocked");
    const t = await runTrial({ task, mode: "toolOnly", client: agent("ask"), index: 1, seed: 77 });
    assert.equal(t.correct, true, t.reason);
    assert.match(t.dialogue[1].user, /exactly two lines/);
  }
});

test("a guess is a write before asking even when the user then has it undone; restocking everything is worse; asking and then slipping fails on the state", async () => {
  const guess = await runTrial({ task: C3, mode: "harness", client: agent("guess"), index: 1, seed: 78 });
  assert.equal(guess.correct, false);
  assert.match(guess.reason, /^changed sku-\d{4} before asking which item was meant/);
  assert.equal(guess.ground.reread, "after");
  assert.match(guess.dialogue[1].user, /nothing else should have been touched\. Put every other item back/);
  assert.equal(guess.toolUseOk, false);
  assert.match(guess.toolUseReason, /in turn 1, before asking/);
  const all = await runTrial({ task: C3, mode: "toolOnly", client: agent("all"), index: 1, seed: 78 });
  assert.equal(all.correct, false);
  assert.match(all.reason, /^changed sku-\d{4}, sku-\d{4}, sku-\d{4} before asking/);
  const wrong = await runTrial({ task: C3, mode: "harness", client: agent("askWrong"), index: 1, seed: 78 });
  assert.equal(wrong.correct, false);
  assert.match(wrong.reason, /ended up modified/);
  assert.match(wrong.toolUseReason, /not the item the user named/);
  const { stateVerdict } = await import("../src/tasks/clarify.js");
  assert.equal(stateVerdict({ state: { items: [{ id: "a", qty: 1, status: "ok" }], ops: 0 }, after: { a: { qty: 9, status: STATUS } }, changed: ["a"] }), "nothing was changed on the server");
  assert.equal(stateVerdict({ state: { items: [{ id: "a", qty: 9, status: STATUS }], ops: 1 }, after: { a: { qty: 9, status: STATUS } }, changed: ["a"] }), null);
});

test("clarify2/3 are registered as multi-turn tasks with the clarification capability, skipped for arms, and the policy is on every mode", () => {
  const listed = listTasks().filter((t) => t.family === "clarify");
  assert.deepEqual(listed.map((t) => [t.name, t.level, t.multiTurn]), [["clarify2", 2, true], ["clarify3", 3, true]]);
  for (const t of listed) { assert.deepEqual(t.modes, ["noHarness", "harness", "toolOnly"]); assert.ok(t.capabilities.includes("clarification")); assert.equal(t.skill, "clarify"); assert.deepEqual(t.tools, ["list_items", "update_item", "get_summary"]); }
  const arm = { name: "arm:x", structuredOnly: true }, plain = { name: "p:m" };
  const plan = planMatrix({ tasks: [C2], modes: ["harness", "noHarness"], clients: [arm, plain], count: 2 });
  assert.ok(plan.cells.every((c) => c.client.name !== "arm:x"), "arms are skipped");
  assert.equal(plan.skipped[0].why, "multi-turn");
  assert.match(C2.harness.system, new RegExp(POLICY.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(C2.noHarness.prompt({ scenario: "scn-t", items }), /ask me before you change anything/);
});

test("the control mode (no tools) still renders the reactive turn from the answer, and a stale total is named", async () => {
  let turns = 0;
  const chatty = {
    name: "c", model: "m",
    async chat(messages) { turns++; const last = messages.at(-1).content; return { text: turns === 1 ? "Which item do you mean? I cannot see the server." : `changed: none\ntotal: 0 (after: ${last.slice(0, 20)})`, toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } }; },
    async runWithTools() { throw new Error("not on this path"); },
  };
  const r = await runTrial({ task: C2, mode: "noHarness", client: chatty, index: 1, seed: 79 });
  assert.equal(r.error, null, r.error);
  assert.equal(r.correct, false);
  assert.equal(r.dialogue.length, 2);
  assert.match(r.dialogue[1].user, /^It's sku-\d{4} \(/, "the second turn was rendered from the first answer");
  assert.equal(r.ground.clarify.asked, true);
  assert.match(r.reason, /nothing was changed on the server/);
  const { expectedFrom: ef } = await import("../src/tasks/clarify.js");
  const e = ef({ items, seed: 5 });
  assert.equal(e.before, 35);
  assert.ok(e.totalQty > e.before);
});
