// runner.js — the shared execution core.
//
// One place where a (task, mode, client) cell is actually run and scored, used by the CLI
// (`bench.js`, `aggregate.js`) and by the web UI alike, so every surface reports the same
// numbers. Callers get progress via `onEvent` and can cancel with an AbortSignal.
//
// This file has no Node-specific imports on purpose: the web server serves it to the browser as
// `/lib/runner.js`, so the UI summarizes runs with this exact code instead of a copy that drifts.

import { validateSchema, schemaHint } from "./schema.js";
import { seedFor, rng } from "./tasks/gen.js";
import { applyFormat, complied as formatComplied } from "./format.js";
import { applyConfidence, readConfidence, calibration, calibrationView } from "./confidence.js";
import { applyAbstain, abstained, abstentionVerdict, abstentionView, unanswerableFor, NOTES as ABSTAIN_NOTES } from "./abstain.js";

// Every mode the benchmark knows. `noHarness` vs `harness` is the headline pair; `schemaOnly` and
// `toolOnly` are the two axes the bundle decomposes into. A task supports a mode by carrying a spec
// under that name — pairs it does not declare are skipped, see planMatrix.
export const MODE_NAMES = ["noHarness", "harness", "schemaOnly", "toolOnly"];
export const DEFAULT_MODES = ["noHarness", "harness"];

// A mode is one of two shapes, by *behavior* rather than by name:
//   - structured  -> inject the output schema, run tools, and score the parsed JSON.
//   - free-form   -> no schema, score the raw text (tools still run if the spec carries them).
// The classic "harness" bundle is the structured mode; the free-form mode is the bare baseline.
// Adding an axis means adding a mode name that is structured or free-form — no runner changes.
export function isStructuredMode(mode) {
  return mode === "harness" || mode === "schemaOnly";
}

// The schema therefore belongs in the prompt the model sees, not only in the scorer — whenever a
// mode is structured, not just the classic harness.
export function buildSystemPrompt(spec, mode) {
  const base = spec.system ?? "";
  if (!isStructuredMode(mode) || !spec.schema) return base;
  // Calibration runs showed models echoing the schema's own envelope ({"type":"array","items":[…]})
  // when told to "match this schema", so the instruction spells out instance-not-schema.
  return [
    base,
    "Return your final answer as a JSON value that is an instance of this JSON Schema (a value that validates against it — not the schema itself):",
    schemaHint(spec.schema),
    "Reply with that JSON value only — no prose, no markdown fences.",
  ].filter(Boolean).join("\n\n");
}

// Ground truth is either a function of the trial — called after the model has answered, with what
// the trial actually did — or a constant, for tasks whose truth is fixed. Passing the trial in lets
// a task define truth as "what my tools really returned", the only honest truth when the endpoint
// is random (see tasks/lookup.js).
async function resolveGround(task, ctx) {
  const g = task.eval.ground;
  return typeof g === "function" ? g(ctx) : g;
}

// The run file keeps a prompt for the drawer, not a 400 KB log; long prompts are cut in the record
// (the model received the whole thing — token counts in usage say so).
const PROMPT_RECORD_MAX = 20_000;
// An arm's raw transcript is kept whole up to this, so a row can be re-parsed when a parser improves.
const TRANSCRIPT_RECORD_MAX = 200_000;
function capText(t, what = "prompt", max = PROMPT_RECORD_MAX) {
  if (typeof t !== "string" || t.length <= max) return t;
  return `${t.slice(0, max)}\n…[${what} truncated in the record: ${t.length} characters in total]`;
}

// The same rule for the trial context. The row records what scoring and a replay need, not the
// environment the trial ran in: a task says what that is with `recordCtx` (needle drops its minted
// log — the seed the row keeps re-mints it; with the log, 36 needle100k rows made a 15 MB run file),
// and with or without a hook every string in the record is capped like the prompt. The live ctx —
// prompts, tools, ground, scorers, wrappers and arms — is untouched.
function recordedCtx(task, ctx) {
  const kept = ctx !== null && ctx !== undefined && typeof task.recordCtx === "function" ? task.recordCtx(ctx) : ctx;
  const cap = (v) => {
    if (typeof v === "string") return capText(v, "context");
    if (Array.isArray(v)) return v.map(cap);
    if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cap(x)]));
    return v;
  };
  return cap(kept);
}

/**
 * Score a trial record in place from what it holds — the parsed or raw answer, the ground truth,
 * the tool calls and results, the context — and report what the runner still has to apply (a
 * hijack the scorer saw). runTrial calls it once the ground is known; `rescore` calls it over the
 * rows of a saved run, so a run can be scored again with today's scorers and no model.
 * `ctx` is the context the scorers see (live in a trial, the recorded one in a re-score);
 * `hasTools` says whether the spec carried tools, which decides the tool-use verdict, and is read
 * from the spec and the context when not given.
 */
export async function scoreRecord(task, record, { judge = null, ctx = record.ctx ?? null, hasTools = null, schema = undefined } = {}) {
  const mode = record.mode;
  const base = task[mode] ?? {};
  // A format variant changed the schema the model was asked for; validity is judged against that.
  const treated = schema === undefined && record.format?.applied ? applyFormat(base, record.format.how, { structured: isStructuredMode(mode) }).spec : null;
  const spec = schema !== undefined ? { ...base, schema } : treated ?? base;
  const structured = isStructuredMode(mode);
  if (hasTools === null) {
    const tools = typeof spec.tools === "function" ? spec.tools(ctx ?? {}) : spec.tools;
    hasTools = (tools ?? []).length > 0;
  }

  // Schema validation belongs to the structured path. With no schema to check against
  // (toolOnly), schemaValid stays null rather than posing as a verdict.
  const parsed = record.structured === undefined ? null : record.structured;
  if (structured && spec.schema) {
    const { valid, errors } = validateSchema(parsed, spec.schema);
    record.schemaValid = parsed !== null && valid;
    record.schemaErrors = parsed === null ? ["final message was not JSON"] : errors;
  } else {
    record.schemaValid = null;
    record.schemaErrors = [];
  }

  // Structured modes score the parsed JSON; free-form scores the raw text. Scorers get the judge
  // (when one is configured) so an open-ended task can grade with it.
  const scorer = structured ? task.eval.scoreHarness : task.eval.scoreNoHarness;
  const answer = structured ? parsed : record.answerText;
  let score;
  if (record.abstain?.applied) {
    // The abstain variant: an unanswerable instance is right when the answer abstains; an
    // answerable one is scored by the task unless the answer abstained. A family with its own
    // reader (the missing thing reported as missing) refines the generic one, which it is handed.
    const generic = abstained(parsed, record.answerText);
    const did = typeof task.eval.abstained === "function" ? !!task.eval.abstained(answer, { structured, text: record.answerText ?? "", ctx, generic, mode }) : generic;
    const own = !record.abstain.unanswerable && !did ? await scorer(answer, record.ground, { judge, mode, ctx }) : null;
    score = abstentionVerdict({ unanswerable: !!record.abstain.unanswerable, abstainedAnswer: did, missing: record.abstain.missing, score: own });
    record.abstain.abstention = score.abstention;
  } else {
    score = await scorer(answer, record.ground, { judge, mode, ctx });
  }
  record.correct = !!score.correct;
  record.reason = score.reason ?? "";
  // A stated confidence is read here, so a re-score reads it again with today's reader.
  if (record.confidence?.applied) record.confidence.value = readConfidence(parsed, record.answerText ?? "");

  // A canonical form of the answer, for agreement across repeated trials of the same cell (the
  // variance measure). Only tasks with fixed truth define one; tasks whose truth is minted per
  // trial (random ids) leave it null and their variance is read from outcomes alone.
  record.canon = null;
  if (typeof task.eval.canon === "function") {
    try {
      const c = task.eval.canon(answer, { mode, structured });
      record.canon = c === null || c === undefined ? null : String(c);
    } catch { /* a canonicalizer that throws just leaves the answer uncounted */ }
  }
  record.judgeScore = score.judge ? score.judge.score ?? null : null;
  record.judgeReason = score.judge ? score.judge.reason ?? "" : "";

  // Was the tool used correctly — right tool, right arguments, right calls? A separate signal
  // from "final answer correct": a model can reach the right answer by hand after firing the
  // wrong tool, or fire the right tool and still misreport. Judged only when the spec carried
  // tools and the task defines a judge; null otherwise. A real-harness arm brings its own tools,
  // so a judge written against the bench's tools has nothing to say about it.
  record.toolUseOk = null;
  record.toolUseReason = "";
  // An arm that brought its own tools is not judged on the bench's; one that took the bench's
  // tools over the bridge is.
  if (hasTools && typeof task.eval.toolUse === "function" && (!record.harness || record.sharedTools)) {
    const use = await task.eval.toolUse({ mode, toolCalls: record.toolCalls ?? [], toolResults: record.toolResults ?? [], ctx, rounds: record.rounds ?? 0 });
    record.toolUseOk = !!use.ok;
    record.toolUseReason = use.reason ?? "";
  }
  return { hijacked: !!score.hijacked };
}

