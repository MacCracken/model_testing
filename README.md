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
after it has seen that output, so harness mode measures the model, not the endpoint. It also keeps
a small log of what `/api/hello` served (`GET /api/recent?since=…`), which is how a real-harness
arm is scored against what the server actually returned even when the harness reshaped its tool
output.

## Tasks

| Task | Category | What it measures |
|------|----------|------------------|
| `health` | api-call | Report live status **and uptime**. Free text can only guess the status. |
| `hello` | api-call | Three greetings verbatim. Tool-optional: the format is documented, so a careful model can pass without tools. |
| `reason` | pure-reasoning | Three arithmetic/logic questions, no tools in either mode. The control: any "delta" here is the schema instruction alone. |
| `lookup` | api-call | Three server-minted random ids. **Tool-essential**: there is nothing to memorize, so free text floors at 0 and truth is whatever the tool returned during the trial. |
| `regex` | tool-reasoning | Which of six strings match an anchored regex, with a correct `regex_match` tool and a `word_count` decoy. Tests tool *selection* and typed arguments, not just firing. |
| `chain` | multi-step | Greet alice, then greet the id that came back, and report the second greeting. The second call depends on the first; the id is random, so nothing but the chain produces the answer. |
| `transform` | extract-transform | Fetch three greetings, then report each name with the first 8 characters of its id and the greeting in upper case. Tool-essential, plus two transformations of what came back. |
| `explain` | open-ended | Explain the server's health and running time to a non-engineer. Graded by a **judge model** against the live facts; needs `--judge`. |

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

Then open <http://127.0.0.1:4000>. The page is a **New run** panel on the left and the results on
the right; the panel folds to a slim rail (the button in its header) and remembers that choice:

- pick **tasks** (grouped by category, all/none per group), **modes** (chips, with *pair* and *all
  four* presets; a mode greys out when no selected task declares it), **models** and **harness arms**
  (one collapsible group per provider with its status, selected count and all/none; providers
  without a key, or an offline Ollama, are greyed out), filter all of them from one box, and set
  trials per cell and the knobs under Settings — the summary at the bottom shows exactly how many
  trials will run and which pairs are skipped;
- the headline is the **harness delta** with its significance line, the per-mode rates with p50/p95
  latency and median time-to-first-token, and the harness hygiene numbers (tool use, **tool args
  ok**, schema validity, tokens); below it, once three of the four modes have run, the **tools ×
  schema 2×2** with the effect of each axis and their interaction;
- a **live cell grid** fills in trial by trial in execution order, so you can see what is running,
  what passed and what is queued; a run can be cancelled mid-flight;
- the task × model matrix is a **dumbbell chart**: no-harness and harness rates on one track per
  row, the delta beside it, and the row's own p-value on hover;
- the **trial log** filters to failures or harness-only rows; click a row (or a grid cell) for the
  full story as a timeline — system and user prompts, every tool call with the real response,
  the final message, the scorer's verdict — plus the answer and the ground truth side by side, and
  any schema errors. ← / → step between trials, esc closes;
- reopen any past run from the header dropdown, including runs launched from the CLI;
- **light / dark / system** theme switch in the header, remembered per browser;
- optional **temperature**, **seed** and **judge** under Settings, and an **export csv** link on every
  finished run.

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
node src/cli.js export <run-id>         # every trial as CSV (--cells for the task × model × mode cells, --out file.csv)
```

`--temperature T`, `--seed S` and `--model-param key=value` (repeatable; e.g. `think=false`,
`max_tokens=600`) are sent as-is with every request and recorded in the run's config (the
determinism knobs; some models reject a non-default temperature, which then shows as an error row).
Every run also records the bench version, git commit and node version under `versions`.

Requests stream by default, which is how the bench measures **time to first token**: each trial
records `ttftMs` (first token of any kind, reasoning included) and `ttfaMs` (first answer token —
content or a tool call); the report and the UI show their medians. For real-harness arms the same two
fields are **event-level**: the arrival of the harness's first visible action (a message or tool
call) and of its final answer, read off its streamed output. `BENCH_TIMEOUT_MS` sets the
per-request timeout.

## Providers

Multiple providers behind a single OpenAI-compatible client (no SDKs):

- **OpenAI** — `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-5-mini`
- **Anthropic** — `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, via Anthropic's OpenAI-compatible route
- **Groq** — `llama-3.3-70b-versatile`, `gemma2-9b-it`
- **DeepSeek** — `deepseek-chat`, `deepseek-reasoner`
- **Local (Ollama)** — no key needed; whatever the daemon reports from `/v1/models`

