// Task family: code — a pure-function spec minted per trial, hidden tests as the truth.
//
// Each instance is one function to write (`code1/2/3`, the level the number of interacting rules):
// a seeded kind — sums, counts, clamps, slugs, run-length codes, range merges, duration parsing,
// word frequencies, CSV fields, range compaction — with its parameters drawn from the seed (the
// divisor, the separator, the tie rule, the threshold, the delimiter, the unit set …), so the same
// classic exercise is a different function on every trial and a remembered solution to the usual
// version fails the hidden edge cases. The truth is a reference implementation rendered from the
// same parameters; the visible tests are the examples in the prompt, the hidden ones the score.
// The harness axis is `run_tests`: the sandbox (`src/sandbox.js`) runs the model's code against
// the examples and reports what failed, so a model with the tool can test before it answers; the
// scorer runs the hidden tests in the same sandbox, in every mode.

import { labelModel } from "../providers/index.js";
import { dice } from "./gen.js";
import { runInSandbox, codeIn, describeSandbox } from "../sandbox.js";

const WORDS = ["apple", "brick", "cloud", "delta", "ember", "frost", "grape", "hazel", "ivory", "jelly", "kiosk", "lemon", "mango", "north", "olive", "pearl", "quilt", "river", "stone", "tulip", "umber", "vivid", "wheat", "xenon", "yacht", "zebra"];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const phrase = (d, n, caps = 0.3) => Array.from({ length: n }, () => { const w = d.pick(WORDS); return d.chance(caps) ? cap(w) : w; }).join(" ");
const ints = (d, n, lo, hi) => Array.from({ length: n }, () => d.int(lo, hi));
const UNIT_SECONDS = { d: 86400, h: 3600, m: 60, s: 1 };

