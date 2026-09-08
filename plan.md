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


**local qwen3.8:27b-mlx** (4 per cell, 2026-09-04) — 12/28 → 28/28, **+57.1pp**, significant · p<0.001 · 28 vs 28 trials; tools-only 24/24, schema-only 12/28; tool args ok 100%; harness p50 7.6 s, first token p50 0.1 s:

| task | noHarness | harness | schemaOnly | toolOnly |
|---|---|---|---|---|
| health | 0/4 | 4/4 | 0/4 | 4/4 |
| hello | 4/4 | 4/4 | 4/4 | 4/4 |
| reason | 4/4 | 4/4 | 4/4 | — |
| lookup | 0/4 | 4/4 | 0/4 | 4/4 |
| regex | 4/4 | 4/4 | 4/4 | 4/4 |
| chain | 0/4 | 4/4 | 0/4 | 4/4 |
| transform | 0/4 | 4/4 | 0/4 | 4/4 |
| **all** | **12/28** | **28/28** | **12/28** | **24/24** |

Per-task deltas now reach significance on their own where the floor is real (`lookup`, `chain`,
`health` on haiku and ornith, `reason` on gpt-4o-mini).

**qwen3.5:9b-mlx** was tried twice as the second local model and is parked: its free-form answers
reason for minutes (104 s to well past the 120 s timeout), and `think=false` through Ollama's
OpenAI route does not suppress the reasoning — with a 600-token cap the whole budget went to
reasoning and no answer arrived. It needs Ollama's native API (or a real reasoning-effort knob) to be
benchmarkable at ten trials per cell in reasonable time. The new `chain` task behaves as designed: 0/10
without a tool in both free-form and schema-only, 10/10 with one. gpt-4o-mini's free-form `reason`
is 0/10 — it writes 10 for the marbles question every single time in prose and 8 every time in
JSON. The local runs at this size are recorded below when they finish.


### Same model, different harness (2026-09-04, four trials per cell, harness mode)

Two real arms next to the synthetic harness on the same model, on the four tool tasks (the
synthetic free-form baselines in the same run: gpt-4o-mini 4/16 · 1.5 s · 218 tok, haiku
1/16 · 2.5 s · 280 tok). Pi's `lookup` / `chain` / `transform` columns are from a
rerun after the scoring fix described below; everything else is one run.

| task | synthetic · gpt-4o-mini | Pi · gpt-4o-mini | synthetic · haiku 4.5 | Claude Code · haiku 4.5 |
|---|---|---|---|---|
| health | 4/4 · 1.0 s · 522 tok | 4/4 · 1.8 s · 1,479 tok | 4/4 · 1.6 s · 1,664 tok | 4/4 · 3.6 s · 5,048 tok |
| lookup | 4/4 · 2.2 s · 912 tok | 4/4 · 4.1 s · 1,807 tok | 4/4 · 1.7 s · 2,018 tok | 4/4 · 7.0 s · 10,292 tok |
| chain | 4/4 · 2.3 s · 1,210 tok | 3/4 · 4.2 s · 2,556 tok | 4/4 · 2.6 s · 3,187 tok | 4/4 · 5.8 s · 9,028 tok |
| transform | 4/4 · 2.0 s · 959 tok | 4/4 · 4.4 s · 2,601 tok | 4/4 · 1.9 s · 2,186 tok | 4/4 · 5.8 s · 6,762 tok |
| **all** | **16/16 · 1.9 s · 901 tok** | **15/16 · 3.6 s · 2,110 tok** | **16/16 · 1.9 s · 2,264 tok** | **16/16 · 5.6 s · 7,782 tok** |

What it says:

- **Correctness is the same story everywhere**: every arm reaches (or nearly reaches) 100% on tasks
  where the free-form baseline is 0%. Pi's one miss is a real one — on `chain` it reported the first
  greeting instead of the second. Harness choice did not change *whether* these models could do the
  jobs.
- **Cost and latency are where the harnesses differ**, exactly as the literature predicted:
  per trial on the same model, Pi used about 2.5× the tokens and 2× the wall-clock of the synthetic
  harness, and Claude Code about 3.5× the tokens and 3× the wall-clock (its system prompt is the
  bulk of it). Those are now headline numbers in every run record.
- **How the arm is scored matters as much as what it does.** The first Pi pass came out 8/16 only
  because the arm was being scored from its own tool output: Pi's model pipes curl through `jq`
  and reshapes the reply, so the raw `{message, id}` never appeared. Scoring against what the
  webserver actually served (`GET /api/recent`) fixed it, and it is now how every arm is scored,
  including Thoth, whose events carry no tool output at all. Run arm trials one process at a time
  against a given webserver: the window is by time, not by caller.
- The bench's tool-use judge does not apply to arms (they bring their own tools); "tool args ok"
  stays null for them by design.


### Same model, three harnesses (2026-09-06, four trials per cell, harness mode)

