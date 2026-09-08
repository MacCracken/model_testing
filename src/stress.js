// stress.js — stressors as a treatment: the same task in a harder environment.
//
// A stress profile is applied to the scenario a trial runs against, so the synthetic harness and the
// real-harness arms meet the same conditions through the same server:
//   flaky        — the first list and the first update of every item fail with 503; a retry succeeds
//   budget       — the scenario accepts low + 5 requests, then refuses every one with 429
//   haystack     — the same low items in an inventory of 60 instead of 2·low + 2
//   distractors  — extra endpoints and tools that look relevant and are not: per-item history, a
//                  price update, and a reorder-all shortcut that marks everything reordered without
//                  fixing a quantity (the trap)
// `withStress(client, profile)` names the variant `<client>@stress:<profile>`; the task's setup reads
// `client.stress` and asks the server for that profile; `ground` reads the scenario's op log back so
// the row records what the stress did (failures served, requests refused, distractor calls).

export const STRESS_MODES = ["flaky", "budget", "haystack", "distractors"];
export const DISTRACTOR_OPS = ["history", "price", "reorder_all"];

// "<client>@stress:<profile>" → { base, how }; anything else → { base: spec, how: null }.
export function parseStressSuffix(spec) {
  const m = String(spec).match(/^(.*)@stress(?::([a-z]+))?$/);
  if (!m) return { base: spec, how: null };
  const how = m[2] ?? "flaky";
  if (!STRESS_MODES.includes(how)) throw new Error(`unknown stress profile "${how}" in "${spec}" — use @stress:${STRESS_MODES.join("|")}`);
  return { base: m[1], how };
}

export function withStress(client, profile) {
  if (!STRESS_MODES.includes(profile)) throw new Error(`unknown stress profile "${profile}" (${STRESS_MODES.join(" | ")})`);
  return {
    ...client,
    name: `${client.name}@stress:${profile}`,
    baseName: client.name,
    stress: profile,
    // The environment carries the treatment; the client is untouched.
    chat: (...args) => client.chat(...args),
    runWithTools: (...args) => client.runWithTools(...args),
  };
}

// What a scenario's op log says the stress did.
export function summarizeOps(ops = []) {
  return {
    requests: ops.length,
    failed: ops.filter((o) => o.status === 503).length,
    rejected: ops.filter((o) => o.status === 429).length,
    distractorCalls: ops.filter((o) => DISTRACTOR_OPS.includes(o.op)).length,
    trap: ops.filter((o) => o.op === "reorder_all").length,
  };
}
