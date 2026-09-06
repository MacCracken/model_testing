# Project conventions

This repo benchmarks **LLM capability with vs. without a harness**. Keep that framing central:
every task defines the *same goal* and is run in `noHarness` (free-form) and `harness`
(tools + schema + structured prompts) modes, scored identically so the delta is the harness.

A mode is defined by **behavior**, not just by name: it is either *structured* (inject the output
schema, run any tools, and score the parsed JSON) or *free-form* (no schema, score the raw text;
tools still run if the spec carries them). `harness` is structured; `noHarness` is free-form.
`schemaOnly` (structured, no tools) and `toolOnly` (free-form, with tools) reuse the same two
behaviors to isolate the harness's axes — see `isStructuredMode` in `runner.js`. `MODE_NAMES` and
`DEFAULT_MODES` in `runner.js` are the single list of modes; every surface imports them.

A task supports a mode by declaring a spec under that name. `planMatrix` **skips** any (task, mode)
pair the task does not declare — it is reported as a warning, never scored as an error row, so a
mode's numbers stay about the model. The four tool tasks declare all four modes; `reason` has no
tools, so its `schemaOnly` is its harness spec and it declares no `toolOnly`. The decomposition specs
are written by hand, not derived: a free-form prompt says "without any tools" and a harness prompt
says "call the X tool and return JSON", so a derived spec would contradict itself.

## Layout

- `src/providers/` — OpenAI-compatible client + provider registry (`index.js`). No SDKs. The client
  streams by default (SSE chunks, tool-call deltas merged by index, usage from the trailing chunk) and
  records `ttftMs` / `ttfaMs`; `stream: false` keeps the plain path.
- `src/tasks/` — task specs: prompt/tools/schema per mode + `eval` block (ground + scorers).
  `tasks/util.js` holds what they share: the webserver `BASE` URL and `unwrapList`.
- `src/runner.js` — **the execution core**: runs one (task, mode, client) trial, scores it,
  aggregates the matrix, and owns the statistics. Every surface (CLI and web) goes through this so
  they can't disagree — the web server serves it to the browser as `/lib/runner.js`, so it must
  stay free of Node-specific imports.
- `src/results.js` — run persistence (`results/runs/<id>.json`).
- `src/json.js` / `src/schema.js` — tolerant JSON extraction + a minimal schema validator.
- `src/env.js` — loads `.env` into `process.env` (never overriding real env vars). Imported first
  by every entry point and by `providers/index.js`.
- `src/bench.js` — CLI over `runMatrix`; `--json` for machine-readable output.
- `src/aggregate.js` — the same matrix with a comparative report.
- `src/report.js` — the one text report over a summary, used by `aggregate` and `cli show`.
- `src/export.js` — CSV views of a run (trial rows, or task × model × mode cells).
- `src/version.js` — bench version / git commit / node, recorded on every run as `versions`.
- `src/judge.js` — LLM-as-judge: `makeJudge(client)` returns `({ rubric, answer, ground, task }) =>
  { score, reason }`, asked for strict JSON and handed the task's ground truth. The runner passes the
  judge to every scorer as `{ judge, mode }`; `--judge provider:model` / `BENCH_JUDGE` / the recipe
  field choose it; the run records it and each row keeps `judgeScore` / `judgeReason`.
- `src/harness/` — real agent harnesses as the harness arm. `util.js` holds what arms share: the
  goal prompt (goal + the same schema instruction the synthetic harness gets), recovery of the
  webserver's replies from raw tool output into bench-shaped tool results, the argv splitter and the
  child runner. `claude-code.js` runs `claude -p --bare --output-format json` and parses its
  transcript (tool outputs included). `pi.js` runs `pi --mode json -p` and reads its `message_end`
  events (tool outputs, usage and cost). `codex.js` runs `codex exec --json` (documented item shapes;
  needs `codex login`). `thoth.js` spawns `thoth --events` (stdin closed, task quoted for ssh) and
  folds its NDJSON (no tool-result contents). Arms report the routed model, run structured modes only
  (`structuredOnly`; the planner skips the rest), and the bench's tool-use judge stays null for them.
  `runChild` timestamps every output line; `eventTimings` turns that into the arm's `ttftMs` (first
  visible action) and `ttfaMs` (final answer) — event-level, coarser than the synthetic client's
  token-level timings. Claude Code therefore runs with `--output-format stream-json --verbose`.
  Tasks expose a `goal` (plain job statement, endpoint described, no bench tool names) for arms;
  `runTrial` passes `task` and `mode` to `runWithTools` so an arm can build its own prompt.
