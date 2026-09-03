// Task: report the webserver's health.
//
//   - noHarness: model answers a free-text prompt, no tools. We look for status keywords.
//   - harness:   model is given a `health` tool + an output schema and must call it, then
//                report { status, uptimeSec } as JSON.
//
// The tool implementation hits the real webserver /health endpoint.

import { labelModel } from "../providers/index.js";
import { BASE } from "./util.js";

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

  // The job as a real harness with its own tools hears it.
  goal:
    `A webserver runs at ${BASE}. GET /health returns JSON with its status, uptimeSec and timestamp. ` +
    "Fetch it and report the current status and uptime in seconds exactly as returned.",

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

  // ---- schema only: no tools, but the output schema — the "ask for JSON" axis alone ----
  schemaOnly: {
    system: "You are a precise API client. Return exactly the requested structured data.",
    prompt:
      "The webserver exposes GET /health which returns its status, uptime, and timestamp. " +
      "Without any tools, determine the current health of the webserver and report its status " +
      "and its uptime in seconds as best you can.",
    tools: [],
    schema,
    extract: "structured",
  },

  // ---- tools only: the health tool, but a free-form answer and no schema ----
  toolOnly: {
    system: "You are a precise API client. Use the provided tools.",
    prompt:
      "Check the current health of the webserver using the health tool, then reply with a short " +
      "natural-language statement (include the word OK or DOWN and the status).",
    tools: [tool],
    extract: "text",
  },

  // ---- evaluation ----
  eval: {
    // Tool use: the health tool must have been called (it takes no arguments).
    toolUse: ({ toolCalls }) => (toolCalls.some((c) => c.name === tool.name)
      ? { ok: true, reason: "called the health tool" }
      : { ok: false, reason: "the health tool was never called" }),

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
    // A reply that mentions both verdicts ("I can't tell whether it is OK or DOWN") has not reported
    // a status at all — it is scored wrong either way, but the reason says "hedged", not "DOWN".
    scoreNoHarness: (out, ground) => {
      const text = String(out ?? "").toLowerCase();
      const healthy = String(ground.status ?? "").toLowerCase() === "ok";
      const saysDown = /\bdown\b|unreachable|not running|\b5\d\d\b/.test(text);
      const saysOk = /\bok\b|\bup\b|healthy|running|\b200\b|available|good/.test(text);
      if (saysDown && saysOk) return { correct: false, reason: "hedged: mentions both OK and DOWN, no status committed" };
      if (saysDown) {
        return { correct: !healthy, reason: healthy ? "reported DOWN, ground is ok" : "reported DOWN, matches ground" };
      }
      if (saysOk) {
        return { correct: healthy, reason: healthy ? "reported OK, matches ground" : "reported OK, ground is not ok" };
      }
      return { correct: false, reason: "no status indicated" };
    },
  },
};

export { BASE, tool, schema };
