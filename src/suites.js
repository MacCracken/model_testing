// suites.js — named presets for the own-model workflow: what to run on a fresh checkpoint before
// anything else (smoke), the standing comparison (standard), and the whole matrix (full). A suite is
// just bench arguments, so everything about a suite run is recorded the way any run is, plus
// `config.suite`.

import { fileURLToPath } from "node:url";

export const SUITES = {
  smoke: {
    description: "one of each capability, two trials per cell, the two headline modes — a few minutes on a hosted model",
    tasks: "health,hello,lookup,chain,wordmath4,datecalc1,logicgrid3,tally20,fanout4,follow3,norelevant,restock3",
    modes: "noHarness,harness",
    count: 2,
    parallel: 4,
  },
  standard: {
    description: "every task, four trials per cell, the two headline modes",
    tasks: "all",
    modes: "noHarness,harness",
    count: 4,
    parallel: 6,
  },
  full: {
    description: "every task in all four modes, eight trials per cell",
    tasks: "all",
    modes: "noHarness,schemaOnly,toolOnly,harness",
    count: 8,
    parallel: 6,
  },
  nightly: {
    description: "the standard suite under a 90-minute time box, gated by gates/nightly.json (exit code 1 on a failed gate, 2 when a gate could not be judged) — what a scheduler runs on the latest checkpoint",
    tasks: "all",
    modes: "noHarness,harness",
    count: 4,
    parallel: 6,
    timeBox: 90,
    gates: fileURLToPath(new URL("../gates/nightly.json", import.meta.url)),
  },
};

// The bench argv for a suite. Extra arguments (clients, instance seed, judge, params) pass through.
export function suiteArgs(name, extra = []) {
  const s = SUITES[name];
  if (!s) throw new Error(`unknown suite "${name}" — one of ${Object.keys(SUITES).join(", ")}`);
  const argv = ["--task", s.tasks, "--modes", s.modes, "--count", String(s.count), "--parallel", String(s.parallel)];
  // A preset's time box and gate file apply unless the command line brings its own.
  if (s.timeBox && !extra.includes("--time-box")) argv.push("--time-box", String(s.timeBox));
  if (s.gates && !extra.includes("--gates") && !extra.includes("--gate")) argv.push("--gates", s.gates);
  return [...argv, ...extra];
}
