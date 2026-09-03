// Task: a two-step chain where the second call depends on the first.
//
//   Step 1: greet alice — the response carries a freshly generated random id.
//   Step 2: greet that id — the greeting from this second call is the answer.
//
// Tool-essential like `lookup` (the id is random) and genuinely multi-step: a model that fires both
// calls up front, or never feeds the first result into the second, cannot produce the answer. Ground
// truth is read out of the trial's own tool results, exactly as in `lookup`.

import { labelModel } from "../providers/index.js";
import { BASE } from "./util.js";
import { tool } from "./hello.js";

const FIRST = "alice";

const schema = {
  type: "object",
  properties: {
    firstId: { type: "string", description: "The id returned when greeting alice." },
    greeting: { type: "string", description: "The greeting the second call returned, verbatim." },
  },
  required: ["greeting"],
};

// Walk the trial's hello results in order: the id alice received, then the message a later call
// returned when that id was passed back as the name.
function chainFrom(toolResults) {
  const greetings = [];
  for (const r of toolResults) {
    if (r.name !== tool.name || r.ok === false) continue;
    let parsed;
    try { parsed = JSON.parse(r.content); } catch { continue; }
    for (const g of parsed?.greetings ?? []) {
      greetings.push({ name: String(g?.name ?? ""), message: String(g?.message ?? ""), id: String(g?.id ?? "") });
    }
  }
  const first = greetings.find((g) => g.name.toLowerCase() === FIRST && g.id);
  if (!first) return { firstId: null, expected: null };
  const second = greetings.find((g) => g.name === first.id);
  return { firstId: first.id, expected: second ? second.message : null };
}

function chainVerdict(ground) {
  if (!ground?.firstId) return "alice was never greeted, so there was no id to chain";
  if (!ground.expected) return `the id ${ground.firstId} was never greeted — the second call did not use the first result`;
  return null;
}

export const task = {
  name: "chain",
  category: "multi-step",
  description:
    "Greet alice, then greet the id that came back, and report the second greeting. The second call depends on the first.",
  model: labelModel,

  goal:
    `A webserver runs at ${BASE}. GET /api/hello?name=<name> returns JSON { message, id }, where id is ` +
    `freshly generated on every call. Fetch it for the name ${FIRST}, take the id from that response, ` +
    "fetch it again with that id as the name, and report the first id and the greeting the second " +
    "response returned, verbatim.",

  // ---- no-harness mode ----
  noHarness: {
    prompt:
      "The webserver exposes GET /api/hello?name=<name>, which returns { message: \"Hello, <name>!\", " +
      `id: <freshly generated random id> }. WITHOUT any tools: greet ${FIRST}, take the id from that ` +
      "response, greet that id, and report the greeting from the second call verbatim. You cannot " +
      "reach the server; report your best attempt anyway.",
    extract: "text",
  },

  // ---- with-harness mode ----
  harness: {
    system:
      "You are a precise API client. Use the provided tools and return exactly the requested structured data.",
    prompt:
      `Use the hello tool to greet ${FIRST}. The response includes an id. Then call the hello tool ` +
      "again with that id as the name. Return a JSON object with the first id and the greeting the " +
      "second call returned, verbatim.",
    tools: [tool],
    schema,
    extract: "structured",
  },

  // ---- schema only ----
  schemaOnly: {
    system: "You are a precise API client. Return exactly the requested structured data.",
    prompt:
      "The webserver exposes GET /api/hello?name=<name>, which returns { message: \"Hello, <name>!\", " +
      `id: <freshly generated random id> }. WITHOUT any tools: greet ${FIRST}, take the id from that ` +
      "response, greet that id, and return a JSON object with the first id and the second greeting. " +
      "You cannot reach the server; report your best attempt anyway.",
    tools: [],
    schema,
    extract: "structured",
  },

  // ---- tools only ----
  toolOnly: {
    system: "You are a precise API client. Use the provided tools.",
    prompt:
      `Use the hello tool to greet ${FIRST}. The response includes an id. Then call the hello tool ` +
      "again with that id as the name. Then reply with the greeting the second call returned, " +
      "verbatim, on its own line.",
    tools: [tool],
    extract: "text",
  },

  // ---- evaluation ----
  eval: {
    // Tool use: alice greeted, then the id she received greeted.
    toolUse: ({ toolResults }) => {
      const why = chainVerdict(chainFrom(toolResults));
      return why ? { ok: false, reason: why } : { ok: true, reason: `greeted ${FIRST}, then the id it returned` };
    },

    // Truth: what the second call really returned — only knowable from this trial's tool results.
    ground: ({ toolResults = [] } = {}) => chainFrom(toolResults),

    scoreHarness: (out, ground) => {
      if (out === null || out === undefined) return { correct: false, reason: "no structured output" };
      const why = chainVerdict(ground);
      if (why) return { correct: false, reason: why };
      const got = String(out?.greeting ?? out?.message ?? "").trim();
      if (!got) return { correct: false, reason: "structured output contained no greeting" };
      if (got.toLowerCase() !== ground.expected.trim().toLowerCase()) {
        return { correct: false, reason: `reported "${got}" but the second call returned "${ground.expected}"` };
      }
      return { correct: true, reason: "the second greeting matches what the tool returned" };
    },

    scoreNoHarness: (out, ground) => {
      const why = chainVerdict(ground);
      if (why) return { correct: false, reason: why };
      const text = String(out ?? "").replace(/["*`]/g, "").toLowerCase();
      return text.includes(ground.expected.trim().toLowerCase())
        ? { correct: true, reason: "the second greeting appears verbatim" }
        : { correct: false, reason: `the second call's greeting "${ground.expected}" is not in the answer` };
    },
  },
};

export { schema, FIRST };
