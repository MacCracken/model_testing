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

---

# Roadmap: improving the benchmark (in-progress)

Working through the improvement tiers below, one at a time. Each tier is roughly independent, so
the roadmap is resilient to a session ending mid-tier. Current state at start of this session:
**44/44 tests pass, clean tree, 4 prior runs.** The harness delta is currently a plain difference of
two percentages with no significance test — the highest-leverage gap.

## Tier 1 — Core premise: is the delta real? (COMPLETE)

- **[1] Statistical significance on the harness delta.** Turn the headline from "a difference" into
  "a real difference." Add a binomial test / Wilson interval on harness-vs-baseline to the
  aggregator, CLI, and web. This is the feature that makes the benchmark trustworthy instead of a
  bar chart of noise. **Action: implement.**
- **[2] A tool-essential calibration task.** Every current task is tool-*optional* (you can answer
  without tools, tools just nudge). Need a task where the tool is genuinely required — e.g. "which
  of these files match a regex?" — so no-harness floors out and harness is required. Also surfaces
  the real failure mode: small models that refuse/can't call tools at all. **DONE:** added `lookup`
  task (`src/tasks/lookup.js`), registered in `registry.js`, tested in `test/tasks.test.js`. The
  webserver's `/api/hello?name=` returns a fresh random UUID per call — nothing to memorize, so a
  free-form model cannot produce the real ids (verified live: no-harness 0/3, harness tool-calls
  100% but 0/3 correct). This isolates "the tool is required" from "the schema is required".
  Live run (local:ornith-1.5:9b, 3 trials): no-harness 0% correct (correctly reports it can't
  guess), harness 100% tool-calls but 0% correct — the model fired the tool 3× but never passed
  the required `name` arg, so each call returned a different random id and matched none of ground.
  This reveals a *second* harness failure mode beyond "can't call tools at all": models that call
  tools but use them wrong. Next: a task that rewards correct multi-arg tool use (e.g. the regex
  task in the roadmap), and possibly tightening the lookup prompt so the model passes `name`.
- **[3] Tool complexity.** Current tools are trivial (one arg or none). Add: multiple tools where
  the model must pick, typed required args, a decoy/wrong-tool path, stateful side effects. Tests
  whether models *reason about* tools, not just fire a one-shot. **DONE:** added `regex` task
  (`src/tasks/regex.js`, registered, 8 tests in `test/tasks.test.js`). Two tools: the correct
  `regex_match` (typed required args `pattern` + `string`) and a decoy `word_count`. Ground truth
  is pure regex with near-miss strings ("12345", "123-456", "12-34" all look like "123-45" but don't
  match the anchored pattern), so it isolates *selecting the right tool and building the right args*
  from *firing at all*. Live run (local:ornith-1.5:9b, 1 trial): **no-harness 0% (0/6), harness 100%
  tool-calls but 0% (structured output contained no results)** — the model returned the schema
  definition itself as the answer instead of populating it. Confirms the failure mode; the task
  isolates tool-selection/arg-building from firing.

## Tier 2 — Methodology / task diversity

- **[4] Decompose the harness (tools × schema view).** The UI already *collects* the 4 modes; surface
  a 2×2 (tools × schema) view so the headline lift can be attributed to tools vs. the schema
  instruction alone.
- **[5] More task kinds.** Add tasks beyond "give me the answer" — e.g. extract-and-transform,
  multi-step where later steps depend on tool results.

## Tier 3 — Data / output

- **[6] Export runs to CSV.** Saved, but no way to pull them out.
- **[7] TTFT + latency distribution.** Latency is recorded but only averaged; streaming client lets
  you measure time-to-first-token, a real signal for small models.

## Tier 4 — Architecture

- **[8] Provider/model breadth.** Client is OpenAI-compatible, so dropping in Cerebras/DeepSeek/
  Together models to span capability tiers is cheap.
- **[9] `schema.js` coverage.** It's a JSON-Schema subset; note/extend (`additionalProperties`,
  `const`, `format`).

## Done

- Baseline benchmark (tasks × modes × clients matrix), CLI + web, per-mode/per-cell breakdowns,
  harness delta.
- schemaOnly / toolOnly axes to decompose the harness.
- Local Ollama model probing from `/v1/models`.
- 44 unit tests covering modes, JSON extraction, schema validation, and task scorers.

