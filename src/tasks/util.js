// Helpers shared by the task specs.

import "../env.js";

// The system under test. `SUT_PORT` is the documented setting; `PORT` is accepted as a legacy
// fallback, but note that dev tooling often injects PORT for *this* process, which is not the
// webserver — prefer SUT_PORT.
export const PORT = process.env.SUT_PORT ?? process.env.PORT ?? 3000;
export const BASE = `http://localhost:${PORT}`;

// Pull the list out of a structured answer. Models rarely disobey a schema outright, but they do
// wrap the array — under a key of their choosing, or under the schema's own `items` key, echoing
// the shape they were shown. Scoring is about the content, not the wrapper, so accept a bare
// array, an array under any of `keys` (or `items`), or a single object that is itself one entry.
export function unwrapList(out, keys = [], isEntry = () => false) {
  if (Array.isArray(out)) return out;
  if (out && typeof out === "object") {
    for (const key of [...keys, "items"]) {
      if (Array.isArray(out[key])) return out[key];
    }
    if (isEntry(out)) return [out];
  }
  return [];
}

// Judge a tool that takes one name (or several, comma-separated) per call: every expected name must
// have been passed to `toolName`, and nothing else. Other tools are ignored here — a decoy check
// belongs to the task that defines the decoy.
export function judgeNameCalls(toolCalls, toolName, expected) {
  const calls = toolCalls.filter((c) => c.name === toolName);
  if (!calls.length) return { ok: false, reason: `the ${toolName} tool was never called` };
  const passed = new Set();
  for (const c of calls) {
    const raw = c.arguments?.name ?? "";
    for (const n of Array.isArray(raw) ? raw : String(raw).split(",")) {
      const t = String(n).trim().toLowerCase();
      if (t) passed.add(t);
    }
  }
  const missing = expected.filter((n) => !passed.has(n));
  const extra = [...passed].filter((n) => !expected.includes(n));
  if (!missing.length && !extra.length) return { ok: true, reason: `${toolName} called for ${expected.join(", ")}` };
  return {
    ok: false,
    reason: [
      missing.length ? `never passed ${missing.join(", ")}` : "",
      extra.length ? `passed unexpected name(s) ${extra.join(", ")}` : "",
    ].filter(Boolean).join("; "),
  };
}
