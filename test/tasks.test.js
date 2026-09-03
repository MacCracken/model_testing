import { test } from "node:test";
import assert from "node:assert/strict";

import { getTask } from "../src/tasks/registry.js";
import { parseJSONLoose } from "../src/json.js";
import { unwrapList } from "../src/tasks/util.js";

// The health/hello tasks need a live webserver for ground(). Their *scorers* are pure functions
// of (answer, ground), so we can drive them with synthetic ground values — no server needed.

// ---- shared: unwrapping the list out of whatever the model wrapped it in ------------------

test("unwrapList accepts a bare array, a named wrapper, the schema's own items key, or a lone entry", () => {
  const list = [{ id: 1 }];
  assert.deepEqual(unwrapList(list), list);
  assert.deepEqual(unwrapList({ results: list }, ["results"]), list);
  assert.deepEqual(unwrapList({ type: "array", items: list }, ["results"]), list);
  assert.deepEqual(unwrapList({ id: 1 }, ["results"], (o) => o.id !== undefined), [{ id: 1 }]);
  assert.deepEqual(unwrapList({ other: list }, ["results"]), []);
  assert.deepEqual(unwrapList("nope", ["results"]), []);
  assert.deepEqual(unwrapList(null), []);
});

// ---- health --------------------------------------------------------------------

test("health scorers: matching ground passes in both modes", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  const harness = t.eval.scoreHarness({ status: "ok", uptimeSec: 42 }, ground);
  assert.equal(harness.correct, true, harness.reason);
  const noH = t.eval.scoreNoHarness("The webserver is up and OK.", ground);
  assert.equal(noH.correct, true, noH.reason);
});

test("health harness scorer rejects a wrong status", () => {
  const t = getTask("health");
  const r = t.eval.scoreHarness({ status: "down", uptimeSec: 42 }, { status: "ok", uptimeSec: 42 });
  assert.equal(r.correct, false);
  assert.match(r.reason, /status/);
});

test("health harness scorer rejects a hallucinated uptime", () => {
  const t = getTask("health");
  const r = t.eval.scoreHarness({ status: "ok", uptimeSec: 1_000_000 }, { status: "ok", uptimeSec: 42 });
  assert.equal(r.correct, false);
  assert.match(r.reason, /uptimeSec/);
});

test("health harness scorer accepts a small uptime drift", () => {
  const t = getTask("health");
  const r = t.eval.scoreHarness({ status: "ok", uptimeSec: 43 }, { status: "ok", uptimeSec: 42 });
  assert.equal(r.correct, true, r.reason);
});

test("health harness scorer rejects a non-numeric uptime", () => {
  const t = getTask("health");
  const r = t.eval.scoreHarness({ status: "ok", uptimeSec: "soon" }, { status: "ok", uptimeSec: 42 });
  assert.equal(r.correct, false);
  assert.match(r.reason, /uptimeSec/);
});

test("health harness scorer rejects a missing structured object", () => {
  const t = getTask("health");
  for (const bad of ["not json", "nope", null, undefined, [1, 2]]) {
    assert.equal(t.eval.scoreHarness(bad, { status: "ok", uptimeSec: 42 }).correct, false, `${bad} should not pass`);
  }
});

test("health noHarness scorer rejects no status at all", () => {
  const t = getTask("health");
  const r = t.eval.scoreNoHarness("I have no idea about the webserver.", { status: "ok", uptimeSec: 42 });
  assert.equal(r.correct, false);
  assert.match(r.reason, /no status/);
});

test("health noHarness scorer scores a DOWN report as wrong when ground is ok", () => {
  const t = getTask("health");
  const r = t.eval.scoreNoHarness("The webserver is DOWN and unreachable.", { status: "ok", uptimeSec: 42 });
  assert.equal(r.correct, false, "DOWN while ground is ok is a wrong answer");
});

test("health noHarness scorer does not read a port number as a 5xx status", () => {
  const t = getTask("health");
  const r = t.eval.scoreNoHarness("The server on port 5000 is OK.", { status: "ok", uptimeSec: 42 });
  assert.equal(r.correct, true, r.reason);
});

// ---- hello ---------------------------------------------------------------------

