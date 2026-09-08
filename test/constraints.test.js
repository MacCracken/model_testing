import { test } from "node:test";
import assert from "node:assert/strict";
import { pickConstraints, checkConstraints, constraintBlock, parseConstraintsSuffix, withConstraints, CONSTRAINT_MODES } from "../src/constraints.js";
import { runTrial, summarize } from "../src/runner.js";
import { resolveClients } from "../src/providers/index.js";
import { goalPrompt } from "../src/harness/util.js";

const byId = (set, prefix) => set.find((c) => c.id.startsWith(prefix));

test("pickConstraints is deterministic in the seed, sized by level, mode-aware", () => {
  assert.deepEqual(CONSTRAINT_MODES, ["light", "medium", "heavy"]);
  const a = pickConstraints({ seed: 9, how: "medium" }), b = pickConstraints({ seed: 9, how: "medium" });
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
  assert.equal(a.length, 3);
  assert.equal(pickConstraints({ seed: 9, how: "light" }).length, 1);
  assert.equal(pickConstraints({ seed: 9, how: "heavy" }).length, 5);
  assert.notDeepEqual(pickConstraints({ seed: 9, how: "heavy" }).map((c) => c.id), pickConstraints({ seed: 10, how: "heavy" }).map((c) => c.id));
  const structured = pickConstraints({ seed: 3, how: "heavy", structured: true, keys: ["work", "answer"] });
  assert.equal(structured.length, 3, "the JSON pool has three families");
  assert.ok(structured.every((c) => /^(key_order|attest:|minified)/.test(c.id)));
  assert.equal(pickConstraints({ seed: 3, how: "heavy", structured: true, keys: ["answer"] }).length, 2, "key order needs two keys");
  const arraySchema = pickConstraints({ seed: 3, how: "heavy", structured: true, keys: [], schemaType: "array" });
  assert.deepEqual(arraySchema.map((c) => c.id), ["minified"], "an array answer has no keys to order and nowhere for an attestation");
  assert.match(constraintBlock(a), /^\n\nFormatting requirements — every one of them must be met:\n1\. /);
  assert.equal(constraintBlock([]), "");
});

test("each free-form family checks what it says", () => {
  const all = Object.fromEntries([...Array(40).keys()].flatMap((s) => pickConstraints({ seed: s, how: "heavy" })).map((c) => [c.id.split(":")[0], c]));
  const max = all.max_words, min = all.min_words;
  assert.equal(max.check("one two three"), true);
  assert.equal(max.check(Array(200).fill("w").join(" ")), false);
  assert.equal(min.check("too short"), false);
  assert.equal(min.check(Array(60).fill("w").join(" ")), true);
  const forbid = all.forbid; const w = forbid.id.split(":")[1];
  assert.equal(forbid.check(`this is ${w} bad`), false);
  assert.equal(forbid.check(`this is fine (${w}ly does not count)`), true);
  const include = all.include; const iw = include.id.split(":")[1];
  assert.equal(include.check(`all ${iw}.`), true);
  assert.equal(include.check("nothing"), false);
  const end = all.end_with; const ep = end.id.split(":").slice(1).join(":");
  assert.equal(end.check(`done. ${ep}`), true);
  assert.equal(end.check(`done. ${ep} **`), true, "trailing markdown is forgiven");
  assert.equal(end.check(`${ep} done.`), false);
  const start = all.start_with; const sp = start.id.split(":").slice(1).join(":");
  assert.equal(start.check(`${sp} the rest`), true);
  assert.equal(start.check(`**${sp}** the rest`), true);
  assert.equal(start.check(`the rest ${sp}`), false);
  assert.equal(all.no_commas.check("a, b"), false);
  assert.equal(all.no_commas.check("a and b"), true);
  const bullets = all.bullets; const n = Number(bullets.id.split(":")[1]);
  assert.equal(bullets.check(Array(n).fill("- item").join("\n")), true);
  assert.equal(bullets.check(Array(n + 1).fill("- item").join("\n")), false);
});

test("each JSON family checks what it says", () => {
  const set = pickConstraints({ seed: 1, how: "heavy", structured: true, keys: ["work", "answer"] });
  const order = byId(set, "key_order"), attest = byId(set, "attest"), minified = byId(set, "minified");
  assert.equal(order.check('{"work":["a"],"answer":5}'), true);
  assert.equal(order.check('{"answer":5,"work":["a"]}'), false);
  assert.equal(order.check('Sure: {"work":[],"answer":1}'), true, "prose around the JSON is ignored");
  const v = attest.id.split(":")[1];
  assert.equal(attest.check("", { answer: 1, attestation: v }), true);
  assert.equal(attest.check("", { answer: 1 }), false);
  assert.equal(minified.check('{"a":1,"b":2}'), true);
  assert.equal(minified.check('{\n  "a": 1\n}'), false);
  const verdict = checkConstraints(set, '{"work":[],"answer":1}', { work: [], answer: 1 });
  assert.equal(verdict.total, 3);
  assert.equal(verdict.met, 2, "order and minified met, attestation missing");
  assert.deepEqual(verdict.list.map((c) => c.met), set.map((c) => c.id !== attest.id));
});

