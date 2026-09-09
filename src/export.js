// export.js — CSV views of a run: one line per trial, or one per task × model × mode cell.
// Plain strings in, plain strings out; no dependencies.

const ROW_COLUMNS = [
  "run", "task", "mode", "client", "model", "index", "correct", "reason", "error",
  "toolCalls", "toolUseOk", "toolUseReason", "schemaValid", "judgeScore", "judgeReason", "latencyMs", "ttftMs", "ttfaMs",
  "promptTokens", "completionTokens", "totalTokens", "rounds", "finishReason", "startedAt", "canon", "skill", "baseClient", "agents", "delegations", "stress", "seed", "constraints", "adherencePct",
];

const CELL_COLUMNS = [
  "run", "task", "client", "mode", "runs", "correct", "correctPct", "toolUsePct", "toolArgsOkPct",
  "schemaValidPct", "errorPct", "avgLatencyMs", "latencyP50Ms", "latencyP95Ms", "ttftP50Ms", "ttfaP50Ms", "totalTokens",
  "agreementPct", "distinctAnswers", "flaky",
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
    canon: r.canon ?? null,
    skill: r.skill?.how ?? null,
    baseClient: r.baseClient ?? null,
    agents: r.agents?.how ?? null,
    delegations: r.agents ? r.agents.delegations ?? 0 : null,
    stress: r.stress?.how ?? null,
    seed: r.seed ?? null,
    constraints: r.constraints?.how ?? null,
    adherencePct: r.constraints?.total ? (100 * r.constraints.met) / r.constraints.total : null,
  })));
}

export function cellsToCsv(runId, summary) {
  return csv(CELL_COLUMNS, summary.cells.map((c) => ({ run: runId, ...c, toolArgsOkPct: c.toolArgsJudged ? c.toolArgsOkPct : null })));
}

// A trial as an event log — the transcript protocol trace tools speak (one event per line, the
// kinds system / user / assistant / tool_call / tool_result), so a row can be handed to a trace
// viewer or set beside a recording. `seq` is the position; `ms` the time since the trial started
// where the row knows it (the synthetic loop's turns). With turns, the order is the session's:
// each turn's text, then the calls it made and their results; without them (an arm, an old row),
// every call and result, then the final message.
export function traceEvents(row) {
  const events = [];
  const push = (kind, payload) => events.push({ seq: events.length, kind, ...payload });
  if (row.system) push("system", { text: row.system });
  push("user", { text: row.prompt ?? "" });
  const calls = row.toolCalls ?? [];
  const results = row.toolResults ?? [];
  const resultFor = (c, i) => (c.id !== undefined && c.id !== null ? results.find((r) => r.id === c.id) : undefined) ?? results[i];
  let i = 0;
  const callEvents = (list) => {
    for (const c of list) {
      push("tool_call", { id: c.id ?? `call_${i + 1}`, name: c.name, args: c.arguments ?? {}, ...(c.agent ? { agent: c.agent } : {}) });
      const r = resultFor(c, i);
      if (r) push("tool_result", { id: c.id ?? r.id ?? `call_${i + 1}`, name: r.name ?? c.name, ok: r.ok !== false, output: r.content ?? null });
      i++;
    }
  };
  if (Array.isArray(row.turns) && row.turns.length) {
    const named = new Set();
    row.turns.forEach((t, ti) => {
      const own = calls.filter((c) => (t.calls ?? []).includes(c.id));
      for (const c of own) named.add(c.id);
      const last = ti === row.turns.length - 1;
      if (t.text || !own.length) push("assistant", { text: t.text ?? "", ...(typeof t.ms === "number" ? { ms: t.ms } : {}), round: t.round ?? ti + 1, ...(last && !own.length ? { finish_reason: t.finishReason ?? row.finishReason ?? null } : {}) });
      callEvents(own);
    });
    callEvents(calls.filter((c) => !named.has(c.id)));
  } else {
    callEvents(calls);
    push("assistant", { text: row.answerText ?? "", finish_reason: row.finishReason ?? null });
  }
  return events;
}

export function traceJsonl(row) {
  const events = traceEvents(row);
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

export { ROW_COLUMNS, CELL_COLUMNS };
