// Task: which strings match a target regex?
//
//   - noHarness: the model determines matches by hand from free text. Regex matching is doable
//     but error-prone, so this floors out somewhat.
//   - harness:   the model is given two tools and must *reason* about them:
//       * `regex_match` — the correct tool. It requires typed args: the regex `pattern` and the
//         `string` to test. The model must construct a valid regex and pass it per-string.
//       * `word_count`  — a decoy. It looks plausible but is irrelevant to matching. Firing it
//         wastes a call and is the "wrong tool" trap.
//
// This exercises *tool complexity*, not just firing: it tests whether the model picks the right
// tool and builds the right arguments, not whether it calls a tool at all (see lookup.js, which
// isolated "can't call tools at all").

import { labelModel } from "../providers/index.js";

const STRINGS = ["123-45", "12345", "abc", "123-456", "12-34", "123-45"];
// Three digits, a dash, two digits — anchored so "12345" and "123-456" are near-misses.
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
  if (!out) return [];
  if (Array.isArray(out)) return out;
  if (out && typeof out === "object") {
    for (const key of ["results", "matches", "data", "entries"]) {
      if (Array.isArray(out[key])) return out[key];
    }
    if (Array.isArray(out.matches)) return out.matches;
    if (Array.isArray(out.data)) return out.data;
  }
  return [];
}

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
      "Reply with one line per string, in order, 'yes' if it matches and 'no' if it does not.",
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

  // ---- evaluation ----
  eval: {
    // Ground: which strings actually match the target regex. Computed at eval time so it is the
    // same truth the harness `regex_match` tool uses.
    ground: async () => STRINGS.map((s) => ({ string: s, matched: new RegExp(TARGET).test(s) })),

    // Harness: every ground {string, matched} must appear in the structured answer. Because the
    // regex is the thing under test, a model that never called regex_match (or called word_count)
    // can still get it by hand — the interesting signal here is *how* it calls the tool, which the
    // CLI/UI surface separately (tool-use rate, arg correctness) via toolCalls/toolResults.
    scoreHarness: (out, ground) => {
      if (!out) return { correct: false, reason: "no structured output" };
      const got = resultsFrom(out);
      if (!got.length) return { correct: false, reason: "structured output contained no results" };
      // A map of reported string -> whether it was marked matched, so a string reported twice
      // (with the same value) is scored per occurrence, and a string not reported at all is a miss.
      const reported = {};
      for (const g of got) reported[String(g?.string ?? "").trim()] = g?.matched === true;
      let correct = 0;
      for (const g of ground) {
        const key = String(g.string).trim();
        if (reported[key] === g.matched) correct++;
      }
      return {
        correct: correct === ground.length,
        reason: `${correct}/${ground.length} matches correct`,
      };
    },

    // No-harness: "yes"/"no" per string in free text. Split into lines and match each ground string
    // against the line that starts with it (a duplicate string is scored per occurrence).
    scoreNoHarness: (out, ground) => {
      const text = String(out ?? "").toLowerCase();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let correct = 0;
      for (const g of ground) {
        const key = String(g.string).trim().toLowerCase();
        const expected = g.matched ? "yes" : "no";
        // Find a line beginning with this string; if found, it must carry the expected yes/no.
        const line = lines.find((l) => l.startsWith(key));
        if (line === undefined) {
          correct += 0; // not reported at all is a miss
        } else if (line.split(":")[1]?.trim() === expected) {
          correct += 1;
        } else {
          correct += 0; // reported, but with the wrong value
        }
      }
      return {
        correct: correct === ground.length,
        reason: `${correct}/${ground.length} matches correct`,
      };
    },
  },
};

export { tools, TARGET, STRINGS };
