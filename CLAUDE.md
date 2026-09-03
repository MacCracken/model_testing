# Project conventions

This repo benchmarks **LLM capability with vs. without a harness**. Keep that framing central:
every task defines the *same goal* and is run in `noHarness` (free-form) and `harness`
(tools + schema + structured prompts) modes, scored identically so the delta is the harness.

A mode is defined by **behavior**, not just by name: it is either *structured* (inject the output
schema, run any tools, and score the parsed JSON) or *free-form* (no tools, score the raw text).
`harness` is structured; `noHarness` is free-form. `schemaOnly` and `toolOnly` reuse the same two
behaviors to isolate the harness's axes — see `isStructuredMode` in `runner.js`. Adding a mode means
adding a name that is one or the other; `runTrial` needs no per-mode special-casing.

## Layout

- `src/providers/` — OpenAI-compatible client + provider registry (`index.js`). No SDKs.
- `src/tasks/` — task specs: prompt/tools/schema per mode + `eval` block (ground + scorers).
- `src/runner.js` — **the execution core**: runs one (task, mode, client) trial, scores it,
  aggregates the matrix. Every surface (CLI and web) goes through this so they can't disagree.
- `src/results.js` — run persistence (`results/runs/<id>.json`).
- `src/json.js` / `src/schema.js` — tolerant JSON extraction + a minimal schema validator.
- `src/bench.js` — CLI over `runMatrix`; `--json` for machine-readable output.
- `src/aggregate.js` — the same matrix with a comparative report.
- `src/web/` — the control plane: `server.js` (node:http, zero deps) + `public/` (the UI).
- `src/cli.js` — entry point (`list` / `serve` / `bench` / `aggregate`).

## Task spec shape

```js
export const task = {
  name: "health",
  category: "api-call",
  description: "…",       // shown in the UI and `cli list`
  model: labelModel,
  noHarness: { prompt, extract: "text" },
  harness:   { system, prompt, tools: [...], schema, extract: "structured" },
  eval: {
    ground,         // hit the real endpoint for truth
    scoreHarness,   // (structuredOutput, ground) => { correct, reason }
    scoreNoHarness, // (freeText, ground)         => { correct, reason }
  },
};
```

Tools use `{ name, description, parameters, impl }` — `impl` is a real async function (hitting
the real endpoint). The runner **executes** it and feeds the result back to the model, so
harness mode tests genuine tool-calling. What gets scored is the model's *final message* after
it has seen tool output — never the arguments it passed in.

`harness.schema` is injected into the system prompt (the schema is part of the harness under
test) and used to compute `schemaValid`.

## Modes

- `noHarness`: model answers a free-form prompt. `extract: "text"`.
- `harness`: model calls tools; final message parsed as JSON. `extract: "structured"`.

## Providers

Add entries to `PROVIDERS` in `src/providers/index.js` (name → baseUrl, auth, default models)
and labels to `MODEL_LABELS`. Keys live in `.env`. Local (Ollama) models are probed live from
`/v1/models`, so that list stays honest without edits.

## Commands

```bash
node src/cli.js serve                       # web UI on http://127.0.0.1:4000
node src/cli.js list                        # tasks/providers, with key status
node src/bench.js --task all --modes harness --clients openai:gpt-4o-mini
node src/aggregate.js --tasks health,hello --modes noHarness,harness --clients local
```

The `webserver/` directory is the **system under test**, not part of the benchmark harness —
keep it minimal. Every run (CLI or web) is saved to `results/`, which is gitignored along
with `.env`.
