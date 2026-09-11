// sandbox.js — run untrusted JavaScript against a test set in a child Node process that can touch
// nothing: Node's permission model (`--permission`) denies it the file system, child processes,
// workers, native addons and the network; the heap is capped (`--max-old-space-size`), the run is
// cut by wall-clock time, and stdout is capped. This is the code family's harness axis (the
// `run_tests` tool) and its scorer (the hidden tests), and it stays zero-dependency. It is not a
// container: a candidate can still burn its CPU budget or exhaust the heap — both are reported as
// a failure, never as a crash of the bench.
//
// The child reads { code, name, tests } from stdin, defines the function from the code inside a
// bare `vm` context (no `process`, no `require`, a stub `console`, a `module.exports` for the
// CommonJS habit; a leading `export` is stripped for the ESM one), hands it the tests' arguments
// parsed from JSON inside that realm and takes the results back as a JSON string — no host object
// ever crosses into the candidate's realm, so there is nothing to climb to `process` from — then
// compares deeply and prints one sentinel-prefixed JSON line the parent reads back.

import { spawn } from "node:child_process";

export const SANDBOX_DEFAULTS = { timeoutMs: 3000, memoryMb: 128, maxOutput: 64 * 1024, maxFailures: 3 };
const SENTINEL = "@@bench-sandbox@@";

// The child program. Kept as a string so the parent passes it with `-e` (no file to read under
// the permission model).
const CHILD = `
const vm = require("node:vm");
const SENT = ${JSON.stringify(SENTINEL)};
const out = (r) => process.stdout.write("\\n" + SENT + JSON.stringify(r) + "\\n");
const same = (a, b) => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k])); }
  return a === b;
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  let job; try { job = JSON.parse(input); } catch (e) { out({ error: "bad job: " + e.message }); return; }
  const { code, name, tests } = job;
  if (!/^[A-Za-z_$][\\w$]*$/.test(String(name))) { out({ error: "bad function name" }); return; }
  const src = String(code ?? "").replace(/^\\s*export\\s+default\\s+/m, "").replace(/^\\s*export\\s+(?=(?:async\\s+)?function|const|let|var|class)/gm, "");
  // A bare context: the candidate sees only its realm's own built-ins, a stub console and a
  // CommonJS module object made inside the realm — nothing of the host's crosses over, in either
  // direction (the tests' arguments are parsed from JSON inside the realm, the results come back
  // as a JSON string), so there is no host object to climb to \`process\` from.
  const context = vm.createContext(Object.create(null));
  try {
    vm.runInContext("var console = { log() {}, error() {}, warn() {}, info() {}, debug() {} }; var module = { exports: {} }; var exports = module.exports;", context);
    vm.runInContext(src, context, { filename: "candidate.js" });
  } catch (e) { out({ error: (e && e.name === "SyntaxError" ? "syntax error: " : "error while loading: ") + (e && e.message ? String(e.message).slice(0, 200) : String(e).slice(0, 200)) }); return; }
  const argsJson = JSON.stringify(JSON.stringify((tests || []).map((t) => (Array.isArray(t.args) ? t.args : []))));
  const runner = "(function () {"
    + " var fn = (typeof " + name + " === 'function') ? " + name + " : ((typeof module.exports === 'function') ? module.exports : (module.exports && module.exports[" + JSON.stringify(name) + "]) || (exports && exports[" + JSON.stringify(name) + "]));"
    + " if (typeof fn !== 'function') return JSON.stringify({ nofn: true });"
    + " var all = JSON.parse(" + argsJson + "); var out = [];"
    + " for (var i = 0; i < all.length; i++) { try { var got = fn.apply(null, all[i]); var s; try { s = JSON.stringify(got === undefined ? null : got); } catch (e) { s = JSON.stringify(String(got)); } out.push({ i: i, got: s === undefined ? 'null' : s }); } catch (e) { out.push({ i: i, error: String(e && e.message ? e.message : e).slice(0, 200) }); } }"
    + " return JSON.stringify(out); })()";
  let raw;
  try { raw = vm.runInContext(runner, context, { filename: "tests.js" }); } catch (e) { out({ error: "error while running: " + String(e && e.message ? e.message : e).slice(0, 200) }); return; }
  let list; try { list = JSON.parse(String(raw)); } catch { out({ error: "unreadable test results" }); return; }
  if (list && list.nofn) { out({ error: "the code defines no function named " + name }); return; }
  const results = [];
  for (const r of list) {
    const t = tests[r.i];
    if (r.error !== undefined) { results.push({ i: r.i, ok: false, error: /ERR_ACCESS_DENIED|access denied/i.test(r.error) ? "access denied by the sandbox" : r.error }); continue; }
    let got; try { got = JSON.parse(r.got); } catch { got = r.got; }
    results.push(same(got, t.expected) ? { i: r.i, ok: true } : { i: r.i, ok: false, got: typeof r.got === "string" && r.got.length > 200 ? r.got.slice(0, 200) + "…" : got });
  }
  out({ results });
});
`;