// A kind: the function's name and level, `params(d)` drawn from the seed, the signature and what
// the arguments are, `rules(p)` (the sentences of the spec), `ref(p)` (the reference source with the
// parameters inlined — the truth, and the only place the behaviour is written), `gen(p, d)` (one
// random argument list) and `edges(p)` (the argument lists that pin the rules' edge cases).
export const KINDS = [
  // ---- level 1: one rule and its edges ----
  {
    name: "sumOfMultiples", level: 1, signature: "sumOfMultiples(xs)", args: "xs is an array of integers",
    params: (d) => ({ m: d.int(2, 7) }),
    rules: (p) => [`returns the sum of the numbers in xs that are divisible by ${p.m} (0 counts as divisible)`, "returns 0 when no number qualifies or xs is empty", "the numbers may be negative"],
    ref: (p) => `function sumOfMultiples(xs) { let s = 0; for (const x of xs) if (x % ${p.m} === 0) s += x; return s; }`,
    gen: (p, d) => [ints(d, d.int(3, 9), -30, 60)],
    edges: (p) => [[[]], [[0, 1]], [[-p.m, p.m, 1]], [[p.m + 1, p.m * 2 + 1]]],
  },
  {
    name: "countChar", level: 1, signature: "countChar(s)", args: "s is a string",
    params: (d) => ({ c: d.pick(["a", "e", "i", "o", "s", "t", "n", "r"]) }),
    rules: (p) => [`returns how many times the letter "${p.c}" occurs in s`, "upper and lower case count alike", "returns 0 for an empty string"],
    ref: (p) => `function countChar(s) { let n = 0; for (const ch of s.toLowerCase()) if (ch === ${JSON.stringify(p.c)}) n++; return n; }`,
    gen: (p, d) => [phrase(d, d.int(2, 6))],
    edges: (p) => [[""], [`${p.c.toUpperCase()}${p.c} ${p.c.toUpperCase()}`], ["xyz"]],
  },
  {
    name: "clampAll", level: 1, signature: "clampAll(xs)", args: "xs is an array of integers",
    params: (d) => ({ lo: d.int(-20, 0), hi: d.int(5, 40) }),
    rules: (p) => [`returns a new array with every number of xs clamped into the range ${p.lo} to ${p.hi} inclusive (below ${p.lo} becomes ${p.lo}, above ${p.hi} becomes ${p.hi})`, "keeps the order and the length", "returns [] for an empty array"],
    ref: (p) => `function clampAll(xs) { return xs.map((x) => Math.min(${p.hi}, Math.max(${p.lo}, x))); }`,
    gen: (p, d) => [ints(d, d.int(2, 8), p.lo - 15, p.hi + 15)],
    edges: (p) => [[[]], [[p.lo, p.hi]], [[p.lo - 1, p.hi + 1]]],
  },
  {
    name: "longestWord", level: 1, signature: "longestWord(s)", args: "s is a string of words separated by one or more spaces",
    params: (d) => ({ tie: d.pick(["first", "last"]) }),
    rules: (p) => ["returns the longest word of s", `when several words share the greatest length, returns the ${p.tie} of them`, "returns \"\" for an empty string or a string of only spaces"],
    ref: (p) => `function longestWord(s) { let best = ""; for (const w of s.split(" ")) if (w.length ${p.tie === "first" ? ">" : ">="} best.length) best = w; return best; }`,
    gen: (p, d) => [phrase(d, d.int(2, 6)).replace(/ /g, () => (d.chance(0.2) ? "  " : " "))],
    edges: () => [[""], ["   "], ["pear plum kiwi"], ["a  bb  cc"]],
  },
  // ---- level 2: a few rules that interact ----
  {
    name: "topK", level: 2, signature: "topK(xs)", args: "xs is an array of integers",
    params: (d) => ({ k: d.int(1, 4), distinct: d.pick([true, false]) }),
    rules: (p) => [p.distinct ? `returns the ${p.k} largest distinct values of xs in descending order (a value that occurs several times is returned once)` : `returns the ${p.k} largest numbers of xs in descending order (a value that occurs several times may be returned several times)`, `returns all of them, sorted descending, when there are fewer than ${p.k}`, "returns [] for an empty array"],
    ref: (p) => `function topK(xs) { const ys = ${p.distinct ? "[...new Set(xs)]" : "[...xs]"}.sort((a, b) => b - a); return ys.slice(0, ${p.k}); }`,
    gen: (p, d) => [ints(d, d.int(2, 9), 0, 12)],
    edges: (p) => [[[]], [[5]], [[3, 3, 3, 3, 3]], [[9, 9, 1, 8, 8, 2]]],
  },
  {
    name: "slugify", level: 2, signature: "slugify(s)", args: "s is a string",
    params: (d) => ({ sep: d.pick(["-", "_", "."]) }),
    rules: (p) => ["lower-cases s", `replaces every run of characters that are not ASCII letters or digits with a single "${p.sep}"`, `leaves no "${p.sep}" at either end`, "returns \"\" when s has no letters or digits"],
    ref: (p) => `function slugify(s) { return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(${JSON.stringify(p.sep)}); }`,
    gen: (p, d) => [d.pick(["", " ", "  "]) + Array.from({ length: d.int(2, 5) }, () => (d.chance(0.3) ? cap(d.pick(WORDS)) : d.pick(WORDS)) + (d.chance(0.2) ? String(d.int(0, 99)) : "")).join(d.pick([" ", ", ", " -- ", "/", "'s ", "  "])) + d.pick(["", "!", ".", " ?"])],
    edges: (p) => [[""], ["!!!"], [`  Already${p.sep}slug  `], ["A1 b2"]],
  },
  {
    name: "runLength", level: 2, signature: "runLength(s)", args: "s is a string",
    params: (d) => ({ singles: d.pick(["counted", "bare"]) }),
    rules: (p) => [`encodes s as each maximal run of one character followed by the run's length ("aaabcc" becomes ${p.singles === "counted" ? "\"a3b1c2\"" : "\"a3bc2\""})`, p.singles === "counted" ? "a run of one character is written with the count 1" : "a run of one character is written as the character alone, without a count", "is case-sensitive: \"aA\" is two runs", "returns \"\" for an empty string"],
    ref: (p) => `function runLength(s) { let out = ""; let i = 0; while (i < s.length) { let j = i; while (j < s.length && s[j] === s[i]) j++; const n = j - i; out += s[i] + (${p.singles === "counted" ? "true" : "n > 1"} ? String(n) : ""); i = j; } return out; }`,
    gen: (p, d) => [Array.from({ length: d.int(2, 6) }, () => d.pick(["a", "b", "c", "A", "z"]).repeat(d.int(1, 4))).join("")],
    edges: () => [[""], ["a"], ["aA"], ["zzzzzzzzzzzz"]],
  },
  {
    name: "mergeRanges", level: 2, signature: "mergeRanges(ranges)", args: "ranges is an array of integer ranges, each a two-element array [start, end] with start <= end, in any order",
    params: (d) => ({ touching: d.pick([true, false]) }),
    rules: (p) => [p.touching ? "merges ranges that overlap or share an endpoint ([1, 3] and [3, 5] become [1, 5])" : "merges ranges that overlap by more than a single point ([1, 3] and [3, 5] stay apart; [1, 4] and [3, 5] become [1, 5])", "returns the merged ranges as [start, end] pairs sorted by start", "returns [] for an empty array"],
    ref: (p) => `function mergeRanges(ranges) { const rs = ranges.map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]); const out = []; for (const r of rs) { const last = out[out.length - 1]; if (last && r[0] ${p.touching ? "<=" : "<"} last[1]) { if (r[1] > last[1]) last[1] = r[1]; } else out.push(r); } return out; }`,
    gen: (p, d) => [Array.from({ length: d.int(2, 5) }, () => { const a = d.int(0, 20); return [a, a + d.int(0, 6)]; })],
    edges: () => [[[]], [[[1, 3], [3, 5]]], [[[1, 4], [2, 3]]], [[[5, 6], [1, 2]]], [[[1, 4], [3, 5]]]],
  },
  // ---- level 3: several rules with a fail case ----
  {
    name: "parseDuration", level: 3, signature: "parseDuration(s)", args: "s is a string",
    params: (d) => ({ units: d.chance(0.5) ? ["d", "h", "m", "s"] : ["h", "m", "s"] }),
    rules: (p) => [`parses a duration written as parts like "2h30m" and returns the total number of seconds, with the units ${p.units.map((u) => `"${u}"`).join(", ")} (${p.units.map((u) => `${u} = ${UNIT_SECONDS[u]}`).join(", ")})`, "each part is a non-negative integer directly followed by its unit; the parts may come in any order and may be separated by spaces", "each unit may appear at most once", "returns 0 for an empty string or a string of only spaces", "returns -1 for anything else: an unknown unit, a unit without a number, a number without a unit, or a repeated unit"],
    ref: (p) => `function parseDuration(s) { const mult = ${JSON.stringify(Object.fromEntries(p.units.map((u) => [u, UNIT_SECONDS[u]])))}; let rest = s.trim(); if (rest === "") return 0; const seen = new Set(); let total = 0; while (rest.length) { const m = /^(\\d+)([A-Za-z])\\s*/.exec(rest); if (!m || !(m[2] in mult) || seen.has(m[2])) return -1; seen.add(m[2]); total += Number(m[1]) * mult[m[2]]; rest = rest.slice(m[0].length); } return total; }`,
    gen: (p, d) => {
      const units = d.shuffle(p.units).slice(0, d.int(1, Math.min(3, p.units.length)));
      let parts = units.map((u) => `${d.int(0, u === "d" ? 3 : 59)}${u}`);
      const twist = d.int(1, 8);
      if (twist === 1) parts.push("4x"); else if (twist === 2) parts.push(parts[0]); else if (twist === 3) parts.push("7"); else if (twist === 4) parts = parts.map((x) => x.replace(/(\d+)([a-z])/, "$1 $2"));
      return [parts.join(d.pick(["", " "]))];
    },
    edges: () => [[""], ["  "], ["5x"], ["1h1h"], ["h"], ["30m2h"], ["2h30"], ["1d"], ["2 h"]],
  },
  {
    name: "wordFreq", level: 3, signature: "wordFreq(text)", args: "text is a string",
    params: (d) => ({ n: d.int(2, 4) }),
    rules: (p) => [`returns the ${p.n} most frequent words of text as an array of [word, count] pairs, most frequent first`, "a word is a maximal run of ASCII letters; everything else separates words; words are compared and returned in lower case", "words with the same count are ordered alphabetically", `returns fewer pairs when text has fewer than ${p.n} distinct words, and [] for a text without letters`],
    ref: (p) => `function wordFreq(text) { const counts = new Map(); for (const w of text.toLowerCase().split(/[^a-z]+/)) if (w) counts.set(w, (counts.get(w) || 0) + 1); return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, ${p.n}); }`,
    gen: (p, d) => { const vocab = d.shuffle(WORDS).slice(0, d.int(3, 6)); const words = Array.from({ length: d.int(6, 14) }, () => d.pick(vocab)); return [words.map((w, i) => (i % 3 === 0 ? cap(w) : w)).join(d.pick([" ", ", ", " - ", "; "])) + d.pick(["", ".", "!", " 42"])]; },
    edges: () => [[""], ["42 --- 7"], ["Apple apple APPLE pear pear kiwi"], ["b a c a b"], ["it's it's its"]],
  },
  {
    name: "csvRow", level: 3, signature: "csvRow(line)", args: "line is a string, one row of a delimited file",
    params: (d) => ({ delim: d.pick([",", ";", "|"]) }),
    rules: (p) => [`splits line into its fields on the "${p.delim}" character and returns them as an array of strings`, `a field wrapped in double quotes may contain "${p.delim}", and a doubled quote inside it ("") stands for one quote character; the wrapping quotes are not part of the value`, "an unquoted field is trimmed of spaces at both ends; a quoted field keeps its inner spaces exactly", "an empty line gives [\"\"], and an empty field gives \"\""],
    ref: (p) => `function csvRow(line) { const D = ${JSON.stringify(p.delim)}; const out = []; let i = 0; while (true) { let field = ""; if (line[i] === '"') { i++; while (i < line.length) { if (line[i] === '"') { if (line[i + 1] === '"') { field += '"'; i += 2; continue; } i++; break; } field += line[i++]; } while (i < line.length && line[i] !== D) i++; } else { let j = i; while (j < line.length && line[j] !== D) j++; field = line.slice(i, j).trim(); i = j; } out.push(field); if (i >= line.length) break; i++; if (i >= line.length) { out.push(""); break; } } return out; }`,
    gen: (p, d) => {
      const D = p.delim;
      const field = () => { const w = d.pick(WORDS); const kind = d.int(1, 5); if (kind === 1) return `"${w}${D} ${d.pick(WORDS)}"`; if (kind === 2) return `"say ""${w}"""`; if (kind === 3) return ` ${w} `; if (kind === 4) return `" ${w} "`; return w; };
      return [Array.from({ length: d.int(2, 4) }, field).join(D)];
    },
    edges: (p) => [[""], [p.delim], [`"a${p.delim}b"${p.delim}c`], ['"say ""hi"""'], [` x ${p.delim} " y " `], [`a${p.delim}${p.delim}b`]],
  },
  {
    name: "compactRanges", level: 3, signature: "compactRanges(nums)", args: "nums is an array of integers in any order, possibly with duplicates",
    params: (d) => ({ minRun: d.pick([2, 3]) }),
    rules: (p) => [`sorts the numbers ascending and drops duplicates, then writes every run of ${p.minRun} or more consecutive integers as "first-last"`, `writes the other numbers on their own${p.minRun === 3 ? " (two consecutive numbers stay separate)" : ""}`, "joins the pieces with \", \" and returns the string", "returns \"\" for an empty array"],
    ref: (p) => `function compactRanges(nums) { const xs = [...new Set(nums)].sort((a, b) => a - b); const parts = []; let i = 0; while (i < xs.length) { let j = i; while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++; if (j - i + 1 >= ${p.minRun}) parts.push(xs[i] + "-" + xs[j]); else for (let k = i; k <= j; k++) parts.push(String(xs[k])); i = j + 1; } return parts.join(", "); }`,
    gen: (p, d) => [ints(d, d.int(3, 10), 1, 30)],
    edges: () => [[[]], [[7]], [[3, 1, 2]], [[5, 4, 4, 9]], [[-2, -1, 0, 5]], [[10, 12, 11, 20, 21]]],
  },
];

