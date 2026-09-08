// constraints.js — instruction-following constraints as a treatment: the same task with verifiable
// formatting requirements added to the prompt, scored by code.
//
// `withConstraints(client, how)` wraps a client as `<client>@constraints:light|medium|heavy` (one,
// three or five constraints). The set is drawn from the trial's seed, so every mode and client in a
// run gets the same requirements on the same instance. Free-form modes get text constraints (word
// limits, forbidden and required words, an opening or closing phrase, no commas, bullet counts);
// structured modes get JSON-shape constraints (key order, an attestation key, a single line). After
// the answer the wrapper checks each one and the row records `constraints`: how many were met and
// which — *adherence* next to correctness, so "did the job" and "did it as told" stay separate.
// Real-harness arms get the requirements through the goal prompt (`opts.constraints`).

import { dice } from "./tasks/gen.js";
import { isStructuredMode } from "./runner.js";

export const CONSTRAINT_MODES = ["light", "medium", "heavy"];
const COUNT = { light: 1, medium: 3, heavy: 5 };

const words = (t) => String(t ?? "").trim().split(/\s+/).filter(Boolean).length;
const wordRe = (w) => new RegExp(`(^|[^a-z])${w}(?=$|[^a-z])`, "i");
const jsonSpan = (t) => { const s = String(t ?? ""); const a = s.indexOf("{"), b = s.lastIndexOf("}"); return a >= 0 && b > a ? s.slice(a, b + 1) : s; };

