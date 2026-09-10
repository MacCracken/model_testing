// The calculator tool: exact arithmetic, and the rounding functions a stated rule needs — the
// forms models actually write (ceil, Math.ceil, round(x, 1), a % b) — with the errors named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calc, calcTool } from "../src/calc.js";

test("arithmetic, precedence, unary minus, separators, the × and ÷ signs", () => {
  assert.equal(calc("(120 + 35) * 4 - 18"), 602);
  assert.equal(calc("1,250 / 4"), 312.5);
  assert.equal(calc("-3 * -(2 + 1)"), 9);
  assert.equal(calc("6 × 7 ÷ 3"), 14);
  assert.equal(calc("2 + 3 * 4"), 14);
  assert.throws(() => calc("1 / 0"), /division by zero/);
  assert.throws(() => calc("2 +"), /expected a number/);
  assert.throws(() => calc("(2 + 3"), /missing \)/);
});

test("rounding functions: ceil, floor, round with places, abs, the Math. prefix, modulo; unknown names are refused by name", async () => {
  assert.equal(calc("ceil(70.44)"), 71);
  assert.equal(calc("Math.ceil(23.506807887731263)"), 24);
  assert.equal(calc("floor(17.9)"), 17);
  assert.equal(calc("round(2839.0588)"), 2839);
  assert.equal(calc("round(21.31884, 1)"), 21.3);
  assert.equal(calc("round(162.2980625, 1)"), 162.3);
  assert.equal(calc("round(2.675, 2)"), 2.68, "half up, without the binary surprise");
  assert.equal(calc("abs(-4.5)"), 4.5);
  assert.equal(calc("ceil(2803.030303030303 / 3600)"), 1);
  assert.equal(calc("ceil(71.001)"), 72);
  assert.equal(calc("ceil(71.0000000000001)"), 71, "a floating-point hair above a whole number is that number");
  assert.equal(calc("23.5 % 1"), 0.5);
  assert.equal(calc("10 % 3 + FLOOR(2.9)"), 3);
  assert.throws(() => calc("sqrt(4)"), /unknown function .*\(ceil, floor, round, abs\)/);
  assert.throws(() => calc("ceil(1"), /missing \) after ceil\(/);
  const out = await calcTool.impl({ expression: "round(97.0570, 1)" });
  assert.deepEqual(out, { expression: "round(97.0570, 1)", result: 97.1 });
  assert.match(calcTool.description, /ceil\(x\), floor\(x\), round\(x, places\), abs\(x\)/);
});
