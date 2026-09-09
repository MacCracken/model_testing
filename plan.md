# LLM Harness Benchmark — roadmap

Forward-facing only. What shipped, by date, is in [CHANGELOG.md](CHANGELOG.md); every measurement
table is in [docs/results.md](docs/results.md). This file says what the project is for, where it
stands, what the field measures that it does not, and what to build next.

## Start here (handoff, 2026-09-08)

- **Run it.** `npm test` (268 tests; no model or server needed), then `node src/cli.js serve` for
  the UI on :4000 and `node webserver/server.js` for the system under test on :3000 (`SUT_PORT`).
  Keys and `LOCAL_ENDPOINTS` live in `.env`; runs land in `results/runs/`, the SQLite index beside
  them (`node src/cli.js index --full` rebuilds it).
- **Read it.** `node src/cli.js show <run> --table` for one run (`--rows`, then `--trial <n>` for
  one trial as a timeline); `scorecard <client>`, `curve <family>`, `regressions` and `compare` for
  questions across runs; `replay <run>` to run the same instances again as a run parented to it,
  `rescore <run> | --all` to apply today's scorers to saved rows, `gate <run> --gates
  gates/nightly.json` for a verdict with an exit code (`suite nightly` runs and gates in one go).
  Every table ever quoted is in docs/results.md; the "Measured" sections of the changelog carry the
  conclusions.
- **Conventions.** This file holds open work only; an item moves to the changelog the day it
  lands, its numbers to docs/results.md; every claim is tied to a test or a saved run; zero
  runtime dependencies; the JSON run files are the source of truth and the index is rebuildable;
  a schema for a task that needs thinking has a `work` field before the answer.
- **Next**: [26] multi-turn with a scripted user. [48] and [49] collect follow-ups on shipped work
  for any spare hour. The decisions at the end are the user's; two of them block work ([27]'s sandbox, the
  hosted-model budget).
- **Environment notes.** Ollama on :11434 serves `ornith-1.5:9b` (at ceiling on the easy tool
  tasks, 100 % on restock3); `qwen3.5` is parked on its thinking output. The arms need their own
  logins (`codex login`, Claude Code, Pi); Thoth runs on the arch host (README, "Thoth"). The
  webserver keeps scenarios and logs in memory, so restarting it mid-run loses them.

## Purpose (restated 2026-09-07)

The bench exists to **measure a model's capabilities ourselves** — public and hosted models today,
and the models trained in this house tomorrow — without leaning on anyone's published numbers. Two
consequences shape everything below:

- **Our numbers or none.** A leaderboard score cannot be reproduced, cannot be re-run on a private
  checkpoint, and may be contaminated. Every capability we care about needs a task we can mint,
  run and score locally, with a p-value that is honest at the sample sizes we actually run.
- **Portions of intelligence, not one number.** "Better" has to decompose: tool use, planning over
  dependent steps, arithmetic and logic, following constraints, reading long inputs, extracting
  structure, staying consistent, knowing when it cannot. A trained checkpoint will be strong in some
  and weak in others; the bench must say which.

The original question — *what does a harness add to a model?* — stays as one lens (the four modes,
the arms, the treatments), because for the models we will train it is also the deployment
question: how much scaffolding does this checkpoint need to be useful?

Design decisions that still hold: one OpenAI-compatible client and no SDKs; tools hit real
implementations; identical scoring across modes; statistics before conclusions; zero runtime
dependencies outside Node; the JSON run files are the source of truth and the SQLite index is
rebuildable. Learned on 2026-09-07: a structured schema for a task that needs thinking must have a
`work` field before the answer, or the schema measures answering-without-thinking, not the task.

## Where we stand

| Dimension | What exists today |
|---|---|
| Tasks | 32: `health`, `hello`, `reason`, `lookup`, `regex`, `chain`, `transform`, `explain` (judged), `restock3/6/12/30` (stateful, end-state scored), the generated `wordmath2/4/6`, `datecalc1/3`, `logicgrid3/4`, `tally20/60`, the scenario-backed `fanout4/8`, `follow3/6`, `norelevant`, the long-context `needle8k/32k/100k`, and the extraction `extract1/2/3` (generated invoices and a purchase-order join with exact truth) — all minted per trial from the run's instance seed; every family with a knob carries `family` and `level` |
| Modes | `noHarness`, `harness`, `schemaOnly`, `toolOnly` — the tools × schema 2×2 |
| Models | OpenAI, Anthropic, Groq, DeepSeek, Ollama (live-probed), any named OpenAI-compatible endpoint (`LOCAL_ENDPOINTS`); real-harness arms Thoth, Claude Code, Pi, Codex; lineage per client from `models/lineage.json` |
| Treatments | client variants paired against their base: `@skill:preload/ondemand/native`, `@agents:available/required`, `@stress:flaky/budget/haystack/distractors/injected`, `@constraints:light/medium/heavy` |
| Scoring | deterministic scorers per task; truth from the trial (tool results) or the server's end state; tool-use verdicts; hijack verdicts from the op log; one judged task |
| Statistics | Fisher exact with the "inconclusive" floor, Wilson bands, 2×2 decomposition, per-arm and per-variant deltas, McNemar + bootstrap on paired instances, power guidance, Bonferroni over cells, stability (agreement, flaky cells), a capability scorecard per run and over the index, difficulty curves with breaking points, regression flags over the index (latest against earlier runs per task, checkpoint against parent) |
| Throughput | parallel trials (arms run alone), 48 trials in 8 s on a hosted model |
| Data | one JSON per run, SQLite index (`index`, `query`, `--sql`, `compact`), CSV, versions and lineage on every run, cross-run cell history, suite presets `smoke|standard|full`; every row keeps the model's turns (or an arm's raw transcript) beside its calls and results; `replay` (a new run parented to its original, paired against it), `rescore` (today's scorers over saved rows, in place), a trial as a timeline or a JSONL event log; gate verdicts on the run and in the index |
| UI | Ledger design, live grid, dumbbell matrix, capability scorecard with regression lines, difficulty curves, paired comparison block, trial drawer with transcript and children, history filter |
| SUT | the webserver: hello/health, the `/api/recent` log, inventory scenarios with tickets, confirm rules, stress profiles and op log, text logs with grep and count |
| Tests | 268, none needing a model; the webserver runs in-process |

## What the field measures that we do not

The platforms split into three layers: **harnesses** that run benchmarks (EleutherAI's
lm-evaluation-harness — the academic standard, 60+ suites, HF/vLLM backends; Stanford HELM —
multi-dimensional: accuracy, calibration, robustness, fairness, efficiency; the UK AISI's Inspect AI —
tasks = dataset + solver + scorer, built-in agents and tools, sandboxes, external agents such as
Claude Code; OpenCompass), **application frameworks** (DeepEval, Promptfoo, RAGAS — regression suites
and matrix comparisons over your own prompts), and **benchmark suites**. Three methodological trends
matter for us: the top of the old suites is saturated (GPQA Diamond at 92 %, MMLU long past useful),
the credible new suites are either expert-authored and private-graded (Humanity's Last Exam, ARC-AGI-2,
FrontierMath) or **contamination-limited by construction** (LiveBench replaces a sixth of its
questions monthly and scores everything against objective truth without a judge), and reasoning
models make scores a function of inference compute, so latency and tokens belong next to accuracy.

Our design already sits on the right side of two of those trends — every task is minted locally and
scored by code, and cost is a headline metric — but it covers a narrow slice of capability. The gaps,
with a priority for the stated purpose:

| Capability area | What the field runs | What we have | Gap | Priority |
|---|---|---|---|---|
| Tool use / function calling | BFCL v4 (AST + executable checks, parallel calls, irrelevance detection, 200 multi-turn trajectories), τ²-bench, MCP-Bench | six tool tasks, decoys, restock, stress profiles, `fanout` (parallel calls), `follow` (dependency chains), `norelevant` (irrelevance), the `injected` profile | argument-type strictness, harder near-miss irrelevance, partial-result recovery ([48]), multi-turn trajectories ([26]) | medium |
| Agentic multi-step | SWE-bench Verified, Terminal-Bench, GAIA, BrowseComp, OSWorld | restock family (3–30 steps), four real arms | other domains (files, terminal, scheduling), longer horizons, policy constraints | **high** |
| Reasoning / math | GPQA Diamond, HLE, ARC-AGI-2, FrontierMath, LiveBench math | `reason` plus the generated `wordmath`, `datecalc`, `logicgrid`, `tally` families with a calculator / date / query tool as the harness axis | harder tiers, unit conversions, spatial and ordering puzzles ([48]) | medium |
| Instruction following | IFEval (verifiable constraints), LiveBench IF | `@constraints` variants: eleven requirement families checked by code on any task, adherence beside correctness | more families (sentences, language), requirements across turns, a `@format` variant ([48]) | low |
| Long context | RULER / needle-in-a-haystack (multi-key, multi-value, aggregation) at 4 k–1 M | `needle8k/32k/100k`: single needle with recorded depth, multi-needle, aggregation; grep/count tools as the harness axis | larger sizes, a depth-sweep view, multi-hop questions ([48]) | medium |
| Structured extraction | LiveBench data analysis, enterprise extraction evals | `transform`, schema modes, the `extract` family: generated invoices with varied layouts, a line-item table, a purchase-order join, tolerance rules, injection through the document | other document kinds (tickets, statements), OCR-like noise, longer tables ([48]) | low |
| Statistics & reproducibility | HELM CIs, Inspect logs, lm-eval fixed prompts and versions | Fisher, Wilson, seeds, versions, canonical answers, index, McNemar + bootstrap on paired instances, power guidance, Bonferroni, curves, regression flags, `cli compare`, replay and re-score | lineage-pooled scorecards and trend views ([49]) | low |
| Own-model workflow | lm-eval HF/vLLM backends; W&B / MLflow tracking; per-checkpoint scoreboards | named endpoints for any OpenAI-compatible server, `docs/serving.md`, `models/lineage.json` on every run and in the index, `cli models` / `suite` / `compare --parent` / `regressions`, the UI compare block, `replay` / `rescore`, `gate` / `suite nightly` (thresholds judged on the Wilson band, exit codes, time boxes) | contamination policy ([38]) | medium |
| Coding | HumanEval → LiveCodeBench → SWE-bench | none | sandboxed execution of generated specs with hidden tests ([27]) | medium (needs a sandbox decision) |
| Calibration & abstention | HELM calibration (ECE); "answer or abstain" splits | hedge detection in one scorer, `norelevant`'s unanswerable half | confidence elicitation, Brier/ECE per cell, unanswerable variants everywhere ([28]) | medium |
| Robustness / consistency | HELM perturbations; paraphrase suites | agreement, flaky cells, stressors | paraphrase and ordering perturbations minted by generators ([29]) | medium |
| Multi-turn & user simulation | τ²-bench user simulator, MT-Bench | single-turn goals | scripted user turns driven by scenario state ([26]) | medium |
| Safety for agents | AgentDojo (prompt injection through tool results), over-refusal suites | the `injected` stress profile (two payloads, hijack verdicts), and injection through a document (`extract` under `@stress:injected`) | over-refusal on benign borderline tasks | medium |
| Preference / open-ended | LMArena, Arena-Hard-Auto (pairwise judge, Bradley-Terry) | absolute judge score on one task | position-swapped pairwise judging, ratings, judge calibration against human labels ([30]) | low–medium |
| Knowledge / factuality | MMLU-Pro, SimpleQA, HLE | none, by design | only open-book (facts served by the SUT) — closed-book knowledge is the most contaminated axis and the least ours | low |
| Multimodal | MMMU and successors | none | out of scope unless the trained models are multimodal | low |
| Cost | tokens everywhere, currency in some | tokens, latency, TTFT | a price table → cost per correct answer ([45]) | low (easy) |

## Roadmap

Numbers are stable across this file, the changelog and the results. [1]–[25], [31]–[37] and [39]
have shipped and are described in the changelog; only open work is listed here.

### Tier 8 — Capability families by generator

Principles for every family: a **generator** takes a seed and a difficulty and mints an instance
with its truth; a **scorer in code** decides; a **difficulty knob** exists so success can be drawn
against it (`family` / `level` on the task, which the curves read); seeds are private, so nothing
here can leak into a training set we do not control; the LLM judge is used only where no code can
decide; every family declares the capabilities it measures and runs in the four modes where they
mean something; a structured schema carries `work` before the answer.

- **[26] Multi-turn with a scripted user.** The SUT plays the user from a scenario script —
  information revealed over turns, a change of mind mid-job — with τ²-style policy constraints
  ("never restock above target") whose violations are scored.
- **[27] Code execution.** Generated function specs with hidden tests, executed in isolation
  (worker threads with limits, or a container — see decisions); repository-scale tasks later.
- **[28] Calibration and abstention.** A stated confidence with every answer → Brier score and ECE
  per cell; generators mint unanswerable variants so abstention is rewarded over fabrication (the
  `lookup` refuse-versus-fabricate split and `norelevant`'s unanswerable half, made systematic).
- **[29] Robustness perturbations.** Paraphrase, ordering and format perturbations minted by the
  generators; consistency across perturbations as a metric beside agreement.
- **[30] Pairwise mode for open-ended tasks.** Position-swapped pairwise judging with Bradley-Terry
  ratings across models; the judge calibrated against a small human-labelled set before it is trusted.
- **[48] Follow-ups on the shipped families.** Generators: unit conversions, spatial and ordering
  puzzles, harder tiers once the current ones saturate (Haiku 4.5 already sits at ceiling on most).
  Constraints: a `@format` variant that strips or adds the `work` field on any schema so the format
  axis runs on demand; language and length-in-sentences families; requirements composed across
  turns. Long context: sizes past 100 k for models that take them, a depth-sweep view over the
  recorded needle depths, multi-hop questions (a line that refers to a second line). Tool breadth:
  argument-type strictness (a tool whose server rejects wrong types), near-miss irrelevance
  (questions about fields that almost exist), recovery from partial results.

### Tier 9 — Scorecards and the statistics of judgment

- **[49] Scorecard and trend views.** A radar per model; the scorecard pooled by lineage family
  across checkpoints; a sparkline per capability from the series behind `cli trend`; regression
  flags delivered somewhere other than the report (a file CI reads, or a webhook); a lineage graph
  in the UI.

### Tier 10 — Own-model workflow

- **[38] Contamination policy.** Private seed pools per training generation, a "minted after
  checkpoint" flag on instances, seeds never published, and an optional hook that hashes our
  instances against a training corpus before a run is trusted.

### Tier 11 — Public benchmarks run locally, as anchors

- **[40] A bridge to Inspect AI or lm-evaluation-harness.** Run selected public sets ourselves
  (GSM8K / MATH subsets, IFEval, GPQA Diamond, BFCL subsets, RULER) against the same endpoint through a
  subprocess, import the results into the index tagged `source: public`. They anchor our generators'
  difficulty to known scales; they are never the headline, and their contamination caveat is recorded
  with them.
- **[41] Native mini-anchors** if the bridge is too heavy: small dependency-free reimplementations
  (IFEval constraint checkers, GSM8K-style items).

### Tier 12 — Harness work still open

- **[42]** Arms' native sub-agents (Pi, Codex, Thoth) and forcing Claude Code's Agent tool the way
  `required` forces the synthetic parent; arms' on-demand skill loaders.
- **[43]** Shared tools for every arm through MCP, labelled, next to bring-your-own.
- **[44]** Thoth's tool access (an operator decision) and running the bench beside hoosh on arch.
- **[45]** Cost in currency: a provider price table → cost per trial and per correct answer; a
  correctness × cost × latency view.
- **[46]** Providers: Gemini (OpenAI-compatible route), Mistral, xAI; a reasoning-effort knob per
  provider (the qwen3.5 thinking problem).
- **[47]** Variance across settings (the old [16]): agreement at temperature 0 versus default, flake
  rate over time, canonical answers for `transform` and `chain`.

## Decisions needed

1. **Order for the next month.** Recommendation: [26] multi-turn, with [48] and [49] as fill-in.
2. **Code sandbox.** Worker-thread isolation keeps the zero-dependency rule but is weaker; Docker is
   stronger and a dependency. This gates [27].
3. **Scope of knowledge and safety.** Exclude closed-book knowledge as an axis? Add over-refusal on
   benign borderline tasks? (Injection through tool output is built, as the `injected` profile.)
4. **Serving stack for trained checkpoints** (vLLM, llama.cpp, MLX) — decides which recipe in
   docs/serving.md gets exercised first and which endpoint the suite presets default to.
5. **Hosted-model budget** for standing matrices, and the Tier 5 leftovers: the cross-harness model
   set, and Thoth's tool policy.

## Sources (read 2026-09-07)

Frameworks: [MLflow, LLM evaluation frameworks explained](https://mlflow.org/articles/llm-evaluation-frameworks-explained-for-ai-practitioners/) ·
[DeepEval, top 5 frameworks 2026](https://deepeval.com/blog/top-5-llm-evaluation-frameworks) ·
[Inference.net, evaluation tools compared 2026](https://inference.net/content/llm-evaluation-tools-comparison/) ·
[Inspect AI](https://inspect.aisi.org.uk/) ·
Contamination: [LiveBench paper](https://livebench.ai/livebench.pdf), [LiveBench repository](https://github.com/livebench/livebench),
[benchmark methodology and leaderboards 2026](https://www.digitalapplied.com/blog/llm-benchmark-methodology-2026-contamination-leaderboard-guide) ·
Tool use: [BFCL V4 leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html), [BFCL paper (ICML 2025)](https://proceedings.mlr.press/v267/patil25a.html) ·
Agents: [AI agent benchmarks 2026](https://www.layer3labs.io/guides/ai-agent-benchmarks), [agent benchmarking infrastructure guide](https://www.spheron.network/blog/ai-agent-benchmarking-gpu-cloud-swebench-gaia/) ·
Frontier reasoning: [AI benchmarks 2026 and their limits](https://kili-technology.com/blog/ai-benchmarks-guide-the-top-evaluations-in-2026-and-why-theyre-not-enough),
[reasoning benchmarks 2026](https://benchmarkingagents.com/best-benchmarks-for-reasoning/), [HLE leaderboard](https://labs.scale.com/leaderboard/humanitys_last_exam) ·
Long context: [needle-in-a-haystack 2026](https://www.digitalapplied.com/blog/long-context-retrieval-needle-in-haystack-2026) ·
Own models: [fine-tuning pipeline evaluation 2026](https://futureagi.com/blog/fine-tuning-pipeline-evaluation-2026/), [LLM evaluation for fine-tuning](https://labelyourdata.com/articles/llm-fine-tuning/llm-evaluation) ·
Earlier harness sources (Terminal-Bench 2.0, openbench, Databricks, Pi / Claude Code / Codex docs) are in the git history of this file at commit 60208ae.