const HELLO_GROUND = [
  { name: "alice", message: "Hello, alice!" },
  { name: "bob", message: "Hello, bob!" },
  { name: "carol", message: "Hello, carol!" },
];

test("hello scorers: all greetings match passes in both modes, under any wrapper", () => {
  const t = getTask("hello");
  for (const out of [HELLO_GROUND, { greetings: HELLO_GROUND }, { type: "array", items: HELLO_GROUND }]) {
    const r = t.eval.scoreHarness(out, HELLO_GROUND);
    assert.equal(r.correct, true, r.reason);
  }
  const noH = t.eval.scoreNoHarness("alice: Hello, alice!\nbob: Hello, bob!\ncarol: Hello, carol!", HELLO_GROUND);
  assert.equal(noH.correct, true, noH.reason);
});

test("hello harness scorer: missing a greeting fails and names it", () => {
  const t = getTask("hello");
  const r = t.eval.scoreHarness({ greetings: [{ name: "alice", message: "Hello, alice!" }] }, HELLO_GROUND);
  assert.equal(r.correct, false);
  assert.match(r.reason, /missing/);
  assert.match(r.reason, /carol/);
});

test("hello harness scorer: empty structured output fails", () => {
  const t = getTask("hello");
  assert.equal(t.eval.scoreHarness({ greetings: [] }, HELLO_GROUND).correct, false);
  assert.equal(t.eval.scoreHarness("no greetings here", HELLO_GROUND).correct, false);
});

test("hello noHarness scorer: partial credit is not full credit", () => {
  const t = getTask("hello");
  const r = t.eval.scoreNoHarness("alice: Hello, alice!\nbob: Hello, bob!", HELLO_GROUND);
  assert.equal(r.correct, false);
  assert.match(r.reason, /2\/3/);
});

// ---- lookup: tool-essential calibration --------------------------------------------------
//
// The endpoint mints a new random id on every call, so the only truth is what the tool returned
// during the trial. ground() reads that back out of the tool results the runner hands it.

const A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const B = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const C = "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f";
const lookupResult = (results) => ({ id: "call_1", name: "lookup", ok: true, arguments: {}, content: JSON.stringify({ results }) });
const FULL_LOOKUP = [lookupResult([{ name: "alice", id: A }, { name: "bob", id: B }, { name: "carol", id: C }])];

test("lookup ground is the ids the tool returned during the trial", () => {
  const t = getTask("lookup");
  assert.deepEqual(t.eval.ground({ toolResults: FULL_LOOKUP }), [
    { name: "alice", ids: [A] }, { name: "bob", ids: [B] }, { name: "carol", ids: [C] },
  ]);
});

test("lookup ground: repeated calls add ids; failed calls and other tools are ignored", () => {
  const t = getTask("lookup");
  const ground = t.eval.ground({ toolResults: [
    lookupResult([{ name: "alice", id: A }]),
    lookupResult([{ name: "Alice", id: "second-alice-id" }]),
    lookupResult([{ name: "bob", id: B }]),
    { id: "x", name: "lookup", ok: false, content: "tool error: lookup tool: no name given" },
    { id: "y", name: "word_count", ok: true, content: JSON.stringify({ results: [{ name: "carol", id: "not-from-lookup" }] }) },
  ] });
  assert.deepEqual(ground, [
    { name: "alice", ids: [A, "second-alice-id"] }, { name: "bob", ids: [B] }, { name: "carol", ids: [] },
  ]);
});

test("lookup ground is empty when no tool ran (free-form mode)", () => {
  const t = getTask("lookup");
  const empty = [{ name: "alice", ids: [] }, { name: "bob", ids: [] }, { name: "carol", ids: [] }];
  assert.deepEqual(t.eval.ground({}), empty);
  assert.deepEqual(t.eval.ground(), empty);
});

test("lookup harness scorer: reporting the ids the tool returned passes under any wrapper", () => {
  const t = getTask("lookup");
  const ground = t.eval.ground({ toolResults: FULL_LOOKUP });
  const list = [{ name: "alice", id: A }, { name: "bob", id: B }, { name: "carol", id: C }];
  for (const out of [list, { results: list }, { data: list }, { type: "array", items: list }]) {
    const r = t.eval.scoreHarness(out, ground);
    assert.equal(r.correct, true, r.reason);
  }
});