- `src/web/` — the control plane: `server.js` (node:http, zero deps) + `public/` (the UI).
- `src/cli.js` — entry point (`list` / `show` / `export` / `serve` / `bench` / `aggregate`).
- `test/` — `npm test` (node:test, no deps). Scorers are tested with synthetic ground values, the
  runner with a fake client; nothing in the suite needs a model or the webserver.

## Task spec shape

```js
export const task = {
  name: "health",
  category: "api-call",
  description: "…",       // shown in the UI and `cli list`
  model: labelModel,
  goal: "…",               // the job in plain words, for real-harness arms that bring their own tools
  noHarness: { prompt, extract: "text" },
  harness:   { system, prompt, tools: [...], schema, extract: "structured" },
  // optional: schemaOnly / toolOnly specs for the decomposition axes
  eval: {
    ground,         // truth: a function of the trial, or a constant (see below)
    scoreHarness,   // (structuredOutput, ground, { judge, mode }) => { correct, reason, judge? }
    scoreNoHarness, // (freeText, ground, { judge, mode })         => { correct, reason, judge? }
    toolUse,        // optional: ({ toolCalls, toolResults }) => { ok, reason } — right tool, right args
    needsJudge,     // optional: true when the scorers grade through the judge (explain)
  },
};
```

Tools use `{ name, description, parameters, impl }` — `impl` is a real async function (hitting
the real endpoint). The runner **executes** it and feeds the result back to the model, so
harness mode tests genuine tool-calling. What gets scored is the model's *final message* after
it has seen tool output — never the arguments it passed in.

`eval.ground` is called **after** the model answers with the trial itself:
`{ mode, toolCalls, toolResults, structured, answerText }`. Most tasks ignore the argument and hit
the endpoint; `lookup` defines truth as the ids its tool actually returned, because the endpoint
mints a new random id per call and any later fetch would be a different number. A task with fixed
truth (`reason`) uses a constant instead of a function.

`harness.schema` is injected into the system prompt (the schema is part of the harness under
test) and used to compute `schemaValid` (null when a mode has no schema to check against).
Scorers judge content, not wrappers: use `unwrapList` so a list under `results`, `data` or the
schema's own `items` key scores the same as a bare array.

## Statistics

`summarize` also computes `delta.byArm`: for a client with harness rows and no free-form rows of its
own (a real-harness arm), its delta against the free-form rows of the same model from any other
client in the run, matched on the model id with any `provider/` prefix stripped.

The headline delta carries a two-sided **Fisher exact** p-value (`fisherExact` in `runner.js`),
exact at the handful of trials this bench actually runs; the z-test and Wilson intervals are kept
as helpers. `describeSignificance` is the one phrasing every surface prints — including
"inconclusive … too few trials" when the sample size could not have reached p < 0.05 at all
(three trials per side never can; four is the floor for a 0% → 100% split).

## Providers

Add entries to `PROVIDERS` in `src/providers/index.js` (name → baseUrl, auth, default models)
and labels to `MODEL_LABELS`. Keys live in `.env`. `local` (Ollama) needs no key; its models are
probed live from `/v1/models` and the UI marks the provider offline when the daemon is down.
`OLLAMA_BASE_URL`, `SUT_PORT` (the webserver's port; `PORT` is a legacy fallback) and `RESULTS_DIR` are honored from `.env` too.

## Commands

```bash
npm test                                    # unit tests, no model needed
node src/cli.js serve                       # web UI on http://127.0.0.1:4000
node src/cli.js list                        # tasks/providers, with key status
node src/cli.js show <run-id> --table       # review a saved run without the UI
node src/cli.js export <run-id> --cells     # CSV of the cells (or of every trial without --cells)
node src/bench.js --task chain --modes harness --clients local:ornith-1.5:9b --count 4 --temperature 0 --seed 7
node src/bench.js --task all --modes harness --clients openai:gpt-4o-mini
node src/aggregate.js --tasks health,hello --modes noHarness,harness --clients local
```

The `webserver/` directory is the **system under test**, not part of the benchmark harness —
keep it minimal. Its one concession to the bench is `GET /api/recent?since=&until=`, a log of the
last few hundred `/api/hello` replies, which lets real-harness arms be scored against what the
server actually served (`recentGreetings` in `harness/util.js`). Every run (CLI or web) is saved to `results/`, which is gitignored along
with `.env`. `plan.md` is the roadmap; keep its "done" claims tied to what the tests and saved runs
actually show.
