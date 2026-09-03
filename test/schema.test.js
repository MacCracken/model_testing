import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSchema, schemaHint } from "../src/schema.js";

// A schema shaped like the harness tasks use.
const schema = {
  type: "object",
  properties: {
    status: { type: "string" },
    uptimeSec: { type: "number" },
  },
  required: ["status", "uptimeSec"],
};

const itemSchema = {
  type: "array",
  minItems: 3,
  items: { type: "object", properties: { name: { type: "string" }, message: { type: "string" } }, required: ["name", "message"] },
};

test("valid object passes", () => {
  const { valid, errors } = validateSchema({ status: "ok", uptimeSec: 12 }, schema);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("missing required field is reported", () => {
  const { valid, errors } = validateSchema({ status: "ok" }, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("uptimeSec")), "should name uptimeSec");
});

test("wrong type is reported", () => {
  const { valid } = validateSchema({ status: "ok", uptimeSec: "not a number" }, schema);
  assert.equal(valid, false);
});

test("array with too few items is reported", () => {
  const { valid, errors } = validateSchema([{ name: "a", message: "hi" }], itemSchema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("at least")), "should mention minItems");
});

test("nested array items are validated", () => {
  const { valid } = validateSchema([
    { name: "a", message: "hi" },
    { name: "b", message: "yo" },
    { name: "c", message: "hey" },
  ], itemSchema);
  assert.equal(valid, true);
});

test("array items with wrong type are reported", () => {
  const { valid } = validateSchema([{ name: 5, message: "hi" }], itemSchema);
  assert.equal(valid, false);
});

test("a non-object where an object was required fails", () => {
  const { valid } = validateSchema("nope", schema);
  assert.equal(valid, false);
});

test("enum rejects out-of-set values", () => {
  const enumSchema = { type: "string", enum: ["ok", "degraded"] };
  const { valid, errors } = validateSchema("unknown", enumSchema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("not in")));
  assert.equal(validateSchema("ok", enumSchema).valid, true);
});

test("schemaHint renders the schema as indented JSON", () => {
  const hint = schemaHint(schema);
  assert.ok(hint.includes('"status"'));
  assert.ok(hint.includes('"uptimeSec"'));
  assert.ok(hint.includes("\n"), "hint should be indented");
});

// ---- the wider subset ---------------------------------------------------------------------

test("additionalProperties: false rejects unknown keys; a schema validates them", () => {
  const strict = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  assert.equal(validateSchema({ a: "x" }, strict).valid, true);
  const r = validateSchema({ a: "x", b: 1 }, strict);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("$.b") && e.includes("unexpected")));
  const typed = { type: "object", additionalProperties: { type: "number" } };
  assert.equal(validateSchema({ x: 1, y: 2 }, typed).valid, true);
  assert.equal(validateSchema({ x: "no" }, typed).valid, false);
});

test("const, string bounds, pattern and formats", () => {
  assert.equal(validateSchema("ok", { const: "ok" }).valid, true);
  assert.equal(validateSchema("nope", { const: "ok" }).valid, false);
  assert.equal(validateSchema("abc", { type: "string", minLength: 2, maxLength: 3 }).valid, true);
  assert.equal(validateSchema("a", { type: "string", minLength: 2 }).valid, false);
  assert.equal(validateSchema("abcd", { type: "string", maxLength: 3 }).valid, false);
  assert.equal(validateSchema("123-45", { type: "string", pattern: "^\\d{3}-\\d{2}$" }).valid, true);
  assert.equal(validateSchema("12345", { type: "string", pattern: "^\\d{3}-\\d{2}$" }).valid, false);
  assert.equal(validateSchema("0f3c1e2a-5b6d-4e7f-8a9b-0c1d2e3f4a5b", { type: "string", format: "uuid" }).valid, true);
  assert.equal(validateSchema("not-a-uuid", { type: "string", format: "uuid" }).valid, false);
  assert.equal(validateSchema("2026-09-03T08:19:33.000Z", { type: "string", format: "date-time" }).valid, true);
  assert.equal(validateSchema("yesterday", { type: "string", format: "date-time" }).valid, false);
  assert.equal(validateSchema("a@b.co", { type: "string", format: "email" }).valid, true);
  assert.equal(validateSchema("http://localhost:3000/health", { type: "string", format: "uri" }).valid, true);
  assert.equal(validateSchema("anything", { type: "string", format: "made-up" }).valid, true, "unknown formats are annotations");
});

test("numeric bounds and multipleOf", () => {
  const s = { type: "number", minimum: 0, maximum: 10, multipleOf: 0.5 };
  assert.equal(validateSchema(7.5, s).valid, true);
  assert.equal(validateSchema(-1, s).valid, false);
  assert.equal(validateSchema(11, s).valid, false);
  assert.equal(validateSchema(7.3, s).valid, false);
  assert.equal(validateSchema(0, { type: "number", exclusiveMinimum: 0 }).valid, false);
  assert.equal(validateSchema(1, { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 2 }).valid, true);
  assert.equal(validateSchema(2, { type: "number", exclusiveMaximum: 2 }).valid, false);
});

test("array maxItems and uniqueItems; type unions", () => {
  assert.equal(validateSchema([1, 2, 3], { type: "array", maxItems: 2 }).valid, false);
  assert.equal(validateSchema([1, 1], { type: "array", uniqueItems: true }).valid, false);
  assert.equal(validateSchema([1, 2], { type: "array", uniqueItems: true }).valid, true);
  assert.equal(validateSchema(null, { type: ["string", "null"] }).valid, true);
  assert.equal(validateSchema(5, { type: ["string", "null"] }).valid, false);
});
