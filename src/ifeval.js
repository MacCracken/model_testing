// ifeval.js — the IFEval instruction checkers (Zhou et al., 2023), reimplemented without
// dependencies so a public prompt set can be scored here, against the same endpoint as everything
// else. Each checker follows google-research/instruction_following_eval/instructions.py; where the
// original leans on nltk or langdetect (sentences, words, capital words, the response language)
// this file uses regular expressions and a script-and-stopword heuristic, and says so in the
// result (`approximate: true`) so the caveat travels with the number. Strict and loose scoring
// follow evaluation_lib.py: loose tries the response with its first line, last line and every `*`
// removed, in every combination, and passes if any variant does.

const COMPARISON = { "at least": (n, k) => n >= k, "less than": (n, k) => n < k };
const compare = (relation, n, k) => (COMPARISON[relation] ?? COMPARISON["at least"])(n, k);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// nltk's word tokenizer counts \w+ runs; Python's \w is Unicode-aware.
export const countWords = (text) => (String(text).match(/[\p{L}\p{N}_]+/gu) ?? []).length;
// nltk's sentence splitter, approximated: a sentence ends at . ! or ? followed by whitespace or the end.
export const countSentences = (text) => {
  const t = String(text).trim();
  if (!t) return 0;
  return (t.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? []).filter((s) => s.trim()).length;
};

// Scripts that name a language on their own, and stopwords for the Latin-script languages IFEval
// asks for. A response counts as the language when most of its letters sit in that script, or —
// for a Latin-script language — when its stopwords outvote English's.
const SCRIPTS = {
  ar: /[؀-ۿ]/g, fa: /[؀-ۿ]/g, ur: /[؀-ۿ]/g,
  hi: /[ऀ-ॿ]/g, mr: /[ऀ-ॿ]/g, ne: /[ऀ-ॿ]/g,
  bn: /[ঀ-৿]/g, pa: /[਀-੿]/g, gu: /[઀-૿]/g, ta: /[஀-௿]/g,
  te: /[ఀ-౿]/g, kn: /[ಀ-೿]/g, ml: /[ഀ-ൿ]/g, th: /[฀-๿]/g,
  ko: /[가-힯ᄀ-ᇿ]/g, ja: /[぀-ヿ]/g, zh: /[一-鿿]/g,
  ru: /[Ѐ-ӿ]/g, bg: /[Ѐ-ӿ]/g, uk: /[Ѐ-ӿ]/g, el: /[Ͱ-Ͽ]/g, he: /[֐-׿]/g,
};
const STOPWORDS = {
  en: ["the", "and", "is", "of", "to", "in", "that", "it", "with", "for", "you", "this"],
  de: ["und", "der", "die", "das", "ist", "nicht", "ich", "mit", "ein", "eine", "sie", "auf"],
  fr: ["le", "la", "les", "et", "est", "une", "des", "que", "pour", "dans", "vous", "nous"],
  es: ["el", "la", "los", "las", "y", "es", "una", "que", "para", "con", "por", "del"],
  it: ["il", "la", "di", "che", "non", "per", "una", "con", "sono", "del", "della", "gli"],
  pt: ["de", "que", "não", "uma", "para", "com", "os", "as", "do", "da", "em", "você"],
  nl: ["de", "het", "een", "en", "van", "niet", "ik", "je", "dat", "met", "zijn", "voor"],
  sw: ["na", "ya", "wa", "kwa", "ni", "za", "la", "katika", "kuwa", "hii", "sana", "lakini"],
  fi: ["ja", "on", "ei", "että", "ovat", "oli", "hän", "se", "kun", "myös", "mutta", "joka"],
  vi: ["và", "của", "là", "không", "có", "được", "cho", "với", "này", "những", "một", "các"],
  tr: ["ve", "bir", "bu", "için", "ile", "da", "de", "çok", "gibi", "ama", "olarak", "daha"],
  id: ["dan", "yang", "di", "untuk", "dengan", "ini", "itu", "tidak", "dari", "akan", "adalah", "juga"],
};
export function detectLanguage(text) {
  const t = String(text);
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (!letters) return null;
  let best = null;
  for (const [lang, re] of Object.entries(SCRIPTS)) {
    const n = (t.match(re) ?? []).length;
    if (n / letters > 0.5 && (!best || n > best.n)) best = { lang, n };
  }
  if (best) return best.lang;
  const words = t.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  const votes = Object.entries(STOPWORDS).map(([lang, list]) => [lang, words.filter((w) => list.includes(w)).length]).sort((a, b) => b[1] - a[1]);
  return votes[0]?.[1] ? votes[0][0] : "en";
}
// The scripts several languages share: a Cyrillic response passes for any Cyrillic language asked
// for, since script alone cannot tell them apart.
const SAME_SCRIPT = [["ar", "fa", "ur"], ["hi", "mr", "ne"], ["ru", "bg", "uk"]];
const languageMatches = (asked, found) => asked === found || SAME_SCRIPT.some((g) => g.includes(asked) && g.includes(found));

