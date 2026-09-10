// perturb.js — robustness as a treatment: the same instance, rewritten.
//
// `<client>@perturb:<kind>` runs a generated task's instance through the family's own
// `perturb(ctx, kind, seed)` hook, which mints a meaning-preserving variant of the very problem
// the base client sees on that trial — the truth is untouched, the surface changes:
//   paraphrase — the sentences, question or clues in other words;
//   order      — independent parts in another order (table rows, clues);
//   format     — another surface form (a bulleted timeline, a CSV table, an ISO date);
//   typos      — typing errors in the words (`typos` below): a letter swapped, dropped, doubled
//                or struck beside itself, inside words of four letters or more, never in a number,
//                an id, a date word or a word the family protects (the entities it scores on).
// The model is told nothing. `summarize` pairs the variant with its base like every treatment and
// adds **consistency**: over the paired instances, the share whose canonical answer did not change
// under the perturbation — right or wrong, the same answer — beside the correctness delta. A family
// that does not support a kind returns null from its hook and the row says the treatment did not
// apply. Node-side only: the runner calls the task's hook, nothing here.

import { dice } from "./tasks/gen.js";

export const PERTURB_KINDS = ["paraphrase", "order", "format", "typos"];

// Month and weekday names, never noised: a date is data, and the format kind already varies it.
export const DATE_WORDS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const NEIGHBOURS = { q: "wa", w: "qes", e: "wrd", r: "etf", t: "ryg", y: "tuh", u: "yij", i: "uok", o: "ipl", p: "ol", a: "qsz", s: "awdz", d: "sefx", f: "drgc", g: "fthv", h: "gyjb", j: "hukn", k: "jilm", l: "kop", z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk" };

// Typing errors, deterministically from the seed: each word of four letters or more that is not
// all capitals (a code such as USD or TOTAL), not a date word and not protected gets one error
// with probability `rate` — two inner letters swapped, one dropped, one doubled, or one replaced by
// a key beside it — with the first and last letters kept, so the word still reads. Tokens with
// digits (ids, amounts, dates) are never letters-only and are never touched. At least one word is
// changed when any is eligible; a text with no eligible word comes back unchanged.
export function typos(text, seed, { protect = [], rate = 0.25 } = {}) {
  const src = String(text ?? "");
  const guard = new Set([...DATE_WORDS, ...protect.map((w) => String(w).toLowerCase())]);
  const ops = ["swap", "drop", "double", "neighbour"];
  const mutate = (word, d) => {
    const at = d.int(1, word.length - 2);
    const op = d.pick(ops);
    const c = word[at].toLowerCase();
    let out;
    if (op === "swap") out = at < word.length - 2 ? word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2) : word.slice(0, at - 1) + word[at] + word[at - 1] + word.slice(at + 1);
    else if (op === "drop") out = word.slice(0, at) + word.slice(at + 1);
    else if (op === "double") out = word.slice(0, at) + word[at] + word.slice(at);
    else { const near = NEIGHBOURS[c]; out = near ? word.slice(0, at) + near[d.int(0, near.length - 1)] + word.slice(at + 1) : word; }
    // A swap of two equal letters changes nothing; drop one instead, so every chosen word changes.
    return out === word ? word.slice(0, at) + word.slice(at + 1) : out;
  };
  // A dice per pass keeps the choice of words and the choice of errors independent of each other.
  const rng = (n) => dice(((seed >>> 0) ^ Math.imul(n, 0x9e3779b9)) >>> 0);
  const words = [];
  const re = /[A-Za-z]+/g;
  let m;
  while ((m = re.exec(src))) {
    const w = m[0];
    const before = src[m.index - 1], after = src[m.index + w.length];
    const joined = (before !== undefined && /[0-9-]/.test(before) && /[0-9]/.test(src.slice(Math.max(0, m.index - 12), m.index))) || (after !== undefined && /[-]/.test(after) && /[0-9]/.test(src[m.index + w.length + 1] ?? ""));
    if (w.length < 4 || w === w.toUpperCase() || guard.has(w.toLowerCase()) || joined) continue;
    words.push({ at: m.index, w });
  }
  if (!words.length) return src;
  const choose = rng(1), make = rng(2);
  let chosen = words.filter(() => choose.chance(rate));
  if (!chosen.length) chosen = [words[choose.int(0, words.length - 1)]];
  let out = "", last = 0;
  for (const { at, w } of chosen) { out += src.slice(last, at) + mutate(w, make); last = at + w.length; }
  return out + src.slice(last);
}

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
  return { paraphrase: "the same problem in other words", order: "the same parts in another order", format: "the same problem in another surface form", typos: "the same text with typing errors in the words" }[how] ?? how;
}
