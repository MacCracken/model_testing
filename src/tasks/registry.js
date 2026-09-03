// Task registry: imports task definitions and exposes them in a uniform shape.
//
// Each task provides:
//   - name / category / description
//   - model: (modelId) => label
//   - noHarness: { prompt, extract }                          // raw free-form call
//   - harness:   { system, prompt, tools, schema, extract }   // structured call
//   - eval: { ground, scoreHarness, scoreNoHarness }
//
// `extract` is one of:
//   - "text"        -> the raw model text is the answer
//   - "structured"  -> the final assistant message is parsed as JSON (harness mode)

import { task as healthTask } from "./health.js";
import { task as helloTask } from "./hello.js";
import { task as reasonTask } from "./reason.js";

export const tasks = [healthTask, helloTask, reasonTask];

export function getTask(name) {
  const t = tasks.find((x) => x.name === name);
  if (!t) throw new Error(`unknown task: ${name}`);
  return t;
}

// The modes a task advertises. A task lists the axes it supports (noHarness, harness, and any of
// the decompositions it defines — e.g. schemaOnly or toolOnly); the registry reports only the ones
// actually present, so a task that never declares toolOnly does not advertise it.
export const MODE_NAMES = ["noHarness", "harness", "schemaOnly", "toolOnly"];

export function listTasks() {
  return tasks.map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description ?? "",
    modes: MODE_NAMES.filter((m) => !!t[m]),
    tools: (t.harness?.tools ?? []).map((tool) => tool.name),
  }));
}

export { healthTask, helloTask };
