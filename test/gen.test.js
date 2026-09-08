import { test } from "node:test";
import assert from "node:assert/strict";
import { fnv1a, rng, seedFor, dice, numberIn, wordIn } from "../src/tasks/gen.js";
import { calc, calcTool } from "../src/calc.js";

test("seeds are deterministic and independent of mode and client", () => {
  assert.equal(fnv1a("abc"), fnv1a("abc"));
  assert.notEqual(fnv1a("abc"), fnv1a("abd"));
  assert.equal(seedFor(7, "wordmath4", 2), seedFor(7, "wordmath4", 2));
  assert.notEqual(seedFor(7, "wordmath4", 2), seedFor(7, "wordmath4", 3));
  assert.notEqual(seedFor(7, "wordmath4", 2), seedFor(8, "wordmath4", 2));
  assert.notEqual(seedFor(7, "wordmath4", 2), seedFor(7, "wordmath2", 2));
  const a = rng(42), b = rng(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const d = dice(1);
  for (let i = 0; i < 50; i++) { const v = d.int(3, 5); assert.ok(v >= 3 && v <= 5); }
  assert.deepEqual([...d.shuffle([1, 2, 3, 4])].sort(), [1, 2, 3, 4]);
});

test("numberIn and wordIn read answers leniently", () => {
  assert.equal(numberIn("So the total is 1,234 crates.\nanswer: 496"), 496);
  assert.equal(numberIn("**Answer:** 42"), 42);
  assert.equal(numberIn("There are 12 vans and 1,200 crates"), 1200);
  assert.ok(Number.isNaN(numberIn("no digits here")));
  assert.equal(wordIn("I think Carol has the cat. answer: Bob", ["Alice", "Bob", "Carol"]), "Bob");
  assert.equal(wordIn("Alice? No — it must be Carol.", ["Alice", "Bob", "Carol"]), "Carol");
  assert.equal(wordIn("nothing", ["Alice"]), null);
});

test("calc evaluates exactly and rejects what it should", async () => {
  assert.equal(calc("(120 + 35) * 4 - 18"), 602);
  assert.equal(calc("1,200 / 8"), 150);
  assert.equal(calc("-(3+4)×2"), -14);
  assert.equal(calc(" 7 ÷ 2 "), 3.5);
  assert.equal(calc("2 * 3 + 4 * 5"), 26);
  assert.throws(() => calc("2 ** 3"), /expected a number|unexpected/);
  assert.throws(() => calc("5 / 0"), /division by zero/);
  assert.throws(() => calc("process.exit(1)"), /expected a number/);
  assert.throws(() => calc("(1 + 2"), /missing \)/);
  assert.deepEqual(await calcTool.impl({ expression: "6*7" }), { expression: "6*7", result: 42 });
});