**gpt-5.4-mini** — the one model the synthetic client, Pi and Codex can all run with tools. Free-form
baseline in the same run: 2/16 · 1.1 s (answer 0.6 s) · 165 tok.

| task | synthetic | Pi | Codex |
|---|---|---|---|
| health | 4/4 · 1.4 s (answer 0.6 s) · 699 tok | 4/4 · 2.8 s (answer 2.8 s) · 1,611 tok | 4/4 · 3.2 s (answer 3.0 s) · 31,663 tok |
| lookup | 4/4 · 1.9 s (answer 0.8 s) · 1,084 tok | 4/4 · 3.7 s (answer 3.7 s) · 2,303 tok | 4/4 · 3.8 s (answer 3.6 s) · 34,270 tok |
| chain | 4/4 · 2.6 s (answer 0.5 s) · 1,488 tok | 2/4 · 6.4 s (answer 6.4 s) · 3,554 tok | 3/4 · 4.9 s (answer 4.7 s) · 54,441 tok |
| transform | 4/4 · 1.8 s (answer 0.7 s) · 1,184 tok | 4/4 · 3.8 s (answer 3.8 s) · 2,367 tok | 4/4 · 3.9 s (answer 3.7 s) · 32,092 tok |
| **all** | **16/16 · 1.9 s (answer 0.7 s) · 1,114 tok** | **14/16 · 4.2 s (answer 4.2 s) · 2,459 tok** | **15/16 · 4.0 s (answer 3.7 s) · 38,117 tok** |

Deltas against that baseline: synthetic +87.5pp (significant · p<0.001 · 16 vs 16 trials); Pi +75.0pp (significant · p<0.001 · 16 vs 16 trials); Codex +81.3pp (significant · p<0.001 · 16 vs 16 trials).

**claude-haiku-4-5** (same run) — baseline 2/16 · 2.5 s (answer 0.5 s) · 274 tok:

| task | synthetic | Claude Code |
|---|---|---|
| health | 4/4 · 1.5 s (answer 0.7 s) · 1,662 tok | 4/4 · 4.7 s (answer 4.1 s) · 4,697 tok |
| lookup | 4/4 · 2.5 s (answer 0.8 s) · 2,019 tok | 4/4 · 6.2 s (answer 5.8 s) · 5,156 tok |
| chain | 4/4 · 3.3 s (answer 0.5 s) · 3,177 tok | 4/4 · 8.3 s (answer 7.8 s) · 9,125 tok |
| transform | 4/4 · 1.7 s (answer 0.6 s) · 2,185 tok | 4/4 · 9.5 s (answer 9.0 s) · 7,958 tok |
| **all** | **16/16 · 2.3 s (answer 0.6 s) · 2,261 tok** | **16/16 · 7.2 s (answer 6.7 s) · 6,734 tok** |

Deltas: synthetic +87.5pp (significant · p<0.001 · 16 vs 16 trials); Claude Code +87.5pp (significant · p<0.001 · 16 vs 16 trials).

