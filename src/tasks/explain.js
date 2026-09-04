// Task: explain the webserver's health to a non-engineer — open-ended, graded by a judge model.
//
// The facts come from /health (status, uptime) exactly as in the `health` task; what is graded is
// whether the explanation gets those facts right and reads as plain language. The judge is handed
// the ground truth, so it grades agreement with facts, not its own guess. Runs need a judge
// (`--judge provider:model` or BENCH_JUDGE); without one every trial is an error row that says so.

import { labelModel } from "../providers/index.js";
import { BASE } from "./util.js";
import { tool } from "./health.js";

const THRESHOLD = 0.75;

const schema = {
  type: "object",
  properties: {
    explanation: { type: "string", description: "Two or three plain sentences for a non-engineer." },
  },
  required: ["explanation"],
};

function humanUptime(sec) {
  const s = Number(sec) || 0;
  if (s >= 2 * 86400) return `about ${(s / 86400).toFixed(1)} days`;
  if (s >= 3600) return `about ${(s / 3600).toFixed(1)} hours`;
  return `about ${Math.round(s / 60)} minutes`;
}

const RUBRIC = [
  "1. States correctly whether the service is healthy (a ground status of \"ok\" means healthy; anything else means not healthy).",
  "2. Gives how long it has been running in human units (minutes, hours or days) consistent with the ground uptime to within about 10%. Reporting raw seconds is not acceptable.",
  "3. Reads as plain language for a non-engineer: no field names, no JSON, no jargon.",
  "Score 1.0 if all three hold, 0.5 if 1 and 2 hold but the language is technical, 0.25 if only the health verdict is right, 0 otherwise.",
].join("\n");

async function grade(text, ground, judge) {
  if (typeof judge !== "function") throw new Error("the explain task needs a judge: pass --judge provider:model (or set BENCH_JUDGE)");
  const answer = String(text ?? "").trim();
  if (!answer) return { correct: false, reason: "empty explanation" };
  const facts = { status: ground.status, uptimeSec: ground.uptimeSec, uptimeInHumanUnits: humanUptime(ground.uptimeSec) };
  const v = await judge({ rubric: RUBRIC, answer, ground: facts, task: "Explain to a non-engineer whether a webserver is healthy and how long it has been running." });
  return { correct: v.score >= THRESHOLD, reason: `judge ${v.score.toFixed(2)}: ${v.reason}`, judge: v };
}

export const task = {
  name: "explain",
  category: "open-ended",
  description: "Explain the webserver's health and running time to a non-engineer; graded by a judge model against the live facts.",
  model: labelModel,

  goal:
    `A webserver runs at ${BASE}. GET /health returns its status, uptimeSec and timestamp. Check it, ` +
    "then explain in two or three plain sentences, for a non-engineer, whether the service is healthy " +
    "and roughly how long it has been running (in minutes, hours or days — not seconds).",

  noHarness: {
    prompt:
      "The webserver exposes GET /health which returns its status, uptime in seconds, and timestamp. " +
      "Without any tools, write two or three plain sentences for a non-engineer explaining whether the " +
      "webserver is healthy right now and roughly how long it has been running (in minutes, hours or " +
      "days — not seconds). Do your best without being able to check.",
    extract: "text",
  },

  harness: {
    system: "You are a precise, plain-spoken assistant. Use the provided tools and return exactly the requested structured data.",
    prompt:
      "Use the health tool, then write two or three plain sentences for a non-engineer explaining whether " +
      "the service is healthy and roughly how long it has been running (in minutes, hours or days — not " +
      "seconds). Return a JSON object with an explanation field.",
    tools: [tool],
    schema,
    extract: "structured",
  },

  schemaOnly: {
    system: "You are a precise, plain-spoken assistant. Return exactly the requested structured data.",
    prompt:
      "The webserver exposes GET /health which returns its status, uptime in seconds, and timestamp. " +
      "Without any tools, write two or three plain sentences for a non-engineer explaining whether the " +
      "webserver is healthy right now and roughly how long it has been running (in minutes, hours or " +
      "days — not seconds). Return a JSON object with an explanation field.",
    tools: [],
    schema,
    extract: "structured",
  },

  toolOnly: {
    system: "You are a precise, plain-spoken assistant. Use the provided tools.",
    prompt:
      "Use the health tool, then reply with two or three plain sentences for a non-engineer explaining " +
      "whether the service is healthy and roughly how long it has been running (in minutes, hours or " +
      "days — not seconds).",
    tools: [tool],
    extract: "text",
  },

  eval: {
    needsJudge: true,
    toolUse: ({ toolCalls }) => (toolCalls.some((c) => c.name === tool.name)
      ? { ok: true, reason: "called the health tool" }
      : { ok: false, reason: "the health tool was never called" }),

    ground: async () => {
      const res = await fetch(`${BASE}/health`);
      if (!res.ok) throw new Error(`ground health: ${res.status}`);
      return res.json();
    },

    scoreHarness: (out, ground, { judge } = {}) => {
      if (out === null || out === undefined) return { correct: false, reason: "no structured output" };
      return grade(typeof out === "string" ? out : out?.explanation, ground, judge);
    },

    scoreNoHarness: (out, ground, { judge } = {}) => grade(out, ground, judge),
  },
};

export { schema, RUBRIC, THRESHOLD, humanUptime };