test("lookup harness scorer: any id the tool returned for a name is accepted", () => {
  const t = getTask("lookup");
  const ground = t.eval.ground({ toolResults: [
    lookupResult([{ name: "alice", id: A }, { name: "bob", id: B }, { name: "carol", id: C }]),
    lookupResult([{ name: "alice", id: "second-alice-id" }]),
  ] });
  const r = t.eval.scoreHarness([{ name: "alice", id: "second-alice-id" }, { name: "bob", id: B }, { name: "carol", id: C }], ground);
  assert.equal(r.correct, true, r.reason);
});

test("lookup harness scorer: invented ids fail even when they look like UUIDs", () => {
  const t = getTask("lookup");
  const ground = t.eval.ground({ toolResults: FULL_LOOKUP });
  const fake = ["alice", "bob", "carol"].map((name, i) => ({ name, id: `00000000-0000-4000-8000-00000000000${i}` }));
  const r = t.eval.scoreHarness({ results: fake }, ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /0\/3 ids match/);
  assert.match(r.reason, /reported an id the tool did not return for alice, bob, carol/);
});

test("lookup harness scorer: a partial report says which names are missing", () => {
  const t = getTask("lookup");
  const ground = t.eval.ground({ toolResults: FULL_LOOKUP });
  const r = t.eval.scoreHarness({ name: "alice", id: A }, ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /1\/3 ids match/);
  assert.match(r.reason, /bob, carol/);
});

test("lookup harness scorer: a name that was never looked up is called out", () => {
  const t = getTask("lookup");
  const ground = t.eval.ground({ toolResults: [lookupResult([{ name: "alice", id: A }, { name: "bob", id: B }])] });
  const r = t.eval.scoreHarness([{ name: "alice", id: A }, { name: "bob", id: B }, { name: "carol", id: "made-up" }], ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /never looked up carol/);
});

test("lookup harness scorer: never calling the tool cannot pass", () => {
  const t = getTask("lookup");
  const r = t.eval.scoreHarness([{ name: "alice", id: A }], t.eval.ground({}));
  assert.equal(r.correct, false);
  assert.match(r.reason, /never called/);
});

test("lookup harness scorer: no ids in the output fails", () => {
  const t = getTask("lookup");
  const ground = t.eval.ground({ toolResults: FULL_LOOKUP });
  assert.equal(t.eval.scoreHarness({ results: [] }, ground).correct, false);
  assert.equal(t.eval.scoreHarness("no ids", ground).correct, false);
  assert.equal(t.eval.scoreHarness(null, ground).correct, false);
});

test("lookup noHarness scorer: without a tool call there is nothing to match", () => {
  const t = getTask("lookup");
  const r = t.eval.scoreNoHarness(`alice: ${A}\nbob: ${B}\ncarol: ${C}`, t.eval.ground({}));
  assert.equal(r.correct, false);
  assert.match(r.reason, /never fetched/);
});

test("lookup noHarness scorer (toolOnly path): the tool's ids in free text pass", () => {
  const t = getTask("lookup");
  const ground = t.eval.ground({ toolResults: FULL_LOOKUP });
  assert.equal(t.eval.scoreNoHarness(`alice: ${A}\nbob: ${B}\ncarol: ${C}`, ground).correct, true);
  const partial = t.eval.scoreNoHarness(`alice: ${A}`, ground);
  assert.equal(partial.correct, false);
  assert.match(partial.reason, /1\/3 ids present/);
});

// ---- regex: tool-reasoning (select the right tool, build the right args) ---------------

const REGEX_GROUND = [
  { string: "123-45", matched: true },
  { string: "12345", matched: false },
  { string: "abc", matched: false },
  { string: "123-456", matched: false },
  { string: "12-34", matched: false },
  { string: "999-88", matched: true },
];

test("regex ground: only the two well-formed strings match the anchored pattern", () => {
  assert.deepEqual(getTask("regex").eval.ground(), REGEX_GROUND);
});

