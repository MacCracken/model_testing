// Task: which strings match a target regex?
//
//   - noHarness: the model determines matches by hand from free text. Regex matching is doable
//     but error-prone on the near-misses, so this is where a careful model separates from a
//     sloppy one.
//   - harness:   the model is given two tools and must *reason* about them:
//       * `regex_match` — the correct tool. It requires typed args: the regex `pattern` and the
//         `string` to test. The model must construct a valid regex and pass it per-string.
//       * `word_count`  — a decoy. It looks plausible but is irrelevant to matching. Firing it
//         wastes a call and is the "wrong tool" trap.
//
// This exercises *tool complexity*, not just firing: it tests whether the model picks the right
// tool and builds the right arguments, not whether it calls a tool at all (see lookup.js, which
// isolates "the tool is required").

import { labelModel } from "../providers/index.js";
import { unwrapList } from "./util.js";

// Two well-formed strings and four near-misses: "12345" (no dash), "123-456" (three trailing
// digits), "12-34" (two leading digits) all look like "123-45" but fail the anchored pattern.
const STRINGS = ["123-45", "12345", "abc", "123-456", "12-34", "999-88"];
// Three digits, a dash, two digits — anchored so the near-misses do not match.
const TARGET = "^\\d{3}-\\d{2}$";

// Real regex matching — the truth the `regex_match` tool computes.
async function regexMatch(pattern, string) {
  return { matched: new RegExp(pattern).test(string), pattern, string };
}

// Decoy: counts words. Irrelevant to matching, but the tempting option. A model that can't tell
// the tools apart fires this and gets nowhere.
async function countWords(string) {
  return { words: String(string).trim().split(/\s+/).filter(Boolean).length, string };
}

const tools = [
  {
    name: "regex_match",
    description:
      "Test whether a string matches a regular expression. Pass the regex as `pattern` and the " +
      "text to test as `string`. Returns { matched: true/false }.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression to test against, e.g. \"^\\\\d{3}-\\\\d{2}$\"." },
        string: { type: "string", description: "The string to test." },
      },
      required: ["pattern", "string"],
    },
    impl: (args) => regexMatch(args.pattern, args.string),
  },
  {
    name: "word_count",
    description:
      "Count the number of words in a string. Not useful for deciding whether a string matches a regex.",
    parameters: {
      type: "object",
      properties: {
        string: { type: "string", description: "The string to count words in." },
      },
      required: ["string"],
    },
    impl: (args) => countWords(args.string),
  },
];

const schema = {
  type: "array",
  minItems: STRINGS.length,
  items: {
    type: "object",
    properties: {
      string: { type: "string", description: "The string, exactly as given." },
      matched: { type: "boolean", description: "Whether the string matches the target regex." },
    },
    required: ["string", "matched"],
  },
};

// Extract the { string, matched } list, tolerating an array or an object wrapper.
function resultsFrom(out) {
  return unwrapList(out, ["results", "matches", "data", "entries"], (o) => o.matched !== undefined && o.string !== undefined);
}

// Free-text parsing helpers for the no-harness scorer.
const YES_NO = /\b(yes|no)\b/;
// Strip a short list marker ("1.", "2)", "-", "*", "•") followed by whitespace, so "1. 123-45: yes"
// reads as "123-45: yes". Limited to two digits so a string like "12345: no" is never eaten.
const stripMarker = (line) => line.replace(/^\s*(?:[-*•]|\(?\d{1,2}[.)])\s+/, "").trim();
const verdictIn = (s) => s.match(YES_NO)?.[1] ?? null;