**gpt-6-astra** (Codex's default) — arms versus raw only, because chat completions refuses function
tools on this model, so the synthetic harness column is not runnable there (its rows are API
errors, excluded here). Baseline 0/16 · 2.5 s (answer 1.9 s) · 166 tok:

| task | Pi | Codex |
|---|---|---|
| health | 4/4 · 3.0 s (answer 3.0 s) · 1,505 tok | 4/4 · 4.3 s (answer 4.1 s) · 36,376 tok |
| lookup | 4/4 · 5.6 s (answer 5.5 s) · 1,869 tok | 4/4 · 6.1 s (answer 5.9 s) · 36,840 tok |
| chain | 4/4 · 9.0 s (answer 9.0 s) · 1,828 tok | 4/4 · 6.3 s (answer 6.1 s) · 36,760 tok |
| transform | 4/4 · 5.2 s (answer 5.2 s) · 1,979 tok | 4/4 · 5.7 s (answer 5.5 s) · 36,969 tok |
| **all** | **16/16 · 5.7 s (answer 5.7 s) · 1,795 tok** | **16/16 · 5.6 s (answer 5.4 s) · 36,736 tok** |

Deltas: Pi +100.0pp (significant · p<0.001 · 16 vs 16 trials); Codex +100.0pp (significant · p<0.001 · 16 vs 16 trials).

"Answer" is the event-level time to the final answer for arms (first-token timing for the synthetic
client is in the run record).

What these add to the earlier picture:

- **The first harness-attributable correctness difference.** On `gpt-5.4-mini`, the synthetic tool
  loop chained `chain` 4/4 while Pi did 2/4 and Codex 3/4, each miss being "the id was never
  greeted — the second call did not use the first result": inside those harnesses the same model
  fetched alice and then answered without making the dependent second call. Small numbers, but the
  scorer names the mechanism, and it did not happen to that model in the bench's own loop.
- **Codex's cost is in a different league**: ~38k tokens per trial against ~1.1k for the synthetic
  harness and ~2.5k for Pi on the same model — its ~12k-token context is resent every turn. On
  correctness all three are within a trial of each other.
- `gpt-6-astra` raw is 0/16 on these tasks and both arms take it to 16/16, so the full harness
  effect is visible even where the synthetic harness cannot run.
- Everything else was model behaviour, not scoring: free-form health hedges and one Pi `chain` report
  of the first greeting instead of the second in the earlier run.

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
  lift to tools. Ten per cell **DONE** on three models; the second local model is
  `qwen3.8:27b-mlx` (about 40 s per free-form answer, so four per cell; see the addendum).
- **[2] Tool-argument correctness as a hygiene metric.** **DONE.** Every tool task defines
  `eval.toolUse` (right tool, right arguments, right calls — `regex` judges the pattern by what it
  computes on the listed strings, not by spelling, and flags the decoy); the runner records
  `toolUseOk` + reason per trial; CLI, `show`, CSV and the UI surface "tool args ok" beside tool-use
  and schema-valid, and the trial drawer shows the verdict as a timeline step.
- **[3] Decide the 2×2.** **Specs DONE:** `health`, `hello`, `lookup` and `regex` carry hand-written
  `schemaOnly` / `toolOnly` specs (not derived: a free-form prompt says "without any tools" and a
  harness prompt says "call the X tool and return JSON", so a derived spec would contradict itself).
  **2×2 panel DONE** (2026-09-04): `twoByTwo` in the runner reads the tools effect, the schema
  effect and their interaction off the four modes; the report prints the grid and the UI shows it
  under the headline once three of the four modes have rows.

### Tier 2 — Methodology / task diversity

- **[4] Multi-step and extract-and-transform tasks.** **DONE.** `chain` greets alice, then must greet
  the random id that came back and report the second greeting; `transform` (2026-09-04) fetches three
  greetings and must report each name with the first 8 characters of its id and the greeting in
  upper case — tool-essential plus two reshapings of what came back. Both read their truth from the
  trial's own tool results.
- **[5] LLM-as-judge.** **DONE** (2026-09-04). `src/judge.js` builds a judge from any synthetic
  client; scorers receive it as `{ judge, mode }`; `--judge` / `BENCH_JUDGE` / the recipe field
  choose it and the run records it. First open-ended task: `explain` (health and running time for a
  non-engineer, graded against the live facts with a rubric, pass at 0.75). Live smoke with
  gpt-4o-mini answering and judging: harness 2/2 at score 1.0 with sensible reasons, free-form 0/2.
- **[6] Determinism knobs.** **DONE.** `--temperature` / `--seed` on the CLI and two fields in the
  recipe flow into every request as-is and are recorded in `run.config.modelParams` (shown in the
  headline). `--model-param key=value` (repeatable, JSON-parsed) covers anything else a provider
  accepts, e.g. `think=false` or `max_tokens=600` for Ollama. Models that reject a non-default
  temperature (the gpt-5 family) surface as error rows.

### Tier 3 — Data / output

- **[7] CSV export.** **DONE.** `node src/cli.js export <id> [--cells]`, `GET /api/runs/<id>/csv`
  (`?cells=1`), and an "export csv" link on every finished run.
- **[8] Latency distribution.** p50 / p95 / max **DONE**, and **TTFT DONE** (2026-09-04): the client
  streams by default, reassembles tool-call deltas by index, and records two timings per trial —
  `ttftMs` (first token of any kind, reasoning included) and `ttfaMs` (first answer token: content or
  a tool call). Validated live on OpenAI, Anthropic's compatible route and Ollama; usage still arrives
  in the trailing chunk. The two timings separate cleanly on thinking models: ornith's free-form
  health answer showed first token at 2.6 s and first answer token at 15.5 s.
- **[9] Per-cell significance in the CLI.** **DONE.** `summary.delta.byTaskClient`, printed by the
  report when there is more than one cell.
- **[13] Long-term storage and cross-run queries.** **DONE** (added and built 2026-09-06). A run is
  still one JSON file under `results/runs/` (durable, portable, diffable, nothing migrated), and a
  **SQLite index over those files** — `results/index.sqlite`, built with Node's own `node:sqlite`, so
  the zero-dependency rule holds — answers the cross-run questions the directory could not.
  - `src/store.js`: tables `runs` (header, config, versions, warnings, row count, file mtime),
    `trials` (the scalar columns the CSV has: task, mode, client, model, harness, correct, reason,
    error, tool calls, tool-use and schema flags, judge score, latency / TTFT / TTFA, tokens) and
    `cells` (task × client × mode aggregates from the same `summarize` every surface uses). Prompts,
    transcripts and ground truth stay in the files; each row points back at its run.
  - Kept current two ways: `saveRun` fires an `onRunSaved` hook the store listens on (a header row
    while a web run is live, trials and cells once it finishes; an index failure never blocks a
    save), and `node src/cli.js index [--full]` reconciles from file mtimes — changed files are
    re-read, vanished files drop out, and the stray non-run file in the directory is skipped by the
    same `isRun` guard `loadRun` uses.
  - `node src/cli.js query runs|trend|cell|worst` (`--task`, `--client`, `--mode`, `--q`, `--since`,
    `--limit`) plus a read-only `--sql` escape hatch. Web: the header's "find a run" box filters the
    history through `GET /api/runs?q=|task=|client=|mode=|since=` (the unfiltered listing stays
    file-based, so the UI never depends on the index), and every trial drawer ends with an
    "Across runs" line from `GET /api/cells` — the same task × model × mode cell pooled over every
    saved run with its date span.
  - Retention: `node src/cli.js compact --older-than <days>` (dry run; `--yes` writes) strips
    prompts, final messages and tool-result contents from old runs while keeping every scalar, marks
    the file `compacted` and re-indexes it; a compacted run is never compacted again.
  - First pass over the existing directory: 32 runs indexed into a 520 KB index; the pooled
    picture across every run so far is harness 91.3 % correct over 550 trials, noHarness 42.0 % over
    369, schemaOnly 49.7 % over 290, toolOnly 99.1 % over 223. `query worst` puts the four
    `openai:gpt-6-astra` harness cells at 0/4 on top — the chat-completions-refuses-tools case from
    the three-harness table, now visible without opening a file. A dry-run compaction of everything
    older than three days would trim 17 files by 610 KB (roughly 60 % of each).
  - Tests: `test/store.test.js` runs against a scratch `RESULTS_DIR` (indexing on save, filters,
    trend and pooled cell, incremental reindex on mtime change and file removal, compaction dry run
    versus apply).

### Tier 4 — Architecture

- **[10] Provider breadth.** DeepSeek added (`deepseek-chat`, `deepseek-reasoner`; greyed out until
  `DEEPSEEK_API_KEY` exists). Cerebras / Together drop in the same way once someone has a key to verify
  their model ids against.
- **[11] `schema.js` coverage.** **DONE.** `additionalProperties` (false or a schema), `const`,
  string bounds / `pattern` / `format` (date-time, date, uuid, email, uri), numeric bounds and
  `multipleOf`, `maxItems` / `uniqueItems`, type unions. Unknown formats stay annotations.
- **[12] Version pinning.** **DONE.** Every run records `versions` (bench version, git commit, node,
  harness kind) next to its config.

### Tier 5 — Real harnesses as the harness arm (STARTED — Thoth, Claude Code, Pi and Codex arms, see below)

---

### Tier 6 — Model variance via parallel requests (STARTED 2026-09-07 — scheduler and stability metrics built)

The bench has always asked "is the harness delta real?" with a p-value. This tier asks the companion
question — "how noisy is the model itself, and does the harness change that?" — and makes the answer
cheap to get by running repeated trials in parallel instead of one after another.

- **[14] Parallel trials.** **DONE** (2026-09-07). `--parallel N` (CLI) / "in parallel" (web
  settings) runs up to N trials at once; `runMatrix` launches in plan order and collects rows as they
  finish (plan order when N is 1). One rule: a real-harness arm always runs **alone** — arms are
  scored against the webserver's time-windowed `/api/recent` log, so nothing else may touch the
  server while an arm trial is in flight (`structuredOnly` clients drain the pool before they start
  and hold it until they finish). The run records `parallel`, the report and headline print
  "N in parallel", and the live view marks every in-flight cell from the runner's new `trial-start`
  events. Measured on gpt-4o-mini (health, reason, regex × noHarness, harness): 24 trials serial in
  36 s; 48 trials at parallel 8 in 8 s — about 9× the throughput, with p50 latency unchanged (650 →
  642 ms free-form, 1,250 → 1,329 ms harness), so OpenAI does not queue at this depth. Local Ollama
  will: it serves `OLLAMA_NUM_PARALLEL` requests at once and queues the rest, so latency columns from
  a parallel local run include queueing (the UI hint says so; compare latencies serial-to-serial).
- **[15] Stability metrics.** **DONE** (2026-09-07). Per cell: `agreementPct` (share of the repeated
  trials that gave the modal *canonical* answer), `distinctAnswers`, and `flaky` (both passes and
  failures). Per mode: `summary.stability` (repeated cells, flaky count, trial-weighted agreement),
  phrased once by `describeStability` for the report and the headline. Canonical answers come from
  `eval.canon(answer, { mode, structured })` on tasks with fixed truth — `health` (status only;
  uptime moves), `reason` (sorted answers / per-question presence pattern), `regex` (per-string
  verdicts). Tasks whose truth is minted per trial (`hello`, `lookup`, `chain`, `transform`) are
  outcome-only; `explain` is judged. Rows carry `canon`; the CSV and the SQLite index carry the new
  columns (`index --full` backfilled 36 runs; the store migrates older indexes in place).
  First readings: the serial run caught health free-form at 3/4 with **75 % agreement** ("ok" ×3,
  "down" ×1) while its harness cell sat at 100 %; `reason` free-form is 0/12 at **100 % agreement**
  — the model misses the same question every time (presence pattern `101`), a systematic error,
  not noise. That distinction is what agreement adds to a correctness percentage: the harness delta
  on `reason` is a fix for a stable failure, the one on `health` free-form is a fix for flakiness.
- **[16] Variance across runs and settings.** **OPEN.** With the index the next questions are cheap:
  agreement at temperature 0 versus the default; a model's flake rate over its last N runs (`query
  --sql` over `cells.flaky`); canonical answers for `transform` (the SHOUT half is deterministic)
  and `chain` (the greeting's shape). Arms could join the parallel pool if each trial greeted a
  unique name (a nonce in the goal prompt) and `recentGreetings` matched on it instead of on the
  time window.

### Tier 7 — Agents: harder tasks, sub-agents, skills (STARTED 2026-09-07 — [17], [18] and [19] built; [20] open)

Everything so far is one goal, one or two tool calls, one answer. The next capability question is
what a harness buys on **harder** work, where the axes belong to the agent rather than the prompt:

- **[17] Multi-step tasks.** **DONE** (2026-09-07). The
  `restock` family — `restock3`, `restock6`, `restock12` — is one job at three lengths against a new
  stateful corner of the SUT: **inventory scenarios** (`POST /api/scenarios` mints an isolated
  inventory of 2K+2 items, K of them below their minimum; `GET …/items`, `PATCH …/items/:id` →
  `{ item, ticket }`, `GET …/summary`, `POST …/confirm { tickets }`). The job: list, update every
  low item to its target with status `reordered` (one dependent call each), confirm with the complete
  ticket set, report the ids changed and the server's total afterwards. Two rules make it agentic
  rather than clerical: the server **refuses to confirm while any item is still low** (409 with a
  count, no ids — the agent has to go back and look), and truth is the **server's end state** read
  after the answer (`GET /api/scenarios/:sid`), so a right-looking report over an unchanged inventory
  scores wrong. Plumbing this needed: a per-trial `setup()` hook on tasks (the scenario is created
  per trial, so parallel trials never share state), prompts/system/goal as functions of that context,
  a task-level `maxRounds`, and `ctx` handed to ground, scorers and the tool-use judge. `noHarness`
  is the control (no tools, nothing can change: 0 % by construction); `toolOnly` isolates the schema.
  First curve, four trials per cell, synthetic harness, parallel 6:

  | model · mode | restock3 | restock6 | restock12 | restock12 tokens · rounds · latency |
  |---|---|---|---|---|
  | gpt-4o-mini · harness | 2/4 | 1/4 | 0/4 | 113 k · 25 · 25.5 s |
  | gpt-4o-mini · toolOnly | 1/4 | 0/4 | 0/4 | 48 k · 12 · 13.1 s |
  | gpt-5.4-mini · harness | 4/4 | 4/4 | 3/4 | 10.9 k · 5 · 5.2 s |
  | gpt-5.4-mini · toolOnly | 4/4 | 4/4 | 3/4 | 10.1 k · 5 · 5.5 s |
  | claude-haiku-4-5 · harness | 4/4 | 4/4 | 4/4 | 19.6 k · 5 · 15.6 s |
  | claude-haiku-4-5 · toolOnly | 4/4 | 4/4 | 4/4 | 17.4 k · 5 · 14.9 s |

  What the failures are: before the confirm rule existed, gpt-4o-mini skipped the item whose qty was
  only a few units under its min in every restock3 trial (it compares the two columns sloppily) and
  confirmed anyway; with the rule it now goes back — and over-corrects, restocking items that were
  never low (`N item(s) that were not low got modified`), burning 25 rounds and 113 k tokens at
  K = 12 without finishing. gpt-5.4-mini's two misses at K = 12 are the same collateral edit, once
  each. Haiku is clean at every length, at 2–3× gpt-5.4-mini's latency. Schema (harness vs toolOnly)
  makes no difference on this task for the capable models; the whole delta is tools plus the loop.
  The synthetic loop's own ceiling shows too: every capable run finishes in 5 rounds because the
  models batch their updates as parallel tool calls.

  The same family through the real arms (three trials per cell, harness mode, arms run alone):

  | arm · model | restock3 | restock6 | restock12 | restock12 tokens · latency | synthetic, same model |
  |---|---|---|---|---|---|
  | pi · gpt-4o-mini | 3/3 | 2/3 | 0/3 | 232 k · 46 s | 2/4 · 1/4 · 0/4 |
  | claude-code · claude-haiku-4-5 | 3/3 | 3/3 | 3/3 | 27 k · 27 s | 4/4 · 4/4 · 4/4 |
  | codex · gpt-5.4-mini | 2/3 | 3/3 | 3/3 | 103 k · 14 s | 4/4 · 4/4 · 3/4 |

  Readings: Pi's loop lifts the weak model at short lengths (3/3 and 2/3 where the synthetic
  harness managed 2/4 and 1/4) and then falls off the same cliff at twelve — 6–11 of 12 items left
  low after 232 k tokens, twice the synthetic harness's spend for the same failure. Claude Code with
  Haiku is clean at every length and the cheapest arm by far (27 k tokens at K = 12, about 1.4× the
  synthetic Haiku run). Codex's one miss is the same collateral edit gpt-5.4-mini made in the
  synthetic harness, at roughly 10× the tokens. So on this task the model sets the ceiling and the
  harness sets the cost: no arm beat its own model's synthetic result at K = 12, and the spread in
  tokens for equal correctness is an order of magnitude.
- **[18] Sub-agents.** **BUILT** (2026-09-07; measurements below as they land). Offloading work is
  a client variant like skills: `openai:gpt-4o-mini@agents:available` (or `:required`) next to the
  plain client in one run. In the synthetic harness the parent gets one extra tool, `delegate(goal)`:
  each call runs a fresh model turn — a child — with the task's own tools (never `delegate`, so depth
  stays at one) and returns the child's final answer as the tool result; several delegate calls in one
  turn run in parallel because the tool loop executes a turn's calls together. Everything a child did
  folds back into the parent's row — tool calls and results tagged with the child's number, usage
  summed — so end-state scoring, tool-use verdicts and cost see the whole tree, and `row.agents`
  records how much was delegated (count, child calls, child tokens, each child's goal and answer).
  `available` tells the parent it may offload independent pieces; `required` tells it to do the
  per-item work through sub-agents. Arms get the request in `opts.agents` and use their own channel:
  Claude Code's Agent tool is allowed (`--allowedTools Bash,Agent,Task`) and its uses counted; an arm
  without a channel leaves `applied` false so the row says the treatment did not happen. Pairing and
  deltas come from the same `variantDeltas` as skills — `delta.byAgents` per cell, `delta.agents[how]`
  pooled, "delegated in n/m" alongside. `src/agents.js`; the web setting "sub-agents" with A/B
  choices; rows and the index carry `agents` / `delegations`.

  First result, gpt-4o-mini on restock6 and restock12, four trials per cell: it **never delegated** —
  0 of 16 treated trials called `delegate`, under `available` and under `required` alike — so the
  cells differ only by noise (restock6 0/4 → 2/4 both ways, restock12 0/4 → 0/4). The plumbing is
  not the reason: asked directly to have a sub-agent say "pong", the same client delegates once and
  relays the answer. Read with [19]'s on-demand result (it never called `load_skill` either), the
  small model does not reach for meta-tools even when told to; capability it is offered but must
  choose to use is capability it does not have.

  The capable models, restock12, four trials per cell (three for the arm):

  | client | plain | @agents:available | @agents:required |
  |---|---|---|---|
  | gpt-5.4-mini | 3/4 · 10.8 k tok · 5.6 s | 3/4 · delegated 0/4 | 2/4 · delegated 4/4 · ~2 children · 20 k tok · 9.8 s |
  | claude-haiku-4-5 | 4/4 · 19.5 k tok · 16.8 s | 4/4 · delegated 0/4 | 3/4 · delegated 2/4 · 12 children when it did · 49 k tok · 18 s |
  | claude-code · haiku (Agent tool allowed) | 3/3 · 50 k tok | 3/3 · Agent tool used 0/3 | — |

  Offered, nobody takes it: neither model nor Claude Code's own Agent tool delegated once when the
  job was one they could finish alone. Forced, it cost: gpt-5.4-mini split the work into one or two
  batch children (once the same batch twice — duplicate updates), doubled its tokens and lost a
  trial to a collateral edit; Haiku obeyed half the time, fanned out one child per item (twelve in
  parallel, so wall time held), spent 2.5× the tokens and also lost one to a collateral edit.
  Twelve dependent steps are simply not where offloading pays.

  So the family got a fourth length — **restock30**, thirty low items in an inventory of sixty, the
  scenario cap — where one context should start to strain. Three trials per cell, harness mode:

  | client | plain | @agents:required |
  |---|---|---|
  | gpt-5.4-mini | **0/3** (one missed item, two collateral edits, one hand-summed total) · 49 k tok · 12.7 s | 1/3 · delegated 3/3 · one batch child · **25 k tok** · 14.3 s |
  | claude-haiku-4-5 | 2/3 · 67 k tok · 41.8 s | **3/3** · delegated 3/3 · 16 children · 125 k tok · 46.8 s |

  Here delegation moved both models up (+33 pp each, n = 3, nothing significant yet) and the two
  shapes of it show: gpt-5.4-mini's single batch child worked from a fresh context and halved the
  total tokens; Haiku's one-child-per-item fan-out doubled tokens while keeping wall time flat
  because the children ran in parallel. Reading across the lengths: sub-agents are a cost at
  twelve steps, a gain at thirty, and never something a model picks up on its own — which is the
  measurement the tier asked for. Still open under [18]: the arms' own sub-agents beyond Claude Code
  (Pi, Codex, Thoth), and forcing Claude Code's Agent tool the way `required` forces the synthetic
  parent.
- **[19] Skills.** **BUILT** (2026-09-07; arm variants measured as they land). A skill is a markdown
  playbook under `skills/<name>.md` — `restock` (shared by the family through `task.skill`), `chain`,
  `transform`. The treatment is a **client variant, not a new mode**: `openai:gpt-4o-mini@skill:preload`
  next to `openai:gpt-4o-mini` in the same run (the web "skill" setting's A/B choice does this for
  every selected model) runs the same task with and without the playbook, and `summarize` pairs each
  `…@skill:<how>` client with its base on the same task and mode — `delta.bySkill` per cell and
  `delta.skill[how]` pooled, with the usual Fisher p. Two deliveries: **preload** appends the playbook
  to the system prompt (synthetic) or the goal prompt (arms); **on demand** offers a `load_skill`
  tool and the row records how often the model actually loaded it (arms get preload — they bring
  their own tools). `src/skills.js` wraps any client and keeps its flags, so an arm variant still
  runs alone; rows carry `skill` and `baseClient`, the CSV and the index too. First A/B on
  gpt-4o-mini, restock family, harness mode, four trials per cell:

  | delivery | restock3 | restock6 | restock12 | pooled |
  |---|---|---|---|---|
  | plain | 2/4 | 1/4 | 0/4 | 3/12 |
  | preload | 3/4 | 3/4 | 0/4 | 6/12 · +25 pp · p = 0.4 |
  | on demand | 1/4 | 0/4 | 0/4 | 1/12 · loaded **0/12** |

  Readings: the written procedure helps exactly where the model was sloppy rather than incapable —
  at 3 and 6 items it stops skipping the marginal ones and mostly stops the collateral edits (the
  one preload miss per length is a single collateral edit) — and does nothing at 12, where the
  failure is capacity, not procedure. On demand is a null result with a cause: gpt-4o-mini **never
  called `load_skill`** in twelve trials, even told to read it before acting, and the extra tool
  cost it (1/12). An offered skill is only as good as the model's habit of reaching for it. Nothing
  here is significant at four per cell; the direction is consistent across lengths.
  A third delivery, **native**, uses the arm's own channel instead of the goal text: Claude Code and
  Pi take the playbook through `--append-system-prompt`, Codex reads it as the `AGENTS.md` of a
  scratch working directory made for the run; Thoth and the synthetic client have no separate
  channel and fall back to preload, and the row's `skill.applied` records which path was taken. The
  measured arm variants are below. Still open: the arms' on-demand loaders (Claude Code skills
  directories, Pi skills).

  The playbook through the arms, preloaded into the goal prompt (three trials per cell; plain
  numbers from the arm table under [17]):

  | arm · model · delivery | restock3 | restock6 | restock12 | tokens at 12 |
  |---|---|---|---|---|
  | pi · gpt-4o-mini · plain | 3/3 | 2/3 | 0/3 | 232 k |
  | pi · gpt-4o-mini · preload (goal prompt) | 3/3 | **0/3** | 0/3 | **914 k** |
  | pi · gpt-4o-mini · native (`--append-system-prompt`) | 3/3 | 1/3 | 0/3 | 534 k |
  | codex · gpt-5.4-mini · plain | 2/3 | 3/3 | 3/3 | 103 k |
  | codex · gpt-5.4-mini · preload (goal prompt) | 3/3 | 3/3 | 3/3 | 170 k |
  | codex · gpt-5.4-mini · native (`AGENTS.md`) | 3/3 | 3/3 | 3/3 | 198 k |

  Readings: for the capable model the playbook removed the one collateral edit Codex made (2/3 →
  3/3 at K = 3) at about 1.5× the tokens. For the weak model inside a real agent loop it was
  harmful: Pi + gpt-4o-mini went from 2/3 to 0/3 at six items (one trial hit the 300 s timeout,
  the others made collateral edits or missed one), and at twelve it spent 914 k tokens and 64 tool
  calls per trial — four times its plain run — still leaving 5–8 items low. The playbook's
  "verify before confirming, go back and look" steps give a model that cannot do the comparison
  reliably a licence to loop; the synthetic harness's round budget capped that, Pi's loop did not.
  A skill amplifies whatever loop it lands in.
  Native delivery changes the cost more than the outcome: through Pi's system prompt the same
  playbook cost 534 k tokens at twelve instead of 914 k (still 2.3× plain) and recovered one of the
  three six-item trials; through Codex's `AGENTS.md` it matched the goal-prompt result exactly at
  a similar spend. Where the playbook sits matters less than which model reads it.

  The small-local-model question ("does a written procedure help them most?") — two Ollama models,
  four tasks with playbooks, harness mode, preload, four trials per cell, serial:

  | model | chain | transform | regex | restock3 | pooled | tokens |
  |---|---|---|---|---|---|---|
  | ornith-1.5:9b · plain | 4/4 | 3/4 | 4/4 | 4/4 | 15/16 | — |
  | ornith-1.5:9b · preload | 4/4 | 3/4 | **2/4** | 4/4 | 13/16 | +15–25 % |
  | qwen3.8:27b-mlx · plain | 4/4 | 4/4 | 4/4 | 4/4 | 16/16 | — |
  | qwen3.8:27b-mlx · preload | 4/4 | 4/4 | 4/4 | 4/4 | 16/16 | +25–35 % |

  Pooled skill delta −6 pp (97 % → 91 %, p = 0.6). Answer: no — not on these tasks, because the
  local models were not failing them (ornith even takes restock3 4/4, where gpt-4o-mini managed
  2/4). The only movement is ornith's regex, 4/4 → 2/4, with one trial producing no structured
  output at all: a longer system prompt cost the 9 B model its output discipline. Taken with the
  gpt-4o-mini and arm results, the picture for [19] is consistent — a playbook pays off in the
  narrow band where a model is sloppy on a task it can otherwise do (gpt-4o-mini at three and six
  items), is neutral where the model is already at ceiling, and is harmful where the model cannot
  execute it (inside a loop with no budget) or cannot afford the context (a small model's output
  discipline). It never substituted for a stronger model.
- **[20] Other stressors.** Distractor tools and endpoints (`regex` already carries a decoy),
  tool results that fail or come back partial so the model must retry, a long log to search (context
  length), and a budget of calls (time pressure). Each is an axis on an existing task rather than a
  new task, so the deltas stay comparable with what is already measured.
- **Decide first: which of [17]–[19] leads.** Recommendation: [17] with a small SUT extension,
  because the four arms exist and `chain` already shows the signal; [19] next, because it is cheap
  in the synthetic harness and reuses [17]'s tasks; [18] last, because it needs each arm's delegation
  driven and observed.

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

**Claude Code arm (2026-09-04).** `claude-code:<model>` runs `claude -p --bare --output-format json
--allowedTools Bash --permission-mode bypassPermissions` on the task's goal. Its JSON transcript
carries the tool outputs, so the arm recovers the webserver's replies from Bash output and
re-expresses them as the bench tools' results (`harness/util.js`), which makes `lookup` and `chain`
scorable exactly as for the synthetic harness. Live at one trial each on `claude-haiku-4-5`:
`health`, `lookup` and `chain` all passed, 3.7–7.5 s per trial, about a cent each. Two arm-specific
details worth knowing: the first curl usually fails on zsh globbing the `?` in the URL and the model
retries with quotes (a genuine harness behaviour, recorded in the tool calls), and the bench's
tool-use judge stays null for arms because it is written against the bench's own tools.

**Pi and Codex arms (2026-09-04).** Both CLIs turned out to be installed here (pi 0.85.0, codex-cli
0.153.2). `pi:<provider>/<model>` runs `pi --mode json -p --no-session -nc --tools bash` with the
bench's key for that provider passed as `--api-key` (Pi does not read `OPENAI_API_KEY` from the
environment); its `message_end` events carry tool calls, tool outputs, usage and a cost, so every
task is scorable. Live at one trial each on `openai/gpt-4o-mini`: `health`, `lookup` and `chain`
all passed in 3–5 s. `codex:<model>` runs `codex exec --json --ephemeral` with the sandbox relaxed
through `CODEX_SANDBOX_ARGS`. Once logged in (2026-09-06, API-key login), the arm ran live on its
default model `gpt-6-astra`: `health`, `lookup`, `chain` and `transform` all passed at one trial
each, 5–7 s per trial, with `--json` items exactly as documented. Two facts learned on the way:
Codex's default model exists on the plain API but **chat completions refuses function tools on it**
(it wants the Responses API), so a synthetic-harness baseline on `gpt-6-astra` is not possible and
that model is compared arms-versus-raw only; and Codex sends ~12k system-prompt tokens per turn.
`gpt-5.4-mini` runs everywhere (synthetic, Pi, Codex), so it is the model for the three-way.

Arms run structured modes only; `planMatrix` skips their free-form pairs and says so, so a mixed
run of synthetic and arm clients yields the baseline from the synthetic client and the harness rows
from every arm in one record.

**Arm dimension in the summary (2026-09-04).** `summary.delta.byArm` gives every arm its delta
against the free-form baseline of the same model from the synthetic client in the same run
(matched on the model id, provider prefix stripped); the report, the headline and the matrix show
it. "Harness X on model M vs raw M" is now a number the run computes, not a table someone assembles.

**Arm timings (2026-09-06).** Every arm's output lines are timestamped as they arrive, and each
arm reports `ttftMs` as the arrival of its first visible action and `ttfaMs` as its final answer
(event-level; Claude Code now runs with `stream-json`). One health trial each: Pi first action at
1.0 s, answer 2.0 s; Claude Code 1.9 s / 3.8 s; Codex 3.3 s / 4.2 s.

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
   Data so far says bring-your-own is enough for these tasks: three arms with only a shell reached
   the synthetic harness's correctness, and the interesting differences were tokens and time.
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
