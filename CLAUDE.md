# Project conventions

This repo benchmarks **LLM capability with vs. without a harness**. Keep that framing central:
every task defines the *same goal* and is run in `noHarness` (free-form) and `harness`
(tools + schema + structured prompts) modes, scored identically so the delta is the harness.

## Layout

- `src/providers/` — OpenAI-compatible client + provider registry (`index.js`). No SDKs.
- `src/tasks/` — task specs: prompt/tools/schema per mode + `eval` block (ground + scorers).
- `src/bench.js` — run one task in one mode; `--json` for machine-readable output.
- `src/aggregate.js` — full task × mode × client matrix + harness delta.
- `src/cli.js` — entry point (`list` / `bench` / `aggregate`).

## Task spec shape

```js
export const task = {
  name: "health",
  category: "api-call",
  model: labelModel,
  noHarness: { prompt, extract: "text|structured" },
  harness:   { system, prompt, tools: [...], extract: "structured" },
  eval: {
    ground,
    scoreHarness,   // (output, ground) => { correct, reason }
    scoreNoHarness, // (output, ground) => { correct, reason }
  },
};
```

Tools use `{ name, description, parameters, impl }` — `impl` is a real async function (hitting the
real endpoint), so harness mode tests genuine tool-calling, not mock calls.

## Modes

- `noHarness`: model answers a free-form prompt. `extract: "text"`.
- `harness`: model calls tools; final message parsed as JSON. `extract: "structured"`.

## Providers

Add entries to `PROVIDERS` in `src/providers/index.js` (name → baseUrl, auth, default models) and
labels to `MODEL_LABELS`. Keys live in `.env`.

## Commands

```bash
node src/cli.js list                       # list tasks/providers
node src/bench.js --task all --mode harness --clients openai:gpt-4o-mini
node src/aggregate.js --tasks health,hello --modes noHarness,harness --clients openai:gpt-4o-mini
```

`results/` and `.env` are gitignored.
