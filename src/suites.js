// suites.js — named presets for the own-model workflow: what to run on a fresh checkpoint before
// anything else (smoke), the standing comparison (standard), and the whole matrix (full). A suite is
// just bench arguments, so everything about a suite run is recorded the way any run is, plus
// `config.suite`.

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
};

// The bench argv for a suite. Extra arguments (clients, instance seed, judge, params) pass through.
export function suiteArgs(name, extra = []) {
  const s = SUITES[name];
  if (!s) throw new Error(`unknown suite "${name}" — one of ${Object.keys(SUITES).join(", ")}`);
  return ["--task", s.tasks, "--modes", s.modes, "--count", String(s.count), "--parallel", String(s.parallel), ...extra];
}
