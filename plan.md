# LLM Harness Benchmark — roadmap

Forward-facing only. What shipped, by date, is in [CHANGELOG.md](CHANGELOG.md); every measurement
table is in [docs/results.md](docs/results.md). This file says what the project is for, where it
stands, what the field measures that it does not, and what is left — reviewed on 2026-09-19 (a
calendar date; see "Dates" under Conventions), a week after the local queue landed. The review
read the index, wrote the queue's tables into docs/results.md and re-ordered the open work around
what those runs showed; [52]–[55] shipped the same day and are in the changelog.

## Start here (handoff, 2026-09-19)

- **Run it.** `npm test` (451 tests; no model or server needed), then `node src/cli.js serve` for
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
  `holes [--client a,b] [--fill]` shows what each model has scored, lost or never run over the
  whole index and prints the commands that close the gaps; `replay <run> --holes` runs only what
  that run is missing. `probe <endpoint>` lists what a host serves, `probe <endpoint:model>` says
  whether it is ready for a harness run, `list` shows every provider live. Every table ever quoted is in
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
  **Dates:** the entries dated 2026-09-15 to 2026-09-21 in the changelog and the results were
  written on 2026-09-09 to 2026-09-12 by the calendar — the bench's dating moved a day per step,
  and a run id carries the real time its run finished. From this review on, dates are calendar
  dates, so an entry dated 2026-09-19 or later is newer than the one dated 2026-09-21.
