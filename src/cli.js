#!/usr/bin/env node
// cli.js — entry point. Select providers/tasks/modes and dispatch.
//
// Examples:
//   node src/cli.js list
//   node src/cli.js serve --port 4000
//   node src/cli.js bench --task health --mode harness --clients openai:gpt-4o-mini
//   node src/cli.js aggregate --tasks health,hello --modes noHarness,harness

import "./env.js";
import "./store.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { listTasks } from "./tasks/registry.js";
import { PROVIDERS, hasCredentials, labelModel, probeLocalModels } from "./providers/index.js";
import { parseArgs } from "./args.js";
import { listRuns, loadRun, saveRun } from "./results.js";
import { summarize } from "./runner.js";
import { printSummary, summaryTable } from "./report.js";
import { rowsToCsv, cellsToCsv, traceEvents, traceJsonl } from "./export.js";
import { writeFileSync } from "node:fs";

const SRC = dirname(fileURLToPath(import.meta.url));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "list": {
      console.log("Tasks:");
      for (const t of listTasks()) {
        console.log(`  ${t.name.padEnd(10)} ${t.category.padEnd(15)} modes: ${t.modes.join(",").padEnd(30)} ${t.description}`);
      }
      const live = await probeLocalModels();
      console.log("\nProviders:");
      for (const [name, cfg] of Object.entries(PROVIDERS)) {
        const models = name === "local" && live ? live : cfg.models;
        if (cfg.harness && name !== "local") { /* the arm's model is whatever it routes to */ }
        const status = cfg.harness
          ? `harness arm · ${cfg.baseUrl}${cfg.keyEnv ? (hasCredentials(name) ? ` · ${cfg.keyEnv} set` : ` · ${cfg.keyEnv} missing`) : ""}`
          : cfg.needsKey === false
            ? (live ? `live, ${live.length} model(s)` : "offline — showing the fallback list")
            : (hasCredentials(name) ? "key set" : `${name.toUpperCase()}_API_KEY missing`);
        console.log(`  ${name.padEnd(10)} [${status}]`);
        for (const m of models) console.log(`    ${name}:${m.padEnd(30)} ${labelModel(m)}`);
      }
      break;
    }

    // Review a saved run without the UI: `show` lists recent runs, `show <id>` prints one.
    case "show": {
      const args = parseArgs(rest);
      const id = args._[0];
      if (!id) {
        for (const r of listRuns({ limit: 20 })) {
          console.log(`${r.id}  ${r.status.padEnd(9)} ${r.source.padEnd(9)} ${r.config.clients.join(",").padEnd(30)} ${r.config.tasks.join(",")} × ${r.config.modes.join(",")} × ${r.config.count}  (${r.rowCount} rows)${r.parent ? `  replay of ${r.parent.id}` : ""}${r.gates ? `  gates: ${r.gates.verdict}` : ""}`);
        }
        break;
      }
      const run = loadRun(id);
      if (!run) { console.error(`unknown run: ${id}`); process.exit(1); }
      // One trial as a timeline, or every row numbered so a trial can be picked.
      if (args.rows || args.trial) {
        const { trialTimeline } = await import("./report.js");
        if (args.trial) {
          const r = run.rows[args.trial - 1];
          if (!r) { console.error(`run ${id} has ${run.rows.length} rows; --trial takes 1..${run.rows.length}`); process.exit(1); }
          console.log(trialTimeline(r));
        } else {
          run.rows.forEach((r, i) => console.log(`${String(i + 1).padStart(4)}  ${r.error ? "err " : r.correct ? "pass" : "fail"}  ${String(r.task).padEnd(12)} ${String(r.mode).padEnd(10)} ${String(r.client).padEnd(36)} #${String(r.index).padEnd(3)} ${r.error ?? r.reason ?? ""}`));
        }
        break;
      }
      const lineage = run.parent ? ` · replay of ${run.parent.id}` : "";
      const rescored = run.rescored?.length ? ` · re-scored ${String(run.rescored.at(-1).at).slice(0, 10)}` : "";
      const gated = run.gates ? ` · gates ${run.gates.verdict}` : "";
      console.log(`run ${run.id} · ${run.source} · ${run.status} · ${run.config.clients.join(", ")} · ${run.rows.length} rows${lineage}${rescored}${gated}`);
      for (const w of run.warnings ?? []) console.log(`warning: ${w}`);
      console.log("");
      // Summaries are recomputed from the rows, so a run saved before a scorer's *reporting* changed
      // still prints with today's aggregation; the verdicts themselves are whatever was recorded.
      const { listTasks: tasksForTags } = await import("./tasks/registry.js");
      const tagged = tasksForTags();
      const summary = summarize(run.rows, {
        capabilitiesOf: Object.fromEntries(tagged.map((t) => [t.name, t.capabilities])),
        levelsOf: Object.fromEntries(tagged.filter((t) => t.family).map((t) => [t.name, { family: t.family, level: t.level }])),
      });
      printSummary(summary);
      if (args.table) console.log(`\n${summaryTable(summary)}`);
      break;
    }

    // The SQLite index over results/runs: rebuild it, ask it questions, or compact old files.
    case "index": {
      const args = parseArgs(rest);
      const { indexRuns } = await import("./store.js");
      const r = indexRuns({ full: !!args.full });
      console.log(`indexed ${r.indexed}, unchanged ${r.skipped}, removed ${r.removed} → ${r.path}`);
      break;
    }

    case "query": {
      const args = parseArgs(rest);
      const { indexRuns, queryRuns, trend, cellHistory, worstCells, rawQuery, depthSweep } = await import("./store.js");
      indexRuns();
      const what = args._[0];
      const table = (rows) => { if (!rows.length) { console.log("(no rows)"); return; } console.table(rows); };
      if (args.sql) { table(rawQuery(args.sql)); break; }
      if (what === "runs") {
        for (const r of queryRuns({ q: args.q, task: args.task, client: args.client, mode: args.mode, since: args.since, limit: args.limit })) {
          console.log(`${r.id}  ${String(r.status).padEnd(9)} ${String(r.source).padEnd(9)} ${r.config.clients.join(",").padEnd(30)} ${r.config.tasks.join(",")} × ${r.config.modes.join(",")} × ${r.config.count}  (${r.rowCount} rows)${r.compacted ? "  compacted" : ""}${r.gates ? `  gates: ${r.gates.verdict}` : ""}`);
        }
      } else if (what === "trend") {
        if (!args.task || !args.client) { console.error("usage: query trend --task <name> --client <provider:model> [--mode harness]"); process.exit(1); }
        table(trend({ task: args.task, client: args.client, mode: args.mode ?? "harness" }));
      } else if (what === "cell") {
        if (!args.task || !args.client) { console.error("usage: query cell --task <name> --client <provider:model> [--mode harness]"); process.exit(1); }
        const c = cellHistory({ task: args.task, client: args.client, mode: args.mode ?? "harness" });
        console.log(`${c.task} · ${c.client} · ${c.mode}: ${c.correct}/${c.trials} correct across ${c.runs} run(s)${c.correctPct === null ? "" : ` (${c.correctPct.toFixed(1)}%)`}${c.first ? `, ${c.first.slice(0, 10)} → ${c.last.slice(0, 10)}` : ""}`);
        table(c.history);
      } else if (what === "worst") {
        table(worstCells({ mode: args.mode ?? "harness", limit: args.limit ?? 10 }));
      } else if (what === "depth") {
        // The needle depth sweep pooled over the index: one planted line, success by its depth.
        table(depthSweep({ client: args.client ?? null, mode: args.mode ?? null }).map((r) => ({ ...r, depth: `${Math.round(r.depth * 100)}%`, correct_pct: Math.round(r.correct_pct) })));
      } else {
        console.error("usage: node src/cli.js query runs|trend|cell|worst|depth [--task] [--client] [--mode] [--q] [--since] [--limit] | --sql \"select …\"");
        process.exit(1);
      }
      break;
    }

    // A model's capability scorecard pooled over every saved run in the index.
    case "scorecard": {
      const args = parseArgs(rest);
      const client = args._[0];
      if (!client && !args.family) { console.error("usage: node src/cli.js scorecard <client> [--since YYYY-MM-DD] [--json] [--svg <file>]\n       node src/cli.js scorecard --family <family> [--mode harness] [--since D] [--json]"); process.exit(1); }
      const { indexRuns, rawQuery } = await import("./store.js");
      const { capabilityStats } = await import("./runner.js");
      const { listTasks } = await import("./tasks/registry.js");
      indexRuns();
      const q = (s) => s.replace(/'/g, "''");
      // --family: a lineage family's checkpoints side by side, per capability, with a trend across them.
      if (args.family) {
        const { familyMembers } = await import("./lineage.js");
        const { familyScorecard } = await import("./trends.js");
        const { sparklineText } = await import("./charts.js");
        const members = familyMembers(args.family);
        if (!members.length) { console.log(`no lineage entries in family ${args.family} (see models/lineage.json)`); break; }
        const mode = args.mode ?? "harness";
        const rowsByClient = {};
        for (const m of members) rowsByClient[m.id] = rawQuery(`select t.run_id as runId, t.task, t.mode, t.client, t.correct from trials t join runs r on r.id = t.run_id where t.client = '${q(m.id)}' and t.error is null and t.base_client is null${args.since ? ` and r.created_at >= '${q(args.since)}'` : ""}`).map((r) => ({ ...r, correct: !!r.correct }));
        const card = familyScorecard(rowsByClient, Object.fromEntries(listTasks().map((t) => [t.name, t.capabilities])), members, { mode });
        if (args.json) { console.log(JSON.stringify({ family: args.family, ...card }, null, 2)); break; }
        console.log(`family ${args.family} · ${mode} — ${card.members.length} checkpoint(s), ${card.trials} scored trials${args.since ? ` since ${args.since}` : ""}\n`);
        const col = (m) => `${m.checkpoint ?? m.id.split(":").pop()}${m.step !== null ? ` @${m.step}` : ""}`;
        console.log(`${"capability".padEnd(22)} ${card.members.map((m) => col(m).slice(0, 15).padEnd(16)).join("")} trend`);
        for (const cap of card.capabilities) {
          const cells = card.members.map((m) => { const r = m.byCapability[cap]; return (r ? `${r.correct}/${r.runs} ${r.correctPct.toFixed(0)}%` : "—").padEnd(16); });
          console.log(`${cap.padEnd(22)} ${cells.join("")} ${sparklineText(card.members.map((m) => m.byCapability[cap]?.correctPct ?? null))}`);
        }
        console.log(`${"trials".padEnd(22)} ${card.members.map((m) => `${m.trials} in ${m.runs} run(s)`.padEnd(16)).join("")}`);
        console.log("\nper checkpoint in registry order (step, then date), pooled over every saved run; the trend reads left to right across the checkpoints (· = no trials)");
        break;
      }
      const rows = rawQuery(`select t.task, t.mode, t.client, t.idx as trialIndex, t.trial_index as "index", t.correct, r.created_at as createdAt from trials t join runs r on r.id = t.run_id where t.client = '${q(client)}' and t.error is null${args.since ? ` and r.created_at >= '${q(args.since)}'` : ""}`)
        .map((r) => ({ ...r, correct: !!r.correct }));
      if (!rows.length) { console.log(`no trials for ${client}${args.since ? ` since ${args.since}` : ""}`); break; }
      const card = capabilityStats(rows, Object.fromEntries(listTasks().map((t) => [t.name, t.capabilities])));
      // --svg: the radar as a file — harness filled, no harness dashed, one axis per capability.
      if (args.svg) {
        const { radarSvg } = await import("./charts.js");
        const { writeFileSync } = await import("node:fs");
        const axes = Object.keys(card).sort();
        writeFileSync(args.svg, radarSvg(axes, [
          { name: `${client} · no harness`, values: axes.map((a) => card[a].byMode.noHarness?.correctPct ?? null), color: "#888", dashed: true },
          { name: `${client} · harness`, values: axes.map((a) => card[a].byMode.harness?.correctPct ?? null), color: "#6d5bd0", fill: true },
        ], { size: 360, title: `${client} — capability radar over ${rows.length} scored trials` }));
        console.log(`wrote ${args.svg}: ${axes.length} axes over ${rows.length} trials (filled = harness, dashed = no harness)`);
      }
      if (args.json) { console.log(JSON.stringify({ client, trials: rows.length, since: args.since ?? null, capabilities: card }, null, 2)); break; }
      console.log(`${client} — ${rows.length} scored trials${args.since ? ` since ${args.since}` : ""}, ${Object.keys(card).length} capabilities\n`);
      const cell = (m) => (m ? `${String(m.correct).padStart(3)}/${String(m.runs).padEnd(4)} ${m.correctPct.toFixed(0).padStart(3)}%  [${(m.wilson.low * 100).toFixed(0)}–${(m.wilson.high * 100).toFixed(0)}]`.padEnd(24) : "—".padEnd(24));
      console.log(`${"capability".padEnd(22)} ${"harness".padEnd(24)} ${"raw (no harness)".padEnd(24)} ${"delta".padEnd(14)} tasks`);
      for (const [cap, st] of Object.entries(card).sort((a, b) => (b[1].byMode.harness?.correctPct ?? -1) - (a[1].byMode.harness?.correctPct ?? -1))) {
        console.log(`${cap.padEnd(22)} ${cell(st.byMode.harness)} ${cell(st.byMode.noHarness)} ${(st.delta ? `${st.delta.deltaPp >= 0 ? "+" : ""}${st.delta.deltaPp.toFixed(0)}pp ${st.delta.significant ? "*" : ""}` : "—").padEnd(14)} ${st.tasks.join(",")}`);
      }
      console.log("\nbands are 95% Wilson intervals; * = Fisher p < 0.05 for the harness delta");
      break;
    }

    // Difficulty curve of one family pooled over the index: success per level per client, and the
    // breaking point (first level whose Wilson band tops out under 50 %).
    case "curve": {
      const args = parseArgs(rest);
      const family = args._[0];
      const { listTasks } = await import("./tasks/registry.js");
      const families = [...new Set(listTasks().map((t) => t.family).filter(Boolean))];
      if (!family || !families.includes(family)) { console.error(`usage: node src/cli.js curve <${families.join("|")}> [--mode harness] [--client <c>] [--since D]`); process.exit(1); }
      const { indexRuns, rawQuery } = await import("./store.js");
      const { curves } = await import("./runner.js");
      indexRuns();
      const levelsOf = Object.fromEntries(listTasks().filter((t) => t.family === family).map((t) => [t.name, { family, level: t.level }]));
      const q = (s) => s.replace(/'/g, "''");
      const rows = rawQuery(`select t.task, t.mode, t.client, t.correct from trials t join runs r on r.id = t.run_id where t.task in (${Object.keys(levelsOf).map((n) => `'${q(n)}'`).join(",")}) and t.error is null${args.client ? ` and t.client = '${q(args.client)}'` : ""}${args.since ? ` and r.created_at >= '${q(args.since)}'` : ""}`).map((r) => ({ ...r, correct: !!r.correct }));
      if (!rows.length) { console.log(`no trials for ${family}`); break; }
      const c = curves(rows, levelsOf)[family];
      const modes = args.mode ? [args.mode] : ["harness", "noHarness"];
      for (const mode of modes) {
        console.log(`\n${family} · ${mode} — correct/trials per level (95% Wilson band); break = first level whose band tops out under 50%`);
        console.log(`${"client".padEnd(34)} ${c.levels.map((l) => String(l).padEnd(20)).join("")} break`);
        for (const [client, byMode] of Object.entries(c.byClient)) {
          const m = byMode[mode];
          if (!m) continue;
          const cells = c.levels.map((l) => { const p = m.points.find((x) => x.level === l); return p ? `${p.correct}/${p.runs} ${p.correctPct.toFixed(0)}% [${(p.wilson.low * 100).toFixed(0)}–${(p.wilson.high * 100).toFixed(0)}]`.padEnd(20) : "—".padEnd(20); });
          console.log(`${client.padEnd(34)} ${cells.join("")} ${m.breakingPoint ?? "none"}`);
        }
      }
      break;
    }

    // A client's capabilities over time, from the index.
    case "trend": {
      const args = parseArgs(rest);
      if (!args.client) { console.error("usage: node src/cli.js trend --client <c> [--capability <cap>] [--mode harness] [--since D]"); process.exit(1); }
      const { indexRuns, rawQuery } = await import("./store.js");
      const { seriesFor } = await import("./trends.js");
      const { listTasks } = await import("./tasks/registry.js");
      indexRuns();
      const q = (s) => s.replace(/'/g, "''");
      const rows = rawQuery(`select t.run_id as runId, r.created_at as createdAt, t.task, t.mode, t.client, t.correct from trials t join runs r on r.id = t.run_id where t.client = '${q(args.client)}' and t.error is null${args.since ? ` and r.created_at >= '${q(args.since)}'` : ""}`).map((r) => ({ ...r, correct: !!r.correct }));
      if (!rows.length) { console.log(`no trials for ${args.client}`); break; }
      const caps = Object.fromEntries(listTasks().map((t) => [t.name, t.capabilities]));
      const series = seriesFor(rows, caps, { capability: args.capability ?? null, mode: args.mode ?? "harness" });
      const names = [...new Set(series.flatMap((s) => Object.keys(s.byCapability)))].sort();
      console.log(`${args.client} · ${args.mode ?? "harness"} — correct/trials per run\n`);
      console.log(`${"run".padEnd(24)} ${"date".padEnd(11)} ${names.map((n) => n.slice(0, 12).padEnd(13)).join("")}`);
      for (const s of series) console.log(`${s.runId.padEnd(24)} ${String(s.createdAt).slice(0, 10).padEnd(11)} ${names.map((n) => { const m = s.byCapability[n]?.[args.mode ?? "harness"]; return (m ? `${m.correct}/${m.runs} ${m.correctPct.toFixed(0)}%` : "").padEnd(13); }).join("")}`);
      // The same series as sparklines: one bar per run, oldest first.
      const { sparklineText } = await import("./charts.js");
      console.log("");
      for (const n of names) {
        const vals = series.map((s) => s.byCapability[n]?.[args.mode ?? "harness"]?.correctPct ?? null);
        const seen = vals.filter((v) => v !== null);
        console.log(`${n.padEnd(22)} ${sparklineText(vals)}  ${seen.length ? `${seen[0].toFixed(0)}% → ${seen[seen.length - 1].toFixed(0)}% over ${seen.length} run(s)` : ""}`);
      }
      console.log("\nsparkline: one bar per run, oldest first (· = the run did not carry the capability)");
      break;
    }

    // Regressions: each client's latest run against its earlier runs, and each checkpoint against its
    // lineage parent — flagged when the later band lies entirely under the earlier one.
    case "regressions": {
      const args = parseArgs(rest);
      const { indexRuns, rawQuery } = await import("./store.js");
      const { regressionsReport } = await import("./trends.js");
      const { formatRegressions, writeReport, postReport } = await import("./notify.js");
      const { listTasks } = await import("./tasks/registry.js");
      const { loadLineage } = await import("./lineage.js");
      indexRuns();
      const q = (s) => s.replace(/'/g, "''");
      const caps = Object.fromEntries(listTasks().map((t) => [t.name, t.capabilities]));
      const all = rawQuery(`select t.run_id as runId, r.created_at as createdAt, t.task, t.mode, t.client, t.correct from trials t join runs r on r.id = t.run_id where t.error is null and t.base_client is null${args.since ? ` and r.created_at >= '${q(args.since)}'` : ""}`).map((r) => ({ ...r, correct: !!r.correct }));
      const report = regressionsReport(all, caps, loadLineage().entries, { client: args.client ?? null, since: args.since ?? null, minTrials: args.minTrials ?? 4 });
      process.stdout.write(formatRegressions(report, args.json ? "json" : args.format ?? "text"));
      // Delivered elsewhere: a file a CI step reads (JSON, or Markdown for a step summary), a webhook.
      if (args.out) { writeReport(args.out, report, { format: args.format ?? (/\.md$/i.test(args.out) ? "md" : "json") }); console.error(`wrote ${args.out}`); }
      if (args.webhook) {
        const r = await postReport(args.webhook, report);
        console.error(r.ok ? `posted to ${args.webhook} (HTTP ${r.status})` : `webhook ${args.webhook} failed: ${r.error ?? `HTTP ${r.status}`}`);
        if (!r.ok) process.exitCode = 2;
      }
      if (args.fail && report.count) process.exitCode = 1;
      break;
    }

    // Public anchor sets: fetch them, list them, or put a client's anchor rates next to its own tasks.
    case "anchors": {
      const args = parseArgs(rest);
      const sub = args._[0];
      const { SOURCES, fetchAnchor, describeAnchor, CAVEAT } = await import("./anchors.js");
      if (sub === "fetch") {
        const names = !args._[1] || args._[1] === "all" ? Object.keys(SOURCES) : args._[1].split(",");
        for (const n of names) { await fetchAnchor(n, { force: !!args.full }); console.log(describeAnchor(n)); }
        console.log(`\n${CAVEAT}`);
        break;
      }
      if (!sub || sub === "list") {
        for (const n of Object.keys(SOURCES)) console.log(describeAnchor(n));
        console.log(`\n${CAVEAT}\nusage: node src/cli.js anchors fetch [all|<name,…>] | anchors list | anchors <client> [--since D]`);
        break;
      }
      const client = sub;
      const { indexRuns, rawQuery } = await import("./store.js");
      const { listTasks } = await import("./tasks/registry.js");
      const { wilsonInterval } = await import("./runner.js");
      indexRuns();
      const q = (s) => s.replace(/'/g, "''");
      const rows = rawQuery(`select t.task, t.mode, t.correct from trials t join runs r on r.id = t.run_id where t.client = '${q(client)}' and t.error is null and t.base_client is null${args.since ? ` and r.created_at >= '${q(args.since)}'` : ""}`).map((r) => ({ ...r, correct: !!r.correct }));
      const tasks = listTasks();
      const own = (cap) => tasks.filter((t) => !t.source && (t.capabilities ?? []).includes(cap)).map((t) => t.name);
      const cell = (rs) => { if (!rs.length) return "—".padEnd(22); const c = rs.filter((r) => r.correct).length; const w = wilsonInterval(c, rs.length); return `${c}/${rs.length} ${((100 * c) / rs.length).toFixed(0)}% [${(w.low * 100).toFixed(0)}–${(w.high * 100).toFixed(0)}]`.padEnd(22); };
      console.log(`${client} — public anchors next to the bench's own tasks for the same capability, pooled over the index${args.since ? ` since ${args.since}` : ""}\n`);
      console.log(`${"anchor".padEnd(14)} ${"mode".padEnd(11)} ${"anchor".padEnd(22)} ${"own tasks".padEnd(22)} capability · own tasks`);
      let any = false;
      for (const [name, src] of Object.entries(SOURCES)) {
        const mine = rows.filter((r) => r.task === name);
        if (!mine.length) continue;
        any = true;
        const ownTasks = own(src.capability);
        for (const mode of [...new Set(mine.map((r) => r.mode))].sort()) {
          const ownRows = rows.filter((r) => r.mode === mode && ownTasks.includes(r.task));
          console.log(`${name.padEnd(14)} ${mode.padEnd(11)} ${cell(mine.filter((r) => r.mode === mode))} ${cell(ownRows)} ${src.capability} · ${ownTasks.join(",") || "(none)"}`);
        }
      }
      if (!any) console.log(`no anchor trials for ${client} — run e.g. node src/bench.js --task gsm8k,ifeval,bfclsimple --modes noHarness,harness --clients ${client} --count 50`);
      console.log(`\n${CAVEAT}`);
      break;
    }

    // The model registry (models/lineage.json) with what the index holds for each entry.
    case "models": {
      const { loadLineage } = await import("./lineage.js");
      const { indexRuns, rawQuery } = await import("./store.js");
      indexRuns();
      const { file, entries } = loadLineage();
      const counts = Object.fromEntries(rawQuery("select client, count(*) as n, count(distinct run_id) as runs, max(started_at) as last from trials group by client").map((r) => [r.client, r]));
      console.log(`${file} — ${Object.keys(entries).length} entries\n`);
      console.log(`${"client".padEnd(28)} ${"family".padEnd(12)} ${"checkpoint".padEnd(12)} ${"step".padEnd(7)} ${"parent".padEnd(26)} runs   trials  last`);
      for (const e of Object.values(entries)) {
        const c = counts[e.id];
        console.log(`${e.id.padEnd(28)} ${String(e.family ?? "").padEnd(12)} ${String(e.checkpoint ?? "").padEnd(12)} ${String(e.step ?? "").padEnd(7)} ${String(e.parent ?? "").padEnd(26)} ${String(c?.runs ?? 0).padStart(4)}   ${String(c?.n ?? 0).padStart(6)}  ${c?.last ? c.last.slice(0, 10) : "—"}`);
      }
      const unlisted = Object.keys(counts).filter((c) => !entries[c] && !/@/.test(c));
      if (unlisted.length) console.log(`\nclients with runs but no lineage entry: ${unlisted.join(", ")}`);
      // --graph: the registry as a tree per family, each checkpoint with its pooled harness rate.
      if (rest.includes("--graph") && Object.keys(entries).length) {
        const { lineageStats } = await import("./trends.js");
        const { lineageLayout, lineageText } = await import("./charts.js");
        const { listTasks } = await import("./tasks/registry.js");
        const q = (s) => s.replace(/'/g, "''");
        const rows = rawQuery(`select t.run_id as runId, r.created_at as createdAt, t.task, t.mode, t.client, t.correct from trials t join runs r on r.id = t.run_id where t.error is null and t.base_client is null and t.client in (${Object.keys(entries).map((id) => `'${q(id)}'`).join(",")})`).map((r) => ({ ...r, correct: !!r.correct }));
        console.log(`\n${lineageText(lineageLayout(entries, { stats: lineageStats(rows, Object.fromEntries(listTasks().map((t) => [t.name, t.capabilities])), entries) }))}`);
      }
      break;
    }

    // Named presets for a fresh checkpoint: node src/cli.js suite smoke --clients vllm:my-ckpt
    case "suite": {
      const { SUITES, suiteArgs } = await import("./suites.js");
      const name = rest[0];
      if (!name || !SUITES[name]) {
        console.error("usage: node src/cli.js suite <smoke|standard|full> --clients <c1,c2> [--instance-seed N] [--judge …]");
        for (const [k, s] of Object.entries(SUITES)) console.error(`  ${k.padEnd(9)} ${s.description}`);
        process.exit(1);
      }
      const { spawnSync } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const bench = fileURLToPath(new URL("./bench.js", import.meta.url));
      const r = spawnSync(process.execPath, [bench, ...suiteArgs(name, rest.slice(1))], { stdio: "inherit", env: { ...process.env, BENCH_SUITE: name } });
      process.exit(r.status ?? 1);
    }

    // Paired comparison: two clients in one run, or two runs on the same instance seed.
    case "compare": {
      const args = parseArgs(rest);
      const { loadRun } = await import("./results.js");
      const { compareRows, describePaired } = await import("./runner.js");
      const [runA, runB] = args._;
      if (!runA) { console.error("usage: node src/cli.js compare <run-id> --a <client> --b <client> [--mode harness]\n       node src/cli.js compare <run-id-A> <run-id-B> [--mode harness]   # same instance seed"); process.exit(1); }
      const A = loadRun(runA); if (!A) { console.error(`unknown run ${runA}`); process.exit(1); }
      let rowsA, rowsB, labelA, labelB;
      if (runB) {
        const B = loadRun(runB); if (!B) { console.error(`unknown run ${runB}`); process.exit(1); }
        if (A.config?.instanceSeed !== B.config?.instanceSeed) console.log(`note: instance seeds differ (${A.config?.instanceSeed} vs ${B.config?.instanceSeed}) — generated tasks are not the same problems`);
        rowsA = A.rows; rowsB = B.rows; labelA = runA; labelB = runB;
      } else {
        // --parent: compare a checkpoint against the parent its lineage entry names.
        if (args.parent && args.a && !args.b) {
          const { parentOf } = await import("./lineage.js");
          const parent = parentOf(args.a);
          if (!parent) { console.error(`no parent recorded for ${args.a} in the lineage file`); process.exit(1); }
          args.b = args.a; args.a = parent;
        }
        if (!args.a || !args.b) { console.error("compare within a run needs --a <client> --b <client> (or --a <checkpoint> --parent)"); process.exit(1); }
        rowsA = A.rows.filter((r) => r.client === args.a); rowsB = A.rows.filter((r) => r.client === args.b); labelA = args.a; labelB = args.b;
      }
      const c = compareRows(rowsA, rowsB, { mode: args.mode ?? null });
      console.log(`A = ${labelA}\nB = ${labelB}\n${c.pairs} paired trials${args.mode ? ` in ${args.mode}` : ""} (${c.unpairedA} A-only, ${c.unpairedB} B-only)\n`);
      console.log(`${"task".padEnd(12)} ${"A".padEnd(7)} ${"B".padEnd(7)} both  A-only  B-only  neither  McNemar`);
      for (const [task, d] of Object.entries(c.byTask)) console.log(`${task.padEnd(12)} ${(d.aPct.toFixed(0) + "%").padEnd(7)} ${(d.bPct.toFixed(0) + "%").padEnd(7)} ${String(d.both).padStart(4)}  ${String(d.onlyBase).padStart(6)}  ${String(d.onlyTreat).padStart(6)}  ${String(d.neither).padStart(7)}  p=${d.pValue.toFixed(3)}${d.significant ? " *" : ""}`);
      if (c.overall) console.log(`\noverall: A ${c.overall.aPct.toFixed(1)}% → B ${c.overall.bPct.toFixed(1)}% · ${describePaired(c.overall)}`);
      break;
    }

    // Replay: the same tasks, modes, models, instances and knobs as a saved run, as a new run
    // parented to it (any of them overridable), then the paired comparison against the parent.
    case "replay": {
      const id = rest[0];
      if (!id || id.startsWith("--")) { console.error("usage: node src/cli.js replay <run-id> [--clients c1,c2] [--task t1,t2] [--modes m1,m2] [--count N] [--parallel N] [--judge …] [--no-save] [--json]"); process.exit(1); }
      await runScript(join(SRC, "bench.js"), ["--replay", id, ...rest.slice(1)]);
      break;
    }

    // Re-score: today's scorers over a saved run's rows, no model. A dry run prints what would
    // change; --yes writes the new verdicts into the run file (the recorded answers stay).
    case "rescore": {
      const args = parseArgs(rest);
      const { rescoreRun, describeRescore } = await import("./rescore.js");
      const { resolveJudge } = await import("./bench.js");
      const ids = args.all ? listRuns({ limit: 100000 }).map((r) => r.id) : args._;
      if (!ids.length) { console.error("usage: node src/cli.js rescore <run-id> [<run-id>…] | --all   [--judge provider:model] [--yes]"); process.exit(1); }
      let judge = null;
      try { judge = resolveJudge(args.judge); } catch (err) { console.error(err.message); process.exit(1); }
      const totals = { runs: 0, scored: 0, flips: 0, changed: 0, skipped: 0 };
      for (const id of ids) {
        const run = loadRun(id);
        if (!run) { console.error(`unknown run: ${id}`); if (!args.all) process.exit(1); continue; }
        const r = await rescoreRun(run, { judge });
        totals.runs++; totals.scored += r.scored; totals.flips += r.flips.length; totals.changed += r.changed; totals.skipped += r.skipped.length;
        console.log(describeRescore(r, { verbose: !args.all || r.flips.length > 0 }));
        if (args.yes && r.scored) { saveRun(r.run); console.log(`  written: ${id} now carries today's verdicts (${r.flips.length} flipped)`); }
      }
      if (ids.length > 1) console.log(`\n${totals.runs} run(s): ${totals.scored} rows scored, ${totals.flips} flipped, ${totals.changed} with another verdict changed, ${totals.skipped} skipped`);
      if (!args.yes) console.log("dry run — add --yes to write the new verdicts into the run file(s)");
      break;
    }

    // Gates over a saved run: thresholds with an exit code, no model needed. The verdict is written
    // on the run (--no-save to skip) so the history and the headline show it.
    case "gate": {
      const args = parseArgs(rest);
      const id = args._[0];
      if (!id || !(args.gate?.length || args.gates)) {
        console.error("usage: node src/cli.js gate <run-id> --gate <spec>… | --gates <file> [--client <c>] [--min-trials N] [--strict] [--json] [--no-save]\n  spec: <capability|task|family:level|break:family|overall>[@mode] >= <percent>   |   errors <= N   |   regressions <= N");
        process.exit(1);
      }
      const run = loadRun(id);
      if (!run) { console.error(`unknown run: ${id}`); process.exit(1); }
      const { gatesFromArgs, gateNames, gateRun, describeRunGates } = await import("./gates.js");
      const { tasks } = await import("./tasks/registry.js");
      let spec;
      try { spec = gatesFromArgs(args, gateNames(tasks), { fallbackMinTrials: run.config?.count ?? 1 }); } catch (err) { console.error(err.message); process.exit(1); }
      const capabilitiesOf = Object.fromEntries(tasks.map((t) => [t.name, t.capabilities ?? []]));
      const levelsOf = Object.fromEntries(tasks.filter((t) => t.family).map((t) => [t.name, { family: t.family, level: t.level }]));
      run.gates = await gateRun(run, { ...spec, clients: args.client ? [args.client] : null, capabilitiesOf, levelsOf });
      if (!args.noSave) saveRun(run);
      if (args.json) console.log(JSON.stringify(run.gates, null, 2));
      else console.log(describeRunGates(run.gates));
      process.exitCode = run.gates.exitCode;
      break;
    }

    case "compact": {
      const args = parseArgs(rest);
      const { compactRuns } = await import("./store.js");
      const r = compactRuns({ olderThanDays: args.olderThan, apply: !!args.yes });
      for (const f of r.files) console.log(`${f.applied ? "compacted" : "would compact"}  ${f.id}  ${(f.bytesBefore / 1024).toFixed(0)} KB → ${(f.bytesAfter / 1024).toFixed(0)} KB`);
      console.log(`${r.files.length} run(s) older than ${r.cutoff.slice(0, 10)}; ${r.apply ? "saved" : "would save"} ${(r.savedBytes / 1024).toFixed(0)} KB${r.apply ? "" : " — add --yes to apply"}`);
      break;
    }

    // CSV export of a saved run: trial rows by default, --cells for the task × model × mode cells.
    case "export": {
      const args = parseArgs(rest);
      const id = args._[0];
      if (!id) { console.error("usage: node src/cli.js export <run-id> [--cells] [--out file.csv]"); process.exit(1); }
      const run = loadRun(id);
      if (!run) { console.error(`unknown run: ${id}`); process.exit(1); }
      let body;
      if (args.jsonl || args.trial) {
        // One trial (or every trial, numbered) as an event log — the transcript protocol.
        if (args.trial) {
          const r = run.rows[args.trial - 1];
          if (!r) { console.error(`run ${id} has ${run.rows.length} rows; --trial takes 1..${run.rows.length}`); process.exit(1); }
          body = args.jsonl ? traceJsonl(r) : rowsToCsv({ id: run.id, rows: [r] });
        } else {
          body = run.rows.flatMap((r, i) => traceEvents(r).map((e) => JSON.stringify({ trial: i + 1, ...e }))).join("\n") + "\n";
        }
      } else body = args.cells ? cellsToCsv(run.id, summarize(run.rows)) : rowsToCsv(run);
      if (args.out) { writeFileSync(args.out, body); console.log(`wrote ${args.out}`); }
      else process.stdout.write(body);
      break;
    }

    case "serve":
    case "web": {
      const args = parseArgs(rest);
      const { serve } = await import("./web/server.js");
      const { url } = await serve({ port: args.port ?? 4000, host: args.host ?? "127.0.0.1" });
      if (args.open) spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      break;
    }

    // bench/aggregate own their own flag parsing; re-exec them with the remaining argv.
    case "bench":
    case "run":
      await runScript(join(SRC, "bench.js"), rest);
      break;

    case "aggregate":
    case "report":
      await runScript(join(SRC, "aggregate.js"), rest);
      break;

    default:
      console.log("Usage:");
      console.log("  node src/cli.js list");
      console.log("  node src/cli.js show [<run-id>] [--table]");
      console.log("  node src/cli.js show <run-id> --rows | --trial <n>       # the rows numbered, or one trial as a timeline");
      console.log("  node src/cli.js export <run-id> [--cells] [--out file.csv]");
      console.log("  node src/cli.js export <run-id> --jsonl [--trial <n>]   # a trial (or every trial) as an event log");
      console.log("  node src/cli.js replay <run-id> [--clients …]          # the same instances again, as a new run parented to this one, with the paired comparison");
      console.log("  node src/cli.js rescore <run-id> | --all [--yes]       # today's scorers over saved rows; --yes writes the verdicts back");
      console.log("  node src/cli.js gate <run-id> --gate <spec>… | --gates <file>   # thresholds over a saved run, exit 0 pass / 1 fail / 2 incomplete");
      console.log("  node src/cli.js suite nightly --clients …             # the standard suite, time-boxed and gated by gates/nightly.json (bench: --gate, --gates, --time-box)");
      console.log("  node src/cli.js index [--full]                        # rebuild the SQLite index over results/runs");
      console.log("  node src/cli.js query runs|trend|cell|worst [...]    # cross-run questions (or --sql)");
      console.log("  node src/cli.js compact --older-than <days> [--yes]  # strip prompts/transcripts from old runs");
      console.log("  node src/cli.js scorecard <client> [--since D] [--svg <file>]   # capability scorecard pooled over the index; --svg writes the radar");
      console.log("  node src/cli.js scorecard --family <family> [--mode] # a lineage family's checkpoints side by side, per capability");
      console.log("  node src/cli.js compare <run> --a <c1> --b <c2> | compare <runA> <runB>   # paired comparison (McNemar)");
      console.log("  node src/cli.js models [--graph]                      # the lineage registry and what the index holds per checkpoint (--graph: as a tree with rates)");
      console.log("  node src/cli.js anchors fetch [all|gsm8k,ifeval,bfclsimple,bfclmultiple] | anchors list | anchors <client>   # public sets as anchors, next to the own tasks");
      console.log("  node src/cli.js curve <family> [--mode] [--client]   # success per difficulty level, with the breaking point");
      console.log("  node src/cli.js trend --client <c> [--capability]    # a client's capabilities per run over time, with sparklines");
      console.log("  node src/cli.js regressions [--client <c>] [--json|--format md] [--out <file>] [--webhook <url>] [--fail]   # latest run vs earlier runs, and checkpoint vs parent; delivered to a file or a webhook");
      console.log("  node src/cli.js suite smoke|standard|full --clients … # preset runs for a fresh checkpoint");
      console.log("  node src/cli.js serve [--port 4000] [--host 127.0.0.1] [--open]");
      console.log("  node src/cli.js bench --task <name|all> --modes noHarness,harness,schemaOnly,toolOnly --clients <p:model,...> [--count N] [--temperature T] [--seed S] [--model-param k=v]... [--json]");
      console.log("  node src/cli.js aggregate [--tasks <name,...>] [--modes ...] [--clients ...] [--count N]");
      process.exit(cmd ? 1 : 0);
  }
}

function runScript(file, argv) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [file, ...argv], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : process.exit(code ?? 1)));
  });
}

main().catch((err) => {
  console.error("cli error:", err.message);
  process.exit(1);
});
