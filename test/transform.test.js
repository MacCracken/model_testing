import { test } from "node:test";
import assert from "node:assert/strict";

import { getTask } from "../src/tasks/registry.js";

const IDS = { alice: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", bob: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e", carol: "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f" };
const result = (names) => ({ id: "c", name: "hello", ok: true, content: JSON.stringify({ greetings: names.map((n) => ({ name: n, message: `Hello, ${n}!`, id: IDS[n] })) }) });
const good = () => Object.keys(IDS).map((n) => ({ name: n, idPrefix: IDS[n].slice(0, 8), shout: `HELLO, ${n.toUpperCase()}!` }));

test("transform ground carries the ids and messages the tool returned", () => {
  const t = getTask("transform");
  const g = t.eval.ground({ toolResults: [result(["alice", "bob", "carol"])] });
  assert.deepEqual(g[0], { name: "alice", ids: [IDS.alice], message: "Hello, alice!" });
  assert.deepEqual(t.eval.ground({})[1], { name: "bob", ids: [], message: "Hello, bob!" });
});

test("transform harness scorer: correct prefixes and upper-cased greetings pass, wrong ones are named", () => {
  const t = getTask("transform");
  const ground = t.eval.ground({ toolResults: [result(["alice", "bob", "carol"])] });
  assert.equal(t.eval.scoreHarness(good(), ground).correct, true);
  assert.equal(t.eval.scoreHarness({ results: good() }, ground).correct, true);
  const bad = good(); bad[1].shout = "Hello, bob!"; bad[2].idPrefix = "deadbeef";
  const r = t.eval.scoreHarness(bad, ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /1\/3 correct/);
  assert.match(r.reason, /bob: shout wrong/);
  assert.match(r.reason, /carol: idPrefix wrong/);
  assert.match(t.eval.scoreHarness(good(), t.eval.ground({})).reason, /never called/);
});

test("transform free-form scorer reads name: prefix SHOUT lines", () => {
  const t = getTask("transform");
  const ground = t.eval.ground({ toolResults: [result(["alice", "bob", "carol"])] });
  const text = `alice: ${IDS.alice.slice(0, 8)} HELLO, ALICE!\nbob: ${IDS.bob.slice(0, 8)} HELLO, BOB!\ncarol: ${IDS.carol.slice(0, 8)} HELLO, CAROL!`;
  assert.equal(t.eval.scoreNoHarness(text, ground).correct, true);
  assert.equal(t.eval.scoreNoHarness("alice: 12345678 HELLO, ALICE!", ground).correct, false);
});

test("transform tool use: every name must be passed to hello", () => {
  const t = getTask("transform");
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "hello", arguments: { name: "alice, bob, carol" } }] }).ok, true);
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "hello", arguments: { name: "alice" } }] }).ok, false);
});