// Each family is a factory: dice → { id, text, check(text, structured) }.
const FREE_FORM = [
  (d) => { const n = d.pick([60, 90, 120]); return { id: `max_words:${n}`, text: `Use at most ${n} words in total.`, check: (t) => words(t) <= n }; },
  (d) => { const n = d.pick([25, 40]); return { id: `min_words:${n}`, text: `Use at least ${n} words in total.`, check: (t) => words(t) >= n }; },
  (d) => { const w = d.pick(["very", "really", "simply", "just", "basically", "clearly"]); return { id: `forbid:${w}`, text: `Do not use the word "${w}".`, check: (t) => !wordRe(w).test(String(t ?? "")) }; },
  (d) => { const w = d.pick(["verified", "noted", "accordingly", "indeed"]); return { id: `include:${w}`, text: `Include the word "${w}" somewhere in your answer.`, check: (t) => wordRe(w).test(String(t ?? "")) }; },
  (d) => { const p = d.pick(["That is all.", "End of report.", "Nothing further."]); return { id: `end_with:${p}`, text: `End your answer with the exact phrase "${p}".`, check: (t) => String(t ?? "").trim().replace(/[*_`\s]+$/, "").endsWith(p) }; },
  (d) => { const p = d.pick(["Report:", "Result:", "Summary:"]); return { id: `start_with:${p}`, text: `Begin your answer with "${p}".`, check: (t) => String(t ?? "").trim().replace(/^[*_`#\s]+/, "").startsWith(p) }; },
  () => ({ id: "no_commas", text: "Do not use any commas.", check: (t) => !String(t ?? "").includes(",") }),
  (d) => { const n = d.pick([2, 3]); return { id: `bullets:${n}`, text: `Present your answer as exactly ${n} bullet points (lines starting with "- ").`, check: (t) => String(t ?? "").split(/\r?\n/).filter((l) => /^\s*[-*•]\s+/.test(l)).length === n }; },
];

const STRUCTURED = [
  (d, keys) => (keys.length < 2 ? null : { id: "key_order", text: `In the JSON, write the keys in exactly this order: ${keys.join(", ")}.`, check: (t) => { const pos = keys.map((k) => jsonSpan(t).indexOf(`"${k}"`)).filter((p) => p >= 0); return pos.length >= 2 && pos.every((p, i) => i === 0 || p > pos[i - 1]); } }),
  (d, keys, schemaType) => (schemaType !== "object" ? null : (() => { const v = d.pick(["checked", "verified", "final"]); return { id: `attest:${v}`, text: `Add a top-level key "attestation" with the exact string value "${v}".`, check: (t, s) => !!s && typeof s === "object" && !Array.isArray(s) && s.attestation === v }; })()),
  () => ({ id: "minified", text: "Write the JSON on a single line, with no line breaks.", check: (t) => !/\r?\n/.test(jsonSpan(t).trim()) }),
];

// The constraint set for one trial: deterministic in the seed, mode-aware, capped by the pool.
export function pickConstraints({ seed = 0, how = "light", structured = false, keys = [], schemaType = "object" } = {}) {
  const d = dice((Number(seed) >>> 0) ^ 0x5eed5eed);
  const pool = structured ? STRUCTURED : FREE_FORM;
  const made = d.shuffle(pool).map((f) => f(d, keys, schemaType)).filter(Boolean);
  return made.slice(0, Math.min(COUNT[how] ?? 1, made.length));
}

export function constraintBlock(set) {
  if (!set.length) return "";
  return `\n\nFormatting requirements — every one of them must be met:\n${set.map((c, i) => `${i + 1}. ${c.text}`).join("\n")}`;
}

export function checkConstraints(set, text, structured = null) {
  const list = set.map((c) => { let met = false; try { met = !!c.check(text ?? "", structured); } catch { met = false; } return { id: c.id, text: c.text, met }; });
  return { total: list.length, met: list.filter((c) => c.met).length, list };
}

// "<client>@constraints" or "@constraints:<how>" → { base, how }; anything else → { base, how: null }.
export function parseConstraintsSuffix(spec) {
  const m = String(spec).match(/^(.*)@constraints(?::([a-z]+))?$/);
  if (!m) return { base: spec, how: null };
  const how = m[2] ?? "light";
  if (!CONSTRAINT_MODES.includes(how)) throw new Error(`unknown constraints level "${how}" in "${spec}" — use @constraints:light|medium|heavy`);
  return { base: m[1], how };
}

export function withConstraints(client, how = "light") {
  if (!CONSTRAINT_MODES.includes(how)) throw new Error(`unknown constraints level "${how}" (light | medium | heavy)`);
  const setFor = (opts, structured) => {
    const schema = opts.task?.[opts.mode]?.schema;
    return pickConstraints({ seed: opts.seed ?? 0, how, structured, keys: Object.keys(schema?.properties ?? {}), schemaType: schema?.type ?? "object" });
  };
  const tag = (resp, set) => ({ ...resp, constraints: { how, applied: set.length > 0, ...checkConstraints(set, resp.text, resp.structured ?? null) } });
  return {
    ...client,
    name: `${client.name}@constraints:${how}`,
    baseName: client.name,
    constraints: how,

    // Free-form path: the requirements go on the end of the user message.
    async chat(messages, tools, opts = {}) {
      const set = setFor(opts, false);
      const msgs = [...messages];
      const i = msgs.map((m) => m.role).lastIndexOf("user");
      if (i >= 0) msgs[i] = { ...msgs[i], content: `${msgs[i].content}${constraintBlock(set)}` };
      const resp = await client.chat(msgs, tools, opts);
      return { ...tag(resp, set), effectivePrompt: i >= 0 ? msgs[i].content : undefined };
    },

    async runWithTools(prompt, tools, system, opts = {}) {
      const set = setFor(opts, isStructuredMode(opts.mode));
      // Arms build their own prompt from the goal; the requirements ride along for goalPrompt.
      const passed = { ...opts, constraints: set.map((c) => c.text) };
      const p = client.structuredOnly ? prompt : `${prompt}${constraintBlock(set)}`;
      const resp = await client.runWithTools(p, tools, system, passed);
      return { ...tag(resp, set), effectivePrompt: client.structuredOnly ? undefined : p };
    },
  };
}
