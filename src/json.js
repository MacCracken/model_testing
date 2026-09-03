// Tolerant JSON extraction.
//
// Harness mode scores the model's *final message* as JSON. Models — especially small local
// ones — routinely wrap that JSON in prose or a ```json fence. Being strict here would score
// formatting rather than capability, so we peel the common wrappers before giving up.

export function parseJSONLoose(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === "object") return text;

  let s = String(text).trim();
  if (!s) return null;

  // ```json … ``` fence
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const direct = tryParse(s);
  if (direct !== undefined) return direct;

  const slice = firstJSONSlice(s);
  if (slice !== null) {
    const parsed = tryParse(slice);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// Scan for the first balanced {...} or [...] block, respecting string state across the whole
// string. A naive scan that only hunts for the first "{" can land inside a quoted string (e.g.
// the model writes `sure — try {"a":1}` first, then the real answer later) and slice the wrong
// block. So we find the first candidate brace anywhere, but bracket-tracking must account for
// quotes from position 0 onward.
function firstJSONSlice(s) {
  let start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") { start = i; break; }
  }
  if (start === -1) return null;

  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
