import { test } from "node:test";
import assert from "node:assert/strict";

import { getTask } from "../src/tasks/registry.js";
import { parseJSONLoose } from "../src/json.js";

// The health/hello tasks need a live webserver for ground(). Their *scorers* are pure functions
// of (answer, ground), so we can drive them with synthetic ground values — no server needed.

// ---- health --------------------------------------------------------------------

test("health scorers: matching ground passes in both modes", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };

  // harness: exact object, correct status + uptime within tolerance.
  const harness = t.eval.scoreHarness({ status: "ok", uptimeSec: 42 }, ground);
  assert.equal(harness.correct, true, harness.reason);

  // noHarness: free text with the OK keyword.
  const noH = t.eval.scoreNoHarness("The webserver is up and OK.", ground);
  assert.equal(noH.correct, true, noH.reason);
});

test("health harness scorer rejects a wrong status", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  const r = t.eval.scoreHarness({ status: "down", uptimeSec: 42 }, ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /status/);
});

test("health harness scorer rejects a hallucinated uptime", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  // Wrong status is enough to fail, but a plausible-looking number proves the check is real.
  const r = t.eval.scoreHarness({ status: "ok", uptimeSec: 1_000_000 }, ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /uptimeSec/);
});

test("health harness scorer accepts a small uptime drift", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  const r = t.eval.scoreHarness({ status: "ok", uptimeSec: 43 }, ground);
  assert.equal(r.correct, true, r.reason);
});

test("health harness scorer rejects a non-numeric uptime", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  const r = t.eval.scoreHarness({ status: "ok", uptimeSec: "soon" }, ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /uptimeSec/);
});

test("health harness scorer rejects a missing structured object", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  for (const bad of ["not json", "nope", null, undefined, "an array [1,2]"]) {
    const r = t.eval.scoreHarness(bad, ground);
    assert.equal(r.correct, false, `${bad} should not pass`);
  }
});

test("health noHarness scorer rejects no status at all", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  const r = t.eval.scoreNoHarness("I have no idea about the webserver.", ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /no status/);
});

test("health noHarness scorer correctly rejects an actually-down server", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  // Even though ground is ok, a truthful "DOWN" answer is scored correctly (the model was wrong).
  const r = t.eval.scoreNoHarness("The webserver is DOWN and unreachable.", ground);
  assert.equal(r.correct, false, "DOWN while ground is ok is a wrong answer");
});

// ---- hello ---------------------------------------------------------------------

test("hello scorers: all greetings match passes in both modes", () => {
  const t = getTask("hello");
  const ground = [{ name: "alice", message: "Hello, alice!" }, { name: "bob", message: "Hello, bob!" }, { name: "carol", message: "Hello, carol!" }];

  // harness: wrapped in an object under "greetings".
  const harness = t.eval.scoreHarness({ greetings: ground }, ground);
  assert.equal(harness.correct, true, harness.reason);

  // noHarness: all three greetings present in prose.
  const noH = t.eval.scoreNoHarness("alice: Hello, alice!\nbob: Hello, bob!\ncarol: Hello, carol!", ground);
  assert.equal(noH.correct, true, noH.reason);
});

test("hello harness scorer: missing a greeting fails", () => {
  const t = getTask("hello");
  const ground = [
    { name: "alice", message: "Hello, alice!" },
    { name: "bob", message: "Hello, bob!" },
    { name: "carol", message: "Hello, carol!" },
  ];
  const r = t.eval.scoreHarness({ greetings: [{ name: "alice", message: "Hello, alice!" }] }, ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /missing/);
  assert.match(r.reason, /carol/);
});

test("hello harness scorer: empty structured output fails", () => {
  const t = getTask("hello");
  const ground = [{ name: "alice", message: "Hello, alice!" }];
  const r = t.eval.scoreHarness({ greetings: [] }, ground);
  assert.equal(r.correct, false);
  const r2 = t.eval.scoreHarness("no greetings here", ground);
  assert.equal(r2.correct, false);
});

test("hello noHarness scorer: partial credit is not full credit", () => {
  const t = getTask("hello");
  const ground = [
    { name: "alice", message: "Hello, alice!" },
    { name: "bob", message: "Hello, bob!" },
    { name: "carol", message: "Hello, carol!" },
  ];
  const r = t.eval.scoreNoHarness("alice: Hello, alice!\nbob: Hello, bob!", ground);
  assert.equal(r.correct, false, "only 2 of 3 present must fail");
  assert.match(r.reason, /2\/3/);
});

// ---- shared: harness answers must survive parseJSONLoose before scoring ----------

test("a harness answer wrapped in prose is still parseable before scoring", () => {
  const t = getTask("health");
  const ground = { status: "ok", uptimeSec: 42 };
  const raw = "Sure! Here is the health report:\n\n{\"status\":\"ok\",\"uptimeSec\":42}";
  const parsed = parseJSONLoose(raw);
  assert.ok(parsed, "parseJSONLoose should extract the JSON");
  assert.equal(t.eval.scoreHarness(parsed, ground).correct, true);
});
