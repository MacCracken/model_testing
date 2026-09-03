# LLM Harness Benchmark — plan

## Goal

Measure **model capability with vs. without a harness**, using the local `webserver` as the task
environment. Each task is run in two modes and scored the same way, so the delta is attributable to
the harness:

- **noHarness** — raw free-form API call. Natural-language prompt only; no tools, no output schema.
- **harness** — the same task wrapped with **tools + output schema + structured prompt**.
- **schemaOnly** — schema + structured prompt, no tools (isolates the "ask for JSON" axis).
- **toolOnly** — tools, no schema, free-form answer (isolates the "give it tools" axis).

Key design decisions that still hold:

- **One OpenAI-compatible client, no SDKs.** OpenAI, Anthropic (OpenAI-compatible route), Groq and
  Ollama all speak `/chat/completions` with function calling.
- **Harness tool calls hit real implementations.** The runner executes each tool against the
  webserver and feeds the result back; what is scored is the model's *final message*.
- **Identical scoring across modes.** The goal is the same; only the scaffolding differs.
- **Statistics before conclusions.** A delta is a claim; every delta carries a p-value that is
  valid at the sample sizes this bench really runs.

---

## State of the benchmark (2026-09-03)

`npm test`: **98/98**. The scorer fixes below were followed by a full calibration on three models
(see *Calibration results*); every live number recorded in earlier versions of this file is void.

### What the audit found

The previous roadmap marked Tier 1 "COMPLETE". Reading the code and the saved runs, each of the three
items had a defect that made its recorded conclusion wrong:

| Item | What was claimed | What was actually true | Fixed by |
|------|------------------|------------------------|----------|
| [1] Significance | "binomial test / Wilson interval on the delta" | `normalCDF` used wrong A&S coefficients (Φ(0.5) came out 0.720, true 0.691), the z=0 special case hid it, and a z-test was applied at n = 3, where its normal approximation is invalid and 0/3 → 3/3 printed "significant". | Correct A&S 7.1.26; headline p-value is now **Fisher's exact test**, with an explicit "inconclusive — too few trials" label when no outcome could reach p < 0.05 (3 per side never can; 4 is the floor). Tests pinned to reference values. |
| [2] `lookup` | "harness 100% tool calls but 0/3 correct — the model never passed `name`" | The model *did* pass `name` ("alice, bob, carol"), received real ids and reported them. Two scorer bugs made 0% the ceiling: ground truth was fetched **after** the trial and got fresh random UUIDs, so no answer could ever match; and the model's `{"type":"array","items":[…]}` wrapper was not unwrapped. | Truth is now the ids the tool returned **during the trial** (`eval.ground` receives the trial); `unwrapList` accepts `items`. |
| [3] `regex` | "no-harness 0/6; harness returned the schema instead of results" | The free-form answer `yes/no/no/no/no/yes` is exactly what the prompt asked for and is 6/6 correct — the scorer demanded a `string: yes` format the prompt never mentioned. The harness answer was also 6/6 correct under an `items` wrapper. The string list also contained a duplicate. | Prompt states the format; scorer accepts labelled lines in any order **and** bare yes/no lines positionally; duplicate replaced by `999-88`; `items` unwrapped. |

Other defects fixed in the same pass (all covered by tests where testable):

- `reason` could never run live: `eval.ground` was an array and the runner called it. Ground may now be
  a function of the trial or a constant.
- The web UI crashed on every run that had both modes: the browser recomputed summaries with its own
  code and read a field only the runner produced. The browser now imports `/lib/runner.js`, so there
  is exactly one `summarize`.
- `aggregate.js` crashed (before saving the run) whenever a task or client lacked one of the two modes.
- `schemaOnly` / `toolOnly` existed by name only: the web server filtered them out, and no task
  declared them. Mode names now live in one place (`MODE_NAMES` / `DEFAULT_MODES`), the server accepts
  all four, undeclared (task, mode) pairs are **skipped and reported** instead of scored as error rows,
  and `reason` declares `schemaOnly` (its harness has no tools, so the two are the same spec).