// One checker per instruction id: (kwargs, response) → boolean. Approximate ones are listed below.
export const CHECKERS = {
  "keywords:existence": ({ keywords = [] }, v) => keywords.every((k) => new RegExp(escapeRe(k), "i").test(v)),
  "keywords:frequency": ({ keyword, frequency, relation }, v) => compare(relation, (v.match(new RegExp(escapeRe(keyword), "gi")) ?? []).length, frequency),
  "keywords:forbidden_words": ({ forbidden_words = [] }, v) => !forbidden_words.some((w) => new RegExp(`\\b${escapeRe(w)}\\b`, "i").test(v)),
  "keywords:letter_frequency": ({ letter, let_frequency, let_relation }, v) => compare(let_relation, v.toLowerCase().split(String(letter).toLowerCase()).length - 1, let_frequency),
  "language:response_language": ({ language }, v) => { const found = detectLanguage(v); return found !== null && languageMatches(language, found); },
  "length_constraints:number_sentences": ({ num_sentences, relation }, v) => compare(relation, countSentences(v), num_sentences),
  "length_constraints:number_paragraphs": ({ num_paragraphs }, v) => {
    const parts = v.split(/\s?\*\*\*\s?/);
    // The original: every part between separators must be non-empty, except the ends.
    for (const [i, p] of parts.entries()) if (!p.trim() && i !== 0 && i !== parts.length - 1) return false;
    return parts.filter((p) => p.trim()).length === num_paragraphs;
  },
  "length_constraints:number_words": ({ num_words, relation }, v) => compare(relation, countWords(v), num_words),
  "length_constraints:nth_paragraph_first_word": ({ num_paragraphs, nth_paragraph, first_word }, v) => {
    const paragraphs = v.split(/\n\n/).filter((p) => p.trim());
    if (paragraphs.length !== num_paragraphs) return false;
    const p = paragraphs[nth_paragraph - 1];
    if (!p) return false;
    const first = (p.trim().split(/\s+/)[0] ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    return first === String(first_word).toLowerCase();
  },
  "detectable_content:number_placeholders": ({ num_placeholders }, v) => (v.match(/\[.*?\]/g) ?? []).length >= num_placeholders,
  "detectable_content:postscript": ({ postscript_marker }, v) => {
    const m = String(postscript_marker);
    const pattern = m === "P.P.S" ? /\s*p\.\s?p\.\s?s.*$/im : m === "P.S." ? /\s*p\.\s?s\..*$/im : new RegExp(`\\s*${escapeRe(m.toLowerCase())}.*$`, "im");
    return pattern.test(v.toLowerCase());
  },
  "detectable_format:number_bullet_lists": ({ num_bullets }, v) => (v.match(/^\s*\*[^*].*$/gm) ?? []).length + (v.match(/^\s*-.*$/gm) ?? []).length === num_bullets,
  "detectable_format:constrained_response": (_k, v) => ["My answer is yes.", "My answer is no.", "My answer is maybe."].some((o) => v.includes(o)),
  "detectable_format:number_highlighted_sections": ({ num_highlights }, v) => {
    const single = (v.match(/\*[^\n*]*\*/g) ?? []).filter((h) => h.replace(/\*/g, "").trim());
    const double = (v.match(/\*\*[^\n*]*\*\*/g) ?? []).filter((h) => h.replace(/\*/g, "").trim());
    return single.length + double.length >= num_highlights;
  },
  "detectable_format:multiple_sections": ({ section_spliter, num_sections }, v) => v.split(new RegExp(`\\s?${escapeRe(section_spliter)}\\s?\\d+\\s?`)).length - 1 >= num_sections,
  "detectable_format:json_format": (_k, v) => {
    const t = v.trim().replace(/^```json/, "").replace(/^```JSON/, "").replace(/^```/, "").replace(/```$/, "").trim();
    try { JSON.parse(t); return true; } catch { return false; }
  },
  "detectable_format:title": (_k, v) => (v.match(/<<[^\n]+>>/g) ?? []).some((t) => t.slice(2, -2).trim()),
  "combination:two_responses": (_k, v) => {
    const parts = v.split("******");
    const valid = [];
    for (const [i, p] of parts.entries()) { if (!p.trim()) { if (i !== 0 && i !== parts.length - 1) return false; } else valid.push(p); }
    return valid.length === 2 && valid[0].trim() !== valid[1].trim();
  },
  "combination:repeat_prompt": ({ prompt_to_repeat }, v) => v.trim().toLowerCase().startsWith(String(prompt_to_repeat).trim().toLowerCase()),
  "startend:end_checker": ({ end_phrase }, v) => v.trim().replace(/^"+|"+$/g, "").toLowerCase().endsWith(String(end_phrase).trim().toLowerCase()),
  "change_case:capital_word_frequency": ({ capital_frequency, capital_relation }, v) => compare(capital_relation, (v.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => /\p{L}/u.test(w) && w === w.toUpperCase()).length, capital_frequency),
  "change_case:english_capital": (_k, v) => /\p{L}/u.test(v) && v === v.toUpperCase(),
  "change_case:english_lowercase": (_k, v) => /\p{L}/u.test(v) && v === v.toLowerCase(),
  "punctuation:no_comma": (_k, v) => !v.includes(","),
  "startend:quotation": (_k, v) => { const t = v.trim(); return t.length > 1 && t.startsWith('"') && t.endsWith('"'); },
};
export const APPROXIMATE = new Set(["language:response_language", "length_constraints:number_sentences", "length_constraints:number_words", "change_case:capital_word_frequency"]);
export const INSTRUCTION_IDS = Object.keys(CHECKERS);

export function checkInstruction(id, kwargs, response) {
  const fn = CHECKERS[id];
  if (!fn) throw new Error(`unknown IFEval instruction ${id}`);
  return !!fn(kwargs ?? {}, String(response ?? ""));
}

// The loose variants from evaluation_lib.py: the response itself, without its first line, without
// its last line, without both, and each of those with every `*` removed.
export function looseVariants(response) {
  const r = String(response ?? "");
  const lines = r.split("\n");
  const noFirst = lines.slice(1).join("\n").trim();
  const noLast = lines.slice(0, -1).join("\n").trim();
  const noBoth = lines.slice(1, -1).join("\n").trim();
  const base = [r, noFirst, noLast, noBoth];
  return [...base, ...base.map((v) => v.replace(/\*/g, ""))];
}

// One prompt: every instruction strictly and loosely, prompt-level pass = all followed.
export function checkPrompt(item, response) {
  const ids = item.instruction_id_list ?? [];
  const variants = looseVariants(response);
  const instructions = ids.map((id, i) => {
    const kwargs = item.kwargs?.[i] ?? {};
    const strict = checkInstruction(id, kwargs, response);
    // evaluation_lib skips a variant that is empty: a one-line answer minus its line proves nothing.
    const loose = strict || variants.some((v) => v.trim() && checkInstruction(id, kwargs, v));
    return { id, kwargs, strict, loose, approximate: APPROXIMATE.has(id) };
  });
  return { instructions, strict: instructions.every((x) => x.strict), loose: instructions.every((x) => x.loose), approximate: instructions.some((x) => x.approximate) };
}
