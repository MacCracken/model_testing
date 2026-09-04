// Task: extract-and-transform — fetch, then reshape what came back.
//
//   For alice, bob and carol: fetch the greeting, then report the name, the first 8 characters of
//   the id the server returned, and the greeting in upper case.
//
// Tool-essential like `lookup` (the id prefix is random) and a transformation on top: the answer is
// not any field the tool returned but two functions of them (substring, upper-case). It separates
// "can fetch" from "can reshape what was fetched". Ground truth is read from the trial's own tool
// results, as in `lookup`.

import { labelModel } from "../providers/index.js";
import { BASE, unwrapList } from "./util.js";
import { tool, NAMES } from "./hello.js";

const PREFIX = 8;

const schema = {
  type: "array",
  minItems: NAMES.length,
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      idPrefix: { type: "string", description: `The first ${PREFIX} characters of the id the server returned.` },
      shout: { type: "string", description: "The greeting the server returned, in upper case." },
    },
    required: ["name", "idPrefix", "shout"],
  },
};

// Every (name, id, message) the hello tool returned during the trial, in call order.
function fetchedFrom(toolResults) {
  const out = [];
  for (const r of toolResults) {
    if (r.name !== tool.name || r.ok === false) continue;
    let parsed;
    try { parsed = JSON.parse(r.content); } catch { continue; }
    for (const g of parsed?.greetings ?? []) {
      const name = String(g?.name ?? "").trim().toLowerCase();
      if (NAMES.includes(name) && g?.id && g?.message) out.push({ name, id: String(g.id), message: String(g.message) });
    }
  }
  return out;
}

function entriesFrom(out) {
  return unwrapList(out, ["results", "entries", "data"], (o) => o.name !== undefined && (o.idPrefix !== undefined || o.shout !== undefined));
}

// Judge the reported entries against what was fetched: each name needs an idPrefix that is the
// start of an id the server gave that name, and a shout equal to that greeting upper-cased.
function judge(entries, ground) {
  const fetched = ground.filter((g) => g.ids.length);
  if (!fetched.length) return { correct: false, reason: "the hello tool was never called, so there is nothing real to transform" };
  const byName = new Map(entries.map((e) => [String(e?.name ?? "").trim().toLowerCase(), e]));
  let ok = 0;
  const problems = [];
  for (const g of ground) {
    const e = byName.get(g.name);
    if (!g.ids.length) { problems.push(`never fetched ${g.name}`); continue; }
    if (!e) { problems.push(`${g.name} missing`); continue; }
    const prefixOk = g.ids.some((id) => String(e.idPrefix ?? "").trim() === id.slice(0, PREFIX));
    const shoutOk = String(e.shout ?? "").trim() === g.message.toUpperCase();
    if (prefixOk && shoutOk) ok++;
    else problems.push(`${g.name}: ${[!prefixOk ? "idPrefix wrong" : "", !shoutOk ? "shout wrong" : ""].filter(Boolean).join(", ")}`);
  }
  return { correct: ok === ground.length, reason: ok === ground.length ? `all ${ground.length} transforms match` : `${ok}/${ground.length} correct; ${problems.join("; ")}` };
}

export const task = {
  name: "transform",
  category: "extract-transform",
  description:
    "Fetch three greetings, then report each name with the first 8 characters of its id and the greeting in upper case.",
  model: labelModel,

  goal:
    `A webserver runs at ${BASE}. GET /api/hello?name=<name> returns JSON { message, id }, where id is ` +
    `freshly generated on every call. Fetch it once for each of these names: ${NAMES.join(", ")}, and ` +
    `report, for each name, the first ${PREFIX} characters of the id the server returned and the ` +
    "message the server returned converted to upper case.",

  // ---- no-harness mode ----
  noHarness: {
    prompt:
      "The webserver exposes GET /api/hello?name=<name>, which returns { message: \"Hello, <name>!\", " +
      `id: <freshly generated random id> }. WITHOUT any tools: for each of ${NAMES.join(", ")}, report the ` +
      `name, the first ${PREFIX} characters of the id the endpoint would return, and the message in upper ` +
      "case — one line per name. You cannot reach the server; report your best attempt anyway.",
    extract: "text",
  },

  // ---- with-harness mode ----
  harness: {
    system:
      "You are a precise API client. Use the provided tools and return exactly the requested structured data.",
    prompt:
      `Call the hello tool for these names: ${NAMES.join(", ")}. Then return a JSON array with one object ` +
      `per name carrying the name, the first ${PREFIX} characters of the id the tool returned (idPrefix), ` +
      "and the greeting the tool returned converted to upper case (shout).",
    tools: [tool],
    schema,
    extract: "structured",
  },

  // ---- schema only ----
  schemaOnly: {
    system: "You are a precise API client. Return exactly the requested structured data.",
    prompt:
      "The webserver exposes GET /api/hello?name=<name>, which returns { message: \"Hello, <name>!\", " +
      `id: <freshly generated random id> }. WITHOUT any tools: for each of ${NAMES.join(", ")}, return the ` +
      `name, the first ${PREFIX} characters of the id the endpoint would return (idPrefix), and the message ` +
      "in upper case (shout). You cannot reach the server; report your best attempt anyway.",
    tools: [],
    schema,
    extract: "structured",
  },

  // ---- tools only ----
  toolOnly: {
    system: "You are a precise API client. Use the provided tools.",
    prompt:
      `Call the hello tool for these names: ${NAMES.join(", ")}. Then reply with one line per name in the ` +
      `form \`<name>: <first ${PREFIX} characters of the id> <greeting in upper case>\`.`,
    tools: [tool],
    extract: "text",
  },

  // ---- evaluation ----
  eval: {
    toolUse: ({ toolCalls }) => {
      const calls = toolCalls.filter((c) => c.name === tool.name);
      if (!calls.length) return { ok: false, reason: "the hello tool was never called" };
      const passed = new Set(calls.flatMap((c) => String(c.arguments?.name ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean)));
      const missing = NAMES.filter((n) => !passed.has(n));
      return missing.length ? { ok: false, reason: `never passed ${missing.join(", ")}` } : { ok: true, reason: `hello called for ${NAMES.join(", ")}` };
    },

    // Truth: what the tool returned per name during this trial (ids and message).
    ground: ({ toolResults = [] } = {}) => NAMES.map((name) => {
      const hits = fetchedFrom(toolResults).filter((f) => f.name === name);
      return { name, ids: hits.map((h) => h.id), message: hits[0]?.message ?? `Hello, ${name}!` };
    }),

    scoreHarness: (out, ground) => {
      if (out === null || out === undefined) return { correct: false, reason: "no structured output" };
      const entries = entriesFrom(out);
      if (!entries.length) return { correct: false, reason: "structured output contained no entries" };
      return judge(entries, ground);
    },

    // Free-form: one line per name, "<name>: <prefix> <SHOUT>" — parsed leniently.
    scoreNoHarness: (out, ground) => {
      const lines = String(out ?? "").replace(/[*`"]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const entries = [];
      for (const name of NAMES) {
        const line = lines.find((l) => l.toLowerCase().startsWith(name));
        if (!line) continue;
        const rest = line.slice(name.length).replace(/^[\s:—-]+/, "");
        const prefix = (rest.match(/[0-9a-f]{8}/i) ?? [])[0] ?? "";
        const shout = (rest.match(/HELLO, [A-Z]+!/) ?? [])[0] ?? "";
        entries.push({ name, idPrefix: prefix, shout });
      }
      if (!entries.length) return { correct: false, reason: "no per-name lines found" };
      return judge(entries, ground);
    },
  },
};

export { schema, PREFIX };