- A `console.error("DEBUG …")` fired on every trial; `schemaValid` was `true/false` for a mode with no
  schema (now `null`); the `local` provider demanded a fake `LOCAL_API_KEY`; `.env` values never reached
  `process.env` (`OLLAMA_BASE_URL`, `PORT`, `RESULTS_DIR` were dead letters); env values were
  URL-decoded (a `%` in a key would throw); unreachable endpoints reported a bare "fetch failed".
- `PORT` meant the webserver's port, but dev tooling sets `PORT` for whatever process it launches —
  the UI ended up probing itself. The system under test is now `SUT_PORT` (`PORT` still a fallback).
- A malformed file in `results/runs/` (`demo-delta.json`, a bare array of sample rows) took down the
  whole history listing; the loader now skips files that are not runs.
- `package.json` had no `test` script; the tests are `npm test` now.
- The web UI was rebuilt on the "Ledger" design (see below) with a light / dark / system switch.

Found by the first live runs after those fixes (second pass, same day):

- The `reason` answer key was wrong: 3 red + 5 green is **8** marbles that are not blue, not 10 (the
  total). The free-form scorer hid it because answers mention the total too; the structured scorer
  exposed it the first time a model answered correctly.
- The Anthropic model ids in the registry no longer exist. Verified against both providers' live
  `/models` lists: OpenAI now lists `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-5-mini`; Anthropic
  `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`.
- `schemaOnly` / `toolOnly` were declared by nothing but `reason`; the four tool tasks now carry
  hand-written specs for both axes, so the four-mode UI runs what it advertises.
- Models echoed the schema's envelope (`{"type":"array","items":[…]}`) when told to "match this
  schema"; the instruction now says *an instance of this schema, not the schema itself*. Scorers
  already unwrap the envelope, so this changes `schemaValid`, not correctness.
- A free-form health answer that hedges ("I can't tell whether it is OK or DOWN") was reported as
  "reported DOWN"; it is now reported as a hedge (still wrong).
- `node src/cli.js show <id> --table` reviews a saved run without the UI, through the same reporter
  `aggregate` prints with.

### Calibration results (2026-09-03)

All five tasks × four modes × **4 trials per cell**, one run per model, fixed scorers. Counts are
correct/trials.

**gpt-4o-mini** — delta +40pp, significant (p < 0.001, 20 vs 20):

| task | noHarness | harness | schemaOnly | toolOnly |
|---|---|---|---|---|
| health | 4/4 | 4/4 | 0/4 | 4/4 |
| hello | 4/4 | 4/4 | 4/4 | 4/4 |
| reason | 0/4 | 4/4 | 4/4 | — |
| lookup | 0/4 | 4/4 | 0/4 | 4/4 |
| regex | 4/4 | 4/4 | 4/4 | 4/4 |
| **all** | **12/20** | **20/20** | **12/20** | **16/16** |

**claude-haiku-4-5** — delta +30pp, significant (p = 0.02, 20 vs 20):

| task | noHarness | harness | schemaOnly | toolOnly |
|---|---|---|---|---|
| health | 3/4 | 4/4 | 0/4 | 4/4 |
| hello | 3/4 | 4/4 | 4/4 | 4/4 |
| reason | 4/4 | 4/4 | 4/4 | — |
| lookup | 0/4 | 4/4 | 0/4 | 4/4 |
| regex | 4/4 | 4/4 | 4/4 | 4/4 |
| **all** | **14/20** | **20/20** | **12/20** | **16/16** |

**local ornith-1.5:9b** — delta +15pp, **not significant** (p = 0.48, 20 vs 20). This run used the
older "match this schema" wording; see the note after the table.

| task | noHarness | harness | schemaOnly | toolOnly |
|---|---|---|---|---|
| health | 1/4 | 4/4 | 0/4 | 4/4 |
| hello | 4/4 | 4/4 | 3/4 | 4/4 |
| reason | 4/4 | 3/4 | 4/4 | — |
| lookup | 0/4 | 2/4 | 0/4 | 4/4 |
| regex | 4/4 | 3/4 | 4/4 | 4/4 |
| **all** | **13/20** | **16/20** | **11/20** | **16/16** |

