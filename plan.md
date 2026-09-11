# LLM Harness Benchmark — roadmap

Forward-facing only. What shipped, by date, is in [CHANGELOG.md](CHANGELOG.md); every measurement
table is in [docs/results.md](docs/results.md). This file says what the project is for, where it
stands, what the field measures that it does not, and what is left — reviewed on 2026-09-21, when
[27] (the last built item of the original roadmap) landed together with the network endpoints and
the reactive user.

## Start here (handoff, 2026-09-21)

- **Run it.** `npm test` (433 tests; no model or server needed), then `node src/cli.js serve` for
  the UI on :4000 and `node webserver/server.js` for the system under test on :3000. The webserver
  listens on `PORT` (the desktop app injects it for a preview); the bench reads the server's port
  from `SUT_PORT` — for a long background run start a private copy with `PORT=3001 node
  webserver/server.js` and run the bench with `SUT_PORT=3001`, so the app's preview lifecycle
  cannot kill it mid-run. Keys and `LOCAL_ENDPOINTS` live in `.env`; runs land in `results/runs/`,
  the SQLite index beside them (`node src/cli.js index --full` rebuilds it); `node src/cli.js
  anchors fetch all` pulls the public sets into `anchors/` before the anchor tasks can run.
- **Read it.** `node src/cli.js show <run> --table` for one run (it prints where the models were
  served from; `--rows`, then `--trial <n>` for one trial as a timeline); across runs `scorecard
  <client>` (`--svg` for the radar, `--family` for a lineage line), `curve <family>`, `variance
  --client <c>` (agreement per instance under each temperature, `--over-time` per run), `trend`,
  `regressions` (`--out`, `--webhook`, `--fail` for CI), `cost <run>`, `anchors <client>`, `models
  --graph`, `compare`; `replay <run>` runs the same instances again as a run parented to it,
  `rescore <run> | --all` applies today's scorers to saved rows in place, `gate <run> --gates
  gates/nightly.json` gives a verdict with an exit code (`suite nightly` runs and gates in one go).
  `probe <endpoint>` lists what a host serves, `probe <endpoint:model>` says whether it is ready
  for a harness run, `list` shows every provider live. Every table ever quoted is in
  docs/results.md; the "Measured" sections of the changelog carry the conclusions.
- **Conventions.** This file holds open work only; an item moves to the changelog the day it
  lands, its numbers to docs/results.md; every claim is tied to a test or a saved run; zero
  runtime dependencies; the JSON run files are the source of truth and the index is rebuildable;
  a schema for a task that needs thinking has a `work` field before the answer; a treatment is
  a client variant (`<client>@<kind>[:<how>]`) paired against its base by `summarize`; a family's
  base rendering never changes once its seeds are in saved runs (perturbations re-render from
  recorded structure); every new task or treatment is run on the local models as well as the
  hosted ones (a laptop is steadier one request at a time, and nothing in the bench limits a local
  run either way — the rows record the machine's thermal state instead).
- **In flight.** A background queue started on 2026-09-21 is running the five Ollama models
  (`ornith-1.5:9b`, `gemma4:12b-mlx`, `qwen3.5:9b-mlx`, `qwen3.8:27b-mlx`, `gemma4:31b-mlx`) on
  the families they had never run — `restock3/6/12`, `fanout4/8`, `follow3/6`, `norelevant`,
  `paged6`, `typed`, `needle8k/32k`, `dialogue2/3/4`, and `logicgrid3/4` / `extract3/4` for the
  four mlx models — then `code1/2/3` and `clarify2/3` on each (seed 2026, four trials per cell,
  one at a time; the two smaller models with `--effort none`, which they need to finish). Each
  job saves a normal run, so the results are in `results/runs/` whether or not the queue is still
  alive. What is owed when they land: the local columns on `cli curve code`, `cli curve clarify`
  and the other families, and a table per family in docs/results.md beside the hosted ones (the
  hosted `code` and `clarify` tables are there already); replay any cell the daemon dropped
  (`--replay <id> --task …`), and treat a burst of timeouts as the laptop's heat (the rows say).
- **Next.** Nothing is left to build without a decision or an external channel; the review below
  says what each remaining item needs. The price-table upkeep in [51] is the user's. [48]'s
  follow-ups wait for a tier to saturate — and the local runs above are what will show which
  tier does.
- **Environment notes.** Ollama 0.33 on :11434 serves the five models above (`ornith-1.5:9b` is a
  9 B thinking model whose reasoning switches off only through `reasoning: { effort: "none" }` on
  the OpenAI route — `think: false`, `reasoning_effort` and `/no_think` do nothing there; the two
  9–12 B mlx models time out with thinking on and finish with `--effort none`). llama.cpp is
  installed as the unified `llama` binary (`~/.local/bin/llama`, build 10679: `llama serve`, jinja
  on by default, `reasoning_effort` honoured per request, `--api-key`, a router mode over a models
  directory) and serves ornith's GGUF straight from Ollama's blob store; the bench reached it over
  the laptop's LAN address with a key, which is the path a desktop host will take — the user's
  target is model hosts elsewhere on the network. The arms need their own logins (`codex login`,
  Claude Code, Pi); Thoth runs on the arch host (README, "Thoth"); Pi has no MCP flag, so it stays
  bring-your-own. The webserver keeps scenarios, logs and documents in memory, so restarting it
  mid-run loses them — and the desktop app stops preview servers on its own, which once turned 96
  server-backed trials into error rows (hence the private copy above; replay the affected tasks
  with `--replay <id> --task …`). On this laptop a second request in flight doubles the heat and
  macOS lowers the clocks; a desktop holds them. `models/prices.json` holds four prices as of
  2026-09-11 that the bench cannot verify; a model without an entry runs unpriced and the cost
  view says so.

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
Learned since: the harness delta changes sign with difficulty (the calculator costs gpt-4o-mini 14
points on GSM8K and lifts it 38 on the bench's own arithmetic); with a tool in hand the models
fabricate answers to unanswerable problems they abstain on in prose; a stated confidence from
gpt-4o-mini is 1.0 whatever the outcome; agreement is only meaningful per instance; a JSON box
with no room to think costs code as it costs sums; a test tool runs what the model asks it to
run, so passing examples say nothing about the edges; asking which item is meant is not the hard
part, keeping the state straight afterwards is; the weights decide the answers, not the runtime
that serves them.

## Where we stand (2026-09-21)

| Dimension | What exists today |
|---|---|
| Tasks | 60: `health`, `hello`, `reason`, `lookup`, `regex`, `chain`, `transform`, `explain` (judged), `restock3/6/12/30` (stateful, end-state scored), the generated `wordmath2/4/6`, `convert1/2/3/4`, `datecalc1/3`, `logicgrid3/4`, `lineup4/6`, `tally20/60`, `code1/2/3` (hidden tests in a sandbox), the scenario-backed `fanout4/8`, `follow3/6`, `toolpick6/13`, `norelevant`, `nearmiss`, `paged3/6`, `typed`, the long-context `needle8k/32k/100k` and `needlehop8k/32k/100k`, the extraction `extract1/2/3/4`, the multi-turn `dialogue2/3/4` (a scripted user) and `clarify2/3` (a user who reacts), and the public anchors `gsm8k`, `ifeval`, `bfclsimple`, `bfclmultiple` (`source: public`, never pooled with the rest) — everything but the anchors minted per trial from the run's instance seed; every family with a knob carries `family` and `level`; wordmath, tally, datecalc, fanout and follow (tool modes), extract1 and extract2 mint unanswerable variants, and those plus logicgrid, extract3/4, restock and dialogue mint perturbations; every scenario-backed family is minted from the trial seed |
| Modes | `noHarness`, `harness`, `schemaOnly`, `toolOnly` — the tools × schema 2×2 |
| Models | OpenAI, Anthropic, Groq, DeepSeek, Gemini, Mistral, xAI (the last three probed from their routes when keyed; untested here), Ollama (live-probed), any named OpenAI-compatible endpoint on any host (`LOCAL_ENDPOINTS`, a key per endpoint from `<NAME>_API_KEY`, probed on its own address, recorded on every run as `config.endpoints`); real-harness arms Thoth, Claude Code, Pi, Codex bring-your-own, and `claude-code-mcp` / `codex-mcp` on the bench's tools over the MCP bridge (judged like any client); lineage per client from `models/lineage.json`; prices from `models/prices.json` |
| Treatments | client variants paired against their base: `@skill:preload/ondemand/native` (on demand reaches the MCP arms), `@agents:available/required` (Claude Code's Agent tool with a worker carrying the bench's tools), `@stress:flaky/budget/haystack/distractors/injected`, `@constraints:light/medium/heavy`, `@format:nowork/work`, `@effort:none…high` (translated per provider; reasoning characters recorded), `@confidence` (Brier, ECE, the gap), `@abstain` (half the instances unanswerable: abstained / fabricated / refused), `@perturb:paraphrase/order/format/typos` (consistency beside the delta); `--effort` as a run-level knob |
| Scoring | deterministic scorers per task; truth from the trial (tool results), the server's end state, or hidden tests run in the sandbox; tool-use verdicts (also for arms on shared tools); hijack verdicts from the op log; the abstention verdict; the conduct verdict of the reactive user (asked before writing); one judged task; the IFEval and BFCL checks reimplemented for the anchors, with the approximate parts marked |
| Sandbox | `src/sandbox.js`: a child Node process under the permission model (no file system, child processes, workers, addons or network), heap and clock capped, the candidate in a bare realm no host object enters; a verdict in about 25 ms; zero dependencies |
| Statistics | Fisher exact with the "inconclusive" floor, Wilson bands, 2×2 decomposition, per-arm and per-variant deltas with consistency, McNemar + bootstrap on paired instances, power guidance, Bonferroni over cells, stability per instance (agreement, flaky instances, variance by setting and over time), calibration (Brier, ECE), a capability scorecard per run and over the index (and per lineage family), difficulty curves with breaking points and the depth sweep, regression flags over the index delivered to a file or a webhook, gates with exit codes |
| Cost | tokens, latency, TTFT/TTFA, dollars per trial and per correct answer from the price table, the correctness × cost × latency view; the machine's thermal state on every local row |
| Throughput | parallel trials (arms run alone), 48 trials in 8 s on a hosted model; a 90-minute time box on the nightly suite; a one-at-a-time queue for local runs (a shell loop over bench commands — nothing in the bench) |
| Data | one JSON per run, SQLite index (`index`, `query`, `--sql`, `compact`; `source`, `cost_usd`, `effort`, `depth`, lineage per trial), CSV and JSONL export, versions, lineage and serving hosts on every run, cross-run cell history, suite presets `smoke|standard|full|nightly`; every row keeps the model's turns (or an arm's raw transcript) beside its calls and results; `replay` and `rescore`; the anchor cache with provenance |
| UI | Ledger design, a setup panel with every treatment and the A/B convention, live grid, headline with a column per treatment, tools × schema 2×2, cost, calibration and abstention blocks, capability scorecard with radars, sparklines and regression lines, lineage graph, difficulty curves with the depth sweep, paired comparison block, dumbbell matrix, trial drawer with transcript, dialogue turns and children, replay button, history filter (restart `serve` to pick up new task families) |
| SUT | the webserver: hello/health, the `/api/recent` log, inventory scenarios with tickets, confirm rules (refused while anything is low), stress profiles, pagination, strict types, a dead-end pointer and an op log, text logs with grep and count, documents |
| Tests | 433, none needing a model; the webserver runs in-process; the sandbox tests spawn child Node processes |

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

Our design sits on the right side of all three — every task is minted locally and scored by code,
cost and reasoning volume are headline metrics, and the public sets run here only as anchors —
and by now covers most of the capability slice it set out to. The gaps that remain, with a
priority for the stated purpose:

| Capability area | What the field runs | What we have | Gap | Priority |
|---|---|---|---|---|
| Tool use / function calling | BFCL v4 (AST + executable checks, parallel calls, irrelevance detection, multi-turn), τ²-bench, MCP-Bench | six tool tasks, decoys, restock, stress profiles, `fanout`, `follow`, `toolpick` (near-duplicate tools), `norelevant` and `nearmiss`, `paged`, `typed`, the `injected` profile, `dialogue`, the BFCL anchors, arms on shared tools with verdicts | a harder `typed` once a model trips the current one ([48]) | low |
| Agentic multi-step | SWE-bench Verified, Terminal-Bench, GAIA, BrowseComp, OSWorld | restock family (3–30 steps), the `dialogue` and `clarify` families, four real arms, two of them on the bench's tools, the `code` family's test-and-fix loop | other domains (files, terminal, scheduling), longer horizons | medium |
| Reasoning / math | GPQA Diamond, HLE, ARC-AGI-2, FrontierMath, LiveBench math | `reason`, the generated `wordmath`, `convert`, `datecalc`, `logicgrid`, `lineup`, `tally` families with a tool or the structured mode as the harness axis, GSM8K as the anchor | harder tiers as models saturate ([48]) | medium |
| Instruction following | IFEval, LiveBench IF | `@constraints` (twelve families, stated once across a dialogue), `@format`, IFEval itself as the anchor | a language family ([48]) | low |
| Long context | RULER at 4 k–1 M | `needle8k/32k/100k`, `needlehop8k/32k/100k`, the depth sweep | sizes past 100 k for models that take them ([48]) | medium |
| Structured extraction | LiveBench data analysis, enterprise extraction evals | `transform`, the `extract` family with four tiers and injection through the document | other document kinds, OCR-like noise, multi-page tables ([48]) | low |
| Statistics & reproducibility | HELM CIs, Inspect logs, lm-eval fixed prompts | everything in the table above | nothing until the house checkpoints arrive | — |
| Own-model workflow | lm-eval backends; W&B / MLflow; per-checkpoint scoreboards | named endpoints on any host, with a key, probed and recorded on every run; `docs/serving.md` (llama.cpp exercised over the LAN); lineage, `models` / `suite` / `compare --parent` / `regressions` / `gate`, the family scorecard and the lineage graph | contamination policy ([38]); the first real checkpoint | medium |
| Coding | HumanEval → LiveCodeBench → SWE-bench | the `code` family: twelve seeded kinds over three levels, hidden tests in a sandbox (a child Node process under the permission model), `run_tests` as the harness axis | a fourth level once a model clears the third (both hosted models sit at 3/4); repository-scale tasks would need a container | low |
| Calibration & abstention | HELM calibration; answer-or-abstain splits | `@confidence` (Brier, ECE, gap), `@abstain` on six families (three generated; fanout and follow in the tool modes; extract1 and extract2), `norelevant` / `nearmiss` | unanswerable variants for the join and the statement (`extract3/4`), `restock` ([48]) | low |
| Robustness / consistency | HELM perturbations; paraphrase suites | agreement per instance, variance by setting, `@perturb` (paraphrase, order, format, typos) on nine families with consistency | — | low |
| Multi-turn & user simulation | τ²-bench user simulator, MT-Bench | the `dialogue` family with a scripted user and policy verdicts; the `clarify` family with a user who reacts to what the model did | longer scripts, a user who reacts across more turns, arms through their session channels ([42]) | low |
| Safety for agents | AgentDojo, over-refusal suites | the `injected` profile (two payloads, hijack verdicts), injection through a document | over-refusal on benign borderline tasks (decision 3) | medium |
| Preference / open-ended | LMArena, Arena-Hard-Auto (pairwise, Bradley-Terry) | one absolute judge score | position-swapped pairwise judging, ratings, judge calibration against human labels ([30]) | low |
| Knowledge / factuality | MMLU-Pro, SimpleQA, HLE | none, by design | open-book only — closed-book knowledge is the most contaminated axis and the least ours | low |
| Multimodal | MMMU and successors | none | out of scope unless the trained models are multimodal | low |
| Public anchors | lm-eval / Inspect on the standard sets | GSM8K, IFEval, BFCL simple and multiple run natively with provenance and the caveat | MATH, GPQA Diamond, RULER through a log import ([40]) | low |

## Open work, reviewed (2026-09-21)

Numbers are stable across this file, the changelog and the results: [1]–[29], [31]–[37], [39],
[41], [43], [45]–[47], [49] and [50] have shipped and are described in the changelog. What
follows is everything left, each with what it needs and a recommendation.

### Gated by a decision

- **[30] Pairwise mode for open-ended tasks.** Position-swapped pairwise judging with Bradley-Terry
  ratings across models. *Needs:* a small human-labelled set (about fifty pairs) before the judge
  is trusted, and more than one judged task to be worth the machinery (`explain` is the only one).
  *Recommendation:* leave until a second open-ended family exists; the mechanics are a day's work
  once the labels are there.
- **[38] Contamination policy.** Private seed pools per training generation, a "minted after
  checkpoint" flag on instances, seeds never published, and an optional hook that hashes our
  instances against a training corpus before a run is trusted. *Needs:* the first house checkpoint
  and a decision on how training generations are named. *Buildable now without the decision:* the
  `mintedAfter` flag on instances (the run's `createdAt` against a checkpoint date from the
  lineage registry) and a private seed-pool file the suite presets draw from. *Recommendation:*
  build those two parts the week the first checkpoint is served; the corpus hash waits for a corpus.

### Waiting on an external channel

- **[40] Importing Inspect AI / lm-evaluation-harness logs** as public runs (`source: public`,
  the same caveat), for the sets the native anchors do not cover (MATH, GPQA Diamond — gated —
  RULER at scale). *Needs:* real logs to write the reader against; neither tool is installed here.
  *Recommendation:* when a MATH or GPQA anchor is wanted, install Inspect in a virtualenv, run one
  small eval against `openai:gpt-4o-mini`, and write the reader from that log — a day's work.
- **[42] Arms' native sub-agents.** Pi, Codex and Thoth expose no sub-agent channel today, and Pi
  has no MCP either; Claude Code's Agent tool is in (with a worker carrying the bench's tools), but
  `required` is an instruction — the row records that Haiku ignored it. *Needs:* the tools to grow
  the channels (a sub-agent API in Pi or Codex; MCP in Pi; Claude Code letting a sub-agent hold
  tools its parent lacks). *Recommendation:* nothing to build; re-check the arms' release notes
  when they move.
- **[44] Thoth.** Its tool access is an operator decision; `thoth-mcp` becomes possible the day
  Thoth speaks MCP; running the bench beside hoosh on arch is a deployment question.
  *Recommendation:* decide the tool policy (decision 5), then wire `thoth-mcp` like the other two.

### Follow-ups as the current tiers saturate ([48])

Haiku 4.5 sits at ceiling on most families; gpt-4o-mini and the local models still separate on
several, and the local runs in flight will say where the mlx models stand on the rest. Each of
these is small unless marked, and each earns its place only when a model in use stops separating
on the tier it extends:

- generators: `logicgrid5` and `lineup8` (qwen3.8:27b and gemma4:31b clear `lineup6` with the
  schema, Haiku is 6/8); harder `extract` and `dialogue` tiers (not yet: `extract4` and
  `dialogue2` still separate the hosted models); a `code4` once a model clears `code3` (both
  hosted models sit at 3/4); a `clarify` with more candidates or a second vague turn, once a model
  clears the stale-total miss (all small);
- constraints: a language family, if a detector without a dependency is worth its approximation
  and the word-answer families are kept out of its way (small);
- long context: 200 k and 500 k needles for models that take them (small; model-dependent; on
  this laptop a local model would take an hour per trial);
- tool breadth: a harder `typed` with nested arguments and enums once a model trips the current
  one (nobody has; the four mlx models get their first try in the queue); a `toolpick` tier with
  tools whose descriptions, not names, differ (the hosted models and every local model that
  has run `toolpick13` are at or near ceiling with the tools; small);
- abstention: unanswerable variants for the join and the statement (`extract3/4`) and for
  `restock` (small each); every family with a rewrite has its perturbations;
- an over-refusal suite of benign borderline tasks, if decision 3 says so (medium).

### Upkeep

- **[51] Price table upkeep.** `models/prices.json` seeds four prices as of 2026-09-11 that the
  bench cannot verify, and has none for gpt-5.4-mini, gpt-6-astra, Claude Sonnet 5 or Opus 5, so
  their trials run unpriced. *Needs:* the user to check the provider lists and add the rows.
  *Size:* minutes. Same for `MODEL_LABELS` and the Gemini / Mistral / xAI default model ids, which
  are fallbacks until a key lets the routes be probed.

## Decisions needed

1. **Order.** Recommendation: the local tables from the queue first (they are measurements owed,
   not code); [51] (minutes, and the cost view starts telling the truth for every model in use);
   then [48]'s follow-ups as tiers saturate; [38] the week the first checkpoint is served; [40]
   when a MATH or GPQA anchor is wanted.
2. **Code sandbox — taken on 2026-09-21** (a child Node process under the permission model; the
   changelog has the reasoning). Docker only if repository-scale tasks are ever wanted.
3. **Scope of knowledge and safety.** Exclude closed-book knowledge as an axis (the recommendation:
   yes, it stays open-book)? Add over-refusal on benign borderline tasks? (Injection through tool
   output and through documents is built.)
4. **Serving stack for trained checkpoints** — which endpoint the suite presets default to.
   llama.cpp is the recipe exercised (the same weights on llama.cpp and Ollama agree on the same
   instances, over the LAN address, with a key); vLLM has no Metal backend on this laptop and MLX
   needs weights outside Ollama's store, so the choice is really about the desktop or server that
   will host the checkpoints.
5. **Hosted-model budget** for standing matrices (the nightly suite on one hosted model is about
   3 M tokens and three minutes), the cross-harness model set, and Thoth's tool policy ([44]).

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
