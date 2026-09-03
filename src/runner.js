// runner.js — the shared execution core.
//
// One place where a (task, mode, client) cell is actually run and scored, used by the CLI
// (`bench.js`, `aggregate.js`) and by the web UI alike, so every surface reports the same
// numbers. Callers get progress via `onEvent` and can cancel with an AbortSignal.
//
// This file has no Node-specific imports on purpose: the web server serves it to the browser as
// `/lib/runner.js`, so the UI summarizes runs with this exact code instead of a copy that drifts.

import { validateSchema, schemaHint } from "./schema.js";

// Every mode the benchmark knows. `noHarness` vs `harness` is the headline pair; `schemaOnly` and
// `toolOnly` are the two axes the bundle decomposes into. A task supports a mode by carrying a spec
// under that name — pairs it does not declare are skipped, see planMatrix.
export const MODE_NAMES = ["noHarness", "harness", "schemaOnly", "toolOnly"];
export const DEFAULT_MODES = ["noHarness", "harness"];

// A mode is one of two shapes, by *behavior* rather than by name:
//   - structured  -> inject the output schema, run tools, and score the parsed JSON.
//   - free-form   -> no schema, score the raw text (tools still run if the spec carries them).
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
  // Calibration runs showed models echoing the schema's own envelope ({"type":"array","items":[…]})
  // when told to "match this schema", so the instruction spells out instance-not-schema.
  return [
    base,
    "Return your final answer as a JSON value that is an instance of this JSON Schema (a value that validates against it — not the schema itself):",
    schemaHint(spec.schema),
    "Reply with that JSON value only — no prose, no markdown fences.",
  ].filter(Boolean).join("\n\n");
}

// Ground truth is either a function of the trial — called after the model has answered, with what
// the trial actually did — or a constant, for tasks whose truth is fixed. Passing the trial in lets
// a task define truth as "what my tools really returned", the only honest truth when the endpoint
// is random (see tasks/lookup.js).
async function resolveGround(task, ctx) {
  const g = task.eval.ground;
  return typeof g === "function" ? g(ctx) : g;
}

/** Run a single (task, mode, client) trial once and score it. Never throws. */
export async function runTrial({ task, mode, client, index = 1, signal, maxRounds = 4 }) {
  // A task carries a spec per mode (task[mode]). planMatrix only schedules the modes a task
  // declares, so a missing spec here means runTrial was called directly with a bad pair.
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
    toolUseOk: null,
    toolUseReason: "",
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
      resp = await client.runWithTools(spec.prompt, spec.tools ?? [], system, { maxRounds, signal, task, mode });
      record.toolCalls = resp.toolCalls ?? [];
      record.toolResults = resp.toolResults ?? [];
      record.rounds = resp.rounds ?? 0;
      record.structured = resp.structured ?? null;
      // A real-harness arm reports the model it actually routed to; record that, not the label.
      if (resp.harness?.model) record.model = resp.harness.model;
      if (resp.harness) record.harness = resp.harness.kind ?? "unknown";

      // Schema validation belongs to the structured path. With no schema to check against
      // (toolOnly), schemaValid stays null rather than posing as a verdict.
      if (structured && spec.schema) {
        const { valid, errors } = validateSchema(resp.structured, spec.schema);
        record.schemaValid = resp.structured !== null && valid;
        record.schemaErrors = resp.structured === null ? ["final message was not JSON"] : errors;
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

    // Truth: fetched after the model's reply, so the answer and the ground are taken at the same
    // wall-clock point (the model never sees it). The trial is passed in so a task can define
    // truth in terms of what its tools actually returned.
    const ground = await resolveGround(task, {
      mode,
      toolCalls: record.toolCalls,
      toolResults: record.toolResults,
      structured: record.structured,
      answerText: record.answerText,
    });
    record.ground = ground;

    // Structured modes score the parsed JSON; free-form scores the raw text.
    const scorer = structured ? task.eval.scoreHarness : task.eval.scoreNoHarness;
    const answer = structured ? record.structured : record.answerText;
    const score = await scorer(answer, ground);

    record.correct = !!score.correct;
    record.reason = score.reason ?? "";

    // Was the tool used correctly — right tool, right arguments, right calls? A separate signal
    // from "final answer correct": a model can reach the right answer by hand after firing the
    // wrong tool, or fire the right tool and still misreport. Judged only when the spec carried
    // tools and the task defines a judge; null otherwise.
    if (hasTools && typeof task.eval.toolUse === "function") {
      const use = await task.eval.toolUse({ mode, toolCalls: record.toolCalls, toolResults: record.toolResults });
      record.toolUseOk = !!use.ok;
      record.toolUseReason = use.reason ?? "";
    }
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
 * The cells a request would actually run, in execution order (task → mode → client), and the
 * (task, mode) pairs it skips because the task declares no spec for that mode. Skipping — rather
 * than scoring an "unsupported mode" error row — keeps a mode's numbers about the model.
 */
export function planMatrix({ tasks, modes, clients, count = 1 }) {
  const cells = [];
  const skipped = [];
  for (const task of tasks) {
    for (const mode of modes) {
      if (!task[mode]) {
        skipped.push({ task: task.name, mode });
        continue;
      }
      for (const client of clients) cells.push({ task, mode, client });
    }
  }
  return { cells, skipped, total: cells.length * count };
}

/**
 * Run the full tasks x modes x clients matrix, `count` trials per cell.
 * `onEvent` receives { type: "start" | "trial" | "done", ... } as work completes.
 */
export async function runMatrix({ tasks, modes, clients, count = 1, onEvent, signal, maxRounds }) {
  const { cells, skipped, total } = planMatrix({ tasks, modes, clients, count });
  const rows = [];
  let completed = 0;

  onEvent?.({
    type: "start",
    total,
    skipped,
    tasks: tasks.map((t) => t.name),
    modes,
    clients: clients.map((c) => c.name),
    count,
  });

  outer:
  for (const { task, mode, client } of cells) {
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) break outer;
      const row = await runTrial({ task, mode, client, index: i + 1, signal, maxRounds });
      rows.push(row);
      completed += 1;
      onEvent?.({ type: "trial", completed, total, result: row });
    }
  }

  const summary = summarize(rows);
  onEvent?.({ type: "done", completed, total, summary, skipped, cancelled: !!signal?.aborted });
  return { rows, summary, skipped };
}