export const LEVELS = [1, 2, 3];
const roundTrip = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

// The instance for a seed and level: the kind, its parameters, the spec, the examples (visible
// tests) and the hidden tests, with the reference source that produced them.
export function generate(seed, level) {
  const d = dice((seed >>> 0) ^ 0xc0de);
  const kinds = KINDS.filter((k) => k.level === level);
  if (!kinds.length) throw new Error(`code: no kinds at level ${level}`);
  const kind = kinds[d.int(0, kinds.length - 1)];
  const params = kind.params(d);
  const ref = kind.ref(params);
  const fn = new Function(`return (${ref});`)(); // our own reference, trusted
  const mk = (args) => ({ args: roundTrip(args), expected: roundTrip(fn(...structuredClone(args))) });
  const edges = kind.edges(params);
  const visible = [mk(kind.gen(params, d)), mk(kind.gen(params, d)), mk(edges[d.int(0, edges.length - 1)])];
  const hidden = [...Array.from({ length: 8 }, () => mk(kind.gen(params, d))), ...edges.map(mk)];
  const rules = kind.rules(params);
  const spec = `Write a JavaScript function \`${kind.signature}\`, where ${kind.args}, that ${rules.map((r, i) => `(${i + 1}) ${r}`).join("; ")}.`;
  const examples = visible.map((t) => `${kind.name}(${t.args.map((a) => JSON.stringify(a)).join(", ")}) → ${JSON.stringify(t.expected)}`);
  return { kind: kind.name, level, name: kind.name, signature: kind.signature, params, rules, spec, examples, visible, hidden, ref, seed: seed >>> 0 };
}

