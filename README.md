# LLM Harness Benchmark

A small Node project that measures **LLM capability with and without a harness**, using the
local `webserver` as a concrete task environment.

For every task we run the **same goal** in two modes and score it identically, so any delta is
attributable to the harness:

| Mode | What the model gets |
|------|---------------------|
| **no-harness** | A raw, free-form prompt. No tools, no output schema — the model just answers in natural language. |
| **harness** | The full bundle: **tools + output schema + structured prompt**. The model must call the tool(s) and return structured data. |
| **schemaOnly** | The schema + structured prompt, **no tools**. Isolates the "ask for JSON" axis. |
| **toolOnly** | The tools, **no schema**, free-form answer. Isolates the "give it tools" axis. |

`no-harness` is the bare baseline. `harness` is the full bundle. `schemaOnly` and `toolOnly` are the
two axes the bundle is made of. A task takes part in a mode by declaring a spec for it; pairs a task
does not declare are skipped and reported, not scored. The four tool tasks declare all four modes;
`reason` has no tools, so its harness *is* schema-only and it declares no `toolOnly`.

The `webserver` (`./webserver`) is the **system under test**. Its real endpoints (`/health`,
`/api/hello`) are what the harness tools actually hit — the runner executes each tool and feeds
its real response back to the model. What gets scored is the model's *final message*, written
after it has seen that output, so harness mode measures the model, not the endpoint.

## Tasks

| Task | Category | What it measures |
|------|----------|------------------|
| `health` | api-call | Report live status **and uptime**. Free text can only guess the status. |
| `hello` | api-call | Three greetings verbatim. Tool-optional: the format is documented, so a careful model can pass without tools. |
| `reason` | pure-reasoning | Three arithmetic/logic questions, no tools in either mode. The control: any "delta" here is the schema instruction alone. |
| `lookup` | api-call | Three server-minted random ids. **Tool-essential**: there is nothing to memorize, so free text floors at 0 and truth is whatever the tool returned during the trial. |
| `regex` | tool-reasoning | Which of six strings match an anchored regex, with a correct `regex_match` tool and a `word_count` decoy. Tests tool *selection* and typed arguments, not just firing. |

## Setup

```bash
cp .env.example .env      # fill in keys; local Ollama needs none
cd webserver && npm start # the system under test, on http://localhost:3000
npm test                  # unit tests — no model or server needed
```

## Web UI

The fastest way to launch runs and read the results:

```bash
node src/cli.js serve
```

Then open <http://127.0.0.1:4000>. The page is a recipe on the left and the results on the right:

- pick **tasks**, **modes** and **models** as chips (a mode greys out when no selected task declares
  it; providers without a key, or an offline Ollama, are greyed out) and set trials per cell — the
  recipe sentence shows exactly how many trials will run and which pairs are skipped;
- the headline is the **harness delta** with its significance line, the per-mode rates, and the
  harness hygiene numbers (tool use, schema validity, tokens);
- a **live cell grid** fills in trial by trial in execution order, so you can see what is running,
  what passed and what is queued; a run can be cancelled mid-flight;
- the task × model matrix is a **dumbbell chart**: no-harness and harness rates on one track per
  row, the delta beside it, and the row's own p-value on hover;
- the **trial log** filters to failures or harness-only rows; click a row (or a grid cell) for the
  full story as a timeline — system and user prompts, every tool call with the real response,
  the final message, the scorer's verdict — plus the answer and the ground truth side by side, and
  any schema errors. ← / → step between trials, esc closes;
- reopen any past run from the header dropdown, including runs launched from the CLI;
- **light / dark / system** theme switch in the header, remembered per browser.

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
node src/cli.js list                    # tasks (with the modes each declares) and providers, with key status
node src/cli.js show                    # recent saved runs
node src/cli.js show <run-id> --table   # one saved run: per-mode stats, deltas with significance, a task × mode table
```

## Providers

Multiple providers behind a single OpenAI-compatible client (no SDKs):

- **OpenAI** — `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-5-mini`
- **Anthropic** — `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, via Anthropic's OpenAI-compatible route
- **Groq** — `llama-3.3-70b-versatile`, `gemma2-9b-it`
- **Local (Ollama)** — no key needed; whatever the daemon reports from `/v1/models`

To add one, add an entry to `PROVIDERS` in `src/providers/index.js` and a label to
`MODEL_LABELS`. Values in `.env` (`*_API_KEY`, `OLLAMA_BASE_URL`, `SUT_PORT`, `RESULTS_DIR`) are loaded
at startup; real environment variables win.

## Evaluation

Tasks carry an `eval` block with:

- `ground(trial)` — the truth, fetched **after** the model answers. It receives what the trial did
  (`toolCalls`, `toolResults`, the parsed answer) so a task can define truth as "what my tool
  really returned" when the endpoint is random. Tasks with fixed truth use a constant.
- `scoreHarness(structured, ground)` — validate the structured answer against it.
- `scoreNoHarness(text, ground)` — judge the free text.

All five tasks use automated ground-truth scoring. Scorers judge content, not wrappers: a list
returned under `results`, `data` or the schema's own `items` key scores the same as a bare array,
while `schemaValid` still records whether the shape matched exactly.

Note that the two scorers are **not equally strict by construction**, and shouldn't be read as
if they were: `health` checks status *and* the real uptime in harness mode, but only the status
keyword in free text, because without tools a model cannot know the uptime. That asymmetry is
the capability being measured — it is worth re-reading whenever you add a task.

## How to read the results

The headline question is: **does the harness help?** Expect with-harness to show higher
correctness and to expose whether the model can call tools against real code.

Every delta carries a two-sided **Fisher exact** p-value, which is valid at the tiny sample sizes
a local run produces — and that is exactly where intuition fails. With three trials per side no
outcome can reach p < 0.05, not even 0/3 → 3/3 (p = 0.10); four per side is the floor for a
perfect split, and a realistic 40% → 70% gap needs on the order of twenty per side. The UI and CLI
say **inconclusive** when the sample could not have been significant, **not significant** when it
could have been but wasn't, and **significant** otherwise. Small local models also vary a lot run
to run, so raise `--count` (or "trials per cell") before drawing a conclusion.