- **The local queue landed — two thirds of it.** Fifteen runs (2026-09-11/12 by their ids), five
  Ollama models on the families they had never run; the tables are in docs/results.md ("The local
  queue"). 357 of the 1 050 rows are error rows and none is a model's doing: the Ollama daemon
  was down for three whole runs and parts of two (163 `fetch failed`), `gemma4:31b-mlx` had left
  the store before its batch (152 rows of `model not found` in three seconds, saved as `done`),
  the 27 B timed out 21 times at 300 s and killed its MLX runner six times, and its batch hit a
  five-hour box at 114 of 152 — and because trials run task by task, the box took whole families
  (`dialogue4`, `logicgrid3/4`, `extract3/4`). The thermal record is clean on all 1 050 rows, so
  this was not heat. Nothing in the bench noticed any of it then; since [53]–[55] a run asks its
  endpoints first, gives up on one that stays down (`partial`, exit 2), runs breadth first, and
  `replay <run> --holes` fills what is missing — `node src/cli.js holes --fill` lists the 23 saved
  runs with holes and the commands for them.
  Still never measured: `ornith-1.5:9b` on `code`, `clarify`, `dialogue` and `extract4`;
  `gemma4:12b-mlx` on `code`; the 27 B's tail; anything at all on `muse-glimmer:30b-mlx`, which
  is in the store where `gemma4:31b-mlx` was.
- **Next.** Fill the holes (M1, M2) — Ollama has to be up; `cli holes --fill` prints the
  commands — then delete the four all-error runs (decided: once their holes are filled); then the
  gauging work, [57] first. The order and the reasons are under "Decisions needed".
- **Environment notes.** Ollama 0.33 on :11434 (down at the time of this review) holds
  `ornith-1.5:9b`, `gemma4:12b-mlx`, `qwen3.5:9b-mlx`, `qwen3.8:27b-mlx` and
  `muse-glimmer:30b-mlx`; `gemma4:31b-mlx` is gone and its 103 scored rows stay in the index as
  history. `ornith-1.5:9b` is a 9 B thinking model whose reasoning switches off only through
  `reasoning: { effort: "none" }` on the OpenAI route — `think: false`, `reasoning_effort` and
  `/no_think` do nothing there; the two 9–12 B mlx models time out with thinking on and finish
  with `--effort none`. Seconds per trial on this laptop, from the queue: `gemma4:12b-mlx` 11 and
  `qwen3.5:9b-mlx` 21 (thinking off), `ornith-1.5:9b` 24, `gemma4:31b-mlx` 58 on `code`,
  `qwen3.8:27b-mlx` 88 on `code`, 158 on the batch and 282 on `clarify` — the standard suite
  (about 470 trials) is an hour and a half on the 12 B and about twenty hours on the 27 B.
  llama.cpp is installed as the unified `llama` binary (`~/.local/bin/llama`, build 10679: `llama
  serve`, jinja on by default, `reasoning_effort` honoured per request, `--api-key`, a router mode
  over a models directory) and serves ornith's GGUF straight from Ollama's blob store; the bench
  reached it over the laptop's LAN address with a key, which is the path a desktop host will take
  — the user's target is model hosts elsewhere on the network. The arms need their own logins
  (`codex login`, Claude Code, Pi); Thoth runs on the arch host (README, "Thoth"); Pi has no MCP
  flag, so it stays bring-your-own. The webserver keeps scenarios, logs and documents in memory,
  so restarting it mid-run loses them — and the desktop app stops preview servers on its own
  (hence the private copy above). The queue that ran the local jobs was a shell loop in a
  session scratchpad and is gone with it ([56]). `models/prices.json` holds four prices as of
  2026-09-11 that the bench cannot verify; a model without an entry runs unpriced and the cost
  view says so. `results/runs/demo-delta.json` is a demo file, not a run; the index skips it.

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
that serves them. Learned from the queue: an unattended local run fails in ways that are not the
model's (a third of the rows), so a run has to notice a dead endpoint itself; and on small models
a quarter of the structured-mode misses are answers that never arrived as JSON — a different
fault from a wrong value, with a different cure, and the bench does not yet tell them apart.

## Where we stand (2026-09-19)

| Dimension | What exists today |
|---|---|
| Tasks | 60: `health`, `hello`, `reason`, `lookup`, `regex`, `chain`, `transform`, `explain` (judged), `restock3/6/12/30` (stateful, end-state scored), the generated `wordmath2/4/6`, `convert1/2/3/4`, `datecalc1/3`, `logicgrid3/4`, `lineup4/6`, `tally20/60`, `code1/2/3` (hidden tests in a sandbox), the scenario-backed `fanout4/8`, `follow3/6`, `toolpick6/13`, `norelevant`, `nearmiss`, `paged3/6`, `typed`, the long-context `needle8k/32k/100k` and `needlehop8k/32k/100k`, the extraction `extract1/2/3/4`, the multi-turn `dialogue2/3/4` (a scripted user) and `clarify2/3` (a user who reacts), and the public anchors `gsm8k`, `ifeval`, `bfclsimple`, `bfclmultiple` (`source: public`, never pooled with the rest) — everything but the anchors minted per trial from the run's instance seed; every family with a knob carries `family` and `level`, and every one of them is a factory registered at a fixed list of levels (`[2, 4, 6].map(makeWordmath)`); wordmath, tally, datecalc, fanout and follow (tool modes), extract1 and extract2 mint unanswerable variants, and those plus logicgrid, extract3/4, restock and dialogue mint perturbations; every scenario-backed family is minted from the trial seed |
| Modes | `noHarness`, `harness`, `schemaOnly`, `toolOnly` — the tools × schema 2×2 |
| Models | OpenAI, Anthropic, Groq, DeepSeek, Gemini, Mistral, xAI (the last three probed from their routes when keyed; untested here), Ollama (live-probed), any named OpenAI-compatible endpoint on any host (`LOCAL_ENDPOINTS`, a key per endpoint from `<NAME>_API_KEY`, probed on its own address, recorded on every run as `config.endpoints`); real-harness arms Thoth, Claude Code, Pi, Codex bring-your-own, and `claude-code-mcp` / `codex-mcp` on the bench's tools over the MCP bridge (judged like any client); lineage per client from `models/lineage.json`; prices from `models/prices.json` |
| Treatments | client variants paired against their base: `@skill:preload/ondemand/native` (on demand reaches the MCP arms), `@agents:available/required` (Claude Code's Agent tool with a worker carrying the bench's tools), `@stress:flaky/budget/haystack/distractors/injected`, `@constraints:light/medium/heavy`, `@format:nowork/work`, `@effort:none…high` (translated per provider; reasoning characters recorded), `@confidence` (Brier, ECE, the gap), `@abstain` (half the instances unanswerable: abstained / fabricated / refused), `@perturb:paraphrase/order/format/typos` (consistency beside the delta); `--effort` as a run-level knob |
| Scoring | deterministic scorers per task; truth from the trial (tool results), the server's end state, or hidden tests run in the sandbox; tool-use verdicts (also for arms on shared tools); hijack verdicts from the op log; the abstention verdict; the conduct verdict of the reactive user (asked before writing); one judged task; the IFEval and BFCL checks reimplemented for the anchors, with the approximate parts marked. Why a trial failed is a free-text `reason`; nothing pools it |
| Sandbox | `src/sandbox.js`: a child Node process under the permission model (no file system, child processes, workers, addons or network), heap and clock capped, the candidate in a bare realm no host object enters; a verdict in about 25 ms; zero dependencies |
| Statistics | Fisher exact with the "inconclusive" floor, Wilson bands, 2×2 decomposition, per-arm and per-variant deltas with consistency, McNemar + bootstrap on paired instances, power guidance, Bonferroni over cells, stability per instance (agreement, flaky instances, variance by setting and over time), calibration (Brier, ECE), a capability scorecard per run and over the index (and per lineage family), difficulty curves with breaking points and the depth sweep, regression flags over the index delivered to a file or a webhook, gates with exit codes |
| Cost | tokens, latency, TTFT/TTFA, dollars per trial and per correct answer from the price table, the correctness × cost × latency view; the machine's thermal state on every local row |
| Throughput | parallel trials (arms run alone), 48 trials in 8 s on a hosted model; trials run breadth first (trial 1 of every cell, then trial 2), so a time box or an outage costs every cell its last trials, not the last families all of theirs; a preflight on every endpoint and the webserver, a stop on an endpoint that stays down (`partial`, the rest skipped instead of written as error rows), `errorKind` on every error row, `replay --holes` and `cli holes`; a 90-minute time box on the nightly suite; no queue in the bench yet ([56]) |
| Data | one JSON per run, SQLite index (`index`, `query`, `--sql`, `compact`; `source`, `cost_usd`, `effort`, `depth`, lineage per trial), CSV and JSONL export, versions, lineage and serving hosts on every run, cross-run cell history, suite presets `smoke|standard|full|nightly`; every row keeps the model's turns (or an arm's raw transcript) beside its calls and results; `replay` and `rescore`; the anchor cache with provenance. 11 633 trial rows over 147 runs: 7 057 base rows from hosted models and arms (gpt-4o-mini 3 106, Haiku 4.5 2 383, gpt-5.4-mini 1 259), 2 429 local base rows, the rest treatments — 2 043 hosted, 104 local |
| UI | Ledger design, a setup panel with every treatment and the A/B convention, live grid, headline with a column per treatment, tools × schema 2×2, cost, calibration and abstention blocks, capability scorecard with radars, sparklines and regression lines, lineage graph, difficulty curves with the depth sweep, paired comparison block, dumbbell matrix, trial drawer with transcript, dialogue turns and children, replay button, history filter (restart `serve` to pick up new task families) |
| SUT | the webserver: hello/health, the `/api/recent` log, inventory scenarios with tickets, confirm rules (refused while anything is low), stress profiles, pagination, strict types, a dead-end pointer and an op log, text logs with grep and count, documents |
| Tests | 451, none needing a model; the webserver runs in-process; the sandbox tests spawn child Node processes |

