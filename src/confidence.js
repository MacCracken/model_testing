// confidence.js — a stated confidence with every answer, and what it is worth.
//
// `<client>@confidence` asks the model, on top of the task's own prompt, for its probability that
// the answer is correct: a `confidence` field after the answer fields of an object schema, or a
// final "confidence: <0–1>" line in free-form modes. The row records the number the model gave
// (`confidence.value`, null when it gave none); `calibration(rows)` turns a set of rows into the
// Brier score (mean squared distance between the stated probability and the outcome), the
// expected calibration error over ten bins, and the gap between mean confidence and accuracy —
// overconfidence when positive. `summarize` pairs the variant with its base like every other
// treatment, so a run says both whether asking for a confidence changed the answers and how much
// the numbers can be trusted. Browser-safe: the runner imports it.

export const CONFIDENCE_FIELD = { type: "number", minimum: 0, maximum: 1, description: "Your probability, from 0 to 1, that the answer above is correct. Be honest: 0.5 is a coin flip, 1 means certain." };
export const NOTES = {
  structured: 'Then state your confidence that the answer is correct as a probability from 0 to 1 in a "confidence" field after the answer (0.5 is a coin flip; 1 means certain).',
  free: 'End your reply with a line of the form "confidence: <number from 0 to 1>" — your probability that the answer is correct (0.5 is a coin flip; 1 means certain).',
};

export function parseConfidenceSuffix(spec) {
  const m = String(spec).match(/^(.*)@confidence$/);
  return m ? { base: m[1], how: "asked" } : { base: spec, how: null };
}

// The spec with the request added: an object schema gains the field (not required, so validity is
// unchanged), every mode's prompt gains the note. An array schema cannot take a field, so a
// structured mode over one asks for nothing (`applied` false) — the free-form modes still do.
export function applyConfidence(spec, { structured = true } = {}) {
  if (structured) {
    const schema = spec?.schema;
    const isObject = schema && typeof schema === "object" && (schema.type === "object" || (schema.type === undefined && schema.properties && typeof schema.properties === "object"));
    if (!isObject) return { spec, applied: false };
    return { spec: { ...spec, schema: { ...schema, properties: { ...schema.properties, confidence: CONFIDENCE_FIELD } }, prompt: `${spec.prompt}\n\n${NOTES.structured}` }, applied: true };
  }
  return { spec: { ...spec, prompt: `${spec.prompt}\n\n${NOTES.free}` }, applied: true };
}

// A number in 0–1 from what the model wrote: a probability, a percentage ("80%", 80 on a 0–100
// scale), or nothing.
export function toProbability(v) {
  if (v === null || v === undefined) return null;
  let n = typeof v === "number" ? v : Number(String(v).trim().replace(/%$/, ""));
  if (!Number.isFinite(n)) return null;
  // "80%" and a bare 80 are percentages; 1.7 is neither a probability nor a percentage.
  if (typeof v === "string" && /%$/.test(v.trim())) n /= 100;
  else if (n >= 2 && n <= 100) n /= 100;
  return n >= 0 && n <= 1 ? n : null;
}

export function readConfidence(structured, text) {
  if (structured && typeof structured === "object" && !Array.isArray(structured) && "confidence" in structured) return toProbability(structured.confidence);
  const t = String(text ?? "");
  const lines = t.match(/confidence\s*[:=]\s*\**\s*([0-9]*\.?[0-9]+\s*%?)/gi);
  if (!lines) return null;
  const last = lines[lines.length - 1].match(/([0-9]*\.?[0-9]+\s*%?)$/)[1].replace(/\s+/g, "");
  return toProbability(last);
}

export function withConfidence(client) {
  return {
    ...client,
    name: `${client.name}@confidence`,
    baseName: client.name,
    confidence: "asked",
    // The runner applies the request to the spec; an arm gets the note for its goal prompt.
    chat: (...args) => client.chat(...args),
    runWithTools: (prompt, tools, system, opts = {}) => client.runWithTools(prompt, tools, system, { ...opts, confidence: NOTES.structured }),
  };
}

const clamp01 = (p) => Math.max(0, Math.min(1, p));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Calibration over rows that stated a confidence: Brier, ECE over `bins` equal-width bins, and the
// confidence-minus-accuracy gap in points. Null when no row stated one.
export function calibration(rows, { bins = 10 } = {}) {
  const pts = (rows ?? []).filter((r) => typeof r.confidence?.value === "number" && !r.error).map((r) => ({ p: clamp01(r.confidence.value), y: r.correct ? 1 : 0 }));
  if (!pts.length) return null;
  const n = pts.length;
  const table = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, confidence: 0, accuracy: 0 }));
  for (const { p, y } of pts) { const b = table[Math.min(bins - 1, Math.floor(p * bins))]; b.n++; b.confidence += p; b.accuracy += y; }
  let ece = 0;
  for (const b of table) if (b.n) { b.confidence /= b.n; b.accuracy /= b.n; ece += (b.n / n) * Math.abs(b.confidence - b.accuracy); }
  const accuracy = mean(pts.map((x) => x.y));
  const meanConfidence = mean(pts.map((x) => x.p));
  return {
    n,
    accuracyPct: accuracy * 100,
    meanConfidencePct: meanConfidence * 100,
    overconfidencePp: (meanConfidence - accuracy) * 100,
    brier: mean(pts.map(({ p, y }) => (p - y) ** 2)),
    ece,
    bins: table.filter((b) => b.n).map((b) => ({ ...b, confidencePct: b.confidence * 100, accuracyPct: b.accuracy * 100 })),
  };
}

// Per client and mode: the calibration of the rows that stated a confidence.
export function calibrationView(rows) {
  const out = [];
  for (const client of [...new Set((rows ?? []).map((r) => r.client))]) {
    for (const mode of [...new Set(rows.filter((r) => r.client === client).map((r) => r.mode))]) {
      const c = calibration(rows.filter((r) => r.client === client && r.mode === mode));
      if (c) out.push({ client, mode, ...c });
    }
  }
  return out;
}

export function describeCalibration(c) {
  if (!c) return "no stated confidence";
  const gap = c.overconfidencePp;
  return `${c.n} stated · accuracy ${c.accuracyPct.toFixed(0)}% · mean confidence ${c.meanConfidencePct.toFixed(0)}% (${gap >= 0 ? "over" : "under"}confident by ${Math.abs(gap).toFixed(0)}pp) · Brier ${c.brier.toFixed(3)} · ECE ${c.ece.toFixed(3)}`;
}
