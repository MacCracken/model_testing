# LLM Harness Benchmark — roadmap

Forward-facing only. What shipped, by date, is in [CHANGELOG.md](CHANGELOG.md); every measurement
table is in [docs/results.md](docs/results.md). This file says what the project is for now, what it
has, what the field measures that it does not, and what to build next.

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
rebuildable. One learned this week: a structured schema for a task that needs thinking must have a
`work` field before the answer, or the schema measures answering-without-thinking, not the task.

## Where we stand

| Dimension | What exists today |
|---|---|
| Tasks | 26: `health`, `hello`, `reason`, `lookup`, `regex`, `chain`, `transform`, `explain` (judged), `restock3/6/12/30` (stateful, end-state scored), the generated `wordmath2/4/6`, `datecalc1/3`, `logicgrid3/4`, `tally20/60`, and the scenario-backed `fanout4/8`, `follow3/6`, `norelevant` (all minted per trial from the run's instance seed) |
| Modes | `noHarness`, `harness`, `schemaOnly`, `toolOnly` — the tools × schema 2×2 |
| Models | OpenAI, Anthropic, Groq, DeepSeek, Ollama (live-probed); real-harness arms Thoth, Claude Code, Pi, Codex |
| Treatments | client variants paired against their base: `@skill:preload/ondemand/native`, `@agents:available/required`, `@stress:flaky/budget/haystack/distractors`, `@constraints:light/medium/heavy`; stress adds `injected` (prompt injection through tool output) |
| Scoring | deterministic scorers per task; truth from the trial (tool results) or the server's end state; tool-use verdicts; one judged task |
| Statistics | Fisher exact with the "inconclusive" floor, Wilson bands, 2×2 decomposition, per-arm and per-variant paired deltas, stability (agreement, flaky cells) |
| Throughput | parallel trials (arms run alone), 48 trials in 8 s on a hosted model |
| Data | one JSON per run, SQLite index (`index`, `query`, `--sql`, `compact`), CSV, versions on every run, cross-run cell history |
| UI | Ledger design, live grid, dumbbell matrix, trial drawer with transcript and children, history filter |
| SUT | the webserver: hello/health, the `/api/recent` log, inventory scenarios with tickets, confirm rules, stress profiles, op log |
| Tests | 217, none needing a model; the webserver runs in-process |

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
| Tool use / function calling | BFCL v4 (AST + executable checks, parallel calls, irrelevance detection, 200 multi-turn trajectories), τ²-bench, MCP-Bench | six tool tasks, decoys, restock, stress profiles, `fanout` (parallel calls), `follow` (dependency chains), `norelevant` (irrelevance), the `injected` profile | argument-type strictness, harder near-miss irrelevance, partial-result recovery, multi-turn trajectories | medium (was high) |
| Agentic multi-step | SWE-bench Verified, Terminal-Bench, GAIA, BrowseComp, OSWorld | restock family (3–30 steps), four real arms | other domains (files, terminal, scheduling), longer horizons, policy constraints | **high** |
| Reasoning / math | GPQA Diamond, HLE, ARC-AGI-2, FrontierMath, LiveBench math | `reason` plus the generated `wordmath`, `datecalc`, `logicgrid`, `tally` families with a calculator / date / query tool as the harness axis | harder tiers, unit conversions, spatial and ordering puzzles | medium (was high) |
| Instruction following | IFEval (verifiable constraints), LiveBench IF | `@constraints` variants: eleven requirement families checked by code on any task, adherence beside correctness | more families (sentences, language), requirements across turns, a `@format` variant | low (was high) |
| Long context | RULER / needle-in-a-haystack (multi-key, multi-value, aggregation) at 4 k–1 M | haystack of 60 items (a few k tokens) | generated logs at 8 k–128 k, position sweeps, aggregation, a search tool as the harness axis | high |
| Structured extraction | LiveBench data analysis, enterprise extraction evals | `transform`, schema modes | generated documents with exact truth, joins across two sources | medium |
| Statistics & reproducibility | HELM CIs, Inspect logs, lm-eval fixed prompts and versions | Fisher, Wilson, seeds, versions, canonical answers, index | paired designs across checkpoints, bootstrap CIs on aggregates, power guidance, multiple-comparison flags | **high** (for own models) |
| Own-model workflow | lm-eval HF/vLLM backends; W&B / MLflow tracking; per-checkpoint scoreboards | Ollama through the OpenAI route | serving recipes, model lineage, checkpoint compare, suites and gates, contamination policy | **high** |
| Coding | HumanEval → LiveCodeBench → SWE-bench | none | sandboxed execution of generated specs with hidden tests | medium (needs a sandbox decision) |
| Calibration & abstention | HELM calibration (ECE); "answer or abstain" splits | hedge detection in one scorer | confidence elicitation, Brier/ECE per cell, unanswerable variants | medium |
| Robustness / consistency | HELM perturbations; paraphrase suites | agreement, flaky cells, stressors | paraphrase and ordering perturbations minted by generators | medium |
| Multi-turn & user simulation | τ²-bench user simulator, MT-Bench | single-turn goals | scripted user turns driven by scenario state | medium |
| Safety for agents | AgentDojo (prompt injection through tool results), over-refusal suites | none | injection as a stress profile; over-refusal on benign borderline tasks | medium (injection) |
| Preference / open-ended | LMArena, Arena-Hard-Auto (pairwise judge, Bradley-Terry) | absolute judge score on one task | position-swapped pairwise judging, ratings, judge calibration against human labels | low–medium |
| Knowledge / factuality | MMLU-Pro, SimpleQA, HLE | none, by design | only open-book (facts served by the SUT) — closed-book knowledge is the most contaminated axis and the least ours | low |
| Multimodal | MMMU and successors | none | out of scope unless the trained models are multimodal | low |
| Cost | tokens everywhere, currency in some | tokens, latency, TTFT | a price table → cost per correct answer | low (easy) |

## Roadmap

Items continue the numbering from the shipped tiers ([1]–[20], see the changelog).

### Tier 8 — Capability families by generator

Principles for every family: a **generator** takes a seed and a difficulty and mints an instance
with its truth; a **scorer in code** decides; a **difficulty knob** exists so success can be drawn
against it (the restock lengths are the prototype); seeds are private, so nothing here can leak into
a training set we do not control; the LLM judge is used only where no code can decide; every family
declares the capability it measures and runs in the four modes where they mean something.

- **[21] Reasoning and arithmetic generators.** Shipped 2026-09-07 (see the changelog): `wordmath`,
  `datecalc`, `logicgrid`, `tally`, instance seeds and capability tags. Left for later: unit
  conversions, spatial/ordering puzzles, and harder difficulty tiers once the current ones saturate.
- **[22] Instruction-following constraints and format effects.** Shipped 2026-09-07 (see the
  changelog): `@constraints:light|medium|heavy` with eight free-form and three JSON requirement
  families checked by code, adherence beside the correctness delta; the format-effects measurement
  (answer-only versus answer-with-`work` schemas) is in docs/results.md. Left for later: a `@format`
  variant that strips or adds the `work` field on any schema so the axis can be run on demand,
  language and length-in-sentences families, and requirements composed across turns.
- **[23] Long-context retrieval and aggregation.** Generated logs and records served by the SUT
  (`GET /api/logs?scenario=…`) or inlined, from 8 k to 128 k tokens; single and multi needle, a
  position sweep, aggregation (count / sum over matches); with and without a search tool, so the
  harness delta on long context is its own number.
- **[24] Structured extraction from generated documents.** Invoices, tickets and tables with known
  truth → JSON under a schema; joins across two documents; tolerance rules for numbers and dates.
- **[25] Tool-use breadth.** Shipped 2026-09-08 (see the changelog): `fanout4/8` (parallel-call
  correctness, with the verdict reading rounds), `follow3/6` (dependency chains), `norelevant`
  (irrelevance detection with an answerable half), and the `injected` stress profile (instructions
  inside tool output, scored as a hijack). Left for later: argument-type strictness (a tool whose
  server rejects wrong types), a harder irrelevance set (near-miss questions about fields that
  almost exist), and recovery from partial results.
- **[26] Multi-turn with a scripted user.** The SUT plays the user from a scenario script —
  information revealed over turns, a change of mind mid-job — with τ²-style policy constraints
  ("never restock above target") whose violations are scored.
- **[27] Code execution.** Generated function specs with hidden tests, executed in isolation
  (worker threads with limits, or a container — see decisions); repository-scale tasks later.
- **[28] Calibration and abstention.** A stated confidence with every answer → Brier score and ECE
  per cell; generators mint unanswerable variants so abstention is rewarded over fabrication (the
  `lookup` refuse-versus-fabricate split, made systematic).
- **[29] Robustness perturbations.** Paraphrase, ordering and format perturbations minted by the
  generators; consistency across perturbations as a metric beside agreement.
- **[30] Pairwise mode for open-ended tasks.** Position-swapped pairwise judging with Bradley-Terry
  ratings across models; the judge calibrated against a small human-labelled set before it is trusted.

### Tier 9 — Scorecards and the statistics of judgment

- **[31] Capability map and scorecard.** Every task and family tagged with the capabilities it
  measures; per-capability aggregates with Wilson or bootstrap bands; one scorecard per model in the
  UI and `node src/cli.js scorecard <model>` pooling the index across runs.
- **[32] Difficulty curves.** Success versus the family's knob; a model's *breaking point* is the
  first difficulty where the band's upper bound falls under 50 %.
- **[33] Paired comparisons.** The same seeds against two models or two checkpoints → McNemar's test
  on paired outcomes (far more power than two independent proportions), bootstrap intervals on
  aggregate deltas, power guidance ("to see Δ = 20 pp at 80 % power run n ≈ …"), and a
  multiple-comparisons flag when a run has many cells.
- **[34] Trend and regression detection.** Per capability per model over time from the index; an
  alert when a checkpoint falls below its parent by more than the band.

### Tier 10 — Own-model workflow

- **[35] Serving recipes.** vLLM, llama.cpp server, MLX server and Ollama Modelfiles, all through the
  OpenAI-compatible route; the `local` provider generalized to named local endpoints.
- **[36] Model registry and lineage.** A model id maps to family, checkpoint or step, parent, training
  data tag and date; recorded on every run; the index groups by lineage; a checkpoint-versus-parent
  compare view built on [33].
- **[37] Suites and gates.** `bench suite smoke|standard|full` presets that are time-boxed; `--gate`
  thresholds per capability with exit codes, so a checkpoint can fail CI; a nightly definition.
- **[38] Contamination policy.** Private seed pools per training generation, a "minted after
  checkpoint" flag on instances, seeds never published, and an optional hook that hashes our
  instances against a training corpus before a run is trusted.
- **[39] Replay.** `bench replay <run>` re-runs a saved run's exact instances (seeds, prompts,
  generator versions) against a new model — the paired design in one command.

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
- **[46]** Providers: Gemini (OpenAI-compatible route), Mistral, xAI, local vLLM; a reasoning-effort
  knob per provider (the qwen3.5 thinking problem).
- **[47]** Variance across settings (the old [16]): agreement at temperature 0 versus default, flake
  rate over time, canonical answers for `transform` and `chain`.

## Decisions needed

1. **Order for the next month.** [21], [22] and [25] are done; recommendation for the rest:
   [31]/[33] scorecards and paired statistics, then [35]/[36] own-model plumbing before the first
   trained checkpoint exists, then [23] long context.
2. **Code sandbox.** Worker-thread isolation keeps the zero-dependency rule but is weaker; Docker is
   stronger and a dependency. This gates [27].
3. **Scope of knowledge and safety.** Exclude closed-book knowledge as an axis? Include tool-result
   injection and over-refusal?
4. **Serving stack for trained checkpoints** (vLLM, llama.cpp, MLX) — decides which recipe in [35]
   is written first.
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