// Token usage summed across the turns of a dialogue (the client sums across a loop's rounds).
function sumUsage(a, b) {
  if (!b) return a;
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
    total_tokens: (a?.total_tokens ?? 0) + (b.total_tokens ?? 0),
  };
}

// A scripted dialogue on the tool path: the spec's prompt, then the user turns the spec scripts for
// this trial, each answered by a full tool loop that continues the same conversation. The synthetic
// client takes the conversation so far as `history` and returns it grown (`messages`); a client
// that returns none gets the turn and its answer appended. Calls, results and loop turns are tagged
// with the user turn they belong to; the final message is the last turn's.
async function runDialogue(client, prompts, tools, system, opts) {
  let history = [];
  const dialogue = [];
  const toolCalls = [];
  const toolResults = [];
  const turns = [];
  let usage = null;
  let reasoningChars = 0;
  let rounds = 0;
  let ttftMs = null;
  let ttfaMs = null;
  let last = null;
  // The row's prompt is the first turn as the model saw it (a wrapper may have added to it); each
  // dialogue entry keeps its own turn the same way.
  let firstPrompt;
  for (let t = 0; t < prompts.length; t++) {
    const n = t + 1;
    const started = performance.now();
    const resp = await client.runWithTools(prompts[t], tools, system, { ...opts, history, turn: n, turnsTotal: prompts.length });
    if (t === 0 && typeof resp.effectivePrompt === "string") firstPrompt = resp.effectivePrompt;
    for (const c of resp.toolCalls ?? []) toolCalls.push({ ...c, turn: n });
    for (const r of resp.toolResults ?? []) toolResults.push({ ...r, turn: n });
    for (const x of resp.turns ?? []) turns.push({ ...x, dialogueTurn: n });
    usage = sumUsage(usage, resp.usage);
    reasoningChars += resp.reasoningChars ?? 0;
    rounds += resp.rounds ?? 0;
    if (t === 0) { ttftMs = resp.ttftMs ?? null; ttfaMs = resp.ttfaMs ?? null; }
    dialogue.push({ turn: n, user: typeof resp.effectivePrompt === "string" ? resp.effectivePrompt : prompts[t], answer: resp.text ?? "", calls: (resp.toolCalls ?? []).length, rounds: resp.rounds ?? 0, ms: Math.round(performance.now() - started) });
    history = Array.isArray(resp.messages) ? resp.messages : [...history, { role: "user", content: prompts[t] }, { role: "assistant", content: resp.text ?? "" }];
    last = resp;
  }
  return { ...last, ...(firstPrompt !== undefined ? { effectivePrompt: firstPrompt } : {}), toolCalls, toolResults, turns: turns.length ? turns : null, usage, reasoningChars, rounds, ttftMs, ttfaMs, dialogue };
}

