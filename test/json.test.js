import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJSONLoose } from "../src/json.js";

test("parses bare JSON", () => {
  assert.deepEqual(parseJSONLoose('{"a":1}'), { a: 1 });
});

test("parses a JSON array", () => {
  assert.deepEqual(parseJSONLoose('["x","y"]'), ["x", "y"]);
});

test("ignores a ```json fence", () => {
  assert.deepEqual(parseJSONLoose("```json\n{\"a\":1}\n```"), { a: 1 });
});

test("skips leading prose before the object", () => {
  assert.deepEqual(parseJSONLoose("Sure, here it is:\n\n{\"a\":1}"), { a: 1 });
});

test("skips a leading newline and whitespace", () => {
  assert.deepEqual(parseJSONLoose("\n\n   {\"a\":1}"), { a: 1 });
});

test("handles a brace inside a quoted string that precedes the real answer", () => {
  // The naive scan would start at the { inside the quoted string and return invalid JSON.
  assert.deepEqual(parseJSONLoose('here is a value "open {brace}" and then the real answer: {"status":"ok"}'), { status: "ok" });
});

test("handles an opening brace that begins the string but is not the first char", () => {
  assert.deepEqual(parseJSONLoose('here is the data: {"a":1}'), { a: 1 });
});

test("respects quotes and escapes while bracket-matching", () => {
  // A stray } inside a string must not end the slice; only the matching close brace does.
  assert.deepEqual(parseJSONLoose('{"a":"} not a close"}'), { a: "} not a close" });
});

test("returns null for empty input", () => {
  assert.equal(parseJSONLoose(""), null);
  assert.equal(parseJSONLoose("   "), null);
});

test("returns null when there is no object anywhere", () => {
  assert.equal(parseJSONLoose("no json here at all"), null);
  assert.equal(parseJSONLoose("attempt failed, retry"), null);
});

test("passes through a non-string object", () => {
  assert.deepEqual(parseJSONLoose({ a: 1 }), { a: 1 });
});

test("a fenced block that is not JSON does not hide the JSON fence after it; a broken json fence falls through to the prose", () => {
  const worked = "Working:\n```\nWork:\n1. fetched doc-6bbe48f4\n2. \"Issued: 2026-12-04\"\n```\n\n```json\n{\"total\": 664.44}\n```";
  assert.deepEqual(parseJSONLoose(worked), { total: 664.44 });
  assert.deepEqual(parseJSONLoose("```text\nnote\n```\n```json\n[1,2]\n```"), [1, 2]);
  assert.deepEqual(parseJSONLoose("```json\nnot json at all\n```\nthen {\"a\":2}"), { a: 2 });
  assert.equal(parseJSONLoose("```\nno json here\n```"), null);
});
