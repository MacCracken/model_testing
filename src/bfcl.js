// bfcl.js — the Berkeley Function Calling Leaderboard's AST check, reimplemented without
// dependencies for the simple and multiple categories: the model's call (native tool calling, or
// a Python-style call written as text) against the possible answers — the function name, every
// required parameter present, every parameter given with a value the answer list allows. Follows
// bfcl_eval/eval_checker/ast_eval/ast_checker.py in spirit; the deviations are named in
// `checkCall`'s reasons and in docs/results.md. Pure functions, no Node.

// BFCL documents functions with Python-flavoured types; OpenAI-style tool calling wants JSON
// Schema. The mapping the leaderboard's own handlers apply.
const TYPE_MAP = { dict: "object", integer: "integer", float: "number", string: "string", boolean: "boolean", array: "array", tuple: "array", any: "string" };
export function toSchema(param) {
  if (!param || typeof param !== "object") return param;
  const out = { ...param };
  if (typeof param.type === "string") out.type = TYPE_MAP[param.type] ?? param.type;
  if (param.properties) out.properties = Object.fromEntries(Object.entries(param.properties).map(([k, v]) => [k, toSchema(v)]));
  if (param.items) out.items = toSchema(param.items);
  return out;
}
// A tool name must match ^[a-zA-Z0-9_-]+$ for OpenAI; BFCL rewrites "math.factorial" as
// "math_factorial" on the way out and back.
export const toolName = (name) => String(name).replace(/\./g, "_");
export function toolsFrom(functions) {
  return (functions ?? []).map((fn) => ({
    name: toolName(fn.name),
    original: fn.name,
    description: fn.description ?? "",
    parameters: toSchema(fn.parameters ?? { type: "dict", properties: {} }),
    // Nothing to run: the call itself is the answer.
    impl: async () => ({ ok: true, note: "recorded" }),
  }));
}

// BFCL's string comparison: case, spaces and a few separators do not count.
export const standardize = (s) => String(s).replace(/[ ,./\-_*^]/g, "").toLowerCase().replace(/'/g, '"');

// One value against the list of acceptable ones. "" in the list means the parameter may be
// omitted (handled by the caller); numbers compare numerically (an integer type still wants an
// integer); strings after standardising; arrays element-wise in order. A dict answer is itself a
// possible-answer structure — each key maps to the list of values it accepts (the leaderboard's
// dict_checker), so { width: [20], height: [12] } accepts { width: 20, height: 12 }.
export function valueMatches(value, accepted, type = null) {
  return accepted.some((want) => sameValue(value, want, type));
}
function dictMatches(value, want) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (!(k in want)) return false;
    const accepted = want[k];
    if (Array.isArray(accepted)) { if (!accepted.some((w) => sameValue(v, w))) return false; }
    else if (accepted && typeof accepted === "object") { if (!dictMatches(v, accepted)) return false; }
    else if (!sameValue(v, accepted)) return false;
  }
  for (const [k, accepted] of Object.entries(want)) if (!(k in value) && !(Array.isArray(accepted) && accepted.includes(""))) return false;
  return true;
}
function sameValue(value, want, type) {
  if (Array.isArray(want)) return Array.isArray(value) && value.length === want.length && want.every((w, i) => sameValue(value[i], w, type === "array" ? null : type));
  if (want && typeof want === "object") return dictMatches(value, want);
  if (typeof want === "number") {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)) ? Number(value) : NaN;
    if (Number.isNaN(n)) return false;
    if (type === "integer" && !Number.isInteger(n)) return false;
    return Math.abs(n - want) < 1e-9;
  }
  if (typeof want === "boolean") return value === want || (typeof value === "string" && value.toLowerCase() === String(want));
  if (typeof want === "string") {
    if (want === "") return false; // "" means optional, never a value to match
    if (typeof value === "string") return standardize(value) === standardize(want);
    if (typeof value === "number" || typeof value === "boolean") return standardize(String(value)) === standardize(want);
    return false;
  }
  return value === want;
}

// A parsed call { name, arguments } against one possible answer { fname: { param: [accepted…] } }.
// `functions` (the item's docs) supplies the declared types.
export function checkCall(call, answer, functions = []) {
  if (!call) return { ok: false, reason: "no call" };
  const [fname, params] = Object.entries(answer)[0];
  const doc = functions.find((f) => f.name === fname);
  const props = doc?.parameters?.properties ?? {};
  const required = doc?.parameters?.required ?? Object.keys(params).filter((k) => !params[k].includes(""));
  const called = call.name === fname || call.name === toolName(fname);
  if (!called) return { ok: false, reason: `called ${call.name}, wanted ${fname}` };
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  for (const k of Object.keys(args)) if (!(k in params)) return { ok: false, reason: `unexpected parameter ${k}` };
  for (const [k, accepted] of Object.entries(params)) {
    const optional = accepted.includes("");
    if (!(k in args)) {
      if (optional && !required.includes(k)) continue;
      return { ok: false, reason: `missing parameter ${k}` };
    }
    if (!valueMatches(args[k], accepted, props[k]?.type ?? null)) return { ok: false, reason: `${k} = ${JSON.stringify(args[k])}, wanted one of ${JSON.stringify(accepted.filter((a) => a !== ""))}` };
  }
  return { ok: true, reason: `${fname}(${Object.keys(args).join(", ")}) matches` };
}

