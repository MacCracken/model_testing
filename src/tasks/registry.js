// Task registry: imports task definitions and exposes them in a uniform shape.
//
// Each task provides:
//   - name / category
//   - model: (modelId) => label
//   - noHarness: { prompt, extract }     // raw free-form call
//   - harness:   { system, prompt, tools, extract }  // structured call
//   - eval: { ground, scoreHarness, scoreNoHarness }
//
// `extract` is one of:
//   - "text"        -> the raw model text is the answer
//   - "structured"  -> the last assistant message is parsed as JSON (harness mode)

import { task as healthTask } from "./health.js";
import { task as helloTask } from "./hello.js";

export const tasks = [healthTask, helloTask];

export function getTask(name) {
  const t = tasks.find((x) => x.name === name);
  if (!t) throw new Error(`unknown task: ${name}`);
  return t;
}

export function listTasks() {
  return tasks.map((t) => ({ name: t.name, category: t.category }));
}

export { healthTask, helloTask };