The small model inverts the hosted picture in one telling way: **tools-only is perfect (16/16) and
the full harness is not (16/20)**. 13 of its structured answers echoed the schema's envelope, and
twice it emitted JSON that does not parse at all (duplicate `items` keys, objects without keys), so
the schema instruction *cost* it correct answers that the tool had already delivered. Its free-form
health answers refuse to guess and say so at length (scored as hedges); its `lookup` harness rows
report only alice after fetching all three names — the partial-report failure seen before the fixes.
Neither model on any run touched the `word_count` decoy.

**Schema-wording A/B (same day).** The schema instruction was changed from "matching this schema
exactly" to "a JSON value that is an instance of this JSON Schema — not the schema itself", and the
schema modes were rerun at 4 per cell:

| model · mode | envelope echoes | schema-valid | correct |
|---|---|---|---|
| gpt-4o-mini · harness | 5 → **0** | 15/20 → **20/20** | 20/20 → 20/20 |
| ornith-1.5:9b · harness | 7 → **0** | 10/20 → **18/20** | 16/20 → **18/20** |
| ornith-1.5:9b · schemaOnly | 6 → **0** | 10/20 → 14/20 | 11/20 → 10/20 |

One sentence of prompt removed the echo entirely on both models and, on the small model, turned the
harness from *worse than tools-only* into 90% correct. With the new wording the local headline is
13/20 → 18/20, not significant · p=0.13 · 20 vs 20 trials. The remaining local failures are the model's: two answers that are not JSON at
all, one `lookup` report with no ids, and the expected `schemaOnly` zeros on `health` and `lookup`.
The wording is part of the harness under test, so this is itself a harness result: the schema axis
is sensitive to phrasing in a way the tool axis is not.

How to read it:

- The 2×2 separates cleanly on both hosted models: **tools are the whole lift** (toolOnly = harness
  = 100%), and **the schema alone buys nothing** (schemaOnly = baseline). That is the control the
  benchmark was designed around, and it now holds in data rather than by assertion.
- `lookup` behaves as the tool-essential calibration should: 0% without a tool in both free-form and
  schema-only, 100% with one in both harness and tools-only. Free-form models refuse rather than
  fabricate; schema-only makes gpt-4o-mini fabricate plausible UUIDs and haiku refuse in prose.
- `health` schema-only is 0/4 on both: without a tool the uptime is a guess (gpt-4o-mini writes 3600
  every time), and the schema turns a hedge into a confidently wrong number.
- `reason` is the surprise: gpt-4o-mini answers the marbles question **wrong in free form (10) and
  right in structured mode (8), four times out of four**; haiku gets both. Asking for JSON changed
  the arithmetic. Worth a dedicated look before reading `reason` as a pure control.
- Per-task deltas at 4 vs 4 are only significant for a perfect 0 → 4 split (`lookup`); the
  20-vs-20 pooled delta is what carries the significance. Ten per cell is the sensible default.
- No model on any run chose the `word_count` decoy, so the regex task's tool-selection trap has
  not bitten anyone yet; its signal today is argument construction and the schema echo, not tool
  choice. A less obviously irrelevant decoy would make it a real test.

### Calibration at 10 trials per cell (2026-09-03, six tasks incl. `chain`, new schema wording)

**gpt-4o-mini** — 30/60 → 60/60, **+50pp, p < 0.001**; tools-only 50/50, schema-only 30/60:

| task | noHarness | harness | schemaOnly | toolOnly |
|---|---|---|---|---|
| health | 10/10 | 10/10 | 0/10 | 10/10 |
| hello | 10/10 | 10/10 | 10/10 | 10/10 |
| reason | 0/10 | 10/10 | 10/10 | — |
| lookup | 0/10 | 10/10 | 0/10 | 10/10 |
| regex | 10/10 | 10/10 | 10/10 | 10/10 |
| chain | 0/10 | 10/10 | 0/10 | 10/10 |

**claude-haiku-4-5** — 32/60 → 60/60, **+46.7pp, p < 0.001**; tools-only 50/50, schema-only 30/60:

