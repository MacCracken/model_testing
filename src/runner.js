// runner.js — the shared execution core.
//
// One place where a (task, mode, client) cell is actually run and scored, used by the CLI
// (`bench.js`, `aggregate.js`) and by the web UI alike, so every surface reports the same
// numbers. Callers get progress via `onEvent` and can cancel with an AbortSignal.

import { validateSchema, schemaHint } from "./schema.js";

export const MODES = ["noHarness", "harness"];

// The harness is defined as "tools + output schema + structured prompts". The schema therefore
// belongs in the prompt the model sees, not only in the scorer.
export function buildSystemPrompt(spec, mode) {
  const base = spec.system ?? "";
  if (mode !== "harness" || !spec.schema) return base;
  return [
    base,
    "Return your final answer as JSON matching this schema exactly:",
    schemaHint(spec.schema),
    "Reply with the JSON only — no prose, no markdown fences.",
  ].filter(Boolean).join("\n\n");
}

/** Run a single (task, mode, client) trial once and score it. Never throws. */
export async function runTrial({ task, mode, client, index = 1, signal, maxRounds = 4 }) {
  const spec = mode === "harness" ? task.harness : task.noHarness;
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

    let resp;
    if (mode === "harness") {
      resp = await client.runWithTools(spec.prompt, spec.tools ?? [], system, { maxRounds, signal });
      record.toolCalls = resp.toolCalls ?? [];
      record.toolResults = resp.toolResults ?? [];
      record.rounds = resp.rounds ?? 0;
      record.structured = resp.structured ?? null;

      if (spec.schema) {
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

    const ground = await task.eval.ground();
    record.ground = ground;

    const scorer = mode === "harness" ? task.eval.scoreHarness : task.eval.scoreNoHarness;
    const answer = mode === "harness" ? record.structured : record.answerText;
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

// ---- aggregation -------------------------------------------------------------------------

export function pct(rows, cond) {
  if (!rows.length) return 0;
  return (rows.filter(cond).length / rows.length) * 100;
}

export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

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
  return {
    noHarnessPct: a,
    harnessPct: b,
    deltaPp: b - a,
    noHarnessRuns: noH.length,
    harnessRuns: withH.length,
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
