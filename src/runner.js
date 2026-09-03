// runner.js — the shared execution core.
//
// One place where a (task, mode, client) cell is actually run and scored, used by the CLI
// (`bench.js`, `aggregate.js`) and by the web UI alike, so every surface reports the same
// numbers. Callers get progress via `onEvent` and can cancel with an AbortSignal.

import { validateSchema, schemaHint } from "./schema.js";

export const MODES = ["noHarness", "harness"];

// A mode is one of two shapes, by *behavior* rather than by name:
//   - structured  -> inject the output schema, run tools, and score the parsed JSON.
//   - free-form   -> no tools, score the raw text.
// The classic "harness" bundle is the structured mode; the free-form mode is the bare baseline.
// Adding an axis means adding a mode name that is structured or free-form — no runner changes.
export function isStructuredMode(mode) {
  return mode === "harness" || mode === "schemaOnly";
}

// The schema therefore belongs in the prompt the model sees, not only in the scorer — whenever a
// mode is structured, not just the classic harness.
export function buildSystemPrompt(spec, mode) {
  const base = spec.system ?? "";
  if (!isStructuredMode(mode) || !spec.schema) return base;
  return [
    base,
    "Return your final answer as JSON matching this schema exactly:",
    schemaHint(spec.schema),
    "Reply with the JSON only — no prose, no markdown fences.",
  ].filter(Boolean).join("\n\n");
}

/** Run a single (task, mode, client) trial once and score it. Never throws. */
export async function runTrial({ task, mode, client, index = 1, signal, maxRounds = 4 }) {
  // A task carries a spec per mode (task[mode]). Only the modes it declares are run; the registry
  // filters modes to those present so an unused axis never produces an "unsupported mode" row.
  const spec = task[mode];
  const structured = isStructuredMode(mode);
  const started = Date.now();
  const t0 = performance.now();

  const record = {
    index,
    task: task.name,
    mode,
    provider: client.provider || client.name,
    client: client.name,
    model: client.model,
    startedAt: new Date(started).toISOString(),
    latencyMs: 0,
    prompt: spec?.prompt ?? null,
    system: null,
    toolCalls: [],
    toolResults: [],
    rounds: 0,
    finishReason: null,
    answerText: null,
    structured: null,
    schemaValid: null,
    schemaErrors: [],
    correct: false,
    reason: "",
    usage: null,
    ground: null,
    error: null,
  };

  if (!spec) {
    record.reason = "unsupported mode";
    record.error = `task "${task.name}" has no "${mode}" spec`;
    return record;
  }

  try {
    const system = buildSystemPrompt(spec, mode);
    record.system = system || null;

    // A mode that is structured (schema-aware) scores the parsed JSON. A mode that carries tools
    // runs them regardless — `toolOnly` is exactly free-form output *with* tools run, so tool
    // execution is gated on tools being present, not on structured scoring.
    const hasTools = (spec.tools ?? []).length > 0;

    let resp;
    if (structured || hasTools) {
      // Tools run (if any) and the final message is parsed as JSON. What gets scored is the
      // model's final message written after it saw real tool output — never the tool args.
      resp = await client.runWithTools(spec.prompt, spec.tools ?? [], system, { maxRounds, signal });
      record.toolCalls = resp.toolCalls ?? [];
      record.toolResults = resp.toolResults ?? [];
      record.rounds = resp.rounds ?? 0;
      record.structured = resp.structured ?? null;

      // Schema validation is part of the structured (schema-aware) path. Running tools without a
      // schema (toolOnly) validates nothing, so schemaValid stays null.
      if (structured && spec.schema) {
        const { valid, errors } = validateSchema(resp.structured, spec.schema);
        record.schemaValid = resp.structured !== null && valid;
        record.schemaErrors = resp.structured === null ? ["final message was not JSON"] : errors;
      } else {
        record.schemaValid = resp.structured !== null;
      }
    } else {
      resp = await client.chat(
        [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: spec.prompt }],
        undefined,
        { signal },
      );
    }

    record.answerText = resp.text ?? "";
    record.finishReason = resp.finishReason ?? null;
    record.usage = resp.usage ?? null;

    // Truth: the task's ground is fetched after the model's reply, so the answer and the ground
    // are taken at the same wall-clock point (the model never sees it). Fetch once for both modes.
    const ground = await task.eval.ground();
    record.ground = ground;

    // Structured modes score the parsed JSON; free-form scores the raw text.
    const scorer = structured ? task.eval.scoreHarness : task.eval.scoreNoHarness;
    const answer = structured ? record.structured : record.answerText;
    console.error("DEBUG structured=", record.structured, "answer=", answer, "ground=", ground);
    const score = await scorer(answer, ground);

    record.correct = !!score.correct;
    record.reason = score.reason ?? "";
  } catch (err) {
    record.correct = false;
    const cancelled = signal?.aborted;
    record.reason = cancelled ? "cancelled" : "exception";
    // A raw "This operation was aborted" reads like a defect; say what actually happened.
    record.error = cancelled ? "cancelled before completing" : (err?.message ?? String(err));
  }

  record.latencyMs = Math.round(performance.now() - t0);
  return record;
}