### Where the models stand (harness mode, pooled over the index; `cli scorecard <client>`)

- **The bench separates the gpt-4o-mini / 9–12 B band and nothing above it.** Haiku 4.5 is at
  96–100 % on 23 of the 30 capabilities it has harness rows for and `qwen3.8:27b-mlx` on 21 of
  22 (88/89 on tool use).
  What still catches them: `clarify` for Haiku (4/8; the 27 B clears it 12/12), `lineup6` (Haiku
  6/8), `code3` without tools (Haiku 3/4 free-form; with tools it and the 27 B clear the family
  since the re-score of 2026-09-19), `extract4`
  (Haiku 3/4 with tools; 0/4 inline for every model), `restock30` (Haiku 2/3), and long inputs
  read without tools. No frontier-class model has rows worth the name (gpt-6-astra: 16 scored),
  so where the bench's ceiling sits for them is unknown (M6).
- **`ornith-1.5:9b`** (921 scored trials): tool use 89 % against gpt-4o-mini's 80 %, planning and
  state 88 % against 24–26 % (`restock12` 4/4 against 0/20); its room is extraction (78 %),
  dependent calls and long context (75 %), tool selection (85 %), `lookup` (15/25), and delivery
  — a quarter of its structured-mode misses are answers that never arrived as JSON. It has never
  run `dialogue`, `clarify`, `code`, `extract4`, the two-hop needles, the anchors, or any
  treatment but constraints and a preloaded skill.
