// Task: report the webserver's health.
//
//   - noHarness: model answers a free-text prompt, no tools. We look for status keywords.
//   - withHarness: model is given a `health` tool + a structured schema and must call it,
//     returning { status, uptimeSec }.
//
// The tool implementation hits the real webserver /health endpoint.

import { labelModel } from "../providers/index.js";

const WEBROOT = process.env.WEBROOT ?? "./webserver";
const PORT = process.env.PORT ?? 3000;
const BASE = `http://localhost:${PORT}`;

const tool = {
  name: "health",
  description: "Check the webserver's health. Returns its status, uptime, and timestamp.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  impl: async (args) => {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`health endpoint: ${res.status}`);
    return res.json();
  },
};

export const task = {
  name: "health",
  category: "api-call",
  model: labelModel,

  // ---- no-harness mode ----
  noHarness: {
    prompt:
      "The webserver exposes GET /health which returns its status, uptime, and timestamp. " +
      "Without any tools, determine the current health of the webserver by its known endpoints " +
      "and answer the question: is the webserver up and healthy right now? " +
      "Reply with a short natural-language statement (include the word OK or DOWN and the status).",
    // Free text. We judge by whether the answer conveys the correct status.
    extract: "text",
  },

  // ---- with-harness mode ----
  harness: {
    system:
      "You are a precise API client. Use the provided tools and return exactly the requested structured data. " +
      "Do not add prose outside the schema fields.",
    prompt: "Report the current health of the webserver using the health tool.",
    tools: [tool],
    extract: "structured",
  },

  // ---- evaluation ----
  eval: {
    // Truth: call the real endpoint ourselves.
    ground: async () => {
      const res = await fetch(`${BASE}/health`);
      if (!res.ok) throw new Error(`ground health: ${res.status}`);
      return res.json();
    },
    // Correctness for the harness mode: schema-valid + status field matches ground.
    scoreHarness: (out, ground) => {
      if (!out || typeof out !== "object") return { correct: false, reason: "no structured output" };
      const status = String(out.status ?? "").trim().toLowerCase();
      const uptime = out.uptimeSec === undefined ? false : Number(out.uptimeSec) > 0;
      if (status !== "ok" || !uptime) {
        return { correct: false, reason: `status "${out.status}" does not match ground "${ground.status}"` };
      }
      return { correct: true, reason: `status "${status}" matches ground` };
    },
    // Correctness for the no-harness mode: look for "ok" / "down" in free text.
    scoreNoHarness: (out, ground) => {
      const text = String(out ?? "").toLowerCase();
      if (/down|unreachable|error|not running|5[0-9][0-9]/.test(text)) {
        return { correct: false, reason: "reported DOWN" };
      }
      if (/ok|up|healthy|running|200|available|good/.test(text)) {
        return { correct: true, reason: "reported OK" };
      }
      return { correct: false, reason: "no status indicated" };
    },
  },
};

export { BASE };
export { tool };