/**
 * Run the full tasks x modes x clients matrix, `count` trials per cell.
 * `onEvent` receives { type: "start" | "trial" | "done", ... } as work completes.
 */
export async function runMatrix({ tasks, modes, clients, count = 1, onEvent, signal, maxRounds }) {
  const total = tasks.length * modes.length * clients.length * count;
  const rows = [];
  let completed = 0;

  onEvent?.({ type: "start", total, tasks: tasks.map((t) => t.name), modes, clients: clients.map((c) => c.name), count });

  outer:
  for (const task of tasks) {
    for (const mode of modes) {
      for (const client of clients) {
        for (let i = 0; i < count; i++) {
          if (signal?.aborted) break outer;
          const row = await runTrial({ task, mode, client, index: i + 1, signal, maxRounds });
          rows.push(row);
          completed += 1;
          onEvent?.({ type: "trial", completed, total, result: row });
        }
      }
    }
  }

  const summary = summarize(rows);
  onEvent?.({ type: "done", completed, total, summary, cancelled: !!signal?.aborted });
  return { rows, summary };
}

// ---- statistical significance --------------------------------------------------------------
//
// The harness delta is the whole point of the benchmark, so a bare difference of two percentages
// tells you almost nothing — with a few trials, a 4-point gap is easily sampling noise. These
// helpers let every delta carry a real answer to "is this gap real?":
//
//   - twoPropZTest — a two-proportion z-test for whether the harness rate differs from baseline
//     (one-sided p-value = probability the harness rate is *not* better than baseline).
//   - wilsonInterval — the Wilson score interval, a confidence band on a single proportion that is
//     far better behaved than the textbook interval when the rate is near 0 or 1.
//
// Both are pure math (no deps). normalCDF uses Abramowitz & Stegun 7.1.26 (max abs error ~1.2e-7).