- **`gemma4:12b-mlx`** (thinking off, 11 s a trial): `dialogue` 12/12 and `clarify` 8/8 tool-only
  — better than both GPT minis — and weak on scans and sums (`paged6` 1/4, `restock6` 1/4,
  `extract4` 0/8). The structured mode costs it on puzzles (`lineup6` 3/6 against 6/6 free-form).
- **`qwen3.5:9b-mlx`** (thinking off): single-step tool work at ceiling, state across steps
  broken — `follow` 0/8, `dialogue` 1/12, `clarify` 2/16, `restock` 5/12 — and the harness costs
  it on reasoning (unit conversion −22 pp, p < 0.05; deduction −31 pp, ordering −50 pp on few
  trials): with thinking off, the `work` field is all the room it has.
- **No treatment has met a local model** beyond constraints (64 rows), a preloaded skill (32) and
  the effort switch (8): abstention, calibration, perturbations, injection and the format axis
  are hosted-only, so "knowing when it cannot", "staying consistent" and the hijack rate are
  unmeasured for every model this bench is ultimately for (M3).
- **Four trials per cell** is the habit, and a single cell can then only ever say 0 % or
  inconclusive; the capability pools carry the conclusions. A checkpoint against its parent will
  need more pairs where the two differ and fewer where both are at 0 or 100 % ([58], [61]).

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
| Own-model workflow | lm-eval backends; W&B / MLflow; per-checkpoint scoreboards | named endpoints on any host, with a key, probed and recorded on every run; `docs/serving.md` (llama.cpp exercised over the LAN); lineage, `models` / `suite` / `compare --parent` / `regressions` / `gate`, the family scorecard and the lineage graph | a queue for unattended multi-job sessions ([56]); a gauge a slow host can afford ([57], [58], [61]); one document per checkpoint ([60]); contamination policy ([38]); the first real checkpoint | high |
| Statistics & reproducibility | HELM CIs, Inspect logs, lm-eval fixed prompts | everything in the table above | why a trial failed, pooled ([59]); trials sized by power where a comparison is wanted ([61]) | medium |
| Calibration & abstention | HELM calibration; answer-or-abstain splits | `@confidence` (Brier, ECE, gap), `@abstain` on six families (three generated; fanout and follow in the tool modes; extract1 and extract2), `norelevant` / `nearmiss` | never run on a local model (M3); unanswerable variants for the join and the statement (`extract3/4`), `restock` ([48]) | medium |
| Robustness / consistency | HELM perturbations; paraphrase suites | agreement per instance, variance by setting, `@perturb` (paraphrase, order, format, typos) on nine families with consistency | never run on a local model (M3) | medium |
| Safety for agents | AgentDojo, over-refusal suites | the `injected` profile (two payloads, hijack verdicts), injection through a document | never run on a local model (M3); over-refusal on benign borderline tasks (decision 4) | medium |
| Agentic multi-step | SWE-bench Verified, Terminal-Bench, GAIA, BrowseComp, OSWorld | restock family (3–30 steps), the `dialogue` and `clarify` families, four real arms, two of them on the bench's tools, the `code` family's test-and-fix loop | other domains (files, terminal, scheduling), longer horizons | medium |
| Reasoning / math | GPQA Diamond, HLE, ARC-AGI-2, FrontierMath, LiveBench math | `reason`, the generated `wordmath`, `convert`, `datecalc`, `logicgrid`, `lineup`, `tally` families with a tool or the structured mode as the harness axis, GSM8K as the anchor | levels past the registered ones, as a knob ([57]) | medium |
| Long context | RULER at 4 k–1 M | `needle8k/32k/100k`, `needlehop8k/32k/100k`, the depth sweep | sizes between and past the registered ones ([57]); the two-hop needles on the local models | medium |
| Coding | HumanEval → LiveCodeBench → SWE-bench | the `code` family: twelve seeded kinds over three levels, hidden tests in a sandbox (a child Node process under the permission model), `run_tests` as the harness axis | a fourth level — `gemma4:31b-mlx` cleared `code3` 16/16, and with tools so do Haiku and the 27 B; repository-scale tasks would need a container | medium |
| Multi-turn & user simulation | τ²-bench user simulator, MT-Bench | the `dialogue` family with a scripted user and policy verdicts; the `clarify` family with a user who reacts to what the model did | the 27 B clears `clarify` (12/12) and the 12 B `dialogue` (12/12): more candidates ([57]), longer scripts, a second vague turn; arms through their session channels ([42]) | medium |
| Tool use / function calling | BFCL v4 (AST + executable checks, parallel calls, irrelevance detection, multi-turn), τ²-bench, MCP-Bench | six tool tasks, decoys, restock, stress profiles, `fanout`, `follow`, `toolpick` (near-duplicate tools), `norelevant` and `nearmiss`, `paged`, `typed`, the `injected` profile, `dialogue`, the BFCL anchors, arms on shared tools with verdicts | `typed` still trips nobody (16/16 on four local models): a harder one only when a model does ([48]) | low |
| Instruction following | IFEval, LiveBench IF | `@constraints` (twelve families, stated once across a dialogue), `@format`, IFEval itself as the anchor | a language family ([48]) | low |
| Structured extraction | LiveBench data analysis, enterprise extraction evals | `transform`, the `extract` family with four tiers and injection through the document | none pressing: `extract4` is 0–3 of 4 for every model | low |
| Preference / open-ended | LMArena, Arena-Hard-Auto (pairwise, Bradley-Terry) | one absolute judge score | position-swapped pairwise judging, ratings, judge calibration against human labels ([30]) | low |
| Knowledge / factuality | MMLU-Pro, SimpleQA, HLE | none, by design | open-book only — closed-book knowledge is the most contaminated axis and the least ours | low |
| Multimodal | MMMU and successors | none | out of scope unless the trained models are multimodal | low |
| Public anchors | lm-eval / Inspect on the standard sets | GSM8K, IFEval, BFCL simple and multiple run natively with provenance and the caveat | never run on a local model (M5); MATH, GPQA Diamond, RULER through a log import ([40]) | low |

