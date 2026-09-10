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
import { PERTURB_KINDS } from "../perturb.js";
import { task as healthTask } from "./health.js";
import { task as helloTask } from "./hello.js";
import { task as reasonTask } from "./reason.js";
import { task as lookupTask } from "./lookup.js";
import { task as regexTask } from "./regex.js";
import { task as chainTask } from "./chain.js";
import { task as transformTask } from "./transform.js";
import { task as explainTask } from "./explain.js";
import { restockTasks } from "./restock.js";
import { wordmathTasks } from "./wordmath.js";
import { convertTasks } from "./convert.js";
import { datecalcTasks } from "./datecalc.js";
import { logicgridTasks } from "./logicgrid.js";
import { tallyTasks } from "./tally.js";
import { fanoutTasks } from "./fanout.js";
import { followTasks } from "./follow.js";
import { task as norelevantTask } from "./norelevant.js";
import { needleTasks, needlehopTasks } from "./needle.js";
import { extractTasks } from "./extract.js";
import { dialogueTasks } from "./dialogue.js";
import { task as nearmissTask } from "./nearmiss.js";
import { pagedTasks } from "./paged.js";
import { task as typedTask } from "./typed.js";
import { publicTasks } from "./public.js";

export const tasks = [
  healthTask, helloTask, reasonTask, lookupTask, regexTask, chainTask, transformTask, explainTask,
  ...restockTasks, ...wordmathTasks, ...convertTasks, ...datecalcTasks, ...logicgridTasks, ...tallyTasks,
  ...fanoutTasks, ...followTasks, norelevantTask, ...needleTasks, ...needlehopTasks, ...extractTasks, ...dialogueTasks,
  nearmissTask, ...pagedTasks, typedTask,
  ...publicTasks,
];

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
    // Tools may depend on the trial's context (restock adds distractor tools under that stress profile).
    tools: (typeof t.harness?.tools === "function" ? t.harness.tools({}) : t.harness?.tools ?? []).map((tool) => tool.name),
    needsJudge: !!t.eval?.needsJudge,
    skill: t.skill ?? t.name, // the playbook name a @skill variant looks for under skills/
    capabilities: t.capabilities ?? [], // what the task measures, for the scorecard
    family: t.family ?? null, // the difficulty family (restock, wordmath, …) and this task's knob value
    level: t.level ?? null,
    // The treatments the task supports: the modes its abstain variant means something in (null
    // when it has no unanswerable variant) and the perturbation kinds its hook can do.
    abstain: typeof t.unanswerable === "function" ? (Array.isArray(t.abstainModes) ? t.abstainModes : MODE_NAMES.filter((m) => !!t[m])) : null,
    perturbs: typeof t.perturb === "function" ? (Array.isArray(t.perturbs) ? t.perturbs : PERTURB_KINDS) : null,
    source: t.source ?? null, // "public" for an anchor set, with the caveat it carries
    caveat: t.caveat ?? null,
    generated: typeof t.setup === "function" && !!t.seeded,
    multiTurn: !!t.multiTurn, // the user's later turns are scripted; arms are skipped
  }));
}
