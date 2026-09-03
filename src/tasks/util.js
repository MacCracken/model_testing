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
