import { test } from "node:test";
import assert from "node:assert/strict";

import { getTask } from "../src/tasks/registry.js";
import { judgeNameCalls } from "../src/tasks/util.js";

// Tool-use verdicts: did the model use the right tool, with the right arguments, the right number
// of times? Independent of whether the final answer was correct.

const call = (name, args) => ({ id: "c", name, arguments: args });

test("judgeNameCalls: every name once, comma-joined or spread across calls", () => {
  const ok1 = judgeNameCalls([call("hello", { name: "alice, bob, carol" })], "hello", ["alice", "bob", "carol"]);
  const ok2 = judgeNameCalls([call("hello", { name: "alice" }), call("hello", { name: "Bob" }), call("hello", { name: "carol" })], "hello", ["alice", "bob", "carol"]);
  assert.equal(ok1.ok, true, ok1.reason);
  assert.equal(ok2.ok, true, ok2.reason);
});

test("judgeNameCalls: missing, extra, and never-called are named", () => {
  const missing = judgeNameCalls([call("hello", { name: "alice" })], "hello", ["alice", "bob", "carol"]);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /never passed bob, carol/);
  const extra = judgeNameCalls([call("hello", { name: "alice, bob, carol, dave" })], "hello", ["alice", "bob", "carol"]);
  assert.equal(extra.ok, false);
  assert.match(extra.reason, /unexpected name\(s\) dave/);
  const none = judgeNameCalls([call("other", {})], "hello", ["alice"]);
  assert.equal(none.ok, false);
  assert.match(none.reason, /never called/);
});

test("health tool use: the health tool must be called", () => {
  const t = getTask("health");
  assert.equal(t.eval.toolUse({ toolCalls: [call("health", {})] }).ok, true);
  assert.equal(t.eval.toolUse({ toolCalls: [] }).ok, false);
});

test("hello and lookup tool use delegate to the name judge", () => {
  for (const name of ["hello", "lookup"]) {
    const t = getTask(name);
    assert.equal(t.eval.toolUse({ toolCalls: [call(name, { name: "alice,bob,carol" })] }).ok, true);
    assert.equal(t.eval.toolUse({ toolCalls: [call(name, { name: "alice" })] }).ok, false);
  }
});

test("regex tool use: right tool, target-equivalent pattern, every string, nothing extra", () => {
  const t = getTask("regex");
  const strings = ["123-45", "12345", "abc", "123-456", "12-34", "999-88"];
  const good = strings.map((s) => call("regex_match", { pattern: "^\\d{3}-\\d{2}$", string: s }));
  assert.equal(t.eval.toolUse({ toolCalls: good }).ok, true);

  // A differently spelled but equivalent pattern is fine; an unanchored one is not.
  const equivalent = strings.map((s) => call("regex_match", { pattern: "^[0-9]{3}-[0-9]{2}$", string: s }));
  assert.equal(t.eval.toolUse({ toolCalls: equivalent }).ok, true);
  const unanchored = strings.map((s) => call("regex_match", { pattern: "\\d{3}-\\d{2}", string: s }));
  const r1 = t.eval.toolUse({ toolCalls: unanchored });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /disagrees with the target on "123-456"/);

  const decoy = t.eval.toolUse({ toolCalls: [...good, call("word_count", { string: "abc" })] });
  assert.equal(decoy.ok, false);
  assert.match(decoy.reason, /decoy/);

  const extra = t.eval.toolUse({ toolCalls: [...good, call("regex_match", { pattern: "^\\d{3}-\\d{2}$", string: "123-457" })] });
  assert.equal(extra.ok, false);
  assert.match(extra.reason, /not in the list: 123-457/);

  const partial = t.eval.toolUse({ toolCalls: good.slice(0, 5) });
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /never tested 999-88/);

  const invalid = t.eval.toolUse({ toolCalls: [call("regex_match", { pattern: "(", string: "abc" })] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /invalid pattern/);
});

// ---- chain: the second call must use the first call's result --------------------------------

const ID = "0f3c1e2a-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const helloResult = (greetings) => ({ id: "c", name: "hello", ok: true, content: JSON.stringify({ greetings }) });
const CHAINED = [
  helloResult([{ name: "alice", message: "Hello, alice!", id: ID }]),
  helloResult([{ name: ID, message: `Hello, ${ID}!`, id: "another-id" }]),
];

test("chain ground: the id alice received and the greeting the second call returned", () => {
  const t = getTask("chain");
  assert.deepEqual(t.eval.ground({ toolResults: CHAINED }), { firstId: ID, expected: `Hello, ${ID}!` });
  assert.deepEqual(t.eval.ground({ toolResults: [CHAINED[0]] }), { firstId: ID, expected: null });
  assert.deepEqual(t.eval.ground({}), { firstId: null, expected: null });
});

test("chain scorers: the chained greeting must be reported verbatim", () => {
  const t = getTask("chain");
  const ground = t.eval.ground({ toolResults: CHAINED });
  assert.equal(t.eval.scoreHarness({ firstId: ID, greeting: `Hello, ${ID}!` }, ground).correct, true);
  assert.equal(t.eval.scoreHarness({ greeting: "Hello, alice!" }, ground).correct, false);
  assert.equal(t.eval.scoreNoHarness(`The second greeting was "Hello, ${ID}!"`, ground).correct, true);
  assert.equal(t.eval.scoreNoHarness("Hello, alice!", ground).correct, false);
});

test("chain scorers: a chain that never happened cannot pass, and the reason says which step failed", () => {
  const t = getTask("chain");
  const noSecond = t.eval.scoreHarness({ greeting: `Hello, ${ID}!` }, t.eval.ground({ toolResults: [CHAINED[0]] }));
  assert.equal(noSecond.correct, false);
  assert.match(noSecond.reason, /never greeted/);
  const nothing = t.eval.scoreNoHarness("Hello, alice!", t.eval.ground({}));
  assert.equal(nothing.correct, false);
  assert.match(nothing.reason, /alice was never greeted/);
});

test("chain tool use follows the same chain", () => {
  const t = getTask("chain");
  assert.equal(t.eval.toolUse({ toolCalls: [], toolResults: CHAINED }).ok, true);
  assert.equal(t.eval.toolUse({ toolCalls: [], toolResults: [CHAINED[0]] }).ok, false);
});
