// Task family: needle — long-context retrieval and aggregation over a generated server log.
//
// A seeded log of N lines (needle8k / needle32k / needle100k, by approximate prompt tokens) with one
// of three questions, rotated by seed: a single needle (the latency of one request id, planted at a
// depth of 10 %, 50 % or 90 % — recorded, so a position sweep falls out of the rows), a multi-needle
// (which hosts logged a CRITICAL event), or an aggregation (how many ERROR lines one service logged).
// Free-form and schema-only modes read the whole log inline; the tool modes get a grep and a count
// over the same log served by the webserver — so the harness delta here is "search versus read".

import { labelModel } from "../providers/index.js";
import { dice, numberIn } from "./gen.js";
import { BASE } from "./util.js";
import { api, enc } from "./scenario.js";

const SERVICES = ["billing", "auth", "search", "catalog", "orders", "mailer", "gateway", "reports"];
const LEVELS = ["INFO", "INFO", "INFO", "INFO", "INFO", "DEBUG", "DEBUG", "WARN", "ERROR"];
const MSGS = {
  INFO: ["request served", "cache hit", "cache miss", "job scheduled", "token refreshed", "batch flushed", "session opened", "healthcheck ok"],
  DEBUG: ["parsed headers", "selected shard", "pool checkout", "template rendered"],
  WARN: ["slow query", "retrying upstream", "queue depth high", "certificate expires soon"],
  ERROR: ["upstream timeout", "db connection reset", "invalid payload", "quota exceeded", "write failed"],
};
const TOKENS_PER_LINE = 42; // calibrated live: ~41 tokens a line on OpenAI's tokenizer, ~47 on Anthropic's (hex ids and timestamps tokenize badly)
const DEPTHS = [0.1, 0.5, 0.9];
const KINDS = ["single", "multi", "agg"];

const hex = (d, n) => Array.from({ length: n }, () => "0123456789abcdef"[d.int(0, 15)]).join("");
const pad = (n) => String(n).padStart(2, "0");

export function linesFor(tokens) { return Math.max(40, Math.round(tokens / TOKENS_PER_LINE)); }

