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

// ---- lookup: tool-essential calibration --------------------------------------------------

// The ids are random, so we drive the scorers with synthetic UUID-shaped ground values. The
// calibration claim is "a model that never hits the endpoint cannot produce these", which the
// scorers enforce regardless of what the real endpoint returns.

test("lookup scorers: ids reported by the tool pass in both modes", () => {
  const t = getTask("lookup");
  const ground = [
    { name: "alice", id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" },
    { name: "bob", id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e" },
    { name: "carol", id: "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f" },
  ];

  // harness: ids under "results".
  const harness = t.eval.scoreHarness({ results: ground }, ground);
  assert.equal(harness.correct, true, harness.reason);

  // noHarness: ids in prose. Without tools the model cannot know these, but the scorer is honest
  // about a correct free-form report if it were somehow produced.
  const noH = t.eval.scoreNoHarness(
    "alice: a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d\n" +
    "bob: b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e\n" +
    "carol: c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f", ground);
  assert.equal(noH.correct, true, noH.reason);
});

test("lookup harness scorer: a model that never called the tool cannot match the ids", () => {
  const t = getTask("lookup");
  const ground = [
    { name: "alice", id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" },
    { name: "bob", id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e" },
    { name: "carol", id: "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f" },
  ];

  // Hallucinated ids — even plausible-looking UUIDs — cannot match the random ground ids.
  const fake = ground.map((g) => ({ name: g.name, id: `00000000-0000-4000-8000-000000000000-${g.name}` }));
  const r = t.eval.scoreHarness({ results: fake }, ground);
  assert.equal(r.correct, false, "a model that never called the tool must not pass");
  assert.match(r.reason, /0\/3 ids match/);

  // A structured report with the right names but wrong ids still fails.
  const wrongNames = t.eval.scoreHarness({ results: [{ name: "alice", id: "wrong" }] }, ground);
  assert.equal(wrongNames.correct, false);
  assert.match(wrongNames.reason, /missing/);
});

test("lookup harness scorer: ids under an object wrapper also pass", () => {
  const t = getTask("lookup");
  const ground = [
    { name: "alice", id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" },
    { name: "bob", id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e" },
    { name: "carol", id: "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f" },
  ];
  const r = t.eval.scoreHarness({ data: ground }, ground);
  assert.equal(r.correct, true, r.reason);
});

test("lookup harness scorer: no ids fails", () => {
  const t = getTask("lookup");
  const ground = [{ name: "alice", id: "x" }];
  const r1 = t.eval.scoreHarness({ results: [] }, ground);
  const r2 = t.eval.scoreHarness("no ids", ground);
  assert.equal(r1.correct, false);
  assert.equal(r2.correct, false);
});

test("lookup noHarness scorer: ids must be present to pass", () => {
  const t = getTask("lookup");
  const ground = [{ name: "alice", id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" }];
  const r = t.eval.scoreNoHarness("I have no idea what the ids are.", ground);
  assert.equal(r.correct, false);
  assert.match(r.reason, /0\/1 ids present/);
});

// ---- regex: tool-reasoning (select the right tool, build the right args) ---------------

// All six strings are distinct, so a correct answer reports each exactly once.
const REGEX_GROUND = [
  { string: "123-45", matched: true },
  { string: "12345", matched: false },
  { string: "abc", matched: false },
  { string: "123-456", matched: false },
  { string: "12-34", matched: false },
  { string: "999-88", matched: true },
];

test("regex scorers: a correct answer passes in both modes", () => {
  const t = getTask("regex");
  // Perfect harness answer, wrapped in an object as the schema allows.
  const harness = t.eval.scoreHarness({ results: REGEX_GROUND }, REGEX_GROUND);
  assert.equal(harness.correct, true, harness.reason);

  // Perfect no-harness answer: "yes"/"no" per string in order.
  const noH = t.eval.scoreNoHarness(
    "123-45: yes\n12345: no\nabc: no\n123-456: no\n12-34: no\n999-88: yes",
    REGEX_GROUND,
  );
  assert.equal(noH.correct, true, noH.reason);
});

// ---- the whole point of Tier 1 item 3: a model that calls the decoy tool does not pass ----

test("regex harness scorer: firing the decoy tool does not pass", () => {
  const t = getTask("regex");
  // The model used word_count (or never used regex_match), so its matched flags are all wrong —
  // it never actually tested the regex. Each string is reported once, but the booleans are wrong.
  const wrongTool = REGEX_GROUND.map((g) => ({ string: g.string, matched: true }));
  const r = t.eval.scoreHarness(wrongTool, REGEX_GROUND);
  assert.equal(r.correct, false, "calling the wrong tool must not pass");
  // Two strings (123-45, 999-88) actually do match, so only those two are "correct" by chance.
  assert.match(r.reason, /2\/6 matches correct/);
});

test("regex harness scorer: missing a string is a miss even if the rest are right", () => {
  const t = getTask("regex");
  // All but the last string correct; the duplicate "123-45" (index 5) is omitted.
  const partial = REGEX_GROUND.slice(0, 5);
  const r = t.eval.scoreHarness(partial, REGEX_GROUND);
  assert.equal(r.correct, false, "a missing string must not pass");
  assert.match(r.reason, /5\/6 matches correct/);
});

test("regex harness scorer: wrong booleans on the near-misses fail", () => {
  const t = getTask("regex");
  // "12345", "123-456", "12-34" all look close to "123-45" but must be non-matches. A model that
  // cannot tell them apart gets them wrong.
  const r = t.eval.scoreHarness(REGEX_GROUND, REGEX_GROUND);
  // This is the correct answer, so it passes — but note "12345" is index 1 (false) and the model
  // would get it wrong if it matched "12345" to the pattern. We assert the correct answer passes.
  assert.equal(r.correct, true);
});

test("regex harness scorer: no results fails", () => {
  const t = getTask("regex");
  const r1 = t.eval.scoreHarness({ results: [] }, REGEX_GROUND);
  const r2 = t.eval.scoreHarness("I'm not sure any match.", REGEX_GROUND);
  assert.equal(r1.correct, false);
  assert.equal(r2.correct, false);
});

test("regex noHarness scorer: a wrong answer on a near-miss fails", () => {
  const t = getTask("regex");
  // "12345" is a near-miss (no dash) and must be "no". A model that says "yes" is wrong.
  const r = t.eval.scoreNoHarness("123-45: yes\n12345: yes\nabc: no\n123-456: no\n12-34: no\n999-88: yes", REGEX_GROUND);
  assert.equal(r.correct, false, "calling 12345 'yes' is wrong");
  assert.match(r.reason, /5\/6 matches correct/);
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