const problem = (ctx) => `${ctx.spec} The arguments always have the stated types; nothing else needs validating. Examples: ${ctx.examples.join("; ")}.`;

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "Your notes before the code: the edge cases the rules name and how the code meets them." },
    code: { type: "string", description: "The complete JavaScript source defining the function, as one string." },
  },
  required: ["code"],
};

// The code in a structured answer: the `code` field (fences unwrapped if the model added them).
export function codeOf(out, name) {
  if (!out || typeof out !== "object") return null;
  const raw = typeof out.code === "string" ? out.code : typeof out.answer === "string" ? out.answer : null;
  if (!raw) return null;
  return codeIn(raw, name) ?? raw;
}

// The harness axis: the sandbox on the visible tests (the examples), reported back to the model.
export const runTestsTool = (ctx = {}) => ({
  name: "run_tests",
  description: `Run your JavaScript code against the ${ctx.visible?.length ?? "example"} example tests of this task and report what failed. Pass the complete source defining ${ctx.name ?? "the function"}. Returns { passed, total, failures: [{ args, expected, got | error }], error, summary }.`,
  parameters: { type: "object", properties: { code: { type: "string", description: `The complete JavaScript source defining ${ctx.name ?? "the function"}.` } }, required: ["code"] },
  impl: async ({ code }) => {
    const src = codeIn(code, ctx.name) ?? String(code ?? "");
    const r = await runInSandbox({ code: src, name: ctx.name, tests: ctx.visible ?? [] });
    return { passed: r.passed, total: r.total, failures: r.failures, error: r.error, summary: describeSandbox(r, { tests: "example test" }) };
  },
});