test("parseConstraintsSuffix and resolveClients", () => {
  assert.deepEqual(parseConstraintsSuffix("openai:gpt-4o-mini@constraints"), { base: "openai:gpt-4o-mini", how: "light" });
  assert.deepEqual(parseConstraintsSuffix("pi:openai/gpt-4o-mini@constraints:heavy"), { base: "pi:openai/gpt-4o-mini", how: "heavy" });
  assert.throws(() => parseConstraintsSuffix("x@constraints:brutal"), /unknown constraints level/);
  const [plain, c] = resolveClients("local:m,local:m@constraints:medium");
  assert.equal(plain.name, "local:m");
  assert.equal(c.name, "local:m@constraints:medium");
  assert.equal(c.baseName, "local:m");
  assert.throws(() => resolveClients("local:m@skill@constraints"), /one variant per client/);
});

test("the wrapper appends the requirements, checks the answer, and reports through the row", async () => {
  const seen = [];
  const client = {
    name: "local:m", model: "m",
    async chat(messages, tools, opts) { seen.push({ path: "chat", content: messages.at(-1).content, opts }); return { text: "Result: the count is 4 — noted. That is all.", toolCalls: [], finishReason: "stop", usage: null }; },
    async runWithTools(prompt, tools, system, opts) { seen.push({ path: "tools", prompt, opts }); return { text: '{"answer":4}', structured: { answer: 4 }, toolCalls: [], toolResults: [], rounds: 1, finishReason: "stop", usage: null }; },
  };
  const w = withConstraints(client, "medium");
  assert.equal(w.name, "local:m@constraints:medium");
  const task = { name: "probe", noHarness: { prompt: "count them" }, harness: { prompt: "count them", tools: [{ name: "t", impl: async () => "" }], schema: { type: "object", properties: { work: { type: "array" }, answer: { type: "integer" } } } },
    eval: { ground: () => 4, scoreHarness: (o) => ({ correct: o?.answer === 4, reason: "" }), scoreNoHarness: (t) => ({ correct: /4/.test(t), reason: "" }) } };
  const free = await runTrial({ task, mode: "noHarness", client: w, seed: 11 });
  const expected = pickConstraints({ seed: 11, how: "medium" });
  assert.match(seen[0].content, /count them\n\nFormatting requirements/);
  assert.equal(seen[0].opts.seed, 11, "the chat path gets the trial context too");
  assert.equal(free.constraints.how, "medium");
  assert.equal(free.constraints.total, 3);
  assert.deepEqual(free.constraints.list.map((c) => c.id), expected.map((c) => c.id));
  assert.match(free.prompt, /Formatting requirements/, "the row shows the prompt the model saw");
  assert.equal(free.correct, true, "correctness is scored on the answer regardless of adherence");
  const structured = await runTrial({ task, mode: "harness", client: w, seed: 11 });
  assert.ok(structured.constraints.list.every((c) => /^(key_order|attest:|minified)/.test(c.id)), "JSON requirements in a structured mode");
  assert.match(seen[1].prompt, /Formatting requirements/);
  assert.deepEqual(seen[1].opts.constraints, structured.constraints.list.map((c) => c.text));
  // An arm: the prompt is left alone, the requirements travel in opts and reach the goal prompt.
  const arm = withConstraints({ name: "arm:x", model: "m", structuredOnly: true, async runWithTools(p, t, s, opts) { seen.push({ path: "arm", prompt: p, opts }); return { text: "{}", structured: {}, toolCalls: [], toolResults: [], rounds: 1 }; } }, "light");
  await arm.runWithTools("goal text", [], "sys", { task, mode: "harness", seed: 2 });
  assert.equal(seen.at(-1).prompt, "goal text");
  assert.equal(seen.at(-1).opts.constraints.length, 1);
  assert.match(goalPrompt(task, "harness", "fb", null, null, seen.at(-1).opts.constraints), /Formatting requirements — every one of them must be met:\n1\. /);
});

test("summarize pairs constraint variants and pools adherence", () => {
  const row = (client, correct, i, over = {}) => ({ task: "tally20", mode: "noHarness", client, model: "m", index: i, correct, toolCalls: [], latencyMs: 1, ...over });
  const co = (met) => ({ baseClient: "local:m", constraints: { how: "heavy", applied: true, total: 5, met, list: [] } });
  const rows = [row("local:m", true, 1), row("local:m", true, 2), row("local:m", true, 3), row("local:m", true, 4),
    row("local:m@constraints:heavy", true, 1, co(5)), row("local:m@constraints:heavy", false, 2, co(3)), row("local:m@constraints:heavy", true, 3, co(4)), row("local:m@constraints:heavy", true, 4, co(5))];
  const s = summarize(rows);
  const d = s.delta.byConstraints["tally20|noHarness|local:m@constraints:heavy"];
  assert.equal(d.deltaPp, -25);
  assert.equal(d.met, 17);
  assert.equal(d.total, 20);
  assert.equal(s.delta.constraints.heavy.met, 17);
  assert.equal(summarize(rows.slice(0, 4)).delta.constraints, null);
});
