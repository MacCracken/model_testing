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

`npm test`: **93/93**. Twelve saved runs, all local `ornith-1.5:9b`; **none of them post-date the
scorer fixes below, so every live number recorded in earlier versions of this file is void.**

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

### Tier 1 — Core premise: is the delta real? (RE-OPENED)

Nothing in this tier can be called done until it has been **run** with the fixed scorers.

- **[1] Re-run the calibration set.** All five tasks, `noHarness` + `harness`, at least one local and
  one hosted model, **≥ 4 trials per cell** (the Fisher floor; 10 is a sensible default). Paste the
  headline numbers and their significance lines into this file. Expected shape: `lookup` free-form 0%
  with a real harness lift; `regex` free-form well above 0%; `reason` delta ≈ 0.
- **[2] Tool-argument correctness as a hygiene metric.** The saved `regex` run shows the model calling
  `regex_match` on strings that were not in the list ("123-457", "123-450"). "Called the right tool with
  the right args" is a distinct signal from "final answer correct"; record it per trial
  (`argsCorrect`) and surface it beside tool-use and schema-valid.
- **[3] Decide the 2×2.** `schemaOnly` / `toolOnly` are *not* derived automatically on purpose: the
  prompts are entangled with the mode (free-form prompts say "without any tools", harness prompts say
  "call the X tool and return JSON"), so a derived spec would either contradict itself or score the
  wrong thing. Author explicit specs for `hello`, `lookup` and `regex`, then add the 2×2 view (the
  dumbbell already draws hollow markers for the extra modes). If Tier 5 goes ahead, do this after it —
  the axes question changes shape when the harness is a real product.

### Tier 2 — Methodology / task diversity

- **[4] Multi-step tasks** where later tool calls depend on earlier results, and an
  extract-and-transform task (fetch, then reshape).
- **[5] LLM-as-judge** for open-ended tasks (`eval.judge`), still pluggable and still unbuilt.
- **[6] Determinism knobs.** `Client.modelParams` exists and nothing sets it; wire `temperature` (and
  `seed` where supported) into the run config and record it.

### Tier 3 — Data / output

- **[7] CSV export** of rows and cells from the CLI and the UI.
- **[8] TTFT and latency distribution** (needs the streaming client); p50/p95 instead of a mean.
- **[9] Per-cell significance in the CLI** (the UI already shows it on hover).

### Tier 4 — Architecture

- **[10] Provider breadth.** Cerebras / DeepSeek / Together drop in via `PROVIDERS`.
- **[11] `schema.js` coverage**: `additionalProperties`, `const`, `format`, nested `required`.
- **[12] Harness version pinning** in the run record (model and client build) so results stay
  comparable over time.

### Tier 5 — Real harnesses as the harness arm (proposed, see below)

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
per the "thoth Open Gaps" review: a terminal agent with an MCP client (bote via daimon), Ollama
support, mid-session model switching, per-turn token/cost accounting, tool-definition pinning and a
hash-linked audit chain. From that review, the one thing it lacks to be a benchmark arm is a
**non-interactive one-shot mode**: `--events` (0.42.0) is a one-way stream, which is the right
transport, but the arm needs a way to send one prompt, receive a marked final message with usage,
and exit. `/audit export` could double as the transcript source. That is a Thoth roadmap item, not a
bench one, and the bench can be built around Pi first while it lands.

### How each harness can be driven (verified against current docs, Sept 2026)

| | Pi | Claude Code | Codex CLI | Thoth |
|---|---|---|---|---|
| Headless | `pi --mode json "<prompt>"` (JSONL events; `message_end` is the final message) | `claude -p "<prompt>" --output-format json` (`stream-json` for tool calls) | `codex exec --json "<prompt>"` (JSONL items) | `--events` stream only (one-way); one-shot mode needed |
| Usage / cost | `usage{…,cost}` from per-model rates in `models.json` | `usage`, `total_cost_usd`, `num_turns` | `turn.completed.usage` tokens only | per-turn accounting exists |
| Structured output | none — parse the final message (`parseJSONLoose`) | `--json-schema` → `structured_output` | `--output-schema <file>` | — |
| Model / local | `--provider`/`--model`; any endpoint via `models.json` (`openai-completions`, `anthropic-messages`, …); Ollama documented | Anthropic Messages format only: Anthropic models, or Ollama via `ANTHROPIC_BASE_URL` (Ollama serves that API); chat-completions-only servers need a proxy | Responses API only (`wire_api = "responses"`); Ollama serves it (`--oss` / `model_provider = ollama`); OpenAI models natively | Ollama and hosted via hoosh |
| Tool set control | `--tools`, `--exclude-tools`, `--no-builtin-tools`; custom tools = TypeScript extensions; **no MCP** | `--tools "Bash,Read"`, `--disallowedTools`; MCP via `--mcp-config` + `--strict-mcp-config` | shell + `apply_patch` always on; MCP via `codex mcp add` / `[mcp_servers.*]`; `enabled_tools` | MCP client; t-ron allow/deny per tool |
| No prompts | none by design ("run in a container") | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` (refused as root unless sandboxed; `--restricted` exists for eval hosts) | `-a never -s workspace-write`, or `--yolo` in a container | fail-closed confirm; session-scoped grants |
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
- `thoth` — once a one-shot mode exists: spawn with `--events`, fold tool events, take the final
  message.

The matrix gains a dimension: **tasks × arms × models**, where arms = `noHarness` (raw model, the
baseline for every arm) + `synthetic` + one per real harness. `runTrial` needs no change beyond the
client abstraction; `summarize` needs the delta computed per arm against the shared baseline; the UI
needs one more column group. Everything else — scoring, ground truth, significance, persistence — is
already arm-agnostic.

Suggested order: Pi first (cheapest to drive, no sandbox, temperature control, documented Ollama
path), then Claude Code and Codex in a container recipe, then Thoth when it can be driven one-shot.
Before any of it: Tier 1 [1], because a multi-harness comparison is only as trustworthy as the scorers
underneath it, and those were wrong until today.

### Decisions needed

1. Same tools for every arm (local MCP server + Pi extension) or bring-your-own — or both, labelled?
2. Model set: Ollama-only for the cross-harness matrix, with hosted models only where the arm supports
   them natively?
3. Does Thoth get a one-shot mode, and what marks its final message?

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
