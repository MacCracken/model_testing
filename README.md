# LLM Harness Benchmark

A small Node project that measures **LLM capability with and without a harness**, using the
local `webserver` as a concrete task environment.

For every task we run the **same goal** in two modes and score it identically, so any delta is
attributable to the harness:

| Mode | What the model gets |
|------|---------------------|
| **no-harness** | A raw, free-form prompt. No tools, no output schema — the model just answers in natural language. |
| **with-harness** | The same goal wrapped in **tools + output schema + structured prompts**. The model must call the tool(s) correctly and return structured data. |

The `webserver` (`./webserver`) is the task environment. Its real endpoints (`/health`,
`/api/hello`) are what the harness tools actually hit.

## Providers

Multiple providers are supported behind a single OpenAI-compatible client (no SDKs):

- **OpenAI** — `gpt-4o-mini`, `gpt-4o`, `gpt-4.1-mini`
- **Anthropic** — `claude-3-5-sonnet-latest`, `claude-opus-4-20250514`
  (driven via Anthropic's OpenAI-compatible route)
- **Groq** — `llama-3.3-70b-versatile`, `gemma2-9b-it`
- **Local** (Ollama) — `llama3.1`, `mistral`, `qwen2.5-coder`

To add a provider, add an entry to `src/providers/index.js` (`PROVIDERS`) and a label to
`MODEL_LABELS`.

## Setup

```bash
cp .env.example .env      # fill in keys
node --check src/*.js      # optional syntax check
```

Run the local `webserver` first (or set `PORT`/`WEBROOT`):

```bash
cd webserver && npm start   # http://localhost:3000
```

## Run a single task in one mode

```bash
# No-harness mode
node src/bench.js --task health --mode noHarness --clients openai:gpt-4o-mini

# With-harness mode (model must call the health tool)
node src/bench.js --task health --mode harness --clients openai:gpt-4o-mini

# All tasks, harness mode, count=3
node src/bench.js --task all --mode harness --clients anthropic:claude-3-5-sonnet-latest --count 3
```

## Full comparison

```bash
node src/aggregate.js --tasks health,hello --modes noHarness,harness --clients openai:gpt-4o-mini,gpt-4o
```

Prints per-mode/per-task/per-model breakdowns plus the **harness delta** (correctness %, tool-use
%, schema-validity).

`--json` on `bench.js` emits machine-readable results under `results/`.

## Evaluation

Tasks carry an `eval` block with:

- `ground()` — call the real endpoint to get ground truth.
- `scoreHarness(output, ground)` — validate structured output (schema + fields).
- `scoreNoHarness(output, ground)` — judge free text (regex / keyword matching).

Starting tasks use **automated ground-truth** scoring. LLM-as-judge can be plugged in per-task
by adding an `eval.judge` block (see `src/tasks/health.js` for the shape).

## How to read the results

The headline question is: **does the harness help?** Expect `with-harness` to show higher
correctness and tool-use rates, and to expose whether the model knows how to call tools against
real code. Lower latency in harness mode is common too (one structured call vs. a long free-form
one) — but slower round-trips from tool calls are also possible, which is why latency is reported
per run.