## Open work, reviewed (2026-09-19)

Numbers are stable across this file, the changelog and the results: [1]–[29], [31]–[37], [39],
[41], [43], [45]–[47], [49], [50] and [52]–[55] have shipped and are described in the changelog.
[56]–[61] came out of the review of 2026-09-19, each from something the queue's runs showed.
Sizes: XS an hour, S a session, M two or three.

### Runs that can be left alone

The local path is the product. [53]–[55] shipped on 2026-09-19 (a preflight, a stop on an
endpoint that stays down, breadth-first trials, `replay --holes` and `cli holes`); what is left of
the theme:

- **[56] A queue in the bench.** `cli queue add | run | status | stop`: jobs are bench argument
  lines in `results/queue.json`, one at a time per endpoint (two hosts on the network work side
  by side); a job the preflight refuses waits and is tried again instead of failing the queue, a
  `partial` job is followed by one `--holes` pass, done jobs are recorded so a restart resumes.
  The pieces exist ([53], [54]); this is the loop around them, which last time was a shell
  script in a session scratchpad and is gone with it. Also worth having with it: the live grid in
  the UI showing "waiting on <endpoint>" (the runner already emits the event; the page ignores
  it), and the run headline leaving transport rows out of its per-mode percentages the way the
  scorecard does. *Size:* S.

### Gauging, not only scoring

- **[57] Open levels.** Every family with a numeric knob is already a factory registered at a
  short list (`[3, 6, 12, 30].map(makeRestock)`). Let the registry mint `wordmath9`, `restock20`,
  `lineup8`, `logicgrid5`, `tally150`, `follow10`, `fanout16`, `paged9`, `needle64k`, `clarify5`
  on demand — `getTask` resolves `<family><level>` through the family's factory within a range
  the family declares (generation cost grows: `logicgrid` and `lineup` enumerate for
  uniqueness) — so replay, rescore and the index work on minted names, the registered ones stay
  what suites and gates list, and rows pool into curves through `family` / `level` as today.
  `listTasks` gains the range; the UI takes a level. This turns most of [48]'s generator items
  from things to build into a number to type. The tiered families (`code`, `convert`,
  `datecalc`, `dialogue`, `extract`) keep named levels. *Size:* M.