To add one, add an entry to `PROVIDERS` in `src/providers/index.js` and a label to
`MODEL_LABELS`. Values in `.env` (`*_API_KEY`, `OLLAMA_BASE_URL`, `SUT_PORT`, `RESULTS_DIR`) are loaded
at startup; real environment variables win.

## Real harnesses as the arm (experimental)

The synthetic harness is not the only harness the bench can run. A real agent harness can be the
harness arm: it gets the task's plain-language **goal**, brings its own tools and model, and its final
message is scored exactly like a synthetic harness trial. Arms run structured modes only; the
free-form baseline for the same model comes from the synthetic client.

In a run that mixes arms with the synthetic client, each arm gets its own **delta against the
free-form baseline of the same model** (the report's "harness arms" section; the headline and the
matrix show it too), so "harness X on model M vs raw M" is read straight off the run.

Arms are scored against what the webserver actually served: each arm brackets its run with
timestamps and asks `GET /api/recent` for the replies in that window (merged with anything it can
read out of the harness's own tool output), so `lookup`, `chain` and `transform` score the same way
as for the synthetic harness. Run arm trials one process at a time against a given webserver, since
the window is by time, not by caller.

- **`claude-code:<model>`** — `claude -p --bare` with Bash only and permissions bypassed. Needs
  `ANTHROPIC_API_KEY`; `CLAUDE_CODE_CMD` overrides the binary.

```bash
node src/bench.js --task health,lookup,chain --modes harness --clients claude-code:claude-haiku-4-5 --count 4
```

- **`pi:<provider>/<model>`** — Pi (`pi --mode json -p`) with its `bash` tool, no session, no context
  files. The bench passes the key for the model's provider (`OPENAI_API_KEY` for `pi:openai/…`) with
  `--api-key`. `PI_CMD` overrides the binary.
- **`codex:<model>`** — Codex CLI (`codex exec --json --ephemeral`), sandbox relaxed through
  `CODEX_SANDBOX_ARGS` (default `--dangerously-bypass-approvals-and-sandbox`, the documented no-prompt
  mode). Codex authenticates through its own `codex login`; until then every trial is an error row
  that names the 401. `CODEX_CMD` overrides the binary.
- **`thoth:default`** — see below.

```bash
node src/bench.js --task health,lookup,chain --modes harness --clients pi:openai/gpt-4o-mini,claude-code:claude-haiku-4-5 --count 4
```

### Thoth

`thoth:default` hands the goal to Thoth one-shot (`thoth --events`).

```bash
# Thoth on another host: reverse-tunnel the webserver (and Ollama, if Thoth's gateway routes to it)
ssh -N -R 3000:localhost:3000 -R 11434:localhost:11434 arch &
THOTH_CMD="ssh -n arch cd ~/Repos/thoth && thoth" node src/bench.js --task reason,health --modes harness --clients thoth:default --count 4
```

Every row records the model Thoth actually routed to and `harness: "thoth"`. Caveats, all
documented in `plan.md`: Thoth's `tool_result` events carry names and byte counts, not contents, so
tasks whose truth is read from tool results (`lookup`, `chain`) cannot be scored from this arm yet;
its gateway caches identical prompts; and reaching a localhost webserver needs either its shell tool
(`[shell].enabled`, off by default) or a `web_fetch` policy that allows private addresses.

## Evaluation

Tasks carry an `eval` block with:

- `ground(trial)` — the truth, fetched **after** the model answers. It receives what the trial did
  (`toolCalls`, `toolResults`, the parsed answer) so a task can define truth as "what my tool
  really returned" when the endpoint is random. Tasks with fixed truth use a constant.
- `scoreHarness(structured, ground)` — validate the structured answer against it.
- `scoreNoHarness(text, ground)` — judge the free text.
- `toolUse(trial)` (optional) — was the tool used *correctly*: right tool, right arguments, right
  calls? Recorded per trial as `toolUseOk` with a reason, and aggregated as "tool args ok". It is a
  separate signal from correctness: a model can reach the right answer by hand after firing the
  wrong tool, or fire the right tool and misreport.

Scorers receive a third argument, `{ judge, mode }`; a task that needs the judge (`eval.needsJudge`)
calls it and returns its verdict alongside `correct` and `reason`.

Seven tasks use automated ground-truth scoring; `explain` is graded by an LLM judge that is handed
the ground truth (status, uptime in human units) and a rubric, and returns a score in 0..1 with a
one-sentence reason. A trial passes at 0.75. Pick the judge with `--judge provider:model` (or
`BENCH_JUDGE` in `.env`, or the judge field in the recipe); it is recorded in the run, and each
row keeps the judge's score and reason. Without a judge, judged tasks produce error rows that say so. Scorers judge content, not wrappers: a list
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