| task | noHarness | harness | schemaOnly | toolOnly |
|---|---|---|---|---|
| health | 5/10 | 10/10 | 0/10 | 10/10 |
| hello | 7/10 | 10/10 | 10/10 | 10/10 |
| reason | 10/10 | 10/10 | 10/10 | — |
| lookup | 0/10 | 10/10 | 0/10 | 10/10 |
| regex | 10/10 | 10/10 | 10/10 | 10/10 |
| chain | 0/10 | 10/10 | 0/10 | 10/10 |

**local ornith-1.5:9b** — 30/60 → 58/60, **+46.7pp, p < 0.001**; tools-only 48/50, schema-only 25/60;
tool args ok 99/100 judged; harness p50 6.2 s, p95 15.5 s:

| task | noHarness | harness | schemaOnly | toolOnly |
|---|---|---|---|---|
| health | 0/10 | 10/10 | 0/10 | 9/10 |
| hello | 10/10 | 10/10 | 8/10 | 10/10 |
| reason | 10/10 | 9/10 | 9/10 | — |
| lookup | 0/10 | 10/10 | 0/10 | 9/10 |
| regex | 10/10 | 9/10 | 8/10 | 10/10 |
| chain | 0/10 | 10/10 | 0/10 | 10/10 |

The small model's free-form `health` is 0/10 because it refuses to guess and says so (scored as a
hedge, which the report now names). With the instance-not-schema wording its harness is 58/60,
where the 4-per-cell run with the old wording had it at 80%. The one tool-use miss in 100 judged
calls is a name split as "car ol".

Per-task deltas now reach significance on their own where the floor is real (`lookup`, `chain`,
`health` on haiku and ornith, `reason` on gpt-4o-mini).

**qwen3.5:9b-mlx** was started as the second local model and stopped after three trials: its
free-form `health` answers ran 104 s and twice past the 120 s request timeout (a thinking-heavy
model writing at length). `BENCH_TIMEOUT_MS` now raises the per-request timeout; the run should be
repeated with it set to 300000 and, ideally, with thinking disabled through the model params. The new `chain` task behaves as designed: 0/10
without a tool in both free-form and schema-only, 10/10 with one. gpt-4o-mini's free-form `reason`
is 0/10 — it writes 10 for the marbles question every single time in prose and 8 every time in
JSON. The local runs at this size are recorded below when they finish.

### What is genuinely done

- Baseline benchmark (tasks × modes × clients), CLI + web, per-mode / per-cell breakdowns, saved runs.
- Five tasks: `health`, `hello` (tool-optional), `reason` (no-tools control), `lookup`
  (tool-essential), `regex` (tool selection + typed args with a decoy).
- Fisher-exact significance on every delta, one shared phrasing across CLI, aggregate and web.
- Live Ollama probing; provider gating that matches what can actually run.
- Web UI: recipe → headline delta with significance → live cell grid → dumbbell matrix → trial log →
  trial drawer with transcript timeline, answer-vs-ground diff, ← / → navigation, theme switch.
- 93 unit tests: statistics, modes and skipping, trial-aware ground truth, every scorer, JSON
  extraction, schema validation, run persistence.

---

## Roadmap

### Tier 1 — Core premise: is the delta real?

- **[1] Re-run the calibration set.** **DONE** for two hosted models at 4 trials per cell (see
  *Calibration results*); the local run is recorded in the addendum. The expected shape held:
  `lookup` free-form 0% with a full harness lift, `regex` free-form 100%, and the 2×2 attributes the
  lift to tools. Still open: raise to 10 per cell and add a second local model so per-task deltas can
  reach significance on their own.
- **[2] Tool-argument correctness as a hygiene metric.** **DONE.** Every tool task defines
  `eval.toolUse` (right tool, right arguments, right calls — `regex` judges the pattern by what it
  computes on the listed strings, not by spelling, and flags the decoy); the runner records
  `toolUseOk` + reason per trial; CLI, `show`, CSV and the UI surface "tool args ok" beside tool-use
  and schema-valid, and the trial drawer shows the verdict as a timeline step.
