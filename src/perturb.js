// perturb.js — robustness as a treatment: the same instance, rewritten.
//
// `<client>@perturb:<kind>` runs a generated task's instance through the family's own
// `perturb(ctx, kind, seed)` hook, which mints a meaning-preserving variant of the very problem
// the base client sees on that trial — the truth is untouched, the surface changes:
//   paraphrase — the sentences, question or clues in other words;
//   order      — independent parts in another order (table rows, clues);
//   format     — another surface form (a bulleted timeline, a CSV table, an ISO date).
// The model is told nothing. `summarize` pairs the variant with its base like every treatment and
// adds **consistency**: over the paired instances, the share whose canonical answer did not change
// under the perturbation — right or wrong, the same answer — beside the correctness delta. A family
// that does not support a kind returns null from its hook and the row says the treatment did not
// apply. Node-side only: the runner calls the task's hook, nothing here.

export const PERTURB_KINDS = ["paraphrase", "order", "format"];

export function parsePerturbSuffix(spec) {
  const m = String(spec).match(/^(.*)@perturb(?::([a-z]+))?$/);
  if (!m) return { base: spec, how: null };
  const how = m[2] ?? "paraphrase";
  if (!PERTURB_KINDS.includes(how)) throw new Error(`unknown perturbation "${how}" in "${spec}" — use @perturb:${PERTURB_KINDS.join("|")}`);
  return { base: m[1], how };
}

export function withPerturb(client, how = "paraphrase") {
  if (!PERTURB_KINDS.includes(how)) throw new Error(`unknown perturbation "${how}" (${PERTURB_KINDS.join(" | ")})`);
  return { ...client, name: `${client.name}@perturb:${how}`, baseName: client.name, perturb: how, chat: (...args) => client.chat(...args), runWithTools: (...args) => client.runWithTools(...args) };
}

export function describePerturbation(how) {
  return { paraphrase: "the same problem in other words", order: "the same parts in another order", format: "the same problem in another surface form" }[how] ?? how;
}
