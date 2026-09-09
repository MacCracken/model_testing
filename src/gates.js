// gates.js — thresholds a run must clear, with exit codes: the CI half of the own-model workflow.
//
// A gate names what to measure (a capability, a task, a family level, a whole mode, the error rows,
// the index's regression flags, a family's breaking point), the mode to read it in, and the bar.
// Verdicts follow the bench's statistics rather than a bare point estimate: a rate gate *passes*
// when the observed rate reaches the bar, *fails* when the whole Wilson band lies under it — the run
// is confidently below — and is *inconclusive* in between, where the trials run could not tell the
// two apart (four trials cannot separate 75 % from 80 %). Too few trials for a gate is *incomplete*,
// which a time-boxed run can produce. Exit codes: 0 pass (inconclusive included unless strict),
// 1 fail, 2 incomplete — so CI fails a checkpoint on evidence and can see which gates it could not
// judge.
//
// `evaluateGates` is pure over one client's rows; the regressions count comes from the index through
// `regressionsForClient`, and `gateRun` puts the two together for every client of a run.

import { readFileSync } from "node:fs";
import { MODE_NAMES, wilsonInterval, curves } from "./runner.js";

export const DEFAULT_MODE = "harness";
export const GATE_KINDS = ["capability", "task", "family", "break", "overall", "errors", "regressions"];
const COUNT_KINDS = new Set(["errors", "regressions"]);

// What a gate can name, from the registry: task names, capability names, families.
export function gateNames(tasks = []) {
  return {
    tasks: tasks.map((t) => t.name),
    capabilities: [...new Set(tasks.flatMap((t) => t.capabilities ?? []))],
    families: [...new Set(tasks.map((t) => t.family).filter(Boolean))],
  };
}

// <subject>[@mode] >= <percent>   |   errors <= <count>   |   regressions <= <count>
const GRAMMAR = /^\s*([^@<>=\s]+)\s*(?:@\s*([A-Za-z]+))?\s*(>=|<=|==|=|>|<)\s*(\d+(?:\.\d+)?)\s*%?\s*$/;

export function parseGate(text, names = null, { defaultMode = DEFAULT_MODE } = {}) {
  const m = GRAMMAR.exec(String(text ?? ""));
  if (!m) throw new Error(`cannot read gate "${text}": expected <subject>[@mode] >= <percent> (or errors / regressions <= <count>)`);
  const [, subject, mode, op, num] = m;
  if (op === ">" || op === "<") throw new Error(`gate "${text}": use >= or <= (a bar is inclusive)`);
  const g = classify(subject, names);
  const counting = COUNT_KINDS.has(g.kind);
  if (counting && op === ">=") throw new Error(`gate "${text}": ${g.kind} is a count to stay under — write ${g.kind} <= ${num}`);
  if (!counting && op === "<=") throw new Error(`gate "${text}": ${subject.trim()} is a rate to reach — write ${subject.trim()} >= ${num}`);
  return finish({ ...g, value: Number(num), mode: mode ?? (counting ? null : defaultMode) }, text);
}

function classify(subject, names) {
  const s = String(subject).trim();
  if (s === "overall") return { kind: "overall", subject: s };
  if (s === "errors") return { kind: "errors", subject: s };
  if (s === "regressions") return { kind: "regressions", subject: s };
  const brk = /^break:(.+)$/.exec(s);
  if (brk) return validated({ kind: "break", subject: brk[1] }, names);
  const fam = /^(.+):(\d+)$/.exec(s);
  if (fam) return validated({ kind: "family", subject: fam[1], level: Number(fam[2]) }, names);
  if (!names) return { kind: "capability", subject: s };
  if (names.tasks?.includes(s)) return { kind: "task", subject: s };
  if (names.capabilities?.includes(s)) return { kind: "capability", subject: s };
  throw new Error(`unknown gate subject "${s}": not a task, a capability, family:level, break:family, overall, errors or regressions`);
}

function validated(g, names) {
  if (!names) return g;
  const known = { task: names.tasks, capability: names.capabilities, family: names.families, break: names.families }[g.kind];
  if (known && !known.includes(g.subject)) throw new Error(`unknown ${g.kind === "break" ? "family" : g.kind} "${g.subject}" in gate (known: ${known.join(", ")})`);
  return g;
}

function finish(g, source = null) {
  const counting = COUNT_KINDS.has(g.kind);
  if (!Number.isFinite(g.value) || g.value < 0) throw new Error(`gate ${source ?? g.subject}: the bar must be a number`);
  if (g.mode && !MODE_NAMES.includes(g.mode)) throw new Error(`gate ${source ?? g.subject}: unknown mode "${g.mode}" (${MODE_NAMES.join(", ")})`);
  const op = counting ? "<=" : ">=";
  const unit = g.kind === "break" || counting ? "" : "%";
  const what = g.kind === "break" ? `break:${g.subject}` : g.kind === "family" ? `${g.subject}:${g.level}` : g.subject;
  return { kind: g.kind, subject: g.subject, level: g.level ?? null, mode: g.mode ?? null, op, value: g.value, label: `${what}${g.mode ? `@${g.mode}` : ""} ${op} ${g.value}${unit}` };
}

