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
