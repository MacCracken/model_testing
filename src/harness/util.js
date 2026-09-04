// harness/util.js — what every real-harness arm shares.
//
// A real harness brings its own tools, so the bench's function tools never run. Tasks whose truth
// is read from tool results (`lookup`, `chain`, and `hello`'s per-name greetings) still need to
// know what the webserver actually served during the trial. When the harness's transcript carries
// its tool outputs (Claude Code's Bash results do; Thoth's events do not), the webserver's JSON
// replies can be recovered from that text and re-expressed as the bench tools' own result shape,
// so the tasks' ground() functions work unchanged.

import { schemaHint } from "../schema.js";

// The prompt a real harness gets: the task's goal plus the same schema instruction the synthetic
// harness receives (the schema is part of the treatment, so both arms see it worded the same).
export function goalPrompt(task, mode, fallback) {
  const goal = task?.goal ?? fallback;
  const schema = task?.[mode]?.schema;
  if (!schema) return goal;
  return `${goal}\n\nReturn your final answer as a JSON value that is an instance of this JSON Schema (a value that validates against it — not the schema itself):\n${schemaHint(schema)}\nReply with that JSON value only — no prose, no markdown fences.`;
}

// Every `{ "message": "Hello, <name>!", "id": "…" }` object found in a blob of tool output.
export function greetingsIn(text) {
  const found = [];
  const re = /\{[^{}]*"message"\s*:\s*"[^"]*"[^{}]*\}/g;
  for (const m of String(text ?? "").match(re) ?? []) {
    let obj;
    try { obj = JSON.parse(m); } catch { continue; }
    const message = String(obj.message ?? "");
    const id = String(obj.id ?? "");
    const name = (message.match(/^Hello, (.+)!$/) ?? [])[1] ?? "";
    if (message && id) found.push({ name, message, id });
  }
  return found;
}

// What the webserver itself says it served in a time window (GET /api/recent), for harnesses whose
// tool output does not carry the raw reply — a model piping curl through jq, a harness whose events
// omit tool results. Empty when the endpoint is missing (an older webserver) or unreachable.
export async function recentGreetings(base, since, until) {
  try {
    const url = new URL("/api/recent", base);
    if (since) url.searchParams.set("since", since);
    if (until) url.searchParams.set("until", until);
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.responses ?? []).map((r) => ({ name: String(r.name ?? ""), message: String(r.message ?? ""), id: String(r.id ?? "") })).filter((g) => g.id);
  } catch {
    return [];
  }
}

// Re-express what the harness fetched as results of the task's own tools, one entry per declared
// tool, carrying both key spellings the bench tools use (`greetings` for hello/chain, `results`
// for lookup) so each task's ground() finds what it expects. Greetings recovered from the tool
// output and those the server logged are merged (by id, output first, server order kept).
export function synthesizeToolResults(task, mode, texts, served = []) {
  const seen = new Set();
  const greetings = [];
  for (const g of [...texts.flatMap(greetingsIn), ...served]) {
    if (!g.id || seen.has(g.id)) continue;
    seen.add(g.id);
    greetings.push(g);
  }
  if (!greetings.length) return [];
  const names = (task?.[mode]?.tools ?? []).map((t) => t.name).filter((n) => n === "hello" || n === "lookup");
  return names.map((name, i) => ({
    id: `synth_${i + 1}`,
    name,
    ok: true,
    synthesized: true,
    content: JSON.stringify({ greetings, results: greetings.map(({ name: n, id }) => ({ name: n, id })) }),
  }));
}

// Split a command prefix into argv, honoring simple quotes: `ssh -n arch cd ~/x && thoth` or a
// path with spaces in quotes. The result is spread before the arm's own arguments.
export function splitCommand(cmd) {
  return String(cmd).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) ?? [];
}

// Run a child process to completion with a timeout and abort support; resolves with its output
// and exit code, rejects on timeout, cancellation or a spawn failure.
export function runChild(argv, { signal, timeoutMs, env, label = argv[0] } = {}) {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${label} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      const onAbort = () => { child.kill("SIGTERM"); reject(new Error("cancelled")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve({ stdout, stderr, code }); });
    });
  });
}