// A gate in a file's object form ({ capability, min } / { task, min } / { family, level, min } /
// { family, noBreakBelow } / { overall: true, min } / { errors: n } / { regressions: n }, each with an
// optional mode), or the string grammar.
export function normalizeGate(item, names = null, { defaultMode = DEFAULT_MODE } = {}) {
  if (typeof item === "string") return parseGate(item, names, { defaultMode });
  if (!item || typeof item !== "object") throw new Error(`cannot read gate ${JSON.stringify(item)}`);
  const bar = (v, what) => { if (v === undefined || v === null) throw new Error(`gate ${what}: needs "min"`); return Number(v); };
  let g;
  if (item.capability) g = { kind: "capability", subject: item.capability, value: bar(item.min, item.capability) };
  else if (item.task) g = { kind: "task", subject: item.task, value: bar(item.min, item.task) };
  else if (item.family && item.level !== undefined) g = { kind: "family", subject: item.family, level: Number(item.level), value: bar(item.min, `${item.family}:${item.level}`) };
  else if (item.family && item.noBreakBelow !== undefined) g = { kind: "break", subject: item.family, value: Number(item.noBreakBelow) };
  else if (item.break) g = { kind: "break", subject: item.break, value: bar(item.min, `break:${item.break}`) };
  else if (item.overall) g = { kind: "overall", subject: "overall", value: bar(item.min, "overall") };
  else if (item.errors !== undefined) g = { kind: "errors", subject: "errors", value: Number(typeof item.errors === "object" ? item.errors.max : item.errors) };
  else if (item.regressions !== undefined) g = { kind: "regressions", subject: "regressions", value: Number(typeof item.regressions === "object" ? item.regressions.max : item.regressions) };
  else throw new Error(`cannot read gate ${JSON.stringify(item)}: name a capability, task, family (with level or noBreakBelow), overall, errors or regressions`);
  validated(g, names);
  return finish({ ...g, mode: item.mode ?? (COUNT_KINDS.has(g.kind) ? null : defaultMode) }, JSON.stringify(item));
}

// A gate file: { name, minTrials, mode, strict, gates: [ … ] }, or a bare array of gates.
export function parseGateFile(text, names = null) {
  let doc;
  try { doc = JSON.parse(text); } catch (err) { throw new Error(`gate file is not JSON: ${err.message}`); }
  const list = Array.isArray(doc) ? doc : doc?.gates;
  if (!Array.isArray(list)) throw new Error('gate file needs a "gates" array');
  const defaultMode = (Array.isArray(doc) ? null : doc.mode) ?? DEFAULT_MODE;
  return {
    name: Array.isArray(doc) ? null : doc.name ?? null,
    minTrials: !Array.isArray(doc) && Number.isInteger(doc.minTrials) ? doc.minTrials : null,
    strict: !Array.isArray(doc) && !!doc.strict,
    gates: list.map((g) => normalizeGate(g, names, { defaultMode })),
  };
}

export function loadGateFile(path, names = null) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (err) { throw new Error(`cannot read gate file ${path}: ${err.message}`); }
  return { ...parseGateFile(text, names), file: path };
}

// Gates from the command line: --gates <file> plus any --gate <spec>; --min-trials and --strict
// override the file's. When neither says, `fallbackMinTrials` — the run's trials per cell — is the
// floor, so a cell a time box cut short reads as incomplete rather than as a pass on one trial.
export function gatesFromArgs({ gate = [], gates = null, strict = false, minTrials = null } = {}, names = null, { fallbackMinTrials = 1 } = {}) {
  const file = gates ? loadGateFile(gates, names) : null;
  const specs = (Array.isArray(gate) ? gate : [gate]).filter(Boolean).map((s) => parseGate(s, names));
  return {
    gates: [...(file?.gates ?? []), ...specs],
    minTrials: Number.isInteger(minTrials) ? minTrials : file?.minTrials ?? (Number.isInteger(fallbackMinTrials) && fallbackMinTrials > 0 ? fallbackMinTrials : 1),
    strict: !!(strict || file?.strict),
    file: gates ?? null,
    name: file?.name ?? null,
  };
}

