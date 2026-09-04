import { test } from "node:test";
import assert from "node:assert/strict";

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

test("every declared spec is well-formed for its mode", () => {
  for (const t of tasks) {
    for (const mode of MODE_NAMES) {
      const spec = t[mode];
      if (!spec) continue;
      assert.ok(typeof spec.prompt === "string" && spec.prompt.length > 20, `${t.name}/${mode} has a prompt`);
      if (isStructuredMode(mode)) {
        assert.ok(spec.schema && typeof spec.schema === "object", `${t.name}/${mode} carries a schema`);
      } else {
        assert.equal(spec.schema, undefined, `${t.name}/${mode} must not carry a schema`);
      }
      if (mode === "toolOnly") assert.ok(spec.tools?.length, `${t.name}/toolOnly carries tools`);
      if (mode === "schemaOnly" || mode === "noHarness") assert.ok(!(spec.tools ?? []).length, `${t.name}/${mode} carries no tools`);
      for (const tool of spec.tools ?? []) {
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
