// Task family: datecalc — calendar arithmetic, minted per trial.
//
//   datecalc1: the date and weekday D days after a given date.
//   datecalc3: a posting date and time, then three durations in sequence (days, hours and minutes,
//              days); the delivery date, time and weekday.
// The harness axis is a date tool. Truth is computed in UTC while the problem is generated.

import { labelModel } from "../providers/index.js";
import { dice, wordIn } from "./gen.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");

export function fmtDate(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
export function fmtTime(ms) { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
export function weekdayOf(ms) { return WEEKDAYS[new Date(ms).getUTCDay()]; }
const prose = (ms) => { const d = new Date(ms); return `${weekdayOf(ms)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

export function parseDateTime(text) {
  const m = String(text ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) throw new Error(`expected "YYYY-MM-DD" or "YYYY-MM-DD HH:MM", got "${text}"`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  if (!Number.isFinite(ms)) throw new Error(`not a date: "${text}"`);
  return ms;
}

const tools = [
  {
    name: "add_time",
    description: "Add a duration to a date or date-time. Returns { datetime: \"YYYY-MM-DD HH:MM\", date, time, weekday }.",
    parameters: {
      type: "object",
      properties: {
        datetime: { type: "string", description: "\"YYYY-MM-DD\" or \"YYYY-MM-DD HH:MM\"" },
        days: { type: "integer" }, hours: { type: "integer" }, minutes: { type: "integer" },
      },
      required: ["datetime"],
    },
    impl: async ({ datetime, days = 0, hours = 0, minutes = 0 }) => {
      const ms = parseDateTime(datetime) + ((Number(days) || 0) * 1440 + (Number(hours) || 0) * 60 + (Number(minutes) || 0)) * 60_000;
      return { datetime: `${fmtDate(ms)} ${fmtTime(ms)}`, date: fmtDate(ms), time: fmtTime(ms), weekday: weekdayOf(ms) };
    },
  },
  {
    name: "days_between",
    description: "Whole days from one date to another (negative if the second is earlier). Returns { days }.",
    parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
    impl: async ({ from, to }) => ({ days: Math.round((parseDateTime(to) - parseDateTime(from)) / 86_400_000) }),
  },
];

export function generate(seed, level) {
  const d = dice(seed);
  const start = Date.UTC(d.int(2024, 2027), d.int(0, 11), d.int(1, 28), level === 3 ? d.int(6, 18) : 0, level === 3 ? d.pick([0, 15, 30, 45]) : 0);
  if (level === 1) {
    const days = d.int(9, 400);
    const end = start + days * 86_400_000;
    return {
      seed, level, wantsTime: false, parts: { start, days },
      text: `A permit is issued on ${prose(start)} and expires ${days} days later.`,
      question: "On what date does it expire, and what day of the week is that?",
      date: fmtDate(end), time: null, weekday: weekdayOf(end),
    };
  }
  const a = d.int(1, 6), b = d.int(1, 47), c = d.pick([15, 30, 45, 50, 90, 135]), e = d.int(1, 5);
  const end = start + (a * 1440 + b * 60 + c + e * 1440) * 60_000;
  return {
    seed, level, wantsTime: true, parts: { start, a, b, c, e },
    text: `A parcel is posted on ${prose(start)} at ${fmtTime(start)}. Processing takes ${a} day${a > 1 ? "s" : ""} and ${b} hour${b > 1 ? "s" : ""}; transit then takes ${c} minutes; the courier holds it for ${e} more day${e > 1 ? "s" : ""} before delivering it.`,
    question: "On what date and at what time (24-hour clock) is it delivered, and what day of the week is that?",
    date: fmtDate(end), time: fmtTime(end), weekday: weekdayOf(end),
  };
}

// The same problem in other words, or with the date in another form (ISO, or month-day-year
// without the weekday — the weekday hint is what the format takes away). Order has no meaning.
const usDate = (ms) => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
export function perturb(ctx, kind, seed = 0) {
  const p = ctx?.parts;
  if (!p) return null;
  const d = dice((seed >>> 0) ^ 0x9e37);
  const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
  if (kind === "paraphrase") {
    const text = ctx.level === 1
      ? d.pick([`A permit dated ${prose(p.start)} runs for ${p.days} days before it expires.`, `Issued on ${prose(p.start)}, a permit is valid for exactly ${p.days} days.`])
      : d.pick([`A parcel goes in the post on ${prose(p.start)} at ${fmtTime(p.start)}. It spends ${plural(p.a, "day")} and ${plural(p.b, "hour")} in processing, ${p.c} minutes in transit, and the courier keeps it ${plural(p.e, "day")} more before delivering it.`, `Posted ${prose(p.start)} at ${fmtTime(p.start)}: processing ${plural(p.a, "day")} ${plural(p.b, "hour")}, then ${p.c} minutes in transit, then held by the courier for ${plural(p.e, "day")} before delivery.`]);
    return { ...ctx, text, perturbed: kind };
  }
  if (kind === "format") {
    const date = d.pick([fmtDate(p.start), usDate(p.start)]);
    const text = ctx.level === 1
      ? `A permit is issued on ${date} and expires ${p.days} days later.`
      : `A parcel is posted on ${date} at ${fmtTime(p.start)}. Processing takes ${plural(p.a, "day")} and ${plural(p.b, "hour")}; transit then takes ${p.c} minutes; the courier holds it for ${plural(p.e, "day")} more before delivering it.`;
    return { ...ctx, text, perturbed: kind };
  }
  return null;
}

// The same question with the date left out: nothing can be placed on the calendar.
export function unanswerable(ctx) {
  const text = ctx.level === 1
    ? String(ctx.text).replace(/is issued on .*? and expires/, "is issued and expires")
    : String(ctx.text).replace(/is posted on .*? at (\d{1,2}:\d{2})\./, "is posted at $1 on a date that was not recorded.");
  return { ...ctx, text, date: null, time: null, weekday: null, answer: null, unanswerable: true, missing: "the starting date" };
}

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "Your working, one step per entry, written before the answer." },
    date: { type: "string", description: "YYYY-MM-DD" },
    time: { type: "string", description: "HH:MM, 24-hour clock (omit when no time is asked)" },
    weekday: { type: "string" },
  },
  required: ["date", "weekday"],
};

function judge(got, ground) {
  const problems = [];
  if (got.date !== ground.date) problems.push(`date ${got.date ?? "(none)"} ≠ ${ground.date}`);
  if (ground.wantsTime && (got.time ?? "").replace(/^(\d):/, "0$1:") !== ground.time) problems.push(`time ${got.time ?? "(none)"} ≠ ${ground.time}`);
  if ((got.weekday ?? "").toLowerCase() !== ground.weekday.toLowerCase()) problems.push(`weekday ${got.weekday ?? "(none)"} ≠ ${ground.weekday}`);
  return problems.length ? { correct: false, reason: problems.join("; ") } : { correct: true, reason: `${ground.date}${ground.wantsTime ? ` ${ground.time}` : ""} ${ground.weekday} — right` };
}

export function readFreeForm(text) {
  const t = String(text ?? "");
  const dates = t.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const times = t.match(/\b(\d{1,2}):(\d{2})\b/g) ?? [];
  return { date: dates.at(-1) ?? null, time: times.at(-1) ?? null, weekday: wordIn(t, WEEKDAYS) };
}

function makeDatecalc(level) {
  const problem = (ctx) => `${ctx.text} ${ctx.question}`;
  const format = (ctx) => (ctx.wantsTime ? "YYYY-MM-DD HH:MM and the weekday" : "YYYY-MM-DD and the weekday");
  return {
    name: `datecalc${level}`,
    family: "datecalc",
    level,
    category: "reasoning",
    seeded: true,
    capabilities: ["arithmetic", "calendar"],
    description: level === 1 ? "The date and weekday a given number of days after a date, minted per trial. With tools, a date calculator." : "A posting time plus three durations: delivery date, time and weekday, minted per trial. With tools, a date calculator.",
    model: labelModel,
    maxRounds: 6,

    setup: async ({ seed }) => generate(seed >>> 0, level),
    unanswerable,
    perturb,

    goal: (ctx) => `${problem(ctx)} Answer with ${format(ctx)}.`,

    noHarness: {
      prompt: (ctx) => `${problem(ctx)} Work it out and finish with a line of the form "answer: ${ctx.wantsTime ? "YYYY-MM-DD HH:MM" : "YYYY-MM-DD"} <weekday>".`,
      extract: "text",
    },
    harness: {
      system: "You are a careful scheduler. Use the date tools for every calendar step — never count days in your head — and return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)} Use add_time for each step, then answer with a JSON object { "work": ["<step>", …], "date": "YYYY-MM-DD"${ctx.wantsTime ? ', "time": "HH:MM"' : ""}, "weekday": "<weekday>" }.`,
      tools,
      schema,
      extract: "structured",
    },
    schemaOnly: {
      system: "You are a careful scheduler. Return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)} Answer with a JSON object { "work": ["<step>", …], "date": "YYYY-MM-DD"${ctx.wantsTime ? ', "time": "HH:MM"' : ""}, "weekday": "<weekday>" } — the working first, then the answer.`,
      tools: [],
      schema,
      extract: "structured",
    },
    toolOnly: {
      system: "You are a careful scheduler. Use the date tools for every calendar step — never count days in your head.",
      prompt: (ctx) => `${problem(ctx)} Use add_time for each step, then finish with a line of the form "answer: ${ctx.wantsTime ? "YYYY-MM-DD HH:MM" : "YYYY-MM-DD"} <weekday>".`,
      tools,
      extract: "text",
    },

    eval: {
      ground: ({ ctx } = {}) => (ctx ? { date: ctx.date, time: ctx.time, weekday: ctx.weekday, wantsTime: ctx.wantsTime } : null),
      toolUse: ({ toolCalls, toolResults, ctx }) => {
        const calls = toolCalls.filter((c) => c.name === "add_time" || c.name === "days_between");
        if (ctx?.unanswerable) return { ok: true, reason: calls.length ? `${calls.length} date tool call(s) with no date to start from` : "nothing to compute: no starting date" };
        if (!calls.length) return { ok: false, reason: "no date tool was called" };
        const failed = toolResults.filter((r) => (r.name === "add_time" || r.name === "days_between") && r.ok === false).length;
        return failed ? { ok: false, reason: `${failed} date tool call(s) failed` } : { ok: true, reason: `${calls.length} date tool call(s)` };
      },
      scoreHarness: (out, ground) => {
        if (!out || typeof out !== "object") return { correct: false, reason: "no structured output" };
        return judge({ date: String(out.date ?? "").slice(0, 10), time: out.time ? String(out.time).slice(0, 5) : null, weekday: out.weekday }, ground);
      },
      scoreNoHarness: (out, ground) => judge(readFreeForm(out), ground),
      canon: (answer, { structured }) => {
        const g = structured ? (answer && typeof answer === "object" ? { date: answer.date, time: answer.time, weekday: answer.weekday } : {}) : readFreeForm(answer);
        return [g.date ?? "?", g.time || null, (g.weekday ?? "?").toLowerCase()].filter(Boolean).join(" ");
      },
    },
  };
}

export const datecalcTasks = [1, 3].map(makeDatecalc);
export { tools, schema, makeDatecalc, WEEKDAYS };
