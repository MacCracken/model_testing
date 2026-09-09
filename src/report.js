import { traceEvents } from "./export.js";
import { fmtUsd } from "./prices.js";
// report.js — print a run summary the same way everywhere (aggregate.js after a run, `cli show`
// for a saved one). Pure formatting over the runner's summary shape.

import { describeSignificance, twoByTwo, describeStability, describePaired, describePower } from "./runner.js";

const fmtDelta = (d) => d
  ? `${d.noHarnessPct.toFixed(1)}% -> ${d.harnessPct.toFixed(1)}% (${d.deltaPp >= 0 ? "+" : ""}${d.deltaPp.toFixed(1)}pp)  [${describeSignificance(d)}]`
  : describeSignificance(null);

export function printSummary(summary, { log = console.log } = {}) {
  for (const mode of summary.modes) {
    const s = summary.byMode[mode];
    log(`-- mode: ${mode}`);
    log(`   correct:      ${s.correct}/${s.runs} (${s.correctPct.toFixed(1)}%)`);
    log(`   schemaValid:  ${s.schemaValidPct.toFixed(1)}%`);
    log(`   toolCalls:    ${s.toolUsePct.toFixed(1)}%`);
    log(`   toolArgsOk:   ${s.toolArgsJudged ? `${s.toolArgsOkPct.toFixed(1)}% of ${s.toolArgsJudged} judged` : "n/a"}`);
    log(`   errors:       ${s.errorPct.toFixed(1)}%`);
    log(`   latency:      avg ${s.avgLatencyMs}ms · p50 ${s.latencyP50Ms}ms · p95 ${s.latencyP95Ms}ms · max ${s.latencyMaxMs}ms`);
    if (s.ttftP50Ms !== null) log(`   first token:  p50 ${s.ttftP50Ms}ms (any) · ${s.ttfaP50Ms ?? "—"}ms (answer)`);
    if (s.judged) log(`   judge:        mean score ${s.judgeMeanScore.toFixed(2)} over ${s.judged} judged`);
    if (summary.stability?.[mode]?.repeated) log(`   stability:    ${describeStability(summary.stability[mode])}`);
  }

  log("\n-- per task x mode x client");
  for (const cell of summary.cells) {
    log(`   ${cell.task.padEnd(8)} ${cell.mode.padEnd(10)} ${cell.client.padEnd(28)} ${cell.correct}/${cell.runs} (${cell.correctPct.toFixed(0)}%)  ${cell.avgLatencyMs}ms`);
  }

  const box = twoByTwo(summary);
  if (box) {
    const c = (m) => (box.grid[m] ? `${box.grid[m].correct}/${box.grid[m].runs} (${box.grid[m].correctPct.toFixed(0)}%)` : "—");
    const pp = (v) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`);
    log("\n-- 2×2: tools × schema");
    log(`                 no schema        schema`);
    log(`   no tools      ${c("noHarness").padEnd(16)} ${c("schemaOnly")}`);
    log(`   tools         ${c("toolOnly").padEnd(16)} ${c("harness")}`);
    log(`   tools effect ${pp(box.toolsEffect)} · schema effect ${pp(box.schemaEffect)} · interaction ${pp(box.interaction)}`);
  }

  if (summary.cost?.some((c) => c.priced)) {
    const usd = fmtUsd;
    const showReasoning = summary.cost.some((c) => c.reasoningCharsMean > 0);
    log("\n-- correctness × cost × latency (per model and mode; prices from models/prices.json on the run's day)");
    for (const c of summary.cost) log(`   ${c.client.padEnd(30)} ${c.mode.padEnd(10)} ${`${c.correct}/${c.runs} (${c.correctPct.toFixed(0)}%)`.padEnd(14)} ${`${usd(c.costUsd)} total`.padEnd(15)} ${`${usd(c.costPerTrialUsd)}/trial`.padEnd(15)} ${`${usd(c.costPerCorrectUsd)}/correct`.padEnd(17)} p50 ${c.latencyP50Ms}ms${c.unpriced ? `  (${c.unpriced} unpriced)` : ""}${showReasoning && c.reasoningCharsMean !== null ? `  reasoning ${c.reasoningCharsMean} chars` : ""}`);
  }
  if (summary.delta?.effort) {
    log("\n-- effort variants (paired against the base client)");
    for (const [how, d] of Object.entries(summary.delta.effort)) log(`   @effort:${how.padEnd(8)} ${fmtDelta(d)}${d.reasoningCharsMean !== null ? ` · reasoning ${d.reasoningCharsMean} chars` : ""}`);
  }

  log("\n-- harness delta (correctness)");
  log(`   overall:      ${fmtDelta(summary.delta.overall)}`);
  if (summary.delta.overall?.paired) log(`   paired:       ${describePaired(summary.delta.overall.paired)}`);
  if (summary.delta.overall && !summary.delta.overall.significant) { const p = describePower(summary.delta.overall); if (p) log(`   power:        ${p}`); }
  if (summary.multiple) log(`   comparisons:  ${summary.multiple.comparisons} task × model cells · ${summary.multiple.significantRaw} significant at 0.05, ${summary.multiple.significantBonferroni} after Bonferroni (α=${summary.multiple.bonferroniAlpha.toFixed(4)}; ~${summary.multiple.expectedFalsePositives.toFixed(1)} false positives expected by chance)`);
  for (const [task, d] of Object.entries(summary.delta.byTask)) log(`   ${task.padEnd(13)} ${fmtDelta(d)}`);
  for (const [client, d] of Object.entries(summary.delta.byClient)) log(`   ${client.padEnd(13)} ${fmtDelta(d)}`);

  if (summary.capabilities && Object.keys(summary.capabilities).length) {
    log("\n-- capability scorecard (harness · raw · delta per model)");
    for (const [cap, c] of Object.entries(summary.capabilities)) {
      for (const [client, st] of Object.entries(c.byClient)) {
        const h = st.byMode.harness, r = st.byMode.noHarness;
        const cell = (m) => (m ? `${m.correct}/${m.runs} (${m.correctPct.toFixed(0)}%, ${(m.wilson.low * 100).toFixed(0)}–${(m.wilson.high * 100).toFixed(0)})` : "—");
        log(`   ${cap.padEnd(22)} ${client.padEnd(30)} harness ${cell(h).padEnd(24)} raw ${cell(r).padEnd(24)} ${st.delta ? `${st.delta.deltaPp >= 0 ? "+" : ""}${st.delta.deltaPp.toFixed(0)}pp` : ""}`);
      }
    }
  }

  if (summary.curves && Object.keys(summary.curves).length) {
    log("\n-- difficulty curves (harness; break = first level whose band tops out under 50%)");
    for (const [family, c] of Object.entries(summary.curves)) {
      for (const [client, byMode] of Object.entries(c.byClient)) {
        const m = byMode.harness ?? Object.values(byMode)[0];
        if (!m) continue;
        log(`   ${family.padEnd(10)} ${client.padEnd(30)} ${m.points.map((p) => `${p.level}: ${p.correct}/${p.runs}`).join("  ").padEnd(40)} break ${m.breakingPoint ?? "none"}`);
      }
    }
  }

  if (summary.depths) {
    log("\n-- needle depth sweep (one planted line: success by its depth in the log)");
    for (const [client, byMode] of Object.entries(summary.depths.byClient)) {
      for (const [mode, byDepth] of Object.entries(byMode)) {
        log(`   ${client.padEnd(30)} ${mode.padEnd(10)} ${summary.depths.depths.map((d) => { const p = byDepth[d]; return p ? `${Math.round(d * 100)}%: ${p.correct}/${p.runs}` : ""; }).filter(Boolean).join("  ")}`);
      }
    }
  }

  if (summary.delta.skill) {
    log("\n-- skill delta (same task, mode and model: without → with the playbook)");
    for (const [how, d] of Object.entries(summary.delta.skill)) {
      log(`   ${how.padEnd(13)} ${fmtDelta(d)}${how === "ondemand" ? ` · loaded in ${d.loaded}/${d.treatRuns}` : ""}`);
    }
    for (const [key, d] of Object.entries(summary.delta.bySkill ?? {})) {
      log(`   ${key.padEnd(52)} ${fmtDelta(d)}${d.how === "ondemand" ? ` · loaded in ${d.loaded}/${d.treatRuns}` : ""}`);
    }
  }

  if (summary.delta.agents) {
    log("\n-- sub-agents delta (same task, mode and model: without → with delegation)");
    for (const [how, d] of Object.entries(summary.delta.agents)) {
      log(`   ${how.padEnd(13)} ${fmtDelta(d)} · delegated in ${d.used}/${d.treatRuns} · ${d.delegations} sub-agent(s) · child tokens ${d.childTokens}`);
    }
    for (const [key, d] of Object.entries(summary.delta.byAgents ?? {})) {
      log(`   ${key.padEnd(52)} ${fmtDelta(d)} · delegated in ${d.used}/${d.treatRuns}`);
    }
  }

  if (summary.delta.stress) {
    log("\n-- stress delta (same task, mode and model: plain → under stress)");
    for (const [how, d] of Object.entries(summary.delta.stress)) {
      log(`   ${how.padEnd(13)} ${fmtDelta(d)} · ${d.failed} failures served · ${d.rejected} refused · ${d.distractorCalls} distractor calls (${d.trap} reorder-all) · hijacked in ${d.hijackedTrials}/${d.treatRuns} trials`);
    }
    for (const [key, d] of Object.entries(summary.delta.byStress ?? {})) log(`   ${key.padEnd(52)} ${fmtDelta(d)}`);
  }

  if (summary.delta.constraints) {
    log("\n-- constraints delta (same task, mode and model: plain → with formatting requirements)");
    for (const [how, d] of Object.entries(summary.delta.constraints)) {
      log(`   ${how.padEnd(13)} ${fmtDelta(d)} · adherence ${d.total ? ((100 * d.met) / d.total).toFixed(0) : "—"}% (${d.met}/${d.total} requirements met)`);
    }
    for (const [key, d] of Object.entries(summary.delta.byConstraints ?? {})) log(`   ${key.padEnd(52)} ${fmtDelta(d)} · adherence ${d.total ? ((100 * d.met) / d.total).toFixed(0) : "—"}%`);
  }

  if (summary.delta.format) {
    log("\n-- format delta (same task, mode and model: the schema as written → with the work field stripped or added)");
    for (const [how, d] of Object.entries(summary.delta.format)) {
      log(`   ${how.padEnd(13)} ${fmtDelta(d)} · applied in ${d.applied}/${d.treatRuns} · complied in ${d.complied}/${d.applied}`);
    }
    for (const [key, d] of Object.entries(summary.delta.byFormat ?? {})) log(`   ${key.padEnd(52)} ${fmtDelta(d)} · applied ${d.applied}/${d.treatRuns} · complied ${d.complied}/${d.applied}`);
  }

  const arms = Object.entries(summary.delta.byArm ?? {});
  if (arms.length) {
    log("\n-- harness arms vs the free-form baseline of the same model");
    for (const [client, a] of arms) {
      log(`   ${client}  (model ${a.model}; baseline from ${a.baselineClients.join(", ")})`);
      log(`      overall:    ${fmtDelta(a.overall)}`);
      for (const [task, d] of Object.entries(a.byTask)) log(`      ${task.padEnd(11)} ${fmtDelta(d)}`);
    }
  }

  const cells = Object.entries(summary.delta.byTaskClient ?? {});
  if (cells.length > 1) {
    log("\n-- harness delta per task x client");
    for (const [key, d] of cells) {
      const [task, client] = key.split("|");
      log(`   ${task.padEnd(8)} ${client.padEnd(28)} ${fmtDelta(d)}`);
    }
  }
}

// A compact task × mode table (counts), handy for pasting into notes.
export function summaryTable(summary) {
  const modes = summary.modes;
  const head = `| task | ${modes.join(" | ")} |`;
  const sep = `|---|${modes.map(() => "---").join("|")}|`;
  const rows = summary.tasks.map((task) => {
    const cells = modes.map((mode) => {
      const sub = summary.cells.filter((c) => c.task === task && c.mode === mode);
      const runs = sub.reduce((a, c) => a + c.runs, 0);
      const correct = sub.reduce((a, c) => a + c.correct, 0);
      return runs ? `${correct}/${runs}` : "—";
    });
    return `| ${task} | ${cells.join(" | ")} |`;
  });
  const totals = modes.map((m) => `${summary.byMode[m].correct}/${summary.byMode[m].runs}`);
  return [head, sep, ...rows, `| **all** | ${totals.map((t) => `**${t}**`).join(" | ")} |`].join("\n");
}

// One trial as a timeline: what the model was told, what it said and did, when, and how it was
// scored — plain text, one event per line, in the order the drawer shows and the JSONL export
// carries.
export function trialTimeline(row) {
  const verdict = row.error ? `error: ${row.error}` : `${row.correct ? "pass" : "fail"} · ${row.reason || "—"}`;
  const L = [
    `${row.task} · ${row.mode} · ${row.client} · #${row.index} · ${verdict}`,
    [
      row.model ? `model ${row.model}` : null,
      typeof row.latencyMs === "number" ? `${row.latencyMs} ms` : null,
      row.usage?.total_tokens ? `${row.usage.total_tokens} tokens` : null,
      row.rounds ? `${row.rounds} round(s)` : null,
      row.harness ? `${row.harness} arm` : null,
      typeof row.seed === "number" ? `seed ${row.seed}` : null,
    ].filter(Boolean).join(" · "),
    "",
  ];
  const clip = (v) => {
    const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > 160 ? `${one.slice(0, 157)}…` : one;
  };
  const tag = (kind) => `${"".padStart(9)}  ${kind.padEnd(11)}`;
  for (const e of traceEvents(row)) {
    const at = typeof e.ms === "number" ? `+${e.ms}ms` : "";
    let line;
    switch (e.kind) {
      case "tool_call": line = `→ ${e.name}${e.agent ? ` (sub-agent ${e.agent})` : ""} ${clip(e.args)}`; break;
      case "tool_result": line = `← ${e.name} ${e.ok ? "ok" : "error"} ${clip(e.output)}`; break;
      default: line = clip(e.text);
    }
    L.push(`${at.padStart(9)}  ${e.kind.padEnd(11)} ${line}`);
  }
  L.push("");
  if (row.schemaValid !== null && row.schemaValid !== undefined) L.push(`${tag("schema")} ${row.schemaValid ? "valid" : `invalid: ${(row.schemaErrors ?? []).join("; ")}`}`);
  if (row.toolUseOk !== null && row.toolUseOk !== undefined) L.push(`${tag("tool use")} ${row.toolUseOk ? "correct" : "wrong"}${row.toolUseReason ? `: ${row.toolUseReason}` : ""}`);
  if (typeof row.judgeScore === "number") L.push(`${tag("judge")} ${row.judgeScore.toFixed(2)}${row.judgeReason ? `: ${row.judgeReason}` : ""}`);
  L.push(`${tag("verdict")} ${verdict}`);
  return L.join("\n");
}