function normalCDF(z) {
  // z = 0 is the only exact point; the A&S rational approximation carries a ~1e-7 rounding error
  // everywhere else (good enough for a significance test, but not for a == 0.5 assertion).
  if (z === 0) return 0.5;
  const sign = z < 0 ? -1 : 1;
  // Abramowitz & Stegun 7.1.26: erf(x) ≈ 1 - P(t)·e^{-x²}, with t = 1/(1 + 0.3275911·x) and
  // P(t) = a1·t + a2·t² + a3·t³ + a4·t⁴ + a5·t⁵. Since CDF(z) = 0.5·(1 + erf(z/sqrt(2))),
  // the erf argument is z/sqrt(2).
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  // A&S 7.1.26 polynomial coefficients a1..a5.
  const p = 0.3275911 * t
    + 0.236255972 * t * t
    + 0.138629446 * t * t * t
    + 0.069460363 * t * t * t * t
    + 0.011772830 * t * t * t * t * t;
  const y = 1 - p * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// Standard-normal quantiles for common confidence levels; 95% is the default band.
function zForLevel(level) {
  const table = {
    0.90: 1.64485362695147,
    0.95: 1.95996398454005,
    0.99: 2.5758293035489,
  };
  return table[level] ?? table[0.95];
}

function twoPropZTest(n1, x1, n2, x2) {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  const z = se > 0 ? (p2 - p1) / se : 0;
  return { z, pValue: 2 * (1 - normalCDF(Math.abs(z))), oneSidedP: 1 - normalCDF(z) };
}

function wilsonInterval(x, n, level = 0.95) {
  if (n === 0) return { low: 0, high: 0 };
  const z2 = zForLevel(level) ** 2;
  const center = (x + z2 / 2) / (n + z2);
  const half = (zForLevel(level) * Math.sqrt(x * (1 - x / n) + z2 / 4)) / (n + z2);
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function pct(rows, cond) {
  if (!rows.length) return 0;
  return (rows.filter(cond).length / rows.length) * 100;
}

export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Exported so the significance helpers can be unit-tested and reused by future tiers (e.g. a
// per-task or per-cell significance). They are pure math, no I/O.
export { normalCDF, twoPropZTest, wilsonInterval, deltaFor };

function statsFor(rows) {
  return {
    runs: rows.length,
    correct: rows.filter((r) => r.correct).length,
    correctPct: pct(rows, (r) => r.correct),
    toolUsePct: pct(rows, (r) => (r.toolCalls?.length ?? 0) > 0),
    schemaValidPct: pct(rows, (r) => r.schemaValid === true),
    errorPct: pct(rows, (r) => !!r.error),
    avgLatencyMs: Math.round(mean(rows.map((r) => r.latencyMs))),
    totalTokens: rows.reduce((a, r) => a + (r.usage?.total_tokens ?? 0), 0),
  };
}

function deltaFor(rows) {
  const noH = rows.filter((r) => r.mode === "noHarness");
  const withH = rows.filter((r) => r.mode === "harness");
  if (!noH.length || !withH.length) return null;
  const a = pct(noH, (r) => r.correct);
  const b = pct(withH, (r) => r.correct);
  const n = noH.length;
  const m = withH.length;
  // Counts of correct answers (0..n), not percentages. `b` is a 0-100 percentage, so divide by 100.
  const x1 = Math.round(n * a / 100);
  const x2 = Math.round(m * b / 100);
  const significance = twoPropZTest(n, x1, m, x2);
  return {
    noHarnessPct: a,
    harnessPct: b,
    deltaPp: b - a,
    noHarnessRuns: n,
    harnessRuns: m,
    // pValue is the probability the harness rate is *not* better than baseline (one-sided). A small
    // value means the observed gap is unlikely to be sampling noise. null when either side is empty.
    pValue: significance?.pValue ?? null,
    z: significance?.z ?? null,
    // The Wilson interval on the harness rate: a confidence band that is honest near 0% / 100%.
    harnessWilson: wilsonInterval(x2, m),
  };
}

export function summarize(rows) {
  const modes = [...new Set(rows.map((r) => r.mode))];
  const taskNames = [...new Set(rows.map((r) => r.task))];
  const clientNames = [...new Set(rows.map((r) => r.client))];

  const byMode = {};
  for (const m of modes) byMode[m] = statsFor(rows.filter((r) => r.mode === m));

  const cells = [];
  for (const task of taskNames) {
    for (const client of clientNames) {
      for (const mode of modes) {
        const sub = rows.filter((r) => r.task === task && r.client === client && r.mode === mode);
        if (sub.length) cells.push({ task, client, mode, ...statsFor(sub) });
      }
    }
  }

  const byTask = {};
  for (const t of taskNames) byTask[t] = deltaFor(rows.filter((r) => r.task === t));

  const byClient = {};
  for (const c of clientNames) byClient[c] = deltaFor(rows.filter((r) => r.client === c));

  return {
    runs: rows.length,
    tasks: taskNames,
    modes,
    clients: clientNames,
    byMode,
    cells,
    delta: { overall: deltaFor(rows), byTask, byClient },
  };
}