// Run `code` (which must define a function `name`) against `tests` ([{ args, expected }]).
// Resolves — never rejects — with { ok, passed, total, failures: [{ i, args, expected, got | error }],
// error: string | null, timedOut, ms }.
export function runInSandbox({ code, name, tests, timeoutMs = SANDBOX_DEFAULTS.timeoutMs, memoryMb = SANDBOX_DEFAULTS.memoryMb, maxOutput = SANDBOX_DEFAULTS.maxOutput, maxFailures = SANDBOX_DEFAULTS.maxFailures, nodePath = process.execPath } = {}) {
  const t0 = Date.now();
  const total = Array.isArray(tests) ? tests.length : 0;
  const done = (r) => ({ ok: false, passed: 0, total, failures: [], error: null, timedOut: false, ...r, ms: Date.now() - t0 });
  if (typeof code !== "string" || !code.trim()) return Promise.resolve(done({ error: "no code" }));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nodePath, ["--permission", `--max-old-space-size=${memoryMb}`, "-e", CHILD], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) { resolve(done({ error: `could not start the sandbox: ${err.message}` })); return; }
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(done(r)); } };
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < maxOutput) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < maxOutput) stderr += d; });
    child.on("error", (err) => finish({ error: `sandbox failed to run: ${err.message}` }));
    child.on("close", (code, signal) => {
      if (timedOut) { finish({ error: `timed out after ${timeoutMs} ms`, timedOut: true }); return; }
      const line = stdout.split("\n").reverse().find((l) => l.startsWith(SENTINEL));
      if (!line) {
        if (/out of memory|heap|Allocation failed/i.test(stderr) || signal === "SIGABRT" || code === 134) { finish({ error: `ran out of memory (limit ${memoryMb} MB)` }); return; }
        if (/ERR_ACCESS_DENIED/.test(stderr)) { finish({ error: "access denied by the sandbox" }); return; }
        finish({ error: `the program produced no result (exit ${signal ?? code})${stderr.trim() ? `: ${stderr.trim().split("\n")[0].slice(0, 160)}` : ""}` });
        return;
      }
      let r; try { r = JSON.parse(line.slice(SENTINEL.length)); } catch { finish({ error: "unreadable result from the sandbox" }); return; }
      if (r.error) { finish({ error: r.error }); return; }
      const results = Array.isArray(r.results) ? r.results : [];
      const passed = results.filter((x) => x.ok).length;
      const failures = results.filter((x) => !x.ok).slice(0, maxFailures).map((x) => ({ i: x.i, args: tests[x.i]?.args, expected: tests[x.i]?.expected, ...(x.error ? { error: x.error } : { got: x.got }) }));
      finish({ ok: passed === total && total > 0, passed, failures });
    });
    try { child.stdin.end(JSON.stringify({ code, name, tests: tests ?? [] })); } catch {}
  });
}

// The code in an answer: the first fenced block tagged js / javascript / ts, else the first fenced
// block, else the text itself when it defines the function. Structured answers hand in `code`.
export function codeIn(text, name = null) {
  const s = String(text ?? "");
  const fences = [...s.matchAll(/```([a-zA-Z]*)[ \t]*\r?\n([\s\S]*?)```/g)];
  const tagged = fences.find((m) => /^(js|javascript|ts|typescript|node)$/i.test(m[1]));
  if (tagged) return tagged[2].trim();
  if (fences.length) return fences[0][2].trim();
  if (name && new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`).test(s)) return s.trim();
  return null;
}

// One line for a sandbox result, for a scorer's reason and the tool's reply.
export function describeSandbox(r, { tests = "test" } = {}) {
  if (!r) return "not run";
  if (r.error) return r.error;
  if (r.ok) return `passed ${r.passed}/${r.total} ${tests}s`;
  const f = r.failures?.[0];
  const detail = f ? ` (e.g. ${JSON.stringify(f.args)} → expected ${JSON.stringify(f.expected)}, ${f.error ? `threw ${f.error}` : `got ${JSON.stringify(f.got)}`})` : "";
  return `failed ${r.total - r.passed}/${r.total} ${tests}s${detail}`;
}
