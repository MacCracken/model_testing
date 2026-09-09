// format.js — the answer's format as a treatment: the `work` field on demand.
//
// A structured schema for a task that needs thinking carries a `work` array before the answer;
// without it, "JSON only — no prose" measures answering without thinking (wordmath4 went 4/4 to
// 0/4 for gpt-4o-mini when the field was missing). This variant makes that axis a treatment on any
// task: `@format:nowork` strips the field from a schema that has it and tells the model not to write
// one; `@format:work` adds it to a schema that lacks one and asks for the working first. The runner
// applies it to the spec before the system prompt is built, so the schema hint the model sees is
// the treated one, and the row records whether the treatment applied (the schema had, or lacked, the
// field) and whether the answer complied (no `work` key, or a `work` array that was used). Free-form
// modes have no schema and are left alone: the row says the treatment did not apply.
// `summarize` pairs a `…@format:<how>` client with its base the way it pairs the other treatments.

export const FORMAT_MODES = ["nowork", "work"];

// "<client>@format:<how>" → { base, how }; anything else → { base: spec, how: null }.
export function parseFormatSuffix(spec) {
  const m = String(spec).match(/^(.*)@format(?::([a-z]+))?$/);
  if (!m) return { base: spec, how: null };
  const how = m[2] ?? "nowork";
  if (!FORMAT_MODES.includes(how)) throw new Error(`unknown format variant "${how}" in "${spec}" — use @format:${FORMAT_MODES.join("|")}`);
  return { base: m[1], how };
}

export function withFormat(client, how) {
  if (!FORMAT_MODES.includes(how)) throw new Error(`unknown format variant "${how}" (${FORMAT_MODES.join(" | ")})`);
  return {
    ...client,
    name: `${client.name}@format:${how}`,
    baseName: client.name,
    format: how,
    // The runner applies the treatment to the spec; the client is untouched.
    chat: (...args) => client.chat(...args),
    runWithTools: (...args) => client.runWithTools(...args),
  };
}

export const WORK_FIELD = { type: "array", items: { type: "string" }, description: "Your working, step by step, written before the answer." };
const hasWork = (schema) => !!(schema && typeof schema === "object" && schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, "work"));

export const NOTES = {
  nowork: 'Format: reply with the answer fields only — no "work" key, no working and no steps inside the JSON.',
  work: 'Format: begin the JSON with a "work" array holding your working step by step, then the answer fields.',
};

// The spec with the treatment applied — the schema with the work field stripped or added, and a line
// on the prompt saying so — or the spec as it was when there is nothing to apply it to.
export function applyFormat(spec, how, { structured = true } = {}) {
  if (!FORMAT_MODES.includes(how)) throw new Error(`unknown format variant "${how}"`);
  if (!structured || !spec?.schema || typeof spec.schema !== "object") return { spec, applied: false };
  const has = hasWork(spec.schema);
  if (how === "nowork") {
    if (!has) return { spec, applied: false };
    const { work: _work, ...properties } = spec.schema.properties;
    const schema = { ...spec.schema, properties, ...(Array.isArray(spec.schema.required) ? { required: spec.schema.required.filter((k) => k !== "work") } : {}) };
    return { spec: { ...spec, schema, prompt: `${spec.prompt}\n\n${NOTES.nowork}` }, applied: true };
  }
  if (has) return { spec, applied: false };
  // Only an object answer has room for a work field; an array answer (a list of results) does not,
  // and forcing one would change the shape the scorer reads.
  const isObject = spec.schema.type === "object" || (spec.schema.type === undefined && spec.schema.properties && typeof spec.schema.properties === "object");
  if (!isObject) return { spec, applied: false };
  const schema = { ...spec.schema, properties: { work: WORK_FIELD, ...spec.schema.properties } };
  return { spec: { ...spec, schema, prompt: `${spec.prompt}\n\n${NOTES.work}` }, applied: true };
}

// Did the answer follow the treatment? nowork: no work key at all; work: a non-empty work array.
// Null when there is no structured answer to read.
export function complied(how, structured) {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  if (how === "nowork") return !Object.prototype.hasOwnProperty.call(structured, "work");
  return Array.isArray(structured.work) && structured.work.length > 0;
}
