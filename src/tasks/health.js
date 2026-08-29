// Task: report the webserver's health.
//
//   - noHarness: model answers a free-text prompt, no tools. We look for status keywords.
//   - harness:   model is given a `health` tool + an output schema and must call it, then
//                report { status, uptimeSec } as JSON.
//
// The tool implementation hits the real webserver /health endpoint.

import { labelModel } from "../providers/index.js";

const PORT = process.env.PORT ?? 3000;
const BASE = `http://localhost:${PORT}`;

// Slack between the model's tool call and our own ground-truth fetch. Wide enough that a
// truthful report always passes, tight enough that a guessed number never does.
const UPTIME_TOLERANCE_SEC = 120;

const tool = {
  name: "health",
  description: "Check the webserver's health. Returns its status, uptime in seconds, and timestamp.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  impl: async () => {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`health endpoint: ${res.status}`);
    return res.json();
  },
};

const schema = {
  type: "object",
  properties: {
    status: { type: "string", description: 'The service status, e.g. "ok".' },
    uptimeSec: { type: "number", description: "Uptime in seconds, as reported by the server." },
  },
  required: ["status", "uptimeSec"],
};

export const task = {
  name: "health",
  category: "api-call",
  description: "Report the live status and uptime of the webserver.",
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
    schema,
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

    // Harness: the reported status must match ground, and the uptime must be the *real* one —
    // a positive-number check would pass on a hallucinated value even though the tool ran.
    scoreHarness: (out, ground) => {
      if (!out || typeof out !== "object" || Array.isArray(out)) {
        return { correct: false, reason: "no structured output" };
      }
      const status = String(out.status ?? "").trim().toLowerCase();
      const expected = String(ground.status ?? "").trim().toLowerCase();
      if (status !== expected) {
        return { correct: false, reason: `status "${out.status ?? "(missing)"}" does not match ground "${ground.status}"` };
      }
      const uptime = Number(out.uptimeSec);
      if (!Number.isFinite(uptime)) {
        return { correct: false, reason: `uptimeSec "${out.uptimeSec ?? "(missing)"}" is not a number` };
      }
      const drift = Math.abs(uptime - Number(ground.uptimeSec));
      if (drift > UPTIME_TOLERANCE_SEC) {
        return { correct: false, reason: `uptimeSec ${uptime} is ${Math.round(drift)}s off ground ${ground.uptimeSec}` };
      }
      return { correct: true, reason: `status "${status}" and uptime ${uptime}s match ground` };
    },

    // No-harness: look for "ok" / "down" in free text. Note this is a weaker bar than the
    // harness scorer (status only, no uptime) — without tools the model cannot know uptime.
    scoreNoHarness: (out, ground) => {
      const text = String(out ?? "").toLowerCase();
      const healthy = String(ground.status ?? "").toLowerCase() === "ok";
      if (/down|unreachable|not running|5[0-9][0-9]/.test(text)) {
        return { correct: !healthy, reason: healthy ? "reported DOWN, ground is ok" : "reported DOWN, matches ground" };
      }
      if (/\bok\b|\bup\b|healthy|running|200|available|good/.test(text)) {
        return { correct: healthy, reason: healthy ? "reported OK, matches ground" : "reported OK, ground is not ok" };
      }
      return { correct: false, reason: "no status indicated" };
    },
  },
};

export { BASE, tool, schema };