- **[58] `cli gauge <client>` — the level where a model breaks, found adaptively.** Per family a
  staircase over [57]'s levels: start in the middle, up after two passes, down after a miss, stop
  at a number of reversals or a trial or time budget; instances from the run's seed, so two
  checkpoints meet the same instances at the levels they share. The result per family is a level
  with a band (the highest level whose Wilson band sits above 50 %, the lowest whose band sits
  under it, a logistic fit between), saved as an ordinary run (`config.gauge`) so `compare`,
  `trend`, `regressions` and the index read it. One number per capability that cannot saturate,
  for a dozen or two trials a family — what a 27 B at 158 s a trial can afford, where four trials
  at every level in two modes is not. *Needs:* [57]. *Size:* M.
- **[59] Failure kinds.** One small vocabulary beside the free-text reason: `delivery` (no
  answer, not JSON, truncated, timed out), `value` (wrong; `near` when the scorer knows it was
  close), `conduct` (wrote before asking, collateral write, unconfirmed, policy), `tool` (unused,
  wrong tool, wrong arguments, pages unread), `safety` (hijacked, fabricated under `@abstain`).
  The bench's own failures are already apart: every error row carries `errorKind` (transport,
  timeout, cancelled, request, bench) since [53], with `error_kind` in the index. First version: a classifier over today's
  `reason` and `error` strings in `scoreRecord`, so `rescore` back-fills every saved row without
  a scorer changing; scorers return `kind` themselves as they are touched. `summary.failures` per
  client and mode, an index column, a column on the scorecard, a block in the UI. For whoever
  trains the checkpoint this is the actionable split — format data, policy data or capability.
  *Size:* S for the classifier, M with the views.
- **[60] The checkpoint card.** `cli card <client> [--against <parent | client>] [--out
  card.md | card.html]`: one document per checkpoint — the scorecard with its radar, the gauge
  levels ([58]), the failure kinds ([59]), calibration, abstention and consistency where those
  treatments ran, tokens, seconds and reasoning characters per correct answer, the holes ([54])
  and where it was served from; `--against` adds the paired comparison per capability. Assembly
  over `report.js`, `charts.js` and `trends.js`. *Size:* S–M.
- **[61] A suite sized by power.** A `gauge` preset that spends its trials where the model is
  near 50 % — the two levels around its breaking point per family, from [58] or the index —
  sixteen paired instances a family, harness mode plus a free-form pass on the reasoning
  families, `--budget <minutes>` scaling trials rather than dropping families. `sampleSizeFor`
  already says why: four a side cannot show anything short of 0 against 100 %. *Needs:* [58].
  *Size:* S.

### Measurements owed (no code)

- **M1. The holes.** `ornith-1.5:9b` on `code1/2/3`, `clarify2/3`, `dialogue2/3/4` and
  `extract4`; `gemma4:12b-mlx` on `code`; the 27 B's `dialogue4`, `logicgrid3/4`, `extract3/4`,
  `follow6` and its cut `restock` cells. `node src/cli.js holes --fill` prints one `replay <run>
  --holes` line per saved run with holes (23 of them, 491 holes, 67 of those timeouts that may
  time out again; the 152 of `gemma4:31b-mlx`'s lost batch cannot be filled while the model is
  out of the store — the preflight will say so).
  One model at a time, the private webserver copy on :3001, `--effort none` comes with the
  parent's knobs. Then the four all-error runs are deleted (decision 2) and the local tables in
  docs/results.md get their missing cells.
- **M2. `muse-glimmer:30b-mlx`.** `cli probe`, then the eight-task set and the queue's batch —
  it has no rows at all.
- **M3. The treatments on a local model.** `@abstain`, `@confidence`, `@perturb:paraphrase` and
  `typos`, `@stress:injected`, `@format:nowork` on `ornith-1.5:9b` first, over the families that
  support them (`wordmath4`, `tally20`, `datecalc1`, `extract1/2`, `fanout4`, `follow3`): about
  300 trials, two to three hours at 24 s a trial.
- **M4. What thinking buys.** `ornith-1.5:9b` through llama.cpp, which honours
  `reasoning_effort` per request (Ollama only switches it off): `@effort:none | low | medium |
  high` on `wordmath6`, `lineup6`, `convert4`, `follow6`, `code3` — correctness against
  reasoning characters and seconds, per family.
- **M5. The anchors on the local models.** GSM8K, IFEval and BFCL at 50 items — the external
  reference the hosted models already have.
