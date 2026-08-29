// Task: call GET /api/hello?name=... to get a greeting.
//
// - noHarness: model answers free text, no tools.
// - withHarness: model uses a `hello` tool + schema to fetch a greeting JSON.
// Eval: exact-match / regex on the greeting string, comparing to the real endpoint.

import { labelModel } from "../providers/index.js";

const WEBROOT = process.env.WEBROOT ?? "./webserver";
const PORT = process.env.PORT ?? 3000;
const BASE = `http://localhost:${PORT}`;

const NAMES = ["alice", "bob", "carol"];

// The tool accepts a single name string or an array of names, fetches all greetings at once,
// and returns them as an array. This allows the model to make one request and get results for all names.
const tool = {
  name: "hello",
  description: "Get a greeting for a person's name. Can handle one or multiple names. Returns { messages (array of {name, message}), id }.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name(s) to greet. Can be a single string or comma-separated names.",
       },
     },
    required: ["name"],
   },
  impl: async (args) => {
    const names = Array.isArray(args.name) ? args.name : args.name.split(/[,\s]+/).map((n) => n.trim()).filter(Boolean);
    const body = {};
    for (const n of names) body[`name=${encodeURIComponent(n)}`] = "";
    const res = await fetch(`${BASE}/api/hello?${new URLSearchParams(body)}`, { method: "GET" });
    if (!res.ok) throw new Error(`hello endpoint: ${res.status}`);
    const data = await res.json();
    return { greeting: data.message, id: data.id };
   },
};

export const task = {
  name: "hello",
  category: "api-call",
  model: labelModel,

  // ---- no-harness mode ----
  noHarness: {
    prompt:
      "The webserver exposes GET /api/hello?name=<name> which returns a greeting like " +
      '"Hello, <name>!" plus an id. WITHOUT any tools, write the greeting you would send to ' +
      "Alice, Bob, and Carol — one line each, in the exact same format the endpoint uses " +
      '(i.e. "Hello, <Name>!").',
    extract: "text",
   },

  // ---- with-harness mode ----
  harness: {
    system:
      "You are a precise API client. Use the provided tools and return exactly the requested structured data.",
    prompt: `Call the hello tool for these names: ${NAMES.join(", ")}. Return one greeting object per name as an array.`,
    tools: [tool],
    extract: "structured",
   },

  // ---- evaluation ----
  eval: {
    ground: async () => {
      const res = await fetch(`${BASE}/api/hello?name=${encodeURIComponent(NAMES.join(","))}`);
      if (!res.ok) throw new Error(`ground hello: ${res.status}`);
      const data = await res.json();
      return data.message;
     },
    // Harness: expect an array of { name, message }. Check each greeting matches the endpoint.
    scoreHarness: async (out, ground) => {
      // Handle both array and single object responses from the tool
      let arr = Array.isArray(out) ? out : [out];

       // Accept either format: array with one item containing all names OR single object with combined greeting
      if (!Array.isArray(out) && typeof out === 'object' && out.greeting && String(out.greeting) === ground) {
        return { correct: true, reason: "single greeting matches expected combined greeting" };
       }

      const msgs = arr.map((o) => String(o?.message ?? o?.greeting ?? "")).join("\n");
      const expected = NAMES.map((n) => `Hello, ${n}!`).join("\n");
      if (msgs === expected) return { correct: true, reason: "all greetings match endpoint" };
      return { correct: false, reason: "greetings differ from endpoint output" };
    },

    // No-harness: check free text contains all three correct greetings.
    scoreNoHarness: async (out, ground) => {
      const text = String(out ?? "").replace(/"/g, "").toLowerCase();
      const expected = NAMES.map((n) => `hello, ${n}!`).join("\n");
      if (text.includes(expected)) return { correct: true, reason: "all three greetings present" };
      // Partial credit for any greetings present.
      const present = NAMES.filter((n) => text.includes(`hello, ${n}!`)).length;
      return {
        correct: present === NAMES.length,
        reason: `${present}/${NAMES.length} greetings present`,
     };
    },
  },
};

export { BASE };
export { tool };