export function generate(seed, tokens, { kind: kindIndex = null } = {}) {
  const d = dice(seed);
  const n = linesFor(tokens);
  let t = Date.UTC(2026, d.int(0, 11), d.int(1, 28), d.int(0, 23), d.int(0, 59), 0);
  const seen = new Set();
  const rows = [];
  for (let i = 0; i < n; i++) {
    t += d.int(1, 20) * 1000;
    const dt = new Date(t);
    const level = d.pick(LEVELS);
    let req = hex(d, 6);
    while (seen.has(req)) req = hex(d, 6);
    seen.add(req);
    rows.push({ ts: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}Z`, host: `host-${d.int(1, 40)}`, svc: d.pick(SERVICES), level, req, latency: d.int(5, 900), bytes: d.int(100, 50000), msg: d.pick(MSGS[level]) });
  }
  const kind = KINDS[(kindIndex ?? seed) % 3];
  let question, answer, key, depth = null;
  if (kind === "single") {
    depth = DEPTHS[d.int(0, 2)];
    const i = Math.min(n - 1, Math.max(0, Math.round(depth * n)));
    const r = rows[i];
    question = `What latency (in ms) was recorded for request ${r.req}?`;
    answer = r.latency;
    key = [r.req];
  } else if (kind === "multi") {
    const k = 3;
    const hosts = new Set();
    while (hosts.size < k) hosts.add(`host-${d.int(1, 40)}`);
    const positions = new Set();
    while (positions.size < k) positions.add(d.int(0, n - 1));
    [...positions].forEach((i, j) => { rows[i] = { ...rows[i], level: "CRITICAL", host: [...hosts][j], msg: d.pick(["disk full", "kernel panic averted", "primary lost", "oom killer invoked"]) }; });
    question = "Which hosts logged a CRITICAL event? List every one of them.";
    answer = [...hosts].sort();
    key = ["CRITICAL"];
  } else {
    const svc = d.pick(SERVICES);
    const count = rows.filter((r) => r.svc === svc && r.level === "ERROR").length;
    question = `How many lines did the ${svc} service log at level ERROR?`;
    answer = count;
    key = [svc, "ERROR"];
  }
  const lines = rows.map((r) => `${r.ts} ${r.host} svc=${r.svc} level=${r.level} req=${r.req} latency=${r.latency}ms bytes=${r.bytes} msg="${r.msg}"`);
  const text = lines.join("\n");
  return { seed, tokens, kind, depth, lines: n, question, answer, key, text, approxTokens: n * TOKENS_PER_LINE };
}

// The instance a saved row ran against, minted again from what the row's ctx keeps (seed, tokens,
// kind): the row records no log text, and this is how a replay or a re-score gets it back. The log
// id is the webserver's for that trial and is not part of the instance.
export function remint({ seed, tokens, kind }) {
  const k = KINDS.indexOf(kind);
  if (k < 0) throw new Error(`needle: unknown question kind "${kind}"`);
  return generate(seed, tokens, { kind: k });
}

const tools = [
  {
    name: "grep_log",
    description: "Search the log with a regular expression. Returns the matching lines with their line numbers (up to `limit`, default 50) and the total number of matches.",
    parameters: { type: "object", properties: { log: { type: "string", description: "The log id." }, pattern: { type: "string", description: "A regular expression, e.g. req=7f3a2c or level=ERROR" }, limit: { type: "integer" } }, required: ["log", "pattern"] },
    impl: async ({ log, pattern, limit }) => api("GET", `/api/logs/${enc(log)}?grep=${enc(pattern)}${limit ? `&limit=${enc(limit)}` : ""}`),
  },
  {
    name: "count_log",
    description: "Count the lines matching a regular expression. Returns { count }.",
    parameters: { type: "object", properties: { log: { type: "string", description: "The log id." }, pattern: { type: "string" } }, required: ["log", "pattern"] },
    impl: async ({ log, pattern }) => api("GET", `/api/logs/${enc(log)}/count?grep=${enc(pattern)}`),
  },
];

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "What you looked at, before the answer." },
    answer: { type: ["integer", "array"], items: { type: "string" }, description: "The number asked for, or the list of hosts." },
  },
  required: ["answer"],
};

const hostsIn = (text) => [...new Set((String(text ?? "").toLowerCase().match(/host-\d+/g) ?? []))].sort();

function judge(kind, got, ground) {
  if (kind === "multi") {
    const want = ground.answer;
    const have = Array.isArray(got) ? [...new Set(got.map((h) => String(h).toLowerCase().trim()))].sort() : hostsIn(got);
    const missing = want.filter((h) => !have.includes(h)), extra = have.filter((h) => !want.includes(h));
    return missing.length || extra.length ? { correct: false, reason: `hosts ${[missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `extra ${extra.join(", ")}` : ""].filter(Boolean).join("; ")}` } : { correct: true, reason: `all ${want.length} hosts — right` };
  }
  const n = typeof got === "number" ? got : Array.isArray(got) ? NaN : numberIn(got);
  if (!Number.isFinite(n)) return { correct: false, reason: "no number in the answer" };
  return n === ground.answer ? { correct: true, reason: `${n} — right` } : { correct: false, reason: `answered ${n}, expected ${ground.answer}` };
}

function makeNeedle(tokens, label) {
  const intro = (ctx) => `A server log of ${ctx.lines} lines follows (one event per line: timestamp, host, svc, level, req, latency, bytes, msg).`;
  const fmt = (ctx) => (ctx.kind === "multi" ? "the host names, comma-separated" : "the number");
  return {
    name: `needle${label}`,
    family: "needle",
    level: tokens,
    category: "long-context",
    capabilities: ["long-context", "retrieval"],
    seeded: true,
    description: `A ~${label}-token server log with one question per trial — one planted line, three CRITICAL hosts, or an ERROR count per service; read inline, or searched with grep and count tools. Minted per trial.`,
    model: labelModel,
    maxRounds: 6,

    setup: async ({ seed, index = 1 }) => {
      // The kind rotates with the trial index, so six trials per cell cover each kind twice.
      const g = generate(seed >>> 0, tokens, { kind: (index - 1) % 3 });
      // The tool modes and the arms read the same log from the webserver.
      const res = await fetch(`${BASE}/api/logs`, { method: "POST", headers: { "content-type": "text/plain" }, body: g.text });
      if (!res.ok) throw new Error(`POST /api/logs → ${res.status}`);
      const { id } = await res.json();
      return { ...g, log: id };
    },

    // The row records the context without the log itself: what scoring reads (kind, answer, depth,
    // key), the question, the log id and the seed stay, and `remint` mints the log again from the
    // seed. With the log, 36 needle100k rows made a 15 MB run file, 14.9 MB of it this one field.
    recordCtx: ({ text: _text, ...rest }) => rest,

    goal: (ctx) => `A webserver runs at ${BASE}. It holds a server log (id ${ctx.log}, ${ctx.lines} lines; fields per line: timestamp, host, svc, level, req, latency, bytes, msg). GET /api/logs/${ctx.log}?grep=<regex>&limit=<n> returns matching lines with line numbers and the total count; GET /api/logs/${ctx.log}/count?grep=<regex> returns just the count. Question: ${ctx.question} Answer with ${fmt(ctx)}.`,

    noHarness: {
      prompt: (ctx) => `${intro(ctx)} Read it and answer the question at the end. Finish with a line of the form "answer: <${fmt(ctx)}>".\n\n${ctx.text}\n\nQuestion: ${ctx.question}`,
      extract: "text",
    },
    schemaOnly: {
      system: "You are a careful log analyst. Return the requested JSON.",
      prompt: (ctx) => `${intro(ctx)} Read it and answer the question at the end with a JSON object { "work": [...], "answer": <${fmt(ctx)}> }.\n\n${ctx.text}\n\nQuestion: ${ctx.question}`,
      tools: [],
      schema,
      extract: "structured",
    },
    harness: {
      system: "You are a careful log analyst. The log is on the server: search it with grep_log and count_log rather than guessing, then return the requested JSON.",
      prompt: (ctx) => `Log id ${ctx.log} (${ctx.lines} lines; fields per line: timestamp, host, svc, level, req, latency, bytes, msg). Question: ${ctx.question} Use grep_log / count_log, then answer with a JSON object { "work": [...], "answer": <${fmt(ctx)}> }.`,
      tools,
      schema,
      extract: "structured",
    },
    toolOnly: {
      system: "You are a careful log analyst. The log is on the server: search it with grep_log and count_log rather than guessing.",
      prompt: (ctx) => `Log id ${ctx.log} (${ctx.lines} lines; fields per line: timestamp, host, svc, level, req, latency, bytes, msg). Question: ${ctx.question} Use grep_log / count_log, then finish with a line of the form "answer: <${fmt(ctx)}>".`,
      tools,
      extract: "text",
    },

    eval: {
      ground: ({ ctx } = {}) => (ctx ? { kind: ctx.kind, answer: ctx.answer, depth: ctx.depth } : null),
      toolUse: ({ toolCalls, ctx }) => {
        const calls = toolCalls.filter((c) => c.name === "grep_log" || c.name === "count_log");
        if (!calls.length) return { ok: false, reason: "the log was never searched" };
        const patterns = calls.map((c) => String(c.arguments?.pattern ?? "").toLowerCase()).join("\n");
        const hit = (ctx?.key ?? []).every((k) => patterns.includes(String(k).toLowerCase()));
        return hit ? { ok: true, reason: `searched for ${ctx.key.join(" and ")} in ${calls.length} call(s)` } : { ok: false, reason: `${calls.length} search(es), none for ${ctx.key.join(" and ")}` };
      },
      scoreHarness: (out, ground) => (out && typeof out === "object" ? judge(ground.kind, out.answer, ground) : { correct: false, reason: "no structured output" }),
      scoreNoHarness: (out, ground) => {
        const t = String(out ?? "");
        const tail = t.match(/answer\s*[:=]?\s*\**\s*(.+)$/im)?.[1] ?? t;
        return judge(ground.kind, ground.kind === "multi" ? tail : tail, ground);
      },
      canon: (answer, { structured }) => {
        const v = structured ? answer?.answer : (String(answer ?? "").match(/answer\s*[:=]?\s*\**\s*(.+)$/im)?.[1] ?? answer);
        return Array.isArray(v) ? [...v].map((x) => String(x).toLowerCase()).sort().join(",") : String(hostsIn(v).length > 1 ? hostsIn(v).join(",") : numberIn(v));
      },
    },
  };
}

export const needleTasks = [[8000, "8k"], [32000, "32k"], [100000, "100k"]].map(([t, l]) => makeNeedle(t, l));
export { tools, schema, makeNeedle, SERVICES };
