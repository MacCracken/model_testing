# LLM Harness Benchmark — plan

## Goal

Build a small Node project that measures **model capability with vs. without a harness**,
using the existing `webserver` as the concrete task environment. Each task is run in **two
modes** and scored the same way, so the delta is attributable to the harness:

- **No-harness** — raw free-form API call. Natural-language prompt only; no tools, no output
  schema. The model's answer is free text we parse/ad-hoc.
- **With-harness** — the same task wrapped with **tools + output schema + structured prompts**.
  The model must call the tool(s) and return structured output.
- **schemaOnly** — schema + structured prompt, **no tools** (isolates the "ask for JSON" axis).
- **toolOnly** — the tools, **no schema**, free-form answer (isolates the "give it tools" axis).
  The model must call the tool(s) and return structured output.

Evaluation is a **mix**: automated/ground-truth checks where the task has a definite answer,
plus LLM-as-judge for open-ended tasks.

## Key design decisions

- **Provider abstraction via OpenAI-compatible REST client.** Both OpenAI and Anthropic
  (and Groq/DeepSeek/Together/Cerebras, etc.) accept OpenAI-style `/chat/completions`
  requests with function calling. One thin client covers multiple providers with no heavy SDKs.
  - Note: Anthropic's native SDK differs, but Anthropic's *API* supports OpenAI-compatible
    requests at `https://api.anthropic.com/v1/chat/completions`, so the same client works. We
    document this; if you specifically want Anthropic's SDK behavior we can add a provider shim.
- **Harness tool calls hit real implementations.** Tool definitions pair with real functions
  (e.g. `GET /health`) that actually run. This tests whether the model knows how to call tools
  correctly against real code — the heart of the "harness" question.
- **Fair comparison.** The *underlying goal* is identical across modes; only the scaffolding
  (tools/schema/prompts) differs. Scoring is identical across modes so the delta is the harness.

## Structure

```
llm-harness-bench/
  package.json            # ESM, zero extra deps (Node built-in fetch/crypto)
  README.md               # how to run + what the experiment measures
  CLAUDE.md               # project conventions
  .env.example            # API keys per provider
  .gitignore              # node_modules, results/, .env
  src/
    providers/client.js   # OpenAI-compatible chat client: messages + tools + function calling
    providers/index.js    # config + provider registry
    tasks/registry.js     # task list (prompt per mode, tools, schema, evaluator)
    tasks/health.js       # example: report webserver health
    tasks/hello.js        # example: call /api/hello?name=...
    bench.js              # run one task in one mode -> structured result
    aggregate.js          # run all tasks x models x modes, score, aggregate
    cli.js                # entry point: providers/tasks/modes flags
  tasks/                  # JSON task specs (extends registry over time)
  results/                 # gitignored output
```

## Tasks (starting set)

1. **health** — "Is the webserver up? Report its status."
   - noHarness: free-text answer, no tools.
   - withHarness: `health` tool + structured schema; model calls it.
   - Eval: automated (compare returned status to real `/health`).
2. **hello** — "Get a greeting for N people."
   - noHarness: free text.
   - withHarness: `hello` tool + schema.
   - Eval: automated (exact-match / regex on the greeting JSON).

## Scoring

Each run produces a record: `{ task, mode, provider, model, toolUsed, schemaValid, correct,
latencyMs, tokens }`. Aggregation reports per-mode/per-provider/model breakdowns and the
**harness delta** (e.g. % correct, % tool-used, schema-validity, avg latency).

Judging (LLM-as-judge) is pluggable — attach a `judge` to a task's `answer` block to score
open-ended tasks; automated `answer` blocks use regex / exact-match / optional code-exec via
`node -e`.

## Next steps (after approval)

1. Scaffold repo + `providers/client.js` (tools + function-calling support).
2. Wire `tasks/registry.js` with the two example tasks.
3. Implement `bench.js` + `aggregate.js`, run end-to-end against one provider to validate.
4. Add a JSON task-spec format + a couple more tasks (e.g. a code-exec task).
5. README + `.env.example`.

## Open questions for you

1. **Which providers/models?** (e.g. OpenAI gpt-4o-mini + gpt-4o, Anthropic claude models).
   Keys go in `.env`; the registry references them by name.
2. **Harness routing:** tool calls hit the *real webserver* implementations (recommended), or
   the model performs HTTP itself? I'll default to real implementations.
3. **Judging:** for the starting tasks, automated ground-truth is enough. Open-ended judge
   tasks can be added later.