- **M6. One ceiling probe.** The top level of every family, harness and free-form, four trials,
  on one frontier hosted model (about 160 trials). It says which harder tiers are worth having
  before any is built. The user's budget.

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
  *Recommendation:* decide the tool policy (decision 6), then wire `thoth-mcp` like the other two.

### Follow-ups as the current tiers saturate ([48])

The queue said which tiers a model in use has stopped separating on. With [57] most generator
tiers become a level to type rather than a task to write; what is left to build:

- generators: `logicgrid5`, `lineup8`, a `clarify` with more candidates — all through [57] (the
  27 B and `gemma4:31b-mlx` clear `lineup6`; the 27 B clears `clarify` 12/12). A `code4` — a
  tier, so built by hand — now that `gemma4:31b-mlx` cleared `code3` 16/16 and, with tools, so do
  Haiku and the 27 B. A second vague turn for `clarify`, longer scripts for `dialogue` (the
  12 B and the 27 B clear all three levels; the GPT minis and `qwen3.5:9b-mlx` do not). Not
  needed: a harder `extract` (`extract4` is 0–3 of 4 for every model);
- constraints: a language family, if a detector without a dependency is worth its approximation
  and the word-answer families are kept out of its way (small);
- long context: sizes past 100 k through [57] for models that take them (on this laptop a local
  model would take an hour per trial);
- tool breadth: a harder `typed` with nested arguments and enums once a model trips the current
  one — the four mlx models had their first try and went 16/16, so still nobody; a `toolpick`
  tier with tools whose descriptions, not names, differ (every model that has run `toolpick13` is
  at or near ceiling; small);
- abstention: unanswerable variants for the join and the statement (`extract3/4`) and for
  `restock` (small each);
- an over-refusal suite of benign borderline tasks, if decision 4 says so (medium).

### Upkeep

- **[51] Price table upkeep.** `models/prices.json` seeds four prices as of 2026-09-11 that the
  bench cannot verify, and has none for gpt-5.4-mini, gpt-6-astra, Claude Sonnet 5 or Opus 5, so
  their trials run unpriced. *Needs:* the user to check the provider lists and add the rows.
  *Size:* minutes. Same for `MODEL_LABELS` and the Gemini / Mistral / xAI default model ids, which
  are fallbacks until a key lets the routes be probed.

## Decisions needed

1. **Order.** Recommendation: M1 and M2 first (measurements owed, and the first unattended use
   of [53]–[55]); then [57] and [58] (the gauge is the piece that makes a slow host affordable
   and a checkpoint line comparable); [59] as the classifier version alongside; [60] once [58]
   and [59] have something to show; [56] before the next multi-job local session; M3–M5 in the
   background through it; [61] last. [38] the week the first checkpoint is served; [40] when a
   MATH or GPQA anchor is wanted.
2. **The four runs that are nothing but error rows — decided 2026-09-19: delete them once their
   holes are filled** (`20260911T183456-b6a6`, `20260911T190501-b808`, `20260911T193506-4b85`,
   `20260912T070845-4831`; 272 rows). Until then they are the record of what is missing, and what
   `replay <run> --holes` reads its list from. The last one is `gemma4:31b-mlx`'s, which cannot be
   filled while the model is out of the store: delete it with the others, or pull the model again
   first — the user's call when M1 is done.
3. **`csvRow`'s quote after a space — decided 2026-09-19: dropped** from what an answer is graded
   on unless the prompt shows it as an example ([52], shipped).
4. **Scope of knowledge and safety.** Exclude closed-book knowledge as an axis (the recommendation:
   yes, it stays open-book)? Add over-refusal on benign borderline tasks? (Injection through tool
   output and through documents is built.)
5. **Serving stack for trained checkpoints** — which endpoint the suite presets default to.
   llama.cpp is the recipe exercised (the same weights on llama.cpp and Ollama agree on the same
   instances, over the LAN address, with a key); vLLM has no Metal backend on this laptop and MLX
   needs weights outside Ollama's store, so the choice is really about the desktop or server that
   will host the checkpoints. The queue adds an argument: in fourteen hours Ollama's daemon was
   unreachable twice — once for ninety minutes, which cost three whole runs — and its MLX runner
   died six times under the 27 B.
6. **Hosted-model budget** for standing matrices (the nightly suite on one hosted model is about
   3 M tokens and three minutes), the ceiling probe (M6), the cross-harness model set, and
   Thoth's tool policy ([44]).

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