/** Run a single (task, mode, client) trial once and score it. Never throws. */
export async function runTrial({ task, mode, client, index = 1, signal, maxRounds = 4, judge = null, seed = null, pricing = null }) {
  // The instance seed: a generated task mints its problem from it, so the same seed re-mints the same
  // problem for every mode, client and later checkpoint. runMatrix derives it from the run's seed.
  const instance = Number.isInteger(seed) ? seed >>> 0 : seedFor(0, task.name, index);
  // A task carries a spec per mode (task[mode]). planMatrix only schedules the modes a task
  // declares, so a missing spec here means runTrial was called directly with a bad pair.
  const spec = task[mode];
  const structured = isStructuredMode(mode);
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
    ttftMs: null,
    ttfaMs: null,
    prompt: spec?.prompt ?? null,
    system: null,
    toolCalls: [],
    toolResults: [],
    rounds: 0,
    turns: null,
    transcript: null,
    dialogue: null,
    finishReason: null,
    answerText: null,
    structured: null,
    schemaValid: null,
    schemaErrors: [],
    correct: false,
    reason: "",
    toolUseOk: null,
    toolUseReason: "",
    judgeScore: null,
    judgeReason: "",
    usage: null,
    ground: null,
    ctx: null,
    // A client wrapped with a playbook ("<client>@skill:<how>") says so here and names the client
    // it is a variant of, so summarize can pair the two.
    skill: client.skill ? { how: client.skill, name: null, applied: false, loaded: null } : null,
    agents: client.agents ? { how: client.agents, applied: false, delegations: 0, childCalls: 0, childTokens: 0, children: [] } : null,
    stress: client.stress ? { how: client.stress, applied: false } : null,
    constraints: client.constraints ? { how: client.constraints, applied: false, total: 0, met: 0, list: [] } : null,
    format: client.format ? { how: client.format, applied: false, complied: null } : null,
    // A confidence variant asks for the model's probability that its answer is right; the row keeps it.
    confidence: client.confidence ? { how: client.confidence, applied: false, value: null } : null,
    // An abstain variant: whether this trial's instance was made unanswerable, and what the answer did.
    abstain: client.abstain ? { how: client.abstain, applied: false, unanswerable: false, missing: null, abstention: null } : null,
    // A perturbation variant: the same instance rewritten by the family, when it supports the kind.
    perturb: client.perturb ? { how: client.perturb, applied: false } : null,
    // The reasoning-effort knob as a variant: the level and the parameters it was sent as.
    effort: client.effort ? { how: client.effort, applied: true, params: client.effortParams ?? {} } : null,
    baseClient: client.baseName ?? null,
    seed: instance,
    // A public anchor set says so on every row, with the contamination caveat it carries.
    source: task.source ?? null,
    // A generated task mints a different instance per trial index: agreement is only measurable
    // between trials of the same instance (the same seed), so the row says whether it is one.
    seeded: task.seeded === true,
    // An arm that ran the bench's tools over the MCP bridge (its calls are bench-shaped and judged).
    sharedTools: false,
    // Cost in currency from the usage and the price table of the day (null when unpriced).
    cost: null,
    reasoningChars: null,
    reasoningTokens: null,
    error: null,
  };

  if (!spec) {
    record.reason = "unsupported mode";
    record.error = `task "${task.name}" has no "${mode}" spec`;
    return record;
  }

  try {
    // Per-trial context: a task with `setup` prepares isolated state (an inventory scenario, say),
    // and its prompts, goal, truth and scorers may be functions of it.
    let ctx = typeof task.setup === "function" ? await task.setup({ mode, index, signal, client, seed: instance }) : null;
    // An abstain variant makes a seeded half of a supporting task's instances unanswerable — in
    // the modes the family says the variant means something in (`abstainModes`; every declared
    // mode when it says nothing). The hooks may be async: extract re-posts its rewritten document.
    if (client.abstain && typeof task.unanswerable === "function" && ctx && (!Array.isArray(task.abstainModes) || task.abstainModes.includes(mode))) {
      record.abstain.applied = true;
      if (unanswerableFor(instance)) {
        ctx = await task.unanswerable(ctx, { mode });
        record.abstain.unanswerable = true;
        record.abstain.missing = ctx.missing ?? null;
      }
    }
    if (client.perturb && typeof task.perturb === "function" && ctx && (!Array.isArray(task.perturbs) || task.perturbs.includes(client.perturb))) {
      const rewritten = await task.perturb(ctx, client.perturb, instance, { mode });
      if (rewritten) { ctx = rewritten; record.perturb.applied = true; }
    }
    record.ctx = recordedCtx(task, ctx);
    const text = (v) => (typeof v === "function" ? v(ctx ?? {}) : v);
    let rspec = { ...spec, prompt: text(spec.prompt), system: text(spec.system), tools: text(spec.tools) };
    // A format variant strips or adds the work field before the schema hint is built from the spec.
    if (client.format) {
      const treated = applyFormat(rspec, client.format, { structured });
      rspec = treated.spec;
      record.format.applied = treated.applied;
    }
    // A confidence variant asks for the probability after the answer (a field, or a final line).
    if (client.confidence) {
      const asked = applyConfidence(rspec, { structured });
      rspec = asked.spec;
      record.confidence.applied = asked.applied;
    }
    if (record.abstain?.applied) rspec = applyAbstain(rspec, { structured }).spec;
    record.prompt = capText(rspec.prompt ?? null);

    const system = buildSystemPrompt(rspec, mode);
    record.system = system || null;

    // A mode that is structured (schema-aware) scores the parsed JSON. A mode that carries tools
    // runs them regardless — `toolOnly` is exactly free-form output *with* tools run, so tool
    // execution is gated on tools being present, not on structured scoring.
    const hasTools = (rspec.tools ?? []).length > 0;
    // A multi-turn spec scripts the user's later turns as a function of the trial context.
    const script = typeof spec.turns === "function" ? spec.turns(ctx ?? {}) : Array.isArray(spec.turns) ? spec.turns : [];
    // An arm builds its own prompt from the task's goal: it gets the treated schema (a format or
    // abstain variant changed it) and the abstain note the synthetic client's prompt carries.
    const callOpts = { maxRounds: task.maxRounds ?? maxRounds, signal, task, mode, ctx, seed: instance, schema: rspec.schema ?? null, abstain: record.abstain?.applied ? ABSTAIN_NOTES.structured : null };

    let resp;
    if (structured || hasTools) {
      // Tools run (if any) and the final message is parsed as JSON. What gets scored is the
      // model's final message written after it saw real tool output — never the tool args.
      resp = script.length
        ? await runDialogue(client, [rspec.prompt, ...script], rspec.tools ?? [], system, callOpts)
        : await client.runWithTools(rspec.prompt, rspec.tools ?? [], system, callOpts);
      record.toolCalls = resp.toolCalls ?? [];
      record.toolResults = resp.toolResults ?? [];
      record.rounds = resp.rounds ?? 0;
      record.structured = resp.structured ?? null;
      // A real-harness arm reports the model it actually routed to; record that, not the label.
      if (resp.harness?.model) record.model = resp.harness.model;
      if (resp.harness) record.harness = resp.harness.kind ?? "unknown";
      if (resp.harness?.sharedTools) record.sharedTools = true;
      // The session as it unfolded: the synthetic loop's turns (what the model said each round,
      // which calls it made, when) and an arm's raw transcript, capped like the prompt — so a row
      // can be read back as a timeline, exported as events, or re-parsed without the model.
      record.turns = Array.isArray(resp.turns) ? resp.turns.map((t) => ({ ...t, text: capText(t.text ?? "", "turn") })) : null;
      record.transcript = resp.transcript && typeof resp.transcript.text === "string"
        ? { format: resp.transcript.format ?? "text", chars: resp.transcript.text.length, text: capText(resp.transcript.text, "transcript", TRANSCRIPT_RECORD_MAX) }
        : null;
    } else {
      // Wrappers (skills, constraints) need the same context on this path as on the tool path. A
      // scripted dialogue continues the same messages: the answer, then the next user turn.
      let messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: rspec.prompt }];
      const dialogue = [];
      let usage = null;
      // The row's prompt is the first turn as the model saw it (a wrapper may have added to it).
      let firstPrompt;
      for (let t = 0; ; t++) {
        const started = performance.now();
        resp = await client.chat(messages, undefined, { signal, task, mode, ctx, seed: instance, ...(script.length ? { turn: t + 1, turnsTotal: script.length + 1 } : {}) });
        if (t === 0 && typeof resp.effectivePrompt === "string") firstPrompt = resp.effectivePrompt;
        usage = sumUsage(usage, resp.usage);
        if (script.length) dialogue.push({ turn: t + 1, user: typeof resp.effectivePrompt === "string" ? resp.effectivePrompt : messages.at(-1).content, answer: resp.text ?? "", calls: 0, rounds: 1, ms: Math.round(performance.now() - started) });
        if (t >= script.length) break;
        messages = [...messages, { role: "assistant", content: resp.text ?? "" }, { role: "user", content: script[t] }];
      }
      if (script.length && firstPrompt !== undefined) resp = { ...resp, effectivePrompt: firstPrompt };
      if (script.length) resp = { ...resp, usage, dialogue };
    }
    // The dialogue as it went: each user turn and the answer it got (capped like the prompt).
    record.dialogue = Array.isArray(resp.dialogue) ? resp.dialogue.map((d) => ({ ...d, user: capText(d.user ?? "", "turn"), answer: capText(d.answer ?? "", "turn") })) : null;

    if (resp.skill) record.skill = resp.skill;
    if (resp.agents) record.agents = resp.agents;
    if (resp.constraints) record.constraints = resp.constraints;
    if (record.format?.applied) record.format.complied = formatComplied(client.format, resp.structured ?? null);
    if (typeof resp.effectivePrompt === "string") record.prompt = capText(resp.effectivePrompt);
    // A variant that rewrote the system prompt reports what the model actually saw.
    if (typeof resp.effectiveSystem === "string") record.system = resp.effectiveSystem;
    record.answerText = resp.text ?? "";
    record.finishReason = resp.finishReason ?? null;
    record.usage = resp.usage ?? null;
    record.ttftMs = resp.ttftMs ?? null;
    record.ttfaMs = resp.ttfaMs ?? null;
    record.reasoningChars = typeof resp.reasoningChars === "number" ? resp.reasoningChars : null;
    // OpenAI's route does not stream its reasoning but counts it in the usage.
    record.reasoningTokens = typeof resp.usage?.completion_tokens_details?.reasoning_tokens === "number" ? resp.usage.completion_tokens_details.reasoning_tokens : null;
    record.cost = typeof pricing === "function" ? pricing(client, record.usage, { model: record.model }) ?? null : null;

    // Truth: fetched after the model's reply, so the answer and the ground are taken at the same
    // wall-clock point (the model never sees it). The trial is passed in so a task can define
    // truth in terms of what its tools actually returned.
    const ground = await resolveGround(task, {
      mode,
      toolCalls: record.toolCalls,
      toolResults: record.toolResults,
      structured: record.structured,
      answerText: record.answerText,
      ctx,
    });
    record.ground = ground;
    // A stress variant's environment reports back through the ground (the scenario's op log); a task
    // with no stress axis leaves the treatment unapplied, and the row says so.
    if (client.stress) record.stress = { how: client.stress, applied: !!ground?.stress, ...(ground?.stress ?? {}) };

    // Every verdict — correctness, schema validity, canon, judge, tool use — comes from the one
    // function a re-score runs over a saved row, so a run can be scored again with today's
    // scorers and land on exactly what a live trial would have.
    const { hijacked } = await scoreRecord(task, record, { judge, ctx, hasTools, schema: rspec.schema });
    // A scorer that recognises a planted value reports a hijack the op log cannot see.
    if (hijacked && record.stress) record.stress.hijacked = (record.stress.hijacked ?? 0) + 1;
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
 * The cells a request would actually run, in execution order (task → mode → client), and the
 * (task, mode) pairs it skips because the task declares no spec for that mode. Skipping — rather
 * than scoring an "unsupported mode" error row — keeps a mode's numbers about the model.
 */
