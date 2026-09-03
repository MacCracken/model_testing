// Task: a tool-essential lookup.
//
//   - noHarness: the model is asked for server-assigned ids it has no way to know. The endpoint
//     mints a brand-new random UUID on every call, so there is nothing to memorize — a free-form
//     model can only refuse or hallucinate, and scores 0. That floor is the calibration.
//   - harness:   the model is given a `lookup` tool that returns the real id for a name, plus an
//     output schema. It must call the tool and report the ids it received, verbatim.
//
// Ground truth is the ids the server handed to THIS trial's tool calls, read back out of the tool
// results. Fetching "the" ids afterwards would compare the model's (correct) report against a
// different random number — no answer could ever score. With no tool calls there is no truth to
// match, which is exactly what makes the task tool-essential.

import { labelModel } from "../providers/index.js";
import { BASE, unwrapList, judgeNameCalls } from "./util.js";

const NAMES = ["alice", "bob", "carol"];

// Fetch the id the endpoint assigns to a name. A fresh random UUID every call.
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
  return unwrapList(out, ["results", "ids", "data", "entries"], (o) => o.id !== undefined);
}

// Which names actually received an id during the trial.
function fetched(ground) {
  return ground.filter((g) => g.ids.length);
}

export const task = {
  name: "lookup",
  category: "api-call",
  description:
    "Fetch the live server id for three names. The ids are random and only the tool can produce them.",
  model: labelModel,

  goal:
    `A webserver runs at ${BASE}. GET /api/hello?name=<name> returns JSON { message, id }, where id is ` +
    `freshly generated on every call. Fetch it once for each of these names: ${NAMES.join(", ")}, and ` +
    "report each name with the id the server returned, verbatim.",

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

  // ---- schema only: no tools, but the output schema — still nothing real to report ----
  schemaOnly: {
    system: "You are a precise API client. Return exactly the requested structured data.",
    prompt:
      "The webserver exposes GET /api/hello?name=<name>, which returns an object with a \`message\` " +
      "and a freshly generated random \`id\`. WITHOUT any tools, and with no way to reach the server, " +
      `write the ids the endpoint would return for these names: ${NAMES.join(", ")}. You will not ` +
      "be able to know the real ids; report them anyway as best you can, as a JSON array with one " +
      "object per name carrying the name and the id.",
    tools: [],
    schema,
    extract: "structured",
  },

  // ---- tools only: the lookup tool, but a free-form answer and no schema ----
  toolOnly: {
    system: "You are a precise API client. Use the provided tools.",
    prompt:
      `Call the lookup tool for these names: ${NAMES.join(", ")}. ` +
      "Then report the id the tool returned for each name — one line each, verbatim.",
    tools: [tool],
    extract: "text",
  },

  // ---- evaluation ----
  eval: {
    // Tool use: every name passed to the lookup tool, and no others.
    toolUse: ({ toolCalls }) => judgeNameCalls(toolCalls, tool.name, NAMES),

    // Truth: every id the tool returned for each name during this trial. A name the model looked
    // up twice has two valid ids; a name it never looked up has none.
    ground: ({ toolResults = [] } = {}) => {
      const byName = new Map(NAMES.map((n) => [n, []]));
      for (const r of toolResults) {
        if (r.name !== tool.name || r.ok === false) continue;
        let parsed;
        try { parsed = JSON.parse(r.content); } catch { continue; }
        for (const entry of parsed?.results ?? []) {
          const name = String(entry?.name ?? "").trim().toLowerCase();
          if (byName.has(name) && entry?.id) byName.get(name).push(String(entry.id).trim().toLowerCase());
        }
      }
      return NAMES.map((name) => ({ name, ids: byName.get(name) }));
    },

    // Harness: for every name, one of the ids the tool actually returned must appear in the
    // structured answer. A model that never called the tool has nothing real to report.
    scoreHarness: (out, ground) => {
      if (out === null || out === undefined) return { correct: false, reason: "no structured output" };
      if (!fetched(ground).length) {
        return { correct: false, reason: "the lookup tool was never called, so there are no real ids to report" };
      }
      const got = idsFrom(out).map((g) => String(g?.id ?? "").trim().toLowerCase()).filter(Boolean);
      if (!got.length) return { correct: false, reason: "structured output contained no ids" };
      const missing = ground.filter((g) => !g.ids.some((id) => got.includes(id)));
      if (missing.length) {
        const unfetched = missing.filter((g) => !g.ids.length).map((g) => g.name);
        const wrong = missing.filter((g) => g.ids.length).map((g) => g.name);
        const why = [
          unfetched.length ? `never looked up ${unfetched.join(", ")}` : "",
          wrong.length ? `reported an id the tool did not return for ${wrong.join(", ")}` : "",
        ].filter(Boolean).join("; ");
        return { correct: false, reason: `${ground.length - missing.length}/${ground.length} ids match; ${why}` };
      }
      return { correct: true, reason: `all ${ground.length} ids match what the tool returned` };
    },

    // Free-form: the same ids, looked for in the text. Without a tool call (noHarness) the real
    // ids were never fetched, so nothing can match — that floor is the point of the task. In
    // toolOnly mode the tool ran, so the text is checked against what it returned.
    scoreNoHarness: (out, ground) => {
      if (!fetched(ground).length) {
        return { correct: false, reason: "no tool was called, so the real ids were never fetched — nothing in free text can match" };
      }
      const text = String(out ?? "").replace(/["*`]/g, "").toLowerCase();
      const present = ground.filter((g) => g.ids.some((id) => text.includes(id)));
      return {
        correct: present.length === ground.length,
        reason: `${present.length}/${ground.length} ids present`,
      };
    },
  },
};

export { BASE, tool, schema, NAMES };