async function grade(code, ground) {
  if (!ground?.hidden) return { correct: false, reason: "no hidden tests recorded" };
  if (!code) return { correct: false, reason: "no code in the answer" };
  const r = await runInSandbox({ code, name: ground.name, tests: ground.hidden });
  return { correct: r.ok, reason: describeSandbox(r, { tests: "hidden test" }) };
}

const LEVEL_TEXT = { 1: "one rule and its edges", 2: "a few rules that interact", 3: "several rules with a fail case" };

function makeCode(level) {
  return {
    name: `code${level}`,
    family: "code",
    level,
    category: "coding",
    seeded: true,
    capabilities: ["code"],
    description: `A pure function to write from a spec minted per trial (${LEVEL_TEXT[level]}), scored by hidden tests in a sandbox. With tools, run_tests runs the examples.`,
    model: labelModel,
    maxRounds: 8,
    skill: "code",

    setup: async ({ seed }) => generate(seed >>> 0, level),

    goal: (ctx) => `${problem(ctx)} Reply with the complete function in one \`\`\`js code block; it must pass tests you cannot see, including the edge cases the rules name.`,

    noHarness: {
      prompt: (ctx) => `${problem(ctx)} Write it in plain JavaScript for Node — self-contained, no imports, no input or output. Reply with the complete function in one \`\`\`js code block.`,
      extract: "text",
    },
    harness: {
      system: "You are a careful programmer. Your code runs in a sandbox with no modules, file system or network. Use the run_tests tool to run your code against the examples before you answer, fix what fails, and return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)} Use run_tests on your code (it runs the examples above), fix what fails, then answer with a JSON object { "work": ["<note>", …], "code": "<the complete function source>" } — the notes first, then the code as one JSON string.`,
      tools: (ctx) => [runTestsTool(ctx)],
      schema,
      extract: "structured",
    },
    schemaOnly: {
      system: "You are a careful programmer. Your code runs in a sandbox with no modules, file system or network. Return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)} Answer with a JSON object { "work": ["<note>", …], "code": "<the complete function source>" } — think it through in "work" first (the edge cases the rules name), then the code as one JSON string.`,
      tools: [],
      schema,
      extract: "structured",
    },
    toolOnly: {
      system: "You are a careful programmer. Your code runs in a sandbox with no modules, file system or network. Use the run_tests tool to run your code against the examples before you answer, and fix what fails.",
      prompt: (ctx) => `${problem(ctx)} Use run_tests on your code (it runs the examples above), fix what fails, then reply with the complete function in one \`\`\`js code block.`,
      tools: (ctx) => [runTestsTool(ctx)],
      extract: "text",
    },

    eval: {
      ground: ({ ctx } = {}) => (ctx?.hidden ? { name: ctx.name, hidden: ctx.hidden } : null),
      toolUse: ({ toolCalls, toolResults }) => {
        const runs = toolCalls.filter((c) => c.name === "run_tests");
        if (!runs.length) return { ok: false, reason: "run_tests was never called — the code went out untested" };
        const last = [...toolResults].reverse().find((r) => r.name === "run_tests");
        const res = last && typeof last.result === "object" ? last.result : null;
        if (!res) return { ok: true, reason: `ran the examples ${runs.length} time(s)` };
        const clean = res.total > 0 && res.passed === res.total;
        return { ok: true, reason: clean ? `ran the examples ${runs.length} time(s); the last run passed them all` : `ran the examples ${runs.length} time(s); the last run did not pass (${res.error ?? `${res.passed}/${res.total}`}) and the code went out anyway` };
      },
      scoreHarness: async (out, ground) => {
        if (!out || typeof out !== "object") return { correct: false, reason: "no structured output" };
        return grade(codeOf(out, ground?.name), ground);
      },
      scoreNoHarness: async (out, ground) => grade(codeIn(out, ground?.name), ground),
    },
  };
}

export const codeTasks = LEVELS.map(makeCode);
export { schema, makeCode };