export function planMatrix({ tasks, modes, clients, count = 1 }) {
  const cells = [];
  const skipped = [];
  for (const task of tasks) {
    for (const mode of modes) {
      if (!task[mode]) {
        skipped.push({ task: task.name, mode });
        continue;
      }
      for (const client of clients) {
        // A real-harness arm always brings its tools, so a free-form baseline from it would not be
        // a baseline; those pairs are skipped and reported, and the baseline comes from the
        // synthetic client for the same model.
        if (client.structuredOnly && !isStructuredMode(mode)) {
          skipped.push({ task: task.name, mode, client: client.name });
          continue;
        }
        // An arm runs one prompt to completion; it cannot take a user's scripted later turns.
        if (client.structuredOnly && task.multiTurn) {
          skipped.push({ task: task.name, mode, client: client.name, why: "multi-turn" });
          continue;
        }
        cells.push({ task, mode, client });
      }
    }
  }
  return { cells, skipped, total: cells.length * count };
}

/**
 * Run the full tasks x modes x clients matrix, `count` trials per cell.
 * `onEvent` receives { type: "start" | "trial" | "done", ... } as work completes.
 */
export async function runMatrix({ tasks, modes, clients, count = 1, parallel = 1, instanceSeed = null, onEvent, signal, maxRounds, judge = null, pricing = null }) {
  const { cells, skipped, total } = planMatrix({ tasks, modes, clients, count });
  const limit = Math.max(1, Math.floor(Number(parallel)) || 1);
  // One seed per run mints every generated instance; recorded so a run can be replayed exactly.
  const runSeed = Number.isInteger(Number(instanceSeed)) && instanceSeed !== null ? Number(instanceSeed) >>> 0 : Math.floor(Math.random() * 2 ** 31);
  const rows = [];
  let completed = 0;

  onEvent?.({
    type: "start",
    total,
    skipped,
    tasks: tasks.map((t) => t.name),
    modes,
    clients: clients.map((c) => c.name),
    count,
    parallel: limit,
    instanceSeed: runSeed,
  });

  // Trials in plan order (task → mode → client → index). Up to `limit` are in flight at once,
  // with one exception: a real-harness arm is scored against the webserver's time-windowed log of
  // what it served, so an arm trial runs alone — nothing else touches the server while it runs.
  // Rows are collected in completion order, which is plan order when `limit` is 1.
  const items = [];
  for (const { task, mode, client } of cells) {
    for (let i = 0; i < count; i++) items.push({ task, mode, client, index: i + 1 });
  }
  const alone = (client) => !!client.structuredOnly;

  const running = new Set();
  const start = (item) => {
    onEvent?.({ type: "trial-start", task: item.task.name, mode: item.mode, client: item.client.name, index: item.index, total });
    const p = runTrial({ ...item, seed: seedFor(runSeed, item.task.name, item.index), signal, maxRounds, judge, pricing })
      .then((row) => {
        rows.push(row);
        completed += 1;
        onEvent?.({ type: "trial", completed, total, result: row });
      })
      .finally(() => running.delete(p));
    running.add(p);
    return p;
  };

  for (const item of items) {
    if (signal?.aborted) break;
    if (alone(item.client)) {
      await Promise.all(running);
      if (signal?.aborted) break;
      await start(item);
    } else {
      while (running.size >= limit) await Promise.race(running);
      start(item);
    }
  }
  await Promise.all(running);

  const summary = summarize(rows, {
    capabilitiesOf: Object.fromEntries(tasks.map((t) => [t.name, t.capabilities ?? []])),
    levelsOf: Object.fromEntries(tasks.filter((t) => t.family).map((t) => [t.name, { family: t.family, level: t.level }])),
  });
  onEvent?.({ type: "done", completed, total, summary, skipped, cancelled: !!signal?.aborted, instanceSeed: runSeed });
  return { rows, summary, skipped, instanceSeed: runSeed };
}

// ---- statistical significance --------------------------------------------------------------
//
// The harness delta is the whole point of the benchmark, so a bare difference of two percentages
// tells you almost nothing — with a few trials, a 30-point gap is easily sampling noise. Every
// delta therefore carries a real answer to "is this gap real?":
//
//   - fisherExact   — Fisher's exact test on the 2×2 table (correct/incorrect × baseline/harness).
//                     It is exact at any sample size, which matters here: this bench routinely
//                     runs 1–5 trials per cell, where a z-test's normal approximation is invalid.
//                     This is the headline p-value.
//   - twoPropZTest  — the two-proportion z-test, kept for large samples and as a reference.
//   - wilsonInterval — a confidence band on a single proportion that stays honest near 0% / 100%.
//
// All pure math, no deps.

