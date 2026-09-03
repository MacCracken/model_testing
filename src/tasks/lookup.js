// Task: a tool-essential lookup.
//
//   - noHarness: the model must write the server ids from memory. The endpoint assigns a
//     brand-new random UUID to each name on every call, so there is nothing to memorize — a
//     free-form model has no way to produce the real ids and will hallucinate or refuse.
//   - harness:   the model is given a `lookup` tool that returns the real id for a name, plus an
//     output schema. It must call the tool and report the ids it received.
//
// This is a calibration task: it isolates "the tool is required" from "the schema is required"
// (see registry). A model that answers from memory without tools should score near zero; a model
// that calls the tool should score near 100%.

import { labelModel } from "../providers/index.js";

const PORT = process.env.PORT ?? 3000;
const BASE = `http://localhost:${PORT}`;
const NAMES = ["alice", "bob", "carol"];

// Fetch the id the endpoint assigns to a name. The endpoint returns a fresh random UUID every
// call, so this must run at eval time — the model never sees it in its prompt.
async function lookup(name) {
  const res = await fetch(`${BASE}/api/hello?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`lookup endpoint: ${res.status}`);
  const data = await res.json();
  return { name, id: data.id };
}

const tool = {
  name: "lookup",
  description:
    "Look up the server-assigned id for a name. The endpoint assigns a new random id to each " +
    "name on every call, so call it once per name and report the id it returns.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name whose id you want. A single name, or several separated by commas.",
      },
    },
    required: ["name"],
  },
  impl: async (args) => {
    const raw = args?.name ?? "";
    const names = (Array.isArray(raw) ? raw : String(raw).split(","))
      .map((n) => String(n).trim())
      .filter(Boolean);
    if (!names.length) throw new Error("lookup tool: no name given");
    return { results: await Promise.all(names.map(lookup)) };
  },
};

const schema = {
  type: "array",
  minItems: NAMES.length,
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      id: { type: "string", description: "The id the server returned for this name." },
    },
    required: ["name", "id"],
  },
};

// Pull the reported ids, tolerating a bare array or an object wrapper.
function idsFrom(out) {
  if (Array.isArray(out)) return out;
  if (out && typeof out === "object") {
    for (const key of ["results", "ids", "data", "entries"]) {
      if (Array.isArray(out[key])) return out[key];
    }
    if (out.id) return [out];
  }
  return [];
}

export const task = {
  name: "lookup",
  category: "api-call",
  description:
    "Fetch the live server id for three names. The ids are random and only the tool can produce them.",
  model: labelModel,

  // ---- no-harness mode ----
  noHarness: {
    prompt:
      "The webserver exposes GET /api/hello?name=<name>, which returns an object with a `message` " +
      "and a freshly generated random `id`. WITHOUT any tools, and with no way to reach the server, " +
      `write the ids the endpoint would return for these names: ${NAMES.join(", ")} — one per name. ` +
      "You will not be able to know the real ids; report them anyway as best you can.",
    extract: "text",
  },

  // ---- with-harness mode ----
  harness: {
    system:
      "You are a precise API client. Use the provided tools and return exactly the requested structured data.",
    prompt:
      `Call the lookup tool for these names: ${NAMES.join(", ")}. ` +
      "Return a JSON array with one object per name, each carrying the id the tool returned verbatim.",
    tools: [tool],
    schema,
    extract: "structured",
  },

  // ---- evaluation ----
  eval: {
    // Truth: the ids the real endpoint actually assigns to these names.
    ground: async () => Promise.all(NAMES.map(lookup)),

    // Harness: every ground id must appear in the structured answer. Because the ids are random,
    // a model that never called the tool cannot match them; only a model that fetched them does.
    scoreHarness: (out, ground) => {
      if (out === null || out === undefined) return { correct: false, reason: "no structured output" };
      const got = idsFrom(out).map((g) => String(g?.id ?? "").trim().toLowerCase()).filter(Boolean);
      if (!got.length) return { correct: false, reason: "structured output contained no ids" };
      const missing = ground.filter((g) => !got.includes(String(g.id).trim().toLowerCase()));
      if (missing.length) {
        return {
          correct: false,
          reason: `${ground.length - missing.length}/${ground.length} ids match; missing ${missing.map((m) => m.name).join(", ")}`,
        };
      }
      return { correct: true, reason: `all ${ground.length} ids match the endpoint` };
    },

    // No-harness: the same ids, looked for in free text. There is nothing to memorize, so a
    // model that did not hit the endpoint scores near zero here — that is the point.
    scoreNoHarness: (out, ground) => {
      const text = String(out ?? "").replace(/["*`]/g, "").toLowerCase();
      const present = ground.filter((g) => text.includes(String(g.id).trim().toLowerCase()));
      return {
        correct: present.length === ground.length,
        reason: `${present.length}/${ground.length} ids present`,
      };
    },
  },
};

export { BASE, tool, schema, NAMES };