// fail > incomplete > inconclusive > pass; strict turns an inconclusive overall into a failure.
const RANK = { pass: 0, inconclusive: 1, incomplete: 2, fail: 3 };
export function combineVerdicts(verdicts, { strict = false } = {}) {
  let worst = "pass";
  for (const v of verdicts) if ((RANK[v] ?? 0) > RANK[worst]) worst = v;
  if (worst === "inconclusive" && strict) worst = "fail";
  return { verdict: worst, exitCode: worst === "fail" ? 1 : worst === "incomplete" ? 2 : 0 };
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// One client's rows against a list of gates. Error rows are excluded from rates (as the scorecard
// excludes them) and counted by the errors gate; rows cancelled by a time box count for nothing.
export function evaluateGates(gates, { rows = [], capabilitiesOf = {}, levelsOf = {}, regressions = null, minTrials = 1, strict = false } = {}) {
  const cancelled = rows.filter((r) => r.error && r.reason === "cancelled");
  const usable = rows.filter((r) => !(r.error && r.reason === "cancelled"));
  const scored = usable.filter((r) => !r.error);
  const need = Math.max(1, minTrials);

  const rate = (g, scope) => {
    const runs = scope.length;
    const correct = scope.filter((r) => r.correct).length;
    if (runs < need) return { correct, runs, pct: null, low: null, high: null, verdict: "incomplete", reason: runs ? `${runs} trial(s), the gate needs ${need}` : "no trials in this run" };
    const p = (correct / runs) * 100;
    const w = wilsonInterval(correct, runs);
    const band = `${fmt(w.low * 100)}–${fmt(w.high * 100)}%`;
    const base = { correct, runs, pct: p, low: w.low * 100, high: w.high * 100 };
    if (p >= g.value) return { ...base, verdict: "pass", reason: `${correct}/${runs} = ${fmt(p)}% (band ${band})` };
    if (w.high * 100 < g.value) return { ...base, verdict: "fail", reason: `${correct}/${runs} = ${fmt(p)}%: the band ${band} tops out under ${g.value}%` };
    return { ...base, verdict: "inconclusive", reason: `${correct}/${runs} = ${fmt(p)}%: ${runs} trial(s) cannot tell it from ${g.value}% (band ${band})` };
  };

  const results = gates.map((g) => {
    const inMode = (list) => (g.mode ? list.filter((r) => r.mode === g.mode) : list);
    let out;
    switch (g.kind) {
      case "capability": out = rate(g, inMode(scored).filter((r) => (capabilitiesOf[r.task] ?? []).includes(g.subject))); break;
      case "task": out = rate(g, inMode(scored).filter((r) => r.task === g.subject)); break;
      case "family": out = rate(g, inMode(scored).filter((r) => levelsOf[r.task]?.family === g.subject && levelsOf[r.task]?.level === g.level)); break;
      case "overall": out = rate(g, inMode(scored)); break;
      case "errors": {
        const scope = inMode(usable);
        const n = scope.filter((r) => r.error).length;
        out = !scope.length
          ? { runs: 0, count: n, verdict: "incomplete", reason: "no trials in this run" }
          : { runs: scope.length, count: n, verdict: n <= g.value ? "pass" : "fail", reason: `${n} error row(s) of ${scope.length}${n > g.value ? ` — over ${g.value}` : ""}` };
        break;
      }
      case "regressions": {
        if (!regressions) out = { runs: usable.length, count: null, verdict: "incomplete", reason: "no regression check available (index unreadable, or not asked for)" };
        else {
          const n = regressions.flags ?? 0;
          out = { runs: usable.length, count: n, verdict: n <= g.value ? "pass" : "fail", reason: `${n} flag(s) over ${regressions.compared ?? 0} comparison(s)${regressions.detail ? ` — ${regressions.detail}` : ""}` };
        }
        break;
      }
      case "break": {
        const scope = inMode(scored).filter((r) => levelsOf[r.task]?.family === g.subject);
        const fam = curves(scope, levelsOf)[g.subject];
        const byMode = fam ? Object.values(fam.byClient)[0] ?? null : null;
        const cm = byMode ? byMode[g.mode] ?? Object.values(byMode)[0] : null;
        if (!cm || !cm.points.length) { out = { runs: scope.length, breakingPoint: null, verdict: "incomplete", reason: "no trials of this family in this run" }; break; }
        const levels = cm.points.map((p) => `${p.level}: ${p.correct}/${p.runs}`).join(", ");
        const bp = cm.breakingPoint;
        if (cm.points.every((p) => p.runs < need)) out = { runs: scope.length, breakingPoint: bp, verdict: "incomplete", reason: `too few trials per level (${levels}; the gate needs ${need})` };
        else if (bp === null || bp >= g.value) out = { runs: scope.length, breakingPoint: bp, verdict: "pass", reason: bp === null ? `no breaking point (${levels})` : `breaks at ${bp} (${levels})` };
        else out = { runs: scope.length, breakingPoint: bp, verdict: "fail", reason: `breaks at ${bp}, under ${g.value} (${levels})` };
        break;
      }
      default: out = { verdict: "incomplete", reason: `unknown gate kind ${g.kind}` };
    }
    return { ...g, ...out };
  });

  const counts = { pass: 0, fail: 0, inconclusive: 0, incomplete: 0 };
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const { verdict, exitCode } = combineVerdicts(results.map((r) => r.verdict), { strict });
  return { verdict, exitCode, strict, minTrials: need, counts, results, trials: usable.length, cancelled: cancelled.length };
}

const MARK = { pass: "✓", fail: "✗", inconclusive: "?", incomplete: "…" };

export function describeGates(result, { client = null } = {}) {
  const c = result.counts;
  const strictNote = result.strict && result.verdict === "fail" && !c.fail ? " (strict: inconclusive counts as a failure)" : "";
  const head = `gates${client ? ` for ${client}` : ""}: ${result.verdict.toUpperCase()}${strictNote} — ${c.pass} pass, ${c.fail} fail, ${c.inconclusive} inconclusive, ${c.incomplete} incomplete over ${result.trials} trial(s)${result.cancelled ? `, ${result.cancelled} cancelled by the time box` : ""}`;
  const width = Math.max(10, ...result.results.map((r) => r.label.length));
  return [head, ...result.results.map((r) => `  ${MARK[r.verdict] ?? "?"} ${r.label.padEnd(width)}  ${r.reason}`)].join("\n");
}

// The index's regression flags for a client — its latest run against its earlier runs, and against
// its lineage parent — as the regressions gate counts them. Null when the index cannot answer.
export async function regressionsForClient(client) {
  try {
    const { indexRuns, rawQuery } = await import("./store.js");
    const { regressionsFor, parentGaps } = await import("./trends.js");
    const { listTasks } = await import("./tasks/registry.js");
    const { parentOf } = await import("./lineage.js");
    indexRuns();
    const q = (s) => s.replace(/'/g, "''");
    const fetchRows = (c) => rawQuery(`select t.run_id as runId, r.created_at as createdAt, t.task, t.mode, t.client, t.correct from trials t join runs r on r.id = t.run_id where t.client = '${q(c)}' and t.error is null and t.base_client is null`).map((r) => ({ ...r, correct: !!r.correct }));
    const caps = Object.fromEntries(listTasks().map((t) => [t.name, t.capabilities]));
    const rows = fetchRows(client);
    const runs = new Set(rows.map((r) => r.runId)).size;
    const parent = parentOf(client);
    if (runs < 2 && !parent) return { flags: 0, compared: 0, runs, detail: "first run of this client in the index, nothing to compare yet" };
    const own = runs >= 2 ? regressionsFor(rows, caps) : { flags: [], compared: 0 };
    const vs = parent ? parentGaps(rows, fetchRows(parent), caps) : null;
    const flags = [
      ...own.flags.map((f) => `${f.capability}@${f.mode} ${f.earlier.correctPct.toFixed(0)}%→${f.later.correctPct.toFixed(0)}%`),
      ...(vs?.flags ?? []).map((f) => `vs parent ${f.capability}@${f.mode} ${f.parent.correctPct.toFixed(0)}%→${f.child.correctPct.toFixed(0)}%`),
    ];
    return { flags: flags.length, compared: own.compared + (vs?.compared ?? 0), runs, detail: flags.join("; ") || null };
  } catch {
    return null;
  }
}

// Every client of a run against the gates; the run-level verdict is the worst client's.
export async function gateRun(run, { gates, minTrials = 1, strict = false, clients = null, capabilitiesOf = {}, levelsOf = {}, file = null, name = null, regressionsFor = regressionsForClient } = {}) {
  const names = clients ?? run.config?.clients ?? [...new Set((run.rows ?? []).map((r) => r.client))];
  const needRegressions = gates.some((g) => g.kind === "regressions");
  const byClient = {};
  for (const client of names) {
    const rows = (run.rows ?? []).filter((r) => r.client === client);
    const regressions = needRegressions ? await regressionsFor(client) : null;
    byClient[client] = evaluateGates(gates, { rows, capabilitiesOf, levelsOf, regressions, minTrials, strict });
  }
  const { verdict, exitCode } = combineVerdicts(Object.values(byClient).map((r) => r.verdict), { strict });
  return { at: new Date().toISOString(), file, name, specs: gates.map((g) => g.label), minTrials, strict, verdict, exitCode, byClient };
}

export function describeRunGates(result) {
  const blocks = Object.entries(result.byClient).map(([client, r]) => describeGates(r, { client }));
  return `${blocks.join("\n\n")}\n\nverdict: ${result.verdict.toUpperCase()} (exit ${result.exitCode})`;
}