// Standard normal CDF via Abramowitz & Stegun 7.1.26 (max abs error 1.5e-7).
function normalCDF(z) {
  if (z === 0) return 0.5;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592;
  const erf = 1 - poly * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

// Standard-normal quantiles for common confidence levels; 95% is the default band.
function zForLevel(level) {
  const table = {
    0.90: 1.64485362695147,
    0.95: 1.95996398454005,
    0.99: 2.5758293035489,
  };
  return table[level] ?? table[0.95];
}

function twoPropZTest(n1, x1, n2, x2) {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  const z = se > 0 ? (p2 - p1) / se : 0;
  return { z, pValue: 2 * (1 - normalCDF(Math.abs(z))), oneSidedP: 1 - normalCDF(z) };
}

function wilsonInterval(x, n, level = 0.95) {
  if (n === 0) return { low: 0, high: 0 };
  const z2 = zForLevel(level) ** 2;
  const center = (x + z2 / 2) / (n + z2);
  const half = (zForLevel(level) * Math.sqrt(x * (1 - x / n) + z2 / 4)) / (n + z2);
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

// log(n!) with a growing memo. Fisher's test needs binomial coefficients that overflow doubles
// past n ≈ 170, so everything stays in log space.
const LOG_FACT = [0];
function logFactorial(n) {
  for (let i = LOG_FACT.length; i <= n; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
}
function logChoose(n, k) {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

// Fisher's exact test, two-sided: with the margins fixed, the probability of every table at least
// as unlikely as the observed one (the convention R's fisher.test uses).
// n1/x1 = trials/correct in one group, n2/x2 in the other.
function fisherExact(n1, x1, n2, x2) {
  const N = n1 + n2;
  const K = x1 + x2;
  const lo = Math.max(0, K - n2);
  const hi = Math.min(K, n1);
  const logP = (x) => logChoose(n1, x) + logChoose(n2, K - x) - logChoose(N, K);
  const observed = logP(x1);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logP(x);
    if (lp <= observed + 1e-9) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

export function pct(rows, cond) {
  if (!rows.length) return 0;
  return (rows.filter(cond).length / rows.length) * 100;
}

export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Exported so the significance helpers can be unit-tested and reused (e.g. per-cell significance).
export { normalCDF, twoPropZTest, wilsonInterval, fisherExact, deltaFor };

// Nearest-rank percentile (p in 0..100) of a list of numbers; 0 for an empty list.
export function percentile(xs, p) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

function statsFor(rows) {
  const judged = rows.filter((r) => r.toolUseOk === true || r.toolUseOk === false);
  const latencies = rows.map((r) => r.latencyMs ?? 0);
  const ttft = rows.map((r) => r.ttftMs).filter((v) => typeof v === "number");
  const ttfa = rows.map((r) => r.ttfaMs).filter((v) => typeof v === "number");
  return {
    runs: rows.length,
    correct: rows.filter((r) => r.correct).length,
    correctPct: pct(rows, (r) => r.correct),
    toolUsePct: pct(rows, (r) => (r.toolCalls?.length ?? 0) > 0),
    // Tool-use hygiene: of the rows a task judged, how many used the tool correctly.
    toolArgsJudged: judged.length,
    toolArgsOkPct: pct(judged, (r) => r.toolUseOk === true),
    schemaValidPct: pct(rows, (r) => r.schemaValid === true),
    judged: rows.filter((r) => typeof r.judgeScore === "number").length,
    judgeMeanScore: (() => { const j = rows.filter((r) => typeof r.judgeScore === "number"); return j.length ? mean(j.map((r) => r.judgeScore)) : null; })(),
    errorPct: pct(rows, (r) => !!r.error),
    avgLatencyMs: Math.round(mean(latencies)),
    latencyP50Ms: Math.round(percentile(latencies, 50)),
    latencyP95Ms: Math.round(percentile(latencies, 95)),
    latencyMaxMs: latencies.length ? Math.max(...latencies) : 0,
    // Time to first token (any kind) and to the first answer token, medians over streamed rows.
    ttftP50Ms: ttft.length ? Math.round(percentile(ttft, 50)) : null,
    ttfaP50Ms: ttfa.length ? Math.round(percentile(ttfa, 50)) : null,
    totalTokens: rows.reduce((a, r) => a + (r.usage?.total_tokens ?? 0), 0),
    ...costStats(rows),
  };
}

// Cost in currency over rows that carry a price: the total, per trial, per correct answer, and how
// many rows had no price (a model missing from the table) — reported, never guessed.
export function costStats(rows) {
  const priced = rows.filter((r) => r.cost && Number.isFinite(r.cost.usd));
  if (!priced.length) return { costUsd: null, costPerTrialUsd: null, costPerCorrectUsd: null, priced: 0, unpriced: rows.length };
  const usd = priced.reduce((a, r) => a + r.cost.usd, 0);
  const correct = priced.filter((r) => r.correct).length;
  return { costUsd: usd, costPerTrialUsd: usd / priced.length, costPerCorrectUsd: correct ? usd / correct : null, priced: priced.length, unpriced: rows.length - priced.length };
}

// Correctness × cost × latency, per client and mode: what a right answer costs and how long it
// takes, side by side with how often it comes.
export function costView(rows) {
  const out = [];
  for (const client of [...new Set(rows.map((r) => r.client))]) {
    for (const mode of [...new Set(rows.filter((r) => r.client === client).map((r) => r.mode))]) {
      const sub = rows.filter((r) => r.client === client && r.mode === mode && !r.error);
      if (!sub.length) continue;
      const correct = sub.filter((r) => r.correct).length;
      const reasoning = sub.map((r) => r.reasoningChars).filter((v) => typeof v === "number");
      const reasoningTokens = sub.map((r) => r.reasoningTokens).filter((v) => typeof v === "number");
      out.push({ client, mode, runs: sub.length, correct, correctPct: (100 * correct) / sub.length, latencyP50Ms: Math.round(percentile(sub.map((r) => r.latencyMs ?? 0), 50)), totalTokens: sub.reduce((a, r) => a + (r.usage?.total_tokens ?? 0), 0), reasoningCharsMean: reasoning.length ? Math.round(mean(reasoning)) : null, reasoningTokensMean: reasoningTokens.length ? Math.round(mean(reasoningTokens)) : null, ...costStats(sub) });
    }
  }
  return out;
}

// Variance across repeated trials of one cell, per instance: a fixed-truth task's trials are all
// the same instance; a generated task's trials are the same instance only when they share a seed
// (a replay, or another run on the same instance seed), and different problems are never compared.
// `agreementPct` is the trial-weighted share of trials that gave the modal canonical answer over
// the repeated instances (only for tasks that define `eval.canon`), `distinctAnswers` the mean
// number of distinct answers per repeated instance, `flakyInstances` how many repeated instances
// had both passes and failures; `flaky` says the cell had any. All null until an instance repeats.
// The instance a row is a trial of: a generated task's seed, a public anchor's item (its trial
// index picks the item from the set's fixed permutation), or the one fixed problem.
export const instanceKey = (r) => (r.seeded ? `seed:${r.seed}` : r.source === "public" ? `item:${r.index}` : "fixed");
export function instanceVariance(rows) {
  const groups = new Map();
  for (const r of rows) { const k = instanceKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const repeated = [...groups.values()].filter((g) => g.length >= 2);
  const canonGroups = repeated.map((g) => g.map((r) => r.canon).filter((c) => typeof c === "string")).filter((c) => c.length >= 2);
  let agreementPct = null, distinctAnswers = null;
  if (canonGroups.length) {
    const weight = canonGroups.reduce((a, c) => a + c.length, 0);
    const modal = (c) => { const counts = new Map(); for (const x of c) counts.set(x, (counts.get(x) ?? 0) + 1); return Math.max(...counts.values()); };
    agreementPct = (canonGroups.reduce((a, c) => a + modal(c), 0) / weight) * 100;
    distinctAnswers = Math.round((canonGroups.reduce((a, c) => a + new Set(c).size, 0) / canonGroups.length) * 10) / 10;
  }
  const flakyGroups = repeated.filter((g) => { const k = g.filter((r) => r.correct).length; return k > 0 && k < g.length; });
  return {
    canonRuns: canonGroups.reduce((a, c) => a + c.length, 0),
    agreementPct,
    distinctAnswers,
    repeatedInstances: repeated.length,
    flakyInstances: flakyGroups.length,
    flaky: repeated.length ? flakyGroups.length > 0 : null,
  };
}
const varianceFor = instanceVariance;

// One phrasing of a mode's stability, shared by the CLI report and the web UI.
export function describeStability(st) {
  if (!st || !st.repeated) return "single trials — repeat a cell to measure variance";
  const flaky = `${st.flaky}/${st.repeated} flaky ${st.repeated === 1 ? "cell" : "cells"}`;
  if (st.agreementPct === null) return `${flaky} · outcome-only (no task with a canonical answer)`;
  return `${st.agreementPct.toFixed(0)}% agreement over ${st.canonCells} ${st.canonCells === 1 ? "cell" : "cells"} · ${flaky}`;
}

// The harness delta: free-form rows against harness rows of the same slice.
function deltaFor(rows) {
  return deltaBetween(rows.filter((r) => r.mode === "noHarness"), rows.filter((r) => r.mode === "harness"));
}

// Baseline rows against treatment rows — the harness delta when the split is by mode, the skill
// delta when it is by client variant. Field names keep the historical noHarness*/harness* spelling
// (baseline/treatment) so every consumer, describeSignificance included, reads both the same way;
// the base*/treat* aliases say the same without the mode connotation.
export function deltaBetween(noH, withH, { bootstrap = true } = {}) {
  if (!noH.length || !withH.length) return null;
  const pairs = pairRows(noH, withH);
  const paired = pairs.length ? { ...pairedOutcome(pairs), bootstrap: bootstrap ? bootstrapDelta(pairs) : null } : null;
  const n = noH.length;
  const m = withH.length;
  const x1 = noH.filter((r) => r.correct).length;
  const x2 = withH.filter((r) => r.correct).length;
  const a = (x1 / n) * 100;
  const b = (x2 / m) * 100;
  const pValue = fisherExact(n, x1, m, x2);
  // The smallest p these sample sizes can produce at all (a 0% → 100% split). When even that is
  // ≥ 0.05, no outcome of this run could have been significant: the honest reading is "run more
  // trials", not "no effect".
  const minPValue = Math.min(fisherExact(n, 0, m, m), fisherExact(n, n, m, 0));
  return {
    noHarnessPct: a,
    harnessPct: b,
    deltaPp: b - a,
    noHarnessRuns: n,
    harnessRuns: m,
    noHarnessCorrect: x1,
    harnessCorrect: x2,
    // Two-sided Fisher exact p-value: the probability of a gap at least this large if the harness
    // made no difference. A harness that *hurts* is a real difference too, hence two-sided.
    pValue,
    minPValue,
    significant: pValue < 0.05,
    test: "fisher-exact",
    z: twoPropZTest(n, x1, m, x2).z,
    // Wilson intervals on each rate: confidence bands that are honest near 0% / 100%.
    noHarnessWilson: wilsonInterval(x1, n),
    harnessWilson: wilsonInterval(x2, m),
    basePct: a,
    treatPct: b,
    baseRuns: n,
    treatRuns: m,
    // The same comparison on paired instances, when both sides ran them (null otherwise).
    paired,
  };
}

// ---- paired statistics -----------------------------------------------------------------------
//
// When both sides of a comparison ran the same instances — same task and trial index, which for a
// generated task means the same seed and therefore the same problem — outcomes can be paired.
// McNemar's exact test then looks only at the discordant pairs, which has far more power than two
// independent proportions at the sample sizes this bench runs; a percentile bootstrap over the
// pairs gives a band on the delta itself.

// Two-sided exact McNemar: b = right only on the baseline side, c = right only on the treatment side.
export function mcnemarExact(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

// Pair rows across two sides by task and index (and client when both sides share clients; the
// variants — a skilled client against its base — drop the client). Empty when nothing pairs.
export function pairRows(base, treat) {
  const key = (r, withClient) => `${r.task}|${withClient ? r.client : ""}|${r.index}`;
  const attempt = (withClient) => {
    const a = new Map();
    const b = new Map();
    for (const r of base) { const k = key(r, withClient); if (a.has(k)) return null; a.set(k, r); }
    for (const r of treat) { const k = key(r, withClient); if (b.has(k)) return null; b.set(k, r); }
    const pairs = [];
    for (const [k, r] of a) if (b.has(k)) pairs.push([r, b.get(k)]);
    return pairs.length ? pairs : null;
  };
  return attempt(true) ?? attempt(false) ?? [];
}

export function pairedOutcome(pairs) {
  let both = 0, onlyBase = 0, onlyTreat = 0, neither = 0;
  for (const [a, b] of pairs) {
    if (a.correct && b.correct) both++;
    else if (a.correct) onlyBase++;
    else if (b.correct) onlyTreat++;
    else neither++;
  }
  const pValue = mcnemarExact(onlyBase, onlyTreat);
  return { n: pairs.length, both, onlyBase, onlyTreat, neither, pValue, significant: pValue < 0.05, test: "mcnemar-exact" };
}

// Percentile bootstrap on the paired delta (resampling pairs), seeded so a report is reproducible.
export function bootstrapDelta(pairs, { iterations = 1000, seed = 7 } = {}) {
  if (pairs.length < 2) return null;
  const rand = rng(seed);
  const deltas = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let a = 0, b = 0;
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[Math.floor(rand() * pairs.length)];
      if (p[0].correct) a++;
      if (p[1].correct) b++;
    }
    deltas[it] = ((b - a) / pairs.length) * 100;
  }
  deltas.sort((x, y) => x - y);
  const q = (f) => deltas[Math.min(iterations - 1, Math.floor(f * iterations))];
  return { low: q(0.025), high: q(0.975), iterations };
}

// Trials per side an unpaired two-proportion comparison needs to see a given delta at the usual
// two-sided α = 0.05 — the "run more" guidance when a gap is not significant.
export function sampleSizeFor({ baselinePct, deltaPp, power = 0.8 }) {
  const clamp = (p) => Math.min(0.995, Math.max(0.005, p));
  const p1 = clamp(baselinePct / 100);
  const p2 = clamp((baselinePct + deltaPp) / 100);
  if (p1 === p2) return Infinity;
  const za = 1.959963984540054;
  const zb = power >= 0.9 ? 1.2815515655446004 : 0.8416212335729143;
  const pbar = (p1 + p2) / 2;
  return Math.ceil((za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2);
}

export function describePaired(p) {
  if (!p) return "unpaired";
  const pv = p.pValue < 0.001 ? "p<0.001" : `p=${p.pValue.toFixed(2)}`;
  const band = p.bootstrap ? ` · 95% band ${p.bootstrap.low >= 0 ? "+" : ""}${p.bootstrap.low.toFixed(0)} to ${p.bootstrap.high >= 0 ? "+" : ""}${p.bootstrap.high.toFixed(0)} pp` : "";
  return `paired ${p.n}: ${p.onlyTreat} up · ${p.onlyBase} down · McNemar ${pv}${band}`;
}

export function describePower(d) {
  if (!d) return "";
  const target = Math.abs(d.deltaPp) >= 5 ? Math.abs(d.deltaPp) : 10;
  const n = sampleSizeFor({ baselinePct: d.noHarnessPct, deltaPp: target });
  return Number.isFinite(n) ? `to see a ${target.toFixed(0)} pp gap from ${d.noHarnessPct.toFixed(0)}% at 80% power, run about ${n} per side` : "";
}

// When a run asks many questions at once, some will look significant by chance. Bonferroni is
// conservative but honest: the number of cells that survive α / k is the number to believe.
export function multipleComparisons(deltas) {
  const ds = Object.values(deltas ?? {}).filter(Boolean);
  if (ds.length < 2) return null;
  const alpha = 0.05 / ds.length;
  return { comparisons: ds.length, bonferroniAlpha: alpha, expectedFalsePositives: ds.length * 0.05, significantRaw: ds.filter((d) => d.pValue < 0.05).length, significantBonferroni: ds.filter((d) => d.pValue < alpha).length };
}

// One phrasing of "is this gap real?" shared by the CLI, the aggregator and the web UI.
export function describeSignificance(d) {
  if (!d) return "n/a — needs both noHarness and harness";
  const n = `${d.noHarnessRuns} vs ${d.harnessRuns} trials`;
  const p = d.pValue < 0.001 ? "p<0.001" : `p=${d.pValue.toFixed(2)}`;
  if (d.pValue < 0.05) return `significant · ${p} · ${n}`;
  if (d.minPValue >= 0.05) return `inconclusive · ${p} · ${n} — too few trials for any result to reach p<0.05`;
  return `not significant · ${p} · ${n}`;
}

// The 2×2 that the four modes form: rows = tools (no / yes), columns = schema (no / yes).
//   noHarness  = no tools, no schema      schemaOnly = no tools, schema
//   toolOnly   = tools, no schema         harness    = tools, schema
// Effects are the average lift along each axis, in percentage points; null until at least three
// cells are present (two effects need three cells; the fourth adds the interaction).
export function twoByTwo(summary) {
  const cell = (m) => summary.byMode?.[m] ?? null;
  const grid = { noHarness: cell("noHarness"), schemaOnly: cell("schemaOnly"), toolOnly: cell("toolOnly"), harness: cell("harness") };
  const present = Object.values(grid).filter(Boolean).length;
  if (present < 3) return null;
  const pctOf = (c) => (c ? c.correctPct : null);
  const diffs = (pairs) => pairs.map(([a, b]) => (a !== null && b !== null ? b - a : null)).filter((v) => v !== null);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const toolsEffect = avg(diffs([[pctOf(grid.noHarness), pctOf(grid.toolOnly)], [pctOf(grid.schemaOnly), pctOf(grid.harness)]]));
  const schemaEffect = avg(diffs([[pctOf(grid.noHarness), pctOf(grid.schemaOnly)], [pctOf(grid.toolOnly), pctOf(grid.harness)]]));
  const interaction = present === 4
    ? (pctOf(grid.harness) - pctOf(grid.toolOnly)) - (pctOf(grid.schemaOnly) - pctOf(grid.noHarness))
    : null;
  return { grid, toolsEffect, schemaEffect, interaction };
}

// "gpt-4o-mini", "openai/gpt-4o-mini" and "GPT-4o-mini" are the same model for baseline matching.
function normalizeModel(m) {
  const s = String(m ?? "").toLowerCase();
  return s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s;
}

// A real-harness arm has no free-form rows of its own, so its delta is its harness rate against the
// free-form baseline of the same model from any other client in the run (normally the synthetic
// arm). Keyed by the arm's client name; absent when no client ran that model free-form.
function armDeltas(rows, clientNames, taskNames) {
  const byArm = {};
  for (const client of clientNames) {
    const own = rows.filter((r) => r.client === client);
    const harness = own.filter((r) => r.mode === "harness");
    if (!harness.length || own.some((r) => r.mode === "noHarness")) continue;
    const models = new Set(harness.map((r) => normalizeModel(r.model)));
    // Skilled variants are a treatment of their own; an arm's baseline is the plain model.
    const baseline = rows.filter((r) => r.mode === "noHarness" && r.client !== client && !r.baseClient && models.has(normalizeModel(r.model)));
    if (!baseline.length) continue;
    const byTask = {};
    for (const t of taskNames) {
      const d = deltaFor([...baseline, ...harness].filter((r) => r.task === t));
      if (d) byTask[t] = d;
    }
    byArm[client] = {
      overall: deltaFor([...baseline, ...harness]),
      byTask,
      baselineClients: [...new Set(baseline.map((r) => r.client))],
      model: [...models].join(", "),
    };
  }
  return byArm;
}

// Two sets of rows on the same instances — two clients in one run, or two runs on the same
// instance seed — compared pairwise, per task and overall. The checkpoint-versus-parent question.
export function compareRows(a, b, { mode = null } = {}) {
  const fa = mode ? a.filter((r) => r.mode === mode) : a;
  const fb = mode ? b.filter((r) => r.mode === mode) : b;
  // Rows of several modes share a task and index, so pairing happens within each mode.
  const modes = [...new Set([...fa, ...fb].map((r) => r.mode))];
  const pairs = modes.flatMap((m) => pairRows(fa.filter((r) => r.mode === m), fb.filter((r) => r.mode === m)));
  const byTask = {};
  for (const task of [...new Set(pairs.map(([r]) => r.task))]) {
    const ps = pairs.filter(([r]) => r.task === task);
    byTask[task] = { ...pairedOutcome(ps), aPct: (ps.filter(([r]) => r.correct).length / ps.length) * 100, bPct: (ps.filter(([, r]) => r.correct).length / ps.length) * 100 };
  }
  const overall = pairs.length ? { ...pairedOutcome(pairs), aPct: (pairs.filter(([r]) => r.correct).length / pairs.length) * 100, bPct: (pairs.filter(([, r]) => r.correct).length / pairs.length) * 100, bootstrap: bootstrapDelta(pairs) } : null;
  return { pairs: pairs.length, unpairedA: fa.length - pairs.length, unpairedB: fb.length - pairs.length, byTask, overall };
}

// A treated variant of a client ("<client>@skill:<how>", "<client>@agents:<how>") is paired with its
// base client on the same task and mode; the difference is the treatment's. `kind` names the row
// field the treatment writes (`skill` or `agents`). Keyed "task|mode|<variant client>"; `pooled`
// gathers every pair per `how`.
function variantDeltas(rows, kind) {
  const by = {};
  const pools = {}; // how → { base: Set<row>, treat: row[] }
  const treated = rows.filter((r) => r.baseClient && r[kind]);
  const stats = (treat) => ({
    applied: treat.filter((r) => r[kind]?.applied).length,
    loaded: treat.filter((r) => (r[kind]?.loaded ?? 0) > 0).length,                 // skills: the playbook was read
    used: treat.filter((r) => (r[kind]?.delegations ?? 0) > 0).length,              // agents: delegated at least once
    delegations: treat.reduce((a, r) => a + (r[kind]?.delegations ?? 0), 0),
    childTokens: treat.reduce((a, r) => a + (r[kind]?.childTokens ?? 0), 0),
    requests: treat.reduce((a, r) => a + (r[kind]?.requests ?? 0), 0),                 // stress: what the environment saw
    failed: treat.reduce((a, r) => a + (r[kind]?.failed ?? 0), 0),
    rejected: treat.reduce((a, r) => a + (r[kind]?.rejected ?? 0), 0),
    distractorCalls: treat.reduce((a, r) => a + (r[kind]?.distractorCalls ?? 0), 0),
    trap: treat.reduce((a, r) => a + (r[kind]?.trap ?? 0), 0),
    hijacked: treat.reduce((a, r) => a + (r[kind]?.hijacked ?? 0), 0),
    hijackedTrials: treat.filter((r) => (r[kind]?.hijacked ?? 0) > 0).length,
    met: treat.reduce((a, r) => a + (r[kind]?.met ?? 0), 0),                       // constraints: adherence
    total: treat.reduce((a, r) => a + (r[kind]?.total ?? 0), 0),
    complied: treat.filter((r) => r[kind]?.complied === true).length,             // format: the answer followed the treatment
    stated: treat.filter((r) => typeof r[kind]?.value === "number").length,        // confidence: a probability was given
    unanswerable: treat.filter((r) => r[kind]?.unanswerable).length,               // abstain: the four cases
    abstained: treat.filter((r) => r[kind]?.abstention === "abstained").length,
    fabricated: treat.filter((r) => r[kind]?.abstention === "fabricated").length,
    refused: treat.filter((r) => r[kind]?.abstention === "refused").length,
    calibration: kind === "confidence" ? calibration(treat) : undefined,
    reasoningCharsMean: (() => { const v = treat.map((r) => r.reasoningChars).filter((x) => typeof x === "number"); return v.length ? Math.round(mean(v)) : null; })(), // effort: how much reasoning came back
    reasoningTokensMean: (() => { const v = treat.map((r) => r.reasoningTokens).filter((x) => typeof x === "number"); return v.length ? Math.round(mean(v)) : null; })(), // …as OpenAI counts it
    costUsd: treat.reduce((a, r) => a + (r.cost?.usd ?? 0), 0),
  });
  for (const key of new Set(treated.map((r) => `${r.task}|${r.mode}|${r.client}`))) {
    const [task, mode, client] = key.split("|");
    const treat = treated.filter((r) => r.task === task && r.mode === mode && r.client === client);
    const base = rows.filter((r) => r.task === task && r.mode === mode && r.client === treat[0].baseClient);
    if (!base.length) continue;
    const how = treat[0][kind]?.how ?? "default";
    // Consistency counts only the trials the treatment actually touched: a row the treatment
    // could not apply to saw the same prompt as its base and would agree trivially.
    const consistency = consistencyOf(base, treat.filter((r) => r[kind]?.applied !== false));
    by[key] = { ...deltaBetween(base, treat), how, baseClient: treat[0].baseClient, ...stats(treat), consistency };
    const pool = (pools[how] ??= { base: new Set(), treat: [], pairs: 0, same: 0 });
    base.forEach((r) => pool.base.add(r));
    pool.treat.push(...treat);
    // Consistency pools by summing the cells: pairing across cells would collide on task and index.
    pool.pairs += consistency.pairs;
    pool.same += consistency.same;
  }
  // Pooled across models, a treated row pairs with its base's row of the same task and index: the
  // treated rows are keyed by their base client for the pairing, so McNemar applies to the pool too.
  const pooled = {};
  for (const [how, p] of Object.entries(pools)) { const treat = p.treat.map((r) => ({ ...r, client: r.baseClient })); pooled[how] = { ...deltaBetween([...p.base], treat), ...stats(p.treat), consistency: { pairs: p.pairs, same: p.same, pct: p.pairs ? (100 * p.same) / p.pairs : null } }; }
  return { by, pooled: Object.keys(pooled).length ? pooled : null };
}

// Consistency between a base and a treated variant: over the paired instances whose canonical
// answers both exist, the share that gave the same answer — right or wrong. The robustness
// measure beside the correctness delta: a perturbation that flips answers is fragile ground.
export function consistencyOf(base, treat) {
  const pairs = pairRows(base, treat).filter(([a, b]) => typeof a.canon === "string" && typeof b.canon === "string");
  const same = pairs.filter(([a, b]) => a.canon === b.canon).length;
  return { pairs: pairs.length, same, pct: pairs.length ? (100 * same) / pairs.length : null };
}

// Per capability: every row whose task is tagged with it, per mode, with a Wilson band and the
// harness delta. `capabilitiesOf` maps task name → tags (from the registry, or the UI's meta).
export function capabilityStats(rows, capabilitiesOf = {}) {
  const out = {};
  const caps = [...new Set(Object.values(capabilitiesOf).flat())];
  for (const cap of caps) {
    const sub = rows.filter((r) => (capabilitiesOf[r.task] ?? []).includes(cap));
    if (!sub.length) continue;
    const byMode = {};
    for (const m of [...new Set(sub.map((r) => r.mode))]) {
      const ms = sub.filter((r) => r.mode === m);
      const correct = ms.filter((r) => r.correct).length;
      byMode[m] = { runs: ms.length, correct, correctPct: (correct / ms.length) * 100, wilson: wilsonInterval(correct, ms.length) };
    }
    out[cap] = { tasks: [...new Set(sub.map((r) => r.task))], byMode, delta: deltaFor(sub) };
  }
  return out;
}

// Success against a family's difficulty knob. `levelsOf` maps task name → { family, level }. Per
// family, per client, per mode: one point per level with its Wilson band, and the *breaking point* —
// the first level, ascending, whose band's upper bound is under 50 % (null when none is).
export function curves(rows, levelsOf = {}) {
  const out = {};
  const tagged = rows.filter((r) => levelsOf[r.task]?.family);
  for (const family of [...new Set(tagged.map((r) => levelsOf[r.task].family))]) {
    const fam = tagged.filter((r) => levelsOf[r.task].family === family);
    const levels = [...new Set(fam.map((r) => levelsOf[r.task].level))].sort((a, b) => a - b);
    const byClient = {};
    for (const client of [...new Set(fam.map((r) => r.client))]) {
      const byMode = {};
      for (const mode of [...new Set(fam.filter((r) => r.client === client).map((r) => r.mode))]) {
        const points = levels.map((level) => {
          const ps = fam.filter((r) => r.client === client && r.mode === mode && levelsOf[r.task].level === level);
          if (!ps.length) return null;
          const correct = ps.filter((r) => r.correct).length;
          return { level, task: ps[0].task, runs: ps.length, correct, correctPct: (correct / ps.length) * 100, wilson: wilsonInterval(correct, ps.length) };
        }).filter(Boolean);
        const breaking = points.find((p) => p.wilson.high < 0.5);
        byMode[mode] = { points, breakingPoint: breaking ? breaking.level : null };
      }
      byClient[client] = byMode;
    }
    out[family] = { levels, byClient };
  }
  return out;
}

// Success by the depth of a single planted line, for rows whose context records one (the needle
// family's single-needle question): per client and mode, one point per depth with its band. Null
// when no row carries a depth.
export function depthSweep(rows) {
  const tagged = rows.filter((r) => typeof r.ctx?.depth === "number" && !r.error);
  if (!tagged.length) return null;
  const depths = [...new Set(tagged.map((r) => r.ctx.depth))].sort((a, b) => a - b);
  const byClient = {};
  for (const client of [...new Set(tagged.map((r) => r.client))]) {
    const byMode = {};
    for (const mode of [...new Set(tagged.filter((r) => r.client === client).map((r) => r.mode))]) {
      const byDepth = {};
      for (const depth of depths) {
        const ps = tagged.filter((r) => r.client === client && r.mode === mode && r.ctx.depth === depth);
        if (!ps.length) continue;
        const correct = ps.filter((r) => r.correct).length;
        byDepth[depth] = { depth, runs: ps.length, correct, correctPct: (correct / ps.length) * 100, wilson: wilsonInterval(correct, ps.length) };
      }
      byMode[mode] = byDepth;
    }
    byClient[client] = byMode;
  }
  return { depths, trials: tagged.length, byClient };
}

export function summarize(rows, { capabilitiesOf = null, levelsOf = null } = {}) {
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
        if (sub.length) cells.push({ task, client, mode, ...statsFor(sub), ...varianceFor(sub) });
      }
    }
  }

  // Stability per mode, aggregated over cells (agreement across different tasks would be
  // meaningless): how many repeated cells were flaky, and the trial-weighted agreement over the
  // cells whose task defines a canonical answer.
  const stability = {};
  for (const m of modes) {
    const cs = cells.filter((c) => c.mode === m);
    // A cell is repeated when some instance in it ran more than once — for a generated task that
    // takes a replay or the same instance seed, four different problems are not a repeat.
    const repeated = cs.filter((c) => c.repeatedInstances > 0);
    const canonCells = repeated.filter((c) => c.agreementPct !== null);
    const weight = canonCells.reduce((a, c) => a + c.canonRuns, 0);
    stability[m] = {
      cells: cs.length,
      repeated: repeated.length,
      flaky: repeated.filter((c) => c.flaky).length,
      canonCells: canonCells.length,
      agreementPct: weight ? canonCells.reduce((a, c) => a + c.agreementPct * c.canonRuns, 0) / weight : null,
    };
  }

  const byTask = {};
  for (const t of taskNames) byTask[t] = deltaFor(rows.filter((r) => r.task === t));

  const byClient = {};
  for (const c of clientNames) byClient[c] = deltaFor(rows.filter((r) => r.client === c));

  // Per (task, client) — the finest grain a delta makes sense at; keyed "task|client".
  const byTaskClient = {};
  for (const t of taskNames) {
    for (const c of clientNames) {
      const sub = rows.filter((r) => r.task === t && r.client === c);
      if (sub.length) byTaskClient[`${t}|${c}`] = deltaBetween(sub.filter((r) => r.mode === "noHarness"), sub.filter((r) => r.mode === "harness"), { bootstrap: false });
    }
  }

  // The capability scorecard for this run, per client (only when the caller knows the tags).
  const capabilities = {};
  if (capabilitiesOf && Object.keys(capabilitiesOf).length) {
    for (const c of clientNames) {
      const stats = capabilityStats(rows.filter((r) => r.client === c), capabilitiesOf);
      for (const [cap, st] of Object.entries(stats)) {
        (capabilities[cap] ??= { tasks: st.tasks, byClient: {} }).byClient[c] = { byMode: st.byMode, delta: st.delta };
      }
    }
  }

  const skillD = variantDeltas(rows, "skill");
  const agentsD = variantDeltas(rows, "agents");
  const stressD = variantDeltas(rows, "stress");
  const constraintsD = variantDeltas(rows, "constraints");
  const formatD = variantDeltas(rows, "format");
  const effortD = variantDeltas(rows, "effort");
  const confidenceD = variantDeltas(rows, "confidence");
  const abstainD = variantDeltas(rows, "abstain");
  const perturbD = variantDeltas(rows, "perturb");

  return {
    runs: rows.length,
    cost: costView(rows),
    calibration: calibrationView(rows),
    abstention: abstentionView(rows),
    tasks: taskNames,
    modes,
    clients: clientNames,
    byMode,
    cells,
    stability,
    capabilities,
    curves: levelsOf && Object.keys(levelsOf).length ? curves(rows, levelsOf) : {},
    depths: depthSweep(rows),
    multiple: multipleComparisons(byTaskClient),
    delta: {
      overall: deltaFor(rows),
      byTask,
      byClient,
      byTaskClient,
      byArm: armDeltas(rows, clientNames, taskNames),
      bySkill: skillD.by,
      skill: skillD.pooled,
      byAgents: agentsD.by,
      agents: agentsD.pooled,
      byStress: stressD.by,
      stress: stressD.pooled,
      byConstraints: constraintsD.by,
      constraints: constraintsD.pooled,
      byFormat: formatD.by,
      format: formatD.pooled,
      byEffort: effortD.by,
      effort: effortD.pooled,
      byConfidence: confidenceD.by,
      confidence: confidenceD.pooled,
      byAbstain: abstainD.by,
      abstain: abstainD.pooled,
      byPerturb: perturbD.by,
      perturb: perturbD.pooled,
    },
  };
}