// The simple and multiple categories want exactly one call that matches the one possible answer.
export function scoreCalls(calls, groundTruth, functions = []) {
  const wanted = groundTruth ?? [];
  if (!calls.length) return { ok: false, reason: "no function call" };
  if (wanted.length !== 1) return { ok: false, reason: `this checker handles one expected call, the answer lists ${wanted.length}` };
  if (calls.length !== 1) return { ok: false, reason: `${calls.length} calls for one expected (${calls.map((c) => c.name).join(", ")})` };
  return checkCall(calls[0], wanted[0], functions);
}

// ---- prompt mode: a Python-style call written as text ---------------------------------------
// BFCL's prompting mode asks for `[func(a=1, b="x")]`; this parser reads that, or a bare call, or
// several in a list, with Python literals: strings (either quote), numbers, True/False/None, lists,
// tuples and dicts. Returns [] when nothing parses.
export function parseCalls(text) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  // Prefer a fenced or bracketed block; fall back to the first name( in the text.
  const candidates = [];
  const fence = t.match(/```(?:python|json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(t);
  for (const c of candidates) {
    const start = c.search(/[A-Za-z_][\w.]*\s*\(/);
    if (start < 0) continue;
    const from = c.startsWith("[") ? 0 : start;
    try {
      const p = new Parser(c.slice(from));
      const calls = p.calls();
      if (calls.length) return calls;
    } catch { /* try the next candidate */ }
  }
  return [];
}

class Parser {
  constructor(s) { this.s = s; this.i = 0; }
  peek() { this.ws(); return this.s[this.i]; }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  eat(ch) { this.ws(); if (this.s[this.i] !== ch) throw new Error(`expected ${ch} at ${this.i}`); this.i++; }
  calls() {
    const out = [];
    if (this.peek() === "[") {
      this.eat("[");
      while (this.peek() !== "]") { out.push(this.call()); if (this.peek() === ",") this.eat(","); else break; }
      this.eat("]");
      return out;
    }
    out.push(this.call());
    return out;
  }
  name() { this.ws(); const m = this.s.slice(this.i).match(/^[A-Za-z_][\w.]*/); if (!m) throw new Error(`name at ${this.i}`); this.i += m[0].length; return m[0]; }
  call() {
    const name = this.name();
    this.eat("(");
    const args = {};
    while (this.peek() !== ")") {
      const key = this.name();
      this.eat("=");
      args[key] = this.value();
      if (this.peek() === ",") this.eat(","); else break;
    }
    this.eat(")");
    return { name, arguments: args };
  }
  value() {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string(c);
    if (c === "[" || c === "(") return this.list(c === "[" ? "]" : ")");
    if (c === "{") return this.dict();
    const m = this.s.slice(this.i).match(/^(-?\d+(?:\.\d+)?(?:e-?\d+)?|True|False|None|true|false|null)/);
    if (!m) throw new Error(`value at ${this.i}`);
    this.i += m[0].length;
    const w = m[0];
    if (w === "True" || w === "true") return true;
    if (w === "False" || w === "false") return false;
    if (w === "None" || w === "null") return null;
    return Number(w);
  }
  string(q) {
    this.eat(q);
    let out = "";
    while (this.i < this.s.length && this.s[this.i] !== q) { if (this.s[this.i] === "\\" && this.i + 1 < this.s.length) { this.i++; } out += this.s[this.i++]; }
    this.eat(q);
    return out;
  }
  list(close) {
    this.eat(close === "]" ? "[" : "(");
    const out = [];
    while (this.peek() !== close) { out.push(this.value()); if (this.peek() === ",") this.eat(","); else break; }
    this.eat(close);
    return out;
  }
  dict() {
    this.eat("{");
    const out = {};
    while (this.peek() !== "}") {
      const c = this.peek();
      const key = c === '"' || c === "'" ? this.string(c) : this.name();
      this.eat(":");
      out[key] = this.value();
      if (this.peek() === ",") this.eat(","); else break;
    }
    this.eat("}");
    return out;
  }
}