export const task = {
  name: "regex",
  category: "tool-reasoning",
  description:
    "Report which strings match a target regex. Uses a correct regex tool plus a decoy tool; the " +
    "model must select the right tool and pass typed args.",
  model: labelModel,

  // ---- no-harness mode ----
  noHarness: {
    prompt:
      `Which of these strings match the regular expression ${TARGET}? Strings: ${STRINGS.join(", ")}. ` +
      "Reply with one line per string, in order, in the form `<string>: yes` if it matches or " +
      "`<string>: no` if it does not.",
    extract: "text",
  },

  // ---- with-harness mode ----
  harness: {
    system:
      "You are a precise tool-using analyst. Use the provided tools, reasoning about which tool and " +
      "what arguments each call needs, and return exactly the requested structured data.",
    prompt:
      `For each string in ${STRINGS.join(", ")} decide whether it matches ${TARGET}. ` +
      "Call the regex_match tool once per string with the pattern and the string. Do NOT use the " +
      "word_count tool. Return a JSON array with one object per string, in order, each with the " +
      "string and whether it matched.",
    tools,
    schema,
    extract: "structured",
  },

  // ---- schema only: decide by hand, but return the schema shape ----
  schemaOnly: {
    system: "You are a precise analyst. Return exactly the requested structured data.",
    prompt:
      `Which of these strings match the regular expression ${TARGET}? Strings: ${STRINGS.join(", ")}. ` +
      "Decide by hand — no tools are available. Return a JSON array with one object per string, in " +
      "order, each with the string and whether it matched.",
    tools: [],
    schema,
    extract: "structured",
  },

  // ---- tools only: both tools, but a free-form answer and no schema ----
  toolOnly: {
    system:
      "You are a precise tool-using analyst. Use the provided tools, reasoning about which tool and " +
      "what arguments each call needs.",
    prompt:
      `For each string in ${STRINGS.join(", ")} decide whether it matches ${TARGET}. ` +
      "Call the regex_match tool once per string with the pattern and the string. Do NOT use the " +
      "word_count tool. Then reply with one line per string, in order, in the form \`<string>: yes\` " +
      "if it matched or \`<string>: no\` if it did not.",
    tools,
    extract: "text",
  },

  // ---- evaluation ----
  eval: {
    // Ground: which strings actually match the target regex — the same truth the harness
    // `regex_match` tool computes.
    ground: () => STRINGS.map((s) => ({ string: s, matched: new RegExp(TARGET).test(s) })),

    // Harness: every ground {string, matched} must appear in the structured answer. A model that
    // never called regex_match (or called word_count) can still get it right by hand — the tool
    // signal (which tool, what args) is surfaced separately via toolCalls/toolResults.
    scoreHarness: (out, ground) => {
      if (!out) return { correct: false, reason: "no structured output" };
      const got = resultsFrom(out);
      if (!got.length) return { correct: false, reason: "structured output contained no results" };
      const reported = {};
      for (const g of got) reported[String(g?.string ?? "").trim()] = g?.matched === true;
      let correct = 0;
      for (const g of ground) {
        if (reported[String(g.string).trim()] === g.matched) correct++;
      }
      return {
        correct: correct === ground.length,
        reason: `${correct}/${ground.length} matches correct`,
      };
    },

    // No-harness: a yes/no per string. Preferred form is a labelled line ("123-45: yes", any
    // order, list markers tolerated). If no line names a string, fall back to reading bare yes/no
    // lines positionally — one per string in order — which is the literal reading of the prompt.
    scoreNoHarness: (out, ground) => {
      const lines = String(out ?? "").toLowerCase().split(/\r?\n/).map(stripMarker).filter(Boolean);
      const labelled = ground.map((g) => {
        const key = String(g.string).toLowerCase();
        // The character after the string must not extend it, so the line for "123-456" is never
        // read as the line for "123-45".
        const line = lines.find((l) => l.startsWith(key) && !/[\w-]/.test(l.charAt(key.length)));
        return line ? verdictIn(line.slice(key.length)) : null;
      });
      let verdicts = labelled;
      let how = "";
      if (!labelled.some((v) => v !== null)) {
        const bare = lines.map(verdictIn).filter(Boolean);
        verdicts = ground.map((_, i) => bare[i] ?? null);
        how = " (read positionally)";
      }
      let correct = 0;
      ground.forEach((g, i) => { if (verdicts[i] === (g.matched ? "yes" : "no")) correct++; });
      return {
        correct: correct === ground.length,
        reason: `${correct}/${ground.length} matches correct${how}`,
      };
    },
  },
};

export { tools, TARGET, STRINGS };
