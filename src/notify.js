// notify.js — regression flags delivered somewhere other than the report: a file a CI step reads
// (JSON, or Markdown for a step summary) or a webhook that takes the JSON. The report itself comes
// from `regressionsReport` in trends.js; this file only formats and delivers it.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const pct = (r) => (r && Number.isFinite(r.correctPct) ? `${r.correctPct.toFixed(0)}% (${r.correct}/${r.runs})` : "—");

// One line per flag, the same wording everywhere.
export function describeFlag(f) {
  const tasks = f.perTask.map((t) => `${t.task} ${t.earlier}→${t.later}/${t.n}`).join(", ");
  return f.kind === "parent"
    ? `${f.client} · ${f.capability} · ${f.mode}: ${pct(f.to)} against parent ${f.parent} at ${pct(f.from)} (−${f.dropPp.toFixed(0)}pp, p=${f.pValue.toFixed(3)}) — ${tasks}`
    : `${f.client} · ${f.capability} · ${f.mode}: ${pct(f.from)} over ${f.earlierRuns} earlier run(s) → ${pct(f.to)} in ${f.latestRuns.join("+")} (${String(f.latestAt).slice(0, 10)}; −${f.dropPp.toFixed(0)}pp, p=${f.pValue.toFixed(3)}) — ${tasks}`;
}

export function formatRegressions(report, format = "text") {
  if (format === "json") return JSON.stringify(report, null, 2) + "\n";
  const head = `${report.count} regression flag(s) over ${report.clients.length} client(s)${report.since ? ` since ${report.since}` : ""} — ${report.generatedAt}`;
  if (format === "md" || format === "markdown") {
    const lines = [`## Regressions`, "", head, ""];
    if (!report.count) lines.push("No capability's latest band lies under its earlier band.");
    else {
      lines.push("| client | capability | mode | from | to | drop | p | tasks |", "|---|---|---|---|---|---|---|---|");
      for (const f of report.flags) lines.push(`| ${f.client} | ${f.capability} | ${f.mode} | ${pct(f.from)}${f.kind === "parent" ? ` (parent ${f.parent})` : ""} | ${pct(f.to)} | −${f.dropPp.toFixed(0)}pp | ${f.pValue.toFixed(3)} | ${f.perTask.map((t) => `${t.task} ${t.earlier}→${t.later}/${t.n}`).join(", ")} |`);
    }
    return lines.join("\n") + "\n";
  }
  return [head, ...(report.count ? report.flags.map(describeFlag) : ["no regressions: no capability's latest band lies under its earlier band"])].join("\n") + "\n";
}

// Write the report to a file — JSON unless `format` says md or text.
export function writeReport(path, report, { format = "json" } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatRegressions(report, format));
  return path;
}

// POST the report as JSON to a webhook. Returns { ok, status }; never throws on a bad status so a
// CI step can decide what a failed delivery means.
export async function postReport(url, report, { fetchImpl = globalThis.fetch, headers = {} } = {}) {
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(report) });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message ?? String(err) };
  }
}