test("regex scorers: a correct answer passes in both modes", () => {
  const t = getTask("regex");
  for (const out of [REGEX_GROUND, { results: REGEX_GROUND }, { type: "array", items: REGEX_GROUND }]) {
    const r = t.eval.scoreHarness(out, REGEX_GROUND);
    assert.equal(r.correct, true, r.reason);
  }
  const noH = t.eval.scoreNoHarness("123-45: yes\n12345: no\nabc: no\n123-456: no\n12-34: no\n999-88: yes", REGEX_GROUND);
  assert.equal(noH.correct, true, noH.reason);
});

test("regex harness scorer: firing the decoy tool does not pass", () => {
  const t = getTask("regex");
  // The model used word_count (or never tested anything) and marked everything matched.
  const r = t.eval.scoreHarness(REGEX_GROUND.map((g) => ({ string: g.string, matched: true })), REGEX_GROUND);
  assert.equal(r.correct, false);
  assert.match(r.reason, /2\/6 matches correct/);
});

test("regex harness scorer: missing a string is a miss even if the rest are right", () => {
  const t = getTask("regex");
  const r = t.eval.scoreHarness(REGEX_GROUND.slice(0, 5), REGEX_GROUND);
  assert.equal(r.correct, false);
  assert.match(r.reason, /5\/6 matches correct/);
});

test("regex harness scorer: no results fails", () => {
  const t = getTask("regex");
  assert.equal(t.eval.scoreHarness({ results: [] }, REGEX_GROUND).correct, false);
  assert.equal(t.eval.scoreHarness("I'm not sure any match.", REGEX_GROUND).correct, false);
});

test("regex noHarness scorer: a wrong answer on a near-miss fails", () => {
  const t = getTask("regex");
  const r = t.eval.scoreNoHarness("123-45: yes\n12345: yes\nabc: no\n123-456: no\n12-34: no\n999-88: yes", REGEX_GROUND);
  assert.equal(r.correct, false, "calling 12345 'yes' is wrong");
  assert.match(r.reason, /5\/6 matches correct/);
});

test("regex noHarness scorer accepts bare yes/no lines in order — the literal reading of the prompt", () => {
  const t = getTask("regex");
  const r = t.eval.scoreNoHarness("yes\nno\nno\nno\nno\nyes", REGEX_GROUND);
  assert.equal(r.correct, true, r.reason);
  assert.match(r.reason, /read positionally/);
  const wrong = t.eval.scoreNoHarness("yes\nyes\nno\nno\nno\nyes", REGEX_GROUND);
  assert.equal(wrong.correct, false);
  assert.match(wrong.reason, /5\/6/);
});

test("regex noHarness scorer accepts labelled lines with list markers, prose, and any order", () => {
  const t = getTask("regex");
  const text = [
    "Here are the results:",
    "1. 999-88 → yes (three digits, dash, two digits)",
    "2. 12345 → no",
    "3. abc → no",
    "4. 123-456 → no, three trailing digits",
    "5. 12-34 → no",
    "6. 123-45 → yes",
  ].join("\n");
  const r = t.eval.scoreNoHarness(text, REGEX_GROUND);
  assert.equal(r.correct, true, r.reason);
});

test("regex noHarness scorer never reads the 123-456 line as the answer for 123-45", () => {
  const t = getTask("regex");
  const r = t.eval.scoreNoHarness("123-456: no\n123-45: yes\n12345: no\nabc: no\n12-34: no\n999-88: yes", REGEX_GROUND);
  assert.equal(r.correct, true, r.reason);
});

// ---- shared: harness answers must survive parseJSONLoose before scoring ----------

test("a harness answer wrapped in prose is still parseable before scoring", () => {
  const t = getTask("health");
  const raw = "Sure! Here is the health report:\n\n{\"status\":\"ok\",\"uptimeSec\":42}";
  const parsed = parseJSONLoose(raw);
  assert.ok(parsed, "parseJSONLoose should extract the JSON");
  assert.equal(t.eval.scoreHarness(parsed, { status: "ok", uptimeSec: 42 }).correct, true);
});

test("health noHarness scorer calls a hedge a hedge, not a DOWN report", () => {
  const t = getTask("health");
  const r = t.eval.scoreNoHarness("I cannot check the endpoint, so I can't say whether it is OK or DOWN.", { status: "ok", uptimeSec: 42 });
  assert.equal(r.correct, false);
  assert.match(r.reason, /hedged/);
});
