// rescore.js — today's scorers over a saved run, without a model.
//
// A row records everything its verdict was derived from: the final message and its parsed form,
// the ground truth taken at the time, the tool calls and results, the context. So when a scorer
// changes — an audit, a fixed bug, a new tool-use judge — a saved run can be scored again through
// `scoreRecord`, the same function a live trial goes through, and whatever moves is exactly the
// scorer's doing. The rows keep what was recorded; only the verdicts change, and the run notes when
// they were last derived and from which bench version. A re-scored run is therefore not a second
// measurement but the same one, read again — which is why it keeps its id and its place in the
// index. (A *replay* is a new measurement: `bench --replay`, a new run parented to the original.)
//
// What a re-score leaves alone: rows that errored (nothing to score), tasks the registry no longer
// knows, a judged task when no judge is given, rows whose scorer throws, and the stress record (the
// scenario's op log is the environment's, not the scorer's).

import { getTask, listTasks } from "./tasks/registry.js";
import { scoreRecord, summarize } from "./runner.js";
import { benchVersions } from "./version.js";

const VERDICT_FIELDS = ["correct", "reason", "toolUseOk", "toolUseReason", "schemaValid", "canon", "judgeScore", "judgeReason"];
// The reason strings were recorded as null before they were recorded as ""; that is not a change.
const TEXT_FIELDS = new Set(["reason", "toolUseReason", "judgeReason"]);
const verdicts = (row) => Object.fromEntries(VERDICT_FIELDS.map((k) => [k, TEXT_FIELDS.has(k) ? row[k] ?? "" : row[k] ?? null]));

const where = (r) => ({ task: r.task, mode: r.mode, client: r.client, index: r.index });

export async function rescoreRun(run, { judge = null, taskFor = getTask, now = new Date() } = {}) {
  const untouched = (note) => ({ run, flips: [], skipped: [], scored: 0, changed: 0, note });
  if (run.status === "running") return untouched("still running");
  if (run.compacted) return untouched("compacted: the answers were stripped from the rows");

  const rows = [];
  const flips = [];
  const skipped = [];
  let scored = 0;
  let changed = 0;
  const skip = (row, why) => { rows.push(row); skipped.push({ ...where(row), why }); };

  for (const original of run.rows ?? []) {
    const row = structuredClone(original);
    if (row.error) { skip(row, "error row"); continue; }
    let task;
    try { task = taskFor(row.task); } catch { skip(row, "unknown task"); continue; }
    if (!task[row.mode]) { skip(row, `no ${row.mode} spec any more`); continue; }
    if (task.eval?.needsJudge && !judge) { skip(row, "needs a judge (--judge)"); continue; }
    const before = verdicts(row);
    try {
      await scoreRecord(task, row, { judge });
    } catch (err) {
      rows.push(original);
      skipped.push({ ...where(original), why: `scorer threw: ${err?.message ?? err}` });
      continue;
    }
    scored++;
    rows.push(row);
    const after = verdicts(row);
    if (!!before.correct !== !!after.correct) {
      flips.push({ ...where(row), before: !!before.correct, after: !!after.correct, reasonBefore: before.reason ?? "", reasonAfter: after.reason ?? "" });
    } else if (VERDICT_FIELDS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) {
      changed++;
    }
  }

  const tagged = listTasks();
  const summary = summarize(rows, {
    capabilitiesOf: Object.fromEntries(tagged.map((t) => [t.name, t.capabilities])),
    levelsOf: Object.fromEntries(tagged.filter((t) => t.family).map((t) => [t.name, { family: t.family, level: t.level }])),
  });
  const note = { at: now.toISOString(), from: run.versions ?? null, scored, flipped: flips.length, changed, skipped: skipped.length };
  const out = { ...run, versions: benchVersions(), summary, rows, rescored: [...(run.rescored ?? []), note] };
  return { run: out, flips, skipped, scored, changed, note: null };
}

// One run's re-score as text: the counts, then (verbose) every flipped row with both reasons.
export function describeRescore(result, { verbose = true } = {}) {
  const { run, flips, skipped, scored, changed, note } = result;
  if (note) return `${run.id}  left alone (${note})`;
  const why = {};
  for (const s of skipped) why[s.why] = (why[s.why] ?? 0) + 1;
  const skippedNote = skipped.length ? `, ${skipped.length} skipped (${Object.entries(why).map(([k, n]) => `${n} ${k}`).join(", ")})` : "";
  const L = [`${run.id}  ${scored} row(s) scored, ${flips.length} flipped, ${changed} with another verdict changed${skippedNote}`];
  if (verbose) {
    for (const f of flips) {
      L.push(`  ${f.task} · ${f.mode} · ${f.client} · #${f.index}: ${f.before ? "pass" : "fail"} → ${f.after ? "pass" : "fail"}  ${f.reasonAfter}${f.reasonBefore ? `  (was: ${f.reasonBefore})` : ""}`);
    }
  }
  return L.join("\n");
}