// ---- statistical significance --------------------------------------------------------------
//
// The harness delta is the whole point of the benchmark, so a bare difference of two percentages
// tells you almost nothing — with a few trials, a 30-point gap is easily sampling noise. Every
// delta therefore carries a real answer to "is this gap real?":
//
//   - fisherExact   — Fisher's exact test on the 2×2 table (correct/incorrect × baseline/harness).
//                     It is exact at any sample size, which matters here: this bench routinely
//                     runs 1–5 trials per cell, where a z-test's normal approximation is invalid.
//                     This is the headline p-value.
//   - twoPropZTest  — the two-proportion z-test, kept for large samples and as a reference.
//   - wilsonInterval — a confidence band on a single proportion that stays honest near 0% / 100%.
//
// All pure math, no deps.

// Standard normal CDF via Abramowitz & Stegun 7.1.26 (max abs error 1.5e-7).
function normalCDF(z) {
  if (z === 0) return 0.5;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592;
  const erf = 1 - poly * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
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

// log(n!) with a growing memo. Fisher's test needs binomial coefficients that overflow doubles
// past n ≈ 170, so everything stays in log space.
const LOG_FACT = [0];
function logFactorial(n) {
  for (let i = LOG_FACT.length; i <= n; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
}
function logChoose(n, k) {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

// Fisher's exact test, two-sided: with the margins fixed, the probability of every table at least
// as unlikely as the observed one (the convention R's fisher.test uses).
// n1/x1 = trials/correct in one group, n2/x2 in the other.
function fisherExact(n1, x1, n2, x2) {
  const N = n1 + n2;
  const K = x1 + x2;
  const lo = Math.max(0, K - n2);
  const hi = Math.min(K, n1);
  const logP = (x) => logChoose(n1, x) + logChoose(n2, K - x) - logChoose(N, K);
  const observed = logP(x1);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logP(x);
    if (lp <= observed + 1e-9) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

export function pct(rows, cond) {
  if (!rows.length) return 0;
  return (rows.filter(cond).length / rows.length) * 100;
}

export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Exported so the significance helpers can be unit-tested and reused (e.g. per-cell significance).
export { normalCDF, twoPropZTest, wilsonInterval, fisherExact, deltaFor };

// Nearest-rank percentile (p in 0..100) of a list of numbers; 0 for an empty list.
export function percentile(xs, p) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

function statsFor(rows) {
  const judged = rows.filter((r) => r.toolUseOk === true || r.toolUseOk === false);
  const latencies = rows.map((r) => r.latencyMs ?? 0);
  return {
    runs: rows.length,
    correct: rows.filter((r) => r.correct).length,
    correctPct: pct(rows, (r) => r.correct),
    toolUsePct: pct(rows, (r) => (r.toolCalls?.length ?? 0) > 0),
    // Tool-use hygiene: of the rows a task judged, how many used the tool correctly.
    toolArgsJudged: judged.length,
    toolArgsOkPct: pct(judged, (r) => r.toolUseOk === true),
    schemaValidPct: pct(rows, (r) => r.schemaValid === true),
    errorPct: pct(rows, (r) => !!r.error),
    avgLatencyMs: Math.round(mean(latencies)),
    latencyP50Ms: Math.round(percentile(latencies, 50)),
    latencyP95Ms: Math.round(percentile(latencies, 95)),
    latencyMaxMs: latencies.length ? Math.max(...latencies) : 0,
    totalTokens: rows.reduce((a, r) => a + (r.usage?.total_tokens ?? 0), 0),
  };
}

function deltaFor(rows) {
  const noH = rows.filter((r) => r.mode === "noHarness");
  const withH = rows.filter((r) => r.mode === "harness");
  if (!noH.length || !withH.length) return null;
  const n = noH.length;
  const m = withH.length;
  const x1 = noH.filter((r) => r.correct).length;
  const x2 = withH.filter((r) => r.correct).length;
  const a = (x1 / n) * 100;
  const b = (x2 / m) * 100;
  const pValue = fisherExact(n, x1, m, x2);
  // The smallest p these sample sizes can produce at all (a 0% → 100% split). When even that is
  // ≥ 0.05, no outcome of this run could have been significant: the honest reading is "run more
  // trials", not "no effect".
  const minPValue = Math.min(fisherExact(n, 0, m, m), fisherExact(n, n, m, 0));
  return {
    noHarnessPct: a,
    harnessPct: b,
    deltaPp: b - a,
    noHarnessRuns: n,
    harnessRuns: m,
    noHarnessCorrect: x1,
    harnessCorrect: x2,
    // Two-sided Fisher exact p-value: the probability of a gap at least this large if the harness
    // made no difference. A harness that *hurts* is a real difference too, hence two-sided.
    pValue,
    minPValue,
    significant: pValue < 0.05,
    test: "fisher-exact",
    z: twoPropZTest(n, x1, m, x2).z,
    // Wilson intervals on each rate: confidence bands that are honest near 0% / 100%.
    noHarnessWilson: wilsonInterval(x1, n),
    harnessWilson: wilsonInterval(x2, m),
  };
}

// One phrasing of "is this gap real?" shared by the CLI, the aggregator and the web UI.
export function describeSignificance(d) {
  if (!d) return "n/a — needs both noHarness and harness";
  const n = `${d.noHarnessRuns} vs ${d.harnessRuns} trials`;
  const p = d.pValue < 0.001 ? "p<0.001" : `p=${d.pValue.toFixed(2)}`;
  if (d.pValue < 0.05) return `significant · ${p} · ${n}`;
  if (d.minPValue >= 0.05) return `inconclusive · ${p} · ${n} — too few trials for any result to reach p<0.05`;
  return `not significant · ${p} · ${n}`;
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

  // Per (task, client) — the finest grain a delta makes sense at; keyed "task|client".
  const byTaskClient = {};
  for (const t of taskNames) {
    for (const c of clientNames) {
      const sub = rows.filter((r) => r.task === t && r.client === c);
      if (sub.length) byTaskClient[`${t}|${c}`] = deltaFor(sub);
    }
  }

  return {
    runs: rows.length,
    tasks: taskNames,
    modes,
    clients: clientNames,
    byMode,
    cells,
    delta: { overall: deltaFor(rows), byTask, byClient, byTaskClient },
  };
}
