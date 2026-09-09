import { test } from "node:test";
import assert from "node:assert/strict";
import { generate as wordmathGen } from "../src/tasks/wordmath.js";
import { generate as datecalcGen } from "../src/tasks/datecalc.js";
import { generate as logicgridGen } from "../src/tasks/logicgrid.js";
import { generate as tallyGen } from "../src/tasks/tally.js";
import { generate as needleGen } from "../src/tasks/needle.js";
import { generate as extractGen } from "../src/tasks/extract.js";

import { listTasks, tasks } from "../src/tasks/registry.js";
import { isStructuredMode, MODE_NAMES } from "../src/runner.js";

// Every advertised mode must be backed by a spec the runner can actually execute.

test("listTasks advertises exactly the modes each task declares", () => {
  const modes = Object.fromEntries(listTasks().map((t) => [t.name, t.modes]));
  for (const name of ["health", "hello", "lookup", "regex", "chain", "transform", "explain"]) {
    assert.deepEqual(modes[name], MODE_NAMES, `${name} should declare all four modes`);
  }
  assert.deepEqual(modes.reason, ["noHarness", "harness", "schemaOnly"], "reason has no tools, so no toolOnly");
});

// A context to render a task's prompts with: generated families mint one from a fixed seed (pure,
// no network); the stateful restock family gets a stand-in scenario.
const bfclFn = { name: "calculate_triangle_area", description: "d", parameters: { type: "dict", properties: { base: { type: "integer" } }, required: ["base"] } };
const generators = { gsm8k: () => ({ question: "Janet has 16 eggs and eats 3. How many are left?", answer: 13 }), ifeval: () => ({ prompt: "Write about rain without commas.", instruction_id_list: ["punctuation:no_comma"], kwargs: [{}] }), bfcl: () => ({ question: "Find the area of a triangle with base 10.", functions: [bfclFn], groundTruth: [] }), wordmath: (t) => wordmathGen(1, Number(t.name.replace("wordmath", ""))), datecalc: (t) => datecalcGen(1, Number(t.name.replace("datecalc", ""))), logicgrid: (t) => logicgridGen(1, Number(t.name.replace("logicgrid", ""))), tally: (t) => tallyGen(1, Number(t.name.replace("tally", ""))), needle: () => ({ ...needleGen(1, 8000), log: "log-test" }), extract: (t) => { const g = extractGen(1, Number(t.name.replace("extract", ""))); return { ...g, docs: g.docs.map((d, i) => ({ ...d, id: `doc-test-${i + 1}` })) }; } };
function sampleCtx(t) {
  const fam = Object.keys(generators).find((k) => t.name.startsWith(k));
  if (fam) return generators[fam](t);
  return { scenario: "scn-test", items: [], low: 3, size: 8, ids: ["sku-1001", "sku-1002"], start: "sku-1001", hops: 3, question: "What is the qty of item sku-1001?", counts: [{ id: "sku-1001", qty: 24 }, { id: "sku-1002", qty: 7 }, { id: "sku-1003", qty: 40 }], pages: 3 };
}

test("every declared spec is well-formed for its mode", () => {
  for (const t of tasks) {
    for (const mode of MODE_NAMES) {
      const spec = t[mode];
      if (!spec) continue;
      // A prompt is a string, or a function of the trial context for tasks with a per-trial setup.
      const prompt = typeof spec.prompt === "function" ? spec.prompt(sampleCtx(t)) : spec.prompt;
      assert.ok(typeof prompt === "string" && prompt.length > 20, `${t.name}/${mode} has a prompt`);
      if (isStructuredMode(mode)) {
        assert.ok(spec.schema && typeof spec.schema === "object", `${t.name}/${mode} carries a schema`);
      } else {
        assert.equal(spec.schema, undefined, `${t.name}/${mode} must not carry a schema`);
      }
      const tools = typeof spec.tools === "function" ? spec.tools({ ...sampleCtx(t), stress: "distractors" }) : spec.tools ?? [];
      if (mode === "toolOnly") assert.ok(tools.length, `${t.name}/toolOnly carries tools`);
      if (mode === "schemaOnly" || mode === "noHarness") assert.ok(!tools.length, `${t.name}/${mode} carries no tools`);
      for (const tool of tools) {
        assert.equal(typeof tool.impl, "function", `${t.name}/${mode} tool ${tool.name} has an impl`);
        assert.ok(tool.parameters?.type === "object", `${t.name}/${mode} tool ${tool.name} has an object schema`);
      }
    }
  }
});

test("reason's harness and schemaOnly are the same spec by design", () => {
  const reason = tasks.find((t) => t.name === "reason");
  assert.equal(reason.harness, reason.schemaOnly);
});
