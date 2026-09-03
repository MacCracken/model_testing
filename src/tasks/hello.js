// Task: call GET /api/hello?name=... to get a greeting for each of three people.
//
// - noHarness: model writes the greetings from memory of the documented format, no tools.
// - harness:   model uses the `hello` tool + an output schema to fetch the real greetings.
//
// Eval: compare the greetings the model reports against the ones the real endpoint returns.

import { labelModel } from "../providers/index.js";
import { BASE, unwrapList, judgeNameCalls } from "./util.js";

const NAMES = ["alice", "bob", "carol"];

// One name per call — the endpoint takes a single `name` query param. Passing several names
// at once just greets the literal comma-joined string, which is not what the task asks for.
async function greet(name) {
  const res = await fetch(`${BASE}/api/hello?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`hello endpoint: ${res.status}`);
  const data = await res.json();
  return { name, message: data.message, id: data.id };
}

const tool = {
  name: "hello",
  description:
    "Get greetings from the webserver. Accepts one name or several comma-separated names. " +
    "Returns { greetings: [{ name, message, id }] } — one entry per name.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name(s) to greet. A single name, or several separated by commas.",
      },
    },
    required: ["name"],
  },
  impl: async (args) => {
    const raw = args?.name ?? "";
    const names = (Array.isArray(raw) ? raw : String(raw).split(","))
      .map((n) => String(n).trim())
      .filter(Boolean);
    if (!names.length) throw new Error("hello tool: no name given");
    const greetings = await Promise.all(names.map(greet));
    return { greetings };
  },
};

const schema = {
  type: "array",
  minItems: NAMES.length,
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      message: { type: "string", description: 'The greeting exactly as the server returned it.' },
    },
    required: ["name", "message"],
  },
};

// The model may reasonably answer with a bare array or wrap it in an object. Accept either.
function greetingsFrom(out) {
  return unwrapList(out, ["greetings", "messages", "results", "data"], (o) => !!(o.message || o.greeting));
}

function messageOf(entry) {
  if (typeof entry === "string") return entry;
  return String(entry?.message ?? entry?.greeting ?? "");
}

export const task = {
  name: "hello",
  category: "api-call",
  description: "Fetch the real greeting for three names and report them verbatim.",
  model: labelModel,

  goal:
    `A webserver runs at ${BASE}. GET /api/hello?name=<name> returns JSON { message, id }. Fetch the ` +
    `greeting for each of these names: ${NAMES.join(", ")}, and report each name with the message ` +
    "the server returned, verbatim.",

  // ---- no-harness mode ----
  noHarness: {
    prompt:
      "The webserver exposes GET /api/hello?name=<name> which returns a greeting like " +
      '"Hello, <name>!" plus an id. WITHOUT any tools, write the greeting the endpoint would ' +
      `return for each of these names: ${NAMES.join(", ")} — one line each, in the exact ` +
      "format the endpoint uses.",
    extract: "text",
  },

  // ---- with-harness mode ----
  harness: {
    system:
      "You are a precise API client. Use the provided tools and return exactly the requested structured data.",
    prompt:
      `Call the hello tool for these names: ${NAMES.join(", ")}. ` +
      "Return a JSON array with one object per name, each carrying the greeting the tool returned verbatim.",
    tools: [tool],
    schema,
    extract: "structured",
  },

  // ---- schema only: no tools, but the output schema ----
  schemaOnly: {
    system: "You are a precise API client. Return exactly the requested structured data.",
    prompt:
      "The webserver exposes GET /api/hello?name=<name> which returns a greeting like " +
      '"Hello, <name>!" plus an id. WITHOUT any tools, write the greeting the endpoint would ' +
      `return for each of these names: ${NAMES.join(", ")}. Return a JSON array with one object ` +
      "per name, each carrying the name and the greeting in the exact format the endpoint uses.",
    tools: [],
    schema,
    extract: "structured",
  },

  // ---- tools only: the hello tool, but a free-form answer and no schema ----
  toolOnly: {
    system: "You are a precise API client. Use the provided tools.",
    prompt:
      `Call the hello tool for these names: ${NAMES.join(", ")}. ` +
      "Then write the greeting the tool returned for each name — one line each, verbatim.",
    tools: [tool],
    extract: "text",
  },

  // ---- evaluation ----
  eval: {
    // Tool use: every name passed to the hello tool, and no others.
    toolUse: ({ toolCalls }) => judgeNameCalls(toolCalls, tool.name, NAMES),

    // Truth: the greetings the real endpoint actually produces, one per name.
    ground: async () => Promise.all(NAMES.map(greet)),

    // Harness: every ground greeting must appear in the structured answer.
    scoreHarness: (out, ground) => {
      if (out === null || out === undefined) return { correct: false, reason: "no structured output" };
      const got = greetingsFrom(out).map((g) => messageOf(g).trim().toLowerCase()).filter(Boolean);
      if (!got.length) return { correct: false, reason: "structured output contained no greetings" };
      const missing = ground.filter((g) => !got.includes(g.message.trim().toLowerCase()));
      if (missing.length) {
        return {
          correct: false,
          reason: `${ground.length - missing.length}/${ground.length} greetings match; missing ${missing.map((m) => m.name).join(", ")}`,
        };
      }
      return { correct: true, reason: `all ${ground.length} greetings match the endpoint` };
    },

    // No-harness: the same greetings, looked for in free text.
    scoreNoHarness: (out, ground) => {
      const text = String(out ?? "").replace(/["*`]/g, "").toLowerCase();
      const present = ground.filter((g) => text.includes(g.message.trim().toLowerCase()));
      return {
        correct: present.length === ground.length,
        reason: `${present.length}/${ground.length} greetings present`,
      };
    },
  },
};

export { BASE, tool, schema, NAMES };
