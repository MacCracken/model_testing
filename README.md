# LLM Harness Benchmark

A small Node project that measures **LLM capability with and without a harness**, using the
local `webserver` as a concrete task environment.

For every task we run the **same goal** in two modes and score it identically, so any delta is
attributable to the harness:

| Mode | What the model gets |
|------|---------------------|
| **no-harness** | A raw, free-form prompt. No tools, no output schema — the model just answers in natural language. |
| **with-harness** | The same goal wrapped in **tools + output schema + structured prompts**. The model must call the tool(s) and return structured data. |

The `webserver` (`./webserver`) is the **system under test**. Its real endpoints (`/health`,
`/api/hello`) are what the harness tools actually hit — the runner executes each tool and feeds
its real response back to the model. What gets scored is the model's *final message*, written
after it has seen that output, so harness mode measures the model, not the endpoint.

## Setup

```bash
cp .env.example .env      # fill in keys
cd webserver && npm start # the system under test, on http://localhost:3000
```

## Web UI

The fastest way to launch runs and read the results:

```bash
node src/cli.js serve
```

Then open <http://127.0.0.1:4000>. The page lets you:

- pick **tasks**, **modes**, and **models** (providers without an API key are greyed out; local
  Ollama models are listed live from the running daemon) and set trials per cell;
- watch a run **stream in trial by trial**, and cancel it mid-flight;
- read the headline **harness delta**, per-mode correctness, tool-use and schema-validity rates,
  and a task × model matrix;
- click any trial for the full story: the system and user prompts, **every tool call with the
  real response the endpoint returned**, the model's final message, the parsed structured
  answer with schema errors, and the ground truth it was scored against;
- reopen any past run from the history dropdown — including ones launched from the CLI.

Useful flags: `--port 4000`, `--host 127.0.0.1`, `--open`.

## Command line

```bash
# One task, one mode
node src/bench.js --task health --mode harness --clients openai:gpt-4o-mini

# Everything, both modes, 3 trials per cell
node src/bench.js --task all --modes noHarness,harness --clients local:ornith-1.5:9b --count 3

# A bare provider name expands to all of its models
node src/aggregate.js --tasks health,hello --clients local
```

`aggregate.js` prints per-mode and per-cell breakdowns plus the **harness delta** (correctness,
tool-use, schema-validity, latency). Every run — CLI or web — is saved under `results/runs/` and
shows up in the web UI's history. `--json` prints the whole run record; `--no-save` skips
writing it.

```bash
node src/cli.js list    # tasks and providers, with API-key status
```

## Providers

Multiple providers behind a single OpenAI-compatible client (no SDKs):

- **OpenAI** — `gpt-4o-mini`, `gpt-4o`, `gpt-4.1-mini`
- **Anthropic** — via Anthropic's OpenAI-compatible route
- **Groq** — `llama-3.3-70b-versatile`, `gemma2-9b-it`
- **Local (Ollama)** — whatever the daemon reports from `/v1/models`

To add one, add an entry to `PROVIDERS` in `src/providers/index.js` and a label to
`MODEL_LABELS`.

## Evaluation

Tasks carry an `eval` block with:

- `ground()` — call the real endpoint to get ground truth.
- `scoreHarness(structured, ground)` — validate the structured answer against it.
- `scoreNoHarness(text, ground)` — judge the free text.

Both starting tasks use automated ground-truth scoring. LLM-as-judge can be plugged in per task
by adding an `eval.judge` block.

Note that the two scorers are **not equally strict by construction**, and shouldn't be read as
if they were: `health` checks status *and* the real uptime in harness mode, but only the status
keyword in free text, because without tools a model cannot know the uptime. That asymmetry is
the capability being measured — it is worth re-reading whenever you add a task.

## How to read the results

The headline question is: **does the harness help?** Expect with-harness to show higher
correctness and to expose whether the model can call tools against real code. Small local
models vary a lot run to run, so use `--count` (or "trials per cell") before drawing a
conclusion from a single trial.