- **[3] Decide the 2×2.** **Specs DONE:** `health`, `hello`, `lookup` and `regex` carry hand-written
  `schemaOnly` / `toolOnly` specs (not derived: a free-form prompt says "without any tools" and a
  harness prompt says "call the X tool and return JSON", so a derived spec would contradict itself).
  Still open: a dedicated 2×2 panel in the UI (today the dumbbell draws hollow markers for the two
  extra modes and the headline shows a column per mode).

### Tier 2 — Methodology / task diversity

- **[4] Multi-step tasks.** **DONE** for the dependent-call case: `chain` greets alice, then must
  greet the random id that came back and report the second greeting; ground truth and the tool-use
  verdict both come from the trial's own tool results, so firing both calls up front cannot pass.
  Still open: an extract-and-transform task (fetch, then reshape).
- **[5] LLM-as-judge** for open-ended tasks (`eval.judge`), still pluggable and still unbuilt.
- **[6] Determinism knobs.** **DONE.** `--temperature` / `--seed` on the CLI and two fields in the
  recipe flow into every request as-is and are recorded in `run.config.modelParams` (shown in the
  headline). Models that reject a non-default temperature (the gpt-5 family) surface as error rows.

### Tier 3 — Data / output

- **[7] CSV export.** **DONE.** `node src/cli.js export <id> [--cells]`, `GET /api/runs/<id>/csv`
  (`?cells=1`), and an "export csv" link on every finished run.
- **[8] Latency distribution.** p50 / p95 / max **DONE** (per mode and per cell, in the report, the
  CSV and the headline). **TTFT still open** — it needs the streaming client, and assembling
  streamed tool-call deltas differs per provider.
- **[9] Per-cell significance in the CLI.** **DONE.** `summary.delta.byTaskClient`, printed by the
  report when there is more than one cell.

### Tier 4 — Architecture

- **[10] Provider breadth.** Cerebras / DeepSeek / Together drop in via `PROVIDERS`.
- **[11] `schema.js` coverage.** **DONE.** `additionalProperties` (false or a schema), `const`,
  string bounds / `pattern` / `format` (date-time, date, uuid, email, uri), numeric bounds and
  `multipleOf`, `maxItems` / `uniqueItems`, type unions. Unknown formats stay annotations.
- **[12] Version pinning.** **DONE.** Every run records `versions` (bench version, git commit, node,
  harness kind) next to its config.

### Tier 5 — Real harnesses as the harness arm (STARTED — Thoth arm plumbed, see below)

---

## Proposal: real harnesses (Pi, Claude Code, Codex, Thoth) and local tools

### The question changes

Today's harness is **synthetic**: the same client, plus tools, a schema and a structured prompt. That
isolates the *mechanism* — it answers "does giving this model tools and a schema help?". A real agent
harness is a *product*: a system prompt (Pi's is under 1k tokens, Claude Code's is over 10k), a
tool loop with its own built-in tools, context management, permissions, instruction files. Running
one as the harness arm answers a different question — "does harness X make model M better than raw M,
and than harness Y?" — and the literature says the answer is strongly regime-dependent:

- Terminal-Bench 2.0's agent × model table has the same model moving by 10–20 points across harnesses,
  yet its authors conclude "model selection is usually more important than agent scaffold".
- openbench (same model, six wrappers) finds correctness saturates while wall-clock spreads ~4× and
  tokens ~8×; Databricks measured a >2× cost delta between Pi and Claude Code / Codex at equal quality.
- "Same Model, Different Harness" (arXiv 2608.26218) and Claw-SWE-Bench (2606.12344) show the
  opposite end: a fixed *weak* model swinging 19% → 73% purely on harness.

Small local models on tool-shaped tasks — this project's setting — is exactly the regime where the
harness delta is large. That is the premise's good news. It also means **tokens, cost and wall-clock
must become headline metrics** next to correctness, because on stronger models that is where the
difference lives.

### Thoth

No public coding-agent harness called Thoth exists (the only candidates are an unrelated LangGraph
desktop assistant since renamed Row-Bot, and a Claude Code plugin). Thoth here is **your own harness**,
and — checked on `arch` on 2026-09-03, **thoth 0.44.3** — it is already drivable as a benchmark arm:

- `thoth <task>` runs one task and prints only the answer (diagnostics on stderr, non-zero exit on
  failure); `thoth -p` takes the whole task from stdin.
- `thoth --json <task>` emits `{response, model, turns, tokens?, cost?, elapsed_ms}`; `--events`
  streams NDJSON (`turn_start` → `tool_call` / `tool_result` → `response` / `error` → `turn_end`),
  which is exactly the transcript the runner needs for `toolCalls` / `toolResults`, and `--logs`
  writes a crash-proof session log with every tool call's arguments and verdict.
- One-shot mode **denies** any action needing authorization unless `[tron].policy` allows it; the
  arch checkout already points `[tron].policy` at `/var/tmp/tron-deleg.toml` with `agent = "thoth"`.
- Its model comes from the hoosh gateway (`[hoosh].url = 127.0.0.1:8088`), and the arch config sets
  `model = "ornith-1.5:9b"` — the same model this bench's local arm runs. A same-model
  synthetic-vs-Thoth comparison is therefore possible without any new model plumbing, as soon as
  hoosh (and daimon for MCP tools) are running there.

**Built (experimental, 2026-09-03):** `thoth:default` is a client (`src/harness/thoth.js`) that runs
a task's `goal` through `thoth --events`, folds the NDJSON into the synthetic result shape, and is
scored by the unchanged runner; `THOTH_CMD` says how to invoke it (e.g. over ssh). Learned the hard
way while wiring it, each now handled or documented:

- **stdin must be closed** (`ssh -n`, `</dev/null`): one-shot mode appends piped stdin to the task and
  blocks until EOF, which looks like a hang before `turn_start`.
- **hoosh withdraws a route after three failed probes** and only restores it on a later success; a
  tunnel that comes and goes between ssh sessions leaves the Ollama route withdrawn and every turn
  hanging. Keep the tunnel persistent (`ssh -N -R …`) or restart the stack after it is up.
- **hoosh caches identical prompts** (`[cache] ttl_secs = 300`): repeated trials of the same task
  would be served from cache. Disable the cache for benchmark runs or salt the goal with a nonce.
- **`tool_result` events carry `name`, `ok` and `bytes`, not the content**, so ground truth that is
  read from tool results (`lookup`, `chain`) is unavailable from this arm. Two ways forward: the
  webserver keeps a small ring of recent responses (`GET /api/recent?since=…`) and the arm rebuilds
  tool results from what the server actually served during the trial window; or Thoth's events grow
  an optional result payload.
- **Reaching a localhost webserver:** daimon's `web_fetch` refuses private addresses by policy, and
  Thoth's model shell tool is off by default (`[shell].enabled`, ADR-0014) even though the t-ron
  policy on arch already allows `thoth_shell`. Enabling the shell tool for the bench is an
  authority decision for the operator, not something the bench should flip.

**Live result (2026-09-03, hosted route via hoosh, model reported as claude-opus-4-8):** run through
the bench with `THOTH_CMD="ssh -n arch cd ~/.agnos-stack && ~/.local/bin/thoth"`:

| task | verdict | what Thoth did |
|---|---|---|
| reason / harness | **pass**, 3/3, 4,061 tokens, 2.3 s | answered the goal directly; JSON valid |
| health / harness | fail: no structured output | tried `web_fetch` on localhost and 127.0.0.1, then `web_search`; all denied by policy; declined to fabricate |

