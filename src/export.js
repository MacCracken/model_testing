// export.js — CSV views of a run: one line per trial, or one per task × model × mode cell.
// Plain strings in, plain strings out; no dependencies.

const ROW_COLUMNS = [
  "run", "task", "mode", "client", "model", "index", "correct", "reason", "error",
  "toolCalls", "toolUseOk", "toolUseReason", "schemaValid", "judgeScore", "judgeReason", "latencyMs", "ttftMs", "ttfaMs",
  "promptTokens", "completionTokens", "totalTokens", "rounds", "finishReason", "startedAt",
];

const CELL_COLUMNS = [
  "run", "task", "client", "mode", "runs", "correct", "correctPct", "toolUsePct", "toolArgsOkPct",
  "schemaValidPct", "errorPct", "avgLatencyMs", "latencyP50Ms", "latencyP95Ms", "ttftP50Ms", "ttfaP50Ms", "totalTokens",
];

function csvField(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(columns, records) {
  return [columns.join(","), ...records.map((rec) => columns.map((c) => csvField(rec[c])).join(","))].join("\n") + "\n";
}

export function rowsToCsv(run) {
  return csv(ROW_COLUMNS, run.rows.map((r) => ({
    run: run.id,
    task: r.task,
    mode: r.mode,
    client: r.client,
    model: r.model,
    index: r.index,
    correct: r.correct,
    reason: r.reason,
    error: r.error,
    toolCalls: r.toolCalls?.length ?? 0,
    toolUseOk: r.toolUseOk ?? null,
    toolUseReason: r.toolUseReason ?? "",
    schemaValid: r.schemaValid ?? null,
    judgeScore: r.judgeScore ?? null,
    judgeReason: r.judgeReason ?? "",
    latencyMs: r.latencyMs,
    ttftMs: r.ttftMs ?? null,
    ttfaMs: r.ttfaMs ?? null,
    promptTokens: r.usage?.prompt_tokens ?? null,
    completionTokens: r.usage?.completion_tokens ?? null,
    totalTokens: r.usage?.total_tokens ?? null,
    rounds: r.rounds ?? null,
    finishReason: r.finishReason ?? null,
    startedAt: r.startedAt,
  })));
}

export function cellsToCsv(runId, summary) {
  return csv(CELL_COLUMNS, summary.cells.map((c) => ({ run: runId, ...c, toolArgsOkPct: c.toolArgsJudged ? c.toolArgsOkPct : null })));
}

export { ROW_COLUMNS, CELL_COLUMNS };
