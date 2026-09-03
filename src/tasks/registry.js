// Task registry: imports task definitions and exposes them in a uniform shape.
//
// Each task provides:
//   - name / category / description
//   - noHarness: { prompt }                                  // raw free-form call
//   - harness:   { system, prompt, tools, schema }           // structured call
//   - optionally schemaOnly / toolOnly specs for the two decomposition axes
//   - eval: { ground, scoreHarness, scoreNoHarness }
//
// `ground` is a function of the trial ({ mode, toolCalls, toolResults, structured, answerText }),
// called after the model answers, or a constant for tasks with fixed truth.

import { MODE_NAMES } from "../runner.js";
import { task as healthTask } from "./health.js";
import { task as helloTask } from "./hello.js";
import { task as reasonTask } from "./reason.js";
import { task as lookupTask } from "./lookup.js";
import { task as regexTask } from "./regex.js";
import { task as chainTask } from "./chain.js";

export const tasks = [healthTask, helloTask, reasonTask, lookupTask, regexTask, chainTask];

export function getTask(name) {
  const t = tasks.find((x) => x.name === name);
  if (!t) throw new Error(`unknown task: ${name}`);
  return t;
}

// What the UI and `cli list` show. `modes` is the subset of MODE_NAMES the task actually declares
// a spec for — the runner skips any other (task, mode) pair rather than scoring it as an error.
export function listTasks() {
  return tasks.map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description ?? "",
    modes: MODE_NAMES.filter((m) => !!t[m]),
    tools: (t.harness?.tools ?? []).map((tool) => tool.name),
  }));
}