So the arm is plumbed: spawn over ssh, events folded into calls/results, routed model and tokens
recorded, scored by the unchanged runner. What it still cannot do is reach the webserver, which is
the operator decision above (shell tool or a `web_fetch` allowance for the bench's address).

Practical shape of a Thoth arm from this machine: `ssh -R 3000:localhost:3000 arch thoth --events
'<goal>'`, so Thoth's tools reach the webserver under test through the reverse tunnel; parse the
NDJSON, take `response` as the final message (it can arrive after `turn_end` — do not stop reading
at `turn_end`), fold `tool_call` / `tool_result` into the trial, and read tokens/cost from the
`--json` envelope or the events. Pi remains the cheapest hosted-model arm; Thoth is now the cheapest
*local-model* arm.

### How each harness can be driven (verified against current docs, Sept 2026)

| | Pi | Claude Code | Codex CLI | Thoth |
|---|---|---|---|---|
| Headless | `pi --mode json "<prompt>"` (JSONL events; `message_end` is the final message) | `claude -p "<prompt>" --output-format json` (`stream-json` for tool calls) | `codex exec --json "<prompt>"` (JSONL items) | `thoth --json "<task>"` (one envelope) or `--events` (NDJSON per tool call, `response` last) |
| Usage / cost | `usage{…,cost}` from per-model rates in `models.json` | `usage`, `total_cost_usd`, `num_turns` | `turn.completed.usage` tokens only | `tokens` / `cost` in the `--json` envelope once the gateway reports them |
| Structured output | none — parse the final message (`parseJSONLoose`) | `--json-schema` → `structured_output` | `--output-schema <file>` | — |
| Model / local | `--provider`/`--model`; any endpoint via `models.json` (`openai-completions`, `anthropic-messages`, …); Ollama documented | Anthropic Messages format only: Anthropic models, or Ollama via `ANTHROPIC_BASE_URL` (Ollama serves that API); chat-completions-only servers need a proxy | Responses API only (`wire_api = "responses"`); Ollama serves it (`--oss` / `model_provider = ollama`); OpenAI models natively | Ollama and hosted via hoosh |
| Tool set control | `--tools`, `--exclude-tools`, `--no-builtin-tools`; custom tools = TypeScript extensions; **no MCP** | `--tools "Bash,Read"`, `--disallowedTools`; MCP via `--mcp-config` + `--strict-mcp-config` | shell + `apply_patch` always on; MCP via `codex mcp add` / `[mcp_servers.*]`; `enabled_tools` | MCP client; t-ron allow/deny per tool |
| No prompts | none by design ("run in a container") | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` (refused as root unless sandboxed; `--restricted` exists for eval hosts) | `-a never -s workspace-write`, or `--yolo` in a container | one-shot denies unless `[tron].policy` allows the tool (fail-closed) |
| Isolate the prompt | `--system-prompt`, `-nc` (no AGENTS.md/CLAUDE.md), `--no-session` | `--bare` (skips hooks, skills, MCP, CLAUDE.md, memory), `--system-prompt`, `--no-session-persistence` | `model_instructions_file`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral` | AGENTS.md is wrapped as reference, not obeyed; CLAUDE.md not injected |
| Temperature | `samplingParams` per model | not configurable | not configurable (`model_reasoning_effort` only) | — |

Consequences for a fair comparison:

1. **The model is the constant, so pick models every arm can run.** The only set all four reach is
   **local Ollama models** — Pi and Thoth natively, Claude Code through Ollama's Anthropic-compatible
   endpoint, Codex through Ollama's Responses endpoint. Anthropic models work in Pi and Claude Code;
   OpenAI models in Pi and Codex. This is the concrete meaning of "localized": local models are the
   lingua franca of a multi-harness benchmark, and the synthetic arm already speaks it.
2. **Equalize the tools or measure the difference — but decide.** Every harness ships a shell, so
   the cheapest fair path is to let each arm reach the webserver with `curl` and score only the final
   message (which is all the runner scores today). The stricter path is a tiny **local MCP server**
   exposing exactly `health`, `hello`, `lookup`, `regex_match`, `word_count` — the same definitions the
   synthetic arm gets — for Claude Code, Codex and Thoth, with a Pi extension wrapping the same
   functions. Same tools everywhere keeps the delta attributable to the harness; "bring your own
   tools" measures the product. Both are valid; label which one a run used.
3. **Strip what is not the harness under test.** `--bare` / `-nc` / `--ignore-rules` so instruction
   files, skills and memory do not leak in; non-interactive permission modes so nothing blocks;
   record the harness version and the exact flags in the run record.
4. **Sandbox the ones that need it.** Claude Code and Codex bypass modes are documented for containers;
   Pi runs in host Node and Thoth is local. A per-arm container recipe belongs in the repo.
5. **Expect variance and budget for it.** No temperature control in Claude Code or Codex; Terminal-Bench
   reruns score 0.85–0.96 of each other. Fisher at n ≥ 4, sensibly n = 10.
6. **Cost is not uniform.** Claude Code reports USD, Pi computes it from rates you configure, Codex
   gives tokens only — normalise to tokens in the record and derive cost from a shared rate table.

### Shape of the change

The runner already talks to a client through two calls (`chat`, `runWithTools`). A real harness fits
behind the second one:

```
HarnessClient.run({ prompt, system, schema, signal })
  → { text, structured, toolCalls, toolResults, rounds, usage, cost, transcript, version }
```

- `synthetic` — the existing `Client` (unchanged).
- `pi` — spawn `pi --mode json --no-session -nc [--system-prompt …] "<prompt>"`, fold
  `tool_execution_*` events into `toolCalls` / `toolResults`, take `message_end`.
- `claude-code` — spawn `claude -p --bare --output-format stream-json --permission-mode
  bypassPermissions [--json-schema …] [--tools …]`, fold `tool_use` / `tool_result` blocks, take
  `result` (with `total_cost_usd`, `num_turns`).
- `codex` — spawn `codex exec --json --ephemeral --ignore-user-config -a never -s workspace-write
  [--output-schema …]`, fold `command_execution` / `mcp_tool_call` items, take the last
  `agent_message`.
- `thoth` — spawn `thoth --events '<goal>'` (over `ssh -R 3000:localhost:3000 arch` while it lives
  there), fold `tool_call` / `tool_result`, take `response`, read tokens/cost from the envelope.

The matrix gains a dimension: **tasks × arms × models**, where arms = `noHarness` (raw model, the
baseline for every arm) + `synthetic` + one per real harness. `runTrial` needs no change beyond the
client abstraction; `summarize` needs the delta computed per arm against the shared baseline; the UI
needs one more column group. Everything else — scoring, ground truth, significance, persistence — is
already arm-agnostic.

Suggested order: Thoth first for the local-model comparison (it already runs the same
`ornith-1.5:9b`, and the arm is one ssh command), Pi first for hosted models (cheapest to drive, no
sandbox, temperature control), then Claude Code and Codex in a container recipe.
Before any of it: Tier 1 [1], because a multi-harness comparison is only as trustworthy as the scorers
underneath it, and those were wrong until today.

### Decisions needed

1. Same tools for every arm (local MCP server + Pi extension) or bring-your-own — or both, labelled?
2. Model set: Ollama-only for the cross-harness matrix, with hosted models only where the arm supports
   them natively?
3. For the Thoth arm: which tools does `/var/tmp/tron-deleg.toml` allow non-interactively, and should
   the webserver be reached through a reverse tunnel from this machine or by running the bench on
   arch next to hoosh?

### Sources

Pi: github.com/earendil-works/pi (README, docs/models.md, docs/json.md, docs/sdk.md),
docs.ollama.com/integrations/pi · Claude Code: code.claude.com/docs (cli-reference, headless,
model-config, llm-gateway, permission-modes, tools-reference, agent-sdk),
docs.ollama.com/integrations/claude-code · Codex: github.com/openai/codex,
learn.chatgpt.com/docs (non-interactive-mode, config-file/config-reference, agent-approvals-security,
extend/mcp), docs.ollama.com/integrations/codex · Prior art: arXiv 2601.11868 (Terminal-Bench 2.0),
tbench.ai/leaderboard, swebench.com/verified, github.com/minghinmatthewlam/openbench, Databricks
"Benchmarking coding agents" (Jul 2026), LangChain "Improving deep agents with harness engineering"
(Feb 2026), arXiv 2608.26218, 2606.12344, 2605.27922, 2606.08529, openai.com/index/harness-engineering,
anthropic.com/engineering/effective-harnesses-for-long-running-agents,
martinfowler.com/articles/harness-engineering.html · Adapters: Vercel AI SDK harness providers
(ai-sdk.dev/providers/ai-sdk-harnesses), github.com/harbor-framework/harbor.
