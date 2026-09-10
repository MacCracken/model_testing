// abstain.js — abstention as a treatment: half the problems cannot be answered, and saying so is
// the right answer.
//
// `<client>@abstain` runs a family that can mint an unanswerable variant of its instance
// (`task.unanswerable(ctx)`: wordmath with a quantity missing, tally with a question the table
// cannot answer, datecalc with the date left out) on a seeded half of its trials as that variant,
// and tells the model on every trial — answerable or not, so the instruction leaks nothing —
// that a problem which cannot be answered from what is given should be reported as such. The
// scoring is then generic: an unanswerable instance is right when the answer abstains and wrong
// when a value is produced (a fabrication); an answerable one is wrong when the answer abstains
// (a refusal) and otherwise scored by the task as usual. `abstentionView` counts the four cases
// per client and mode, and `summarize` pairs the variant with its base like every treatment.
// Browser-safe: the runner imports it.

import { dice } from "./tasks/gen.js";

export const ABSTAIN_MODES = ["half"];
export const NOTES = {
  structured: 'If the problem cannot be answered from the information given, set "answerable" to false and "answer" to null, and say in "work" what is missing.',
  free: 'If the problem cannot be answered from the information given, say so with a line of the form "answer: cannot be determined" and name what is missing.',
};
export const ANSWERABLE_FIELD = { type: "boolean", description: "false when the problem cannot be answered from the information given (then answer is null)." };

export function parseAbstainSuffix(spec) {
  const m = String(spec).match(/^(.*)@abstain(?::([a-z]+))?$/);
  if (!m) return { base: spec, how: null };
  const how = m[2] ?? "half";
  if (!ABSTAIN_MODES.includes(how)) throw new Error(`unknown abstain mode "${how}" in "${spec}" — use @abstain`);
  return { base: m[1], how };
}

export function withAbstain(client, how = "half") {
  if (!ABSTAIN_MODES.includes(how)) throw new Error(`unknown abstain mode "${how}"`);
  return { ...client, name: `${client.name}@abstain`, baseName: client.name, abstain: how, chat: (...args) => client.chat(...args), runWithTools: (...args) => client.runWithTools(...args) };
}

// The seeded coin: the same trial is unanswerable in every mode and for every client.
export const unanswerableFor = (seed) => dice((seed >>> 0) ^ 0xab57).chance(0.5);

// The spec with the instruction added (both kinds of instance get it) and, for an object schema,
// the optional `answerable` field and null allowed on `answer`.
export function applyAbstain(spec, { structured = true } = {}) {
  if (!structured) return { spec: { ...spec, prompt: `${spec.prompt}\n\n${NOTES.free}` }, applied: true };
  const schema = spec?.schema;
  const isObject = schema && typeof schema === "object" && (schema.type === "object" || (schema.type === undefined && schema.properties && typeof schema.properties === "object"));
  if (!isObject) return { spec: { ...spec, prompt: `${spec.prompt}\n\n${NOTES.free}` }, applied: true };
  const properties = { ...schema.properties, answerable: ANSWERABLE_FIELD };
  if (properties.answer && typeof properties.answer === "object") {
    const t = properties.answer.type;
    properties.answer = { ...properties.answer, type: Array.isArray(t) ? [...new Set([...t, "null"])] : t ? [t, "null"] : ["integer", "number", "string", "null"] };
  }
  return { spec: { ...spec, schema: { ...schema, properties }, prompt: `${spec.prompt}\n\n${NOTES.structured}` }, applied: true };
}

const ABSTAIN_RE = /cannot be determined|can't be determined|cannot be answered|can't be answered|not enough information|insufficient information|unanswerable|no way to (?:know|tell|determine)|impossible to (?:determine|know|tell|say)|not determinable|indeterminate/i;

// Did the answer abstain? Structured: answerable false, or a null answer; free-form: the phrase.
export function abstained(structured, text) {
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    if (structured.answerable === false) return true;
    if ("answer" in structured && structured.answer === null) return true;
    if (structured.answerable === true) return false;
  }
  return ABSTAIN_RE.test(String(text ?? ""));
}

// The verdict for an abstain-variant row, given whether its instance was answerable, whether the
// answer abstained, and the task's own score for an answered answerable instance.
export function abstentionVerdict({ unanswerable, abstainedAnswer, missing = null, score = null }) {
  if (unanswerable) {
    return abstainedAnswer
      ? { correct: true, reason: `abstained — right${missing ? ` (${missing} was missing)` : ""}`, abstention: "abstained" }
      : { correct: false, reason: `fabricated an answer${missing ? ` — ${missing} was missing` : ""}`, abstention: "fabricated" };
  }
  if (abstainedAnswer) return { correct: false, reason: "abstained on a problem that could be answered", abstention: "refused" };
  return { ...(score ?? { correct: false, reason: "no score" }), abstention: "answered" };
}

// Per client and mode over abstain-variant rows: the four cases, and the two rates that matter.
export function abstentionView(rows) {
  const out = [];
  const treated = (rows ?? []).filter((r) => r.abstain?.applied && !r.error);
  for (const client of [...new Set(treated.map((r) => r.client))]) {
    for (const mode of [...new Set(treated.filter((r) => r.client === client).map((r) => r.mode))]) {
      const sub = treated.filter((r) => r.client === client && r.mode === mode);
      const un = sub.filter((r) => r.abstain.unanswerable), an = sub.filter((r) => !r.abstain.unanswerable);
      const abstainedN = un.filter((r) => r.abstain.abstention === "abstained").length;
      const refused = an.filter((r) => r.abstain.abstention === "refused").length;
      out.push({ client, mode, trials: sub.length, unanswerable: un.length, abstained: abstainedN, fabricated: un.length - abstainedN, answerable: an.length, refused, answeredRight: an.filter((r) => r.correct).length, abstainRatePct: un.length ? (100 * abstainedN) / un.length : null, refusalRatePct: an.length ? (100 * refused) / an.length : null });
    }
  }
  return out;
}

export function describeAbstention(v) {
  if (!v) return "no abstain trials";
  return `${v.unanswerable} unanswerable: abstained ${v.abstained}, fabricated ${v.fabricated}${v.abstainRatePct !== null ? ` (${v.abstainRatePct.toFixed(0)}% abstained)` : ""} · ${v.answerable} answerable: refused ${v.refused}, right ${v.answeredRight}`;
}
