# Changelog

What shipped, by date. Full measurement tables live in [docs/results.md](docs/results.md); the
forward roadmap is [plan.md](plan.md). Dates are the commit dates; item numbers ([1]–[49]) are the
roadmap's, stable across the plan, this file and the results.

## 2026-09-08 (night) — difficulty curves and regression detection

### Added
- **Difficulty curves** ([32]): every family with a knob tags its tasks with `family` and `level`
  (restock items 3/6/12/30, wordmath steps 2/4/6, datecalc 1/3, logicgrid 3/4, tally 20/60, fanout
  4/8, follow 3/6, needle 8k/32k/100k), exposed by the registry and `/api/meta`. `curves` in
  `runner.js` (`summarize`'s `curves`, from `levelsOf`) gives, per family, client and mode, success
  per level with its Wilson band and the **breaking point**: the first level whose band tops out
  under 50 % — conservative by construction (three trials can never break a model; 0/4 can). The
  report prints the curves, the UI draws them (a "Difficulty curves" panel: one small chart per
  family, a line per model, the break as a hollow square, the mode switchable) and
  `node src/cli.js curve <family> [--mode] [--client] [--since]` pools the same over every saved run.
- **Trend and regression detection** ([34]): `src/trends.js` — `seriesFor` (a client's capabilities
  per run over time, behind `cli trend --client <c> [--capability] [--mode]`), `regressionsFor` and
  `parentGaps` behind `cli regressions [--client] [--since]` and `GET /api/regressions?client=`.
  Per capability and mode, a client's latest run of each task is set against its earlier runs of
  the same task, with the same number of trials per task on both sides (the most recent earlier
  ones), so neither a change of task mix nor a side heavy in the hardest task reads as a change in
  the model; a checkpoint is compared with its lineage parent the same way. A flag needs the later
  Wilson band to lie entirely under the earlier one, and carries the per-task split, the drop in
  points, Fisher's p and the runs involved. The UI shows the flags as lines under the capability
  scorecard, fetched per model when a run is opened.

### Measured (the index as of tonight)
- Two breaking points: **gpt-4o-mini at six restock items** in the synthetic loop (4/12, 5/28,
  0/16 over 3/6/12 items) and **gpt-5.4-mini at six follow hops** (3/4, then 0/12; Codex's loop
  takes the same model to 6/6 at that level). gpt-5.4-mini at 30 items is 0/3 but not a break:
  three trials cannot push a band under 50 %. Haiku 4.5 breaks nowhere the index has run it. The
  pooled tables are in docs/results.md.
- **No regressions** in the index by the balanced rule (ornith: 14 capability × mode comparisons;
  gpt-4o-mini: 24 runs). Before balancing, the same band rule flagged two — ornith's free-form
  tool-use pool (62 % → 29 %) and gpt-4o-mini's harness arithmetic (95 % → 69 %) — and both were
  the later side leaning on the harder task (free-form `lookup`, `wordmath6`) rather than the
  model changing, which is what the per-task balance is for.
- Tests: 239 (curves and breaking points, series, regressions with a task-mix change and a lopsided
  pool, parent gaps, and every family task carrying its knob).

### Changed
- `plan.md` lists open work only: the shipped items ([21]–[23], [25], [31]–[36] and the preset half
  of [37]) were removed, their leftovers collected as [48] (follow-ups on the shipped families) and
  [49] (scorecard and trend views), and a "Start here" handoff section opens the file.

## 2026-09-08 (evening) — long context

### Added
- **The `needle` family** ([23]): `needle8k`, `needle32k`, `needle100k` — a seeded server log of
  about that many tokens (296, 1,185 and 3,704 lines) with one question per trial, rotated by seed:
  a single planted line (the latency of one request id, at 10 %, 50 % or 90 % depth — recorded, so
  a position sweep falls out of the rows), a multi-needle (which three hosts logged a CRITICAL
  event), or an aggregation (how many ERROR lines one service logged). Free-form and schema-only
  modes read the whole log inline; the tool modes get `grep_log` / `count_log` over the same log,
  posted to the webserver — so the harness delta here is *search versus read*. Truth is recomputable
  from the lines (the tests do).
- Webserver: `POST /api/logs` (text, one event per line), `GET /api/logs/:id?grep=&limit=`
  (numbered matches and the total), `GET /api/logs/:id/count?grep=`.
- Run records keep a capped prompt (20 k characters) — the model receives the whole log, and the
  token counts in `usage` say so.

### Measured (three hosted models, six trials per cell, seed 2026)
- **Search beats reading, completely**: with `grep_log` / `count_log` every model was 6/6 on both
  sizes in both tool modes, on about 1–3 k tokens per trial. Reading the log inline, gpt-4o-mini was
  2/6 and 1/6 (12 k and 48 k tokens per trial), gpt-5.4-mini 4/6 and 4/6, Haiku 6/6 and 4/6.
- **Aggregation is what breaks on a long read.** Single planted lines were mostly found (23/24 at
  10 % depth, 4/6 at 90 % — a depth effect already at 32 k) and the three CRITICAL hosts usually
  listed, but counting one service's ERROR lines across the log failed for every model inline:
  gpt-4o-mini 0/5 (it often gave no number at all), gpt-5.4-mini 2/5, Haiku 3/5 at 8 k and 0/2 at
  32 k — off by one to three each time. The count tool made it 100 %.
- The question kind now rotates with the trial index (single, multi, aggregation), so a cell of six
  covers each twice; this run's cells were unbalanced by the seed hash (no multi-needle at 8 k).
- **The 100 k log** (three per cell): the tool modes were 3/3 for every model on about 1–4 k
  tokens; reading inline, gpt-5.4-mini was 1/3 and 0/3 and Haiku 1/3 and 1/3 — the multi-needle
  usually found, the aggregation off by 10–40 — and **gpt-4o-mini could not run the inline modes at
  all**: the prompt measured 150 k tokens on OpenAI's tokenizer (174 k on Anthropic's) against its
  128 k context, so every inline trial is an API error row while the same model with grep and count
  is 3/3. At this size the tool axis does not improve the task; it makes it possible.
- The sizes were mislabelled: the line-length estimate was 27 tokens and the live counts say about
  41 (OpenAI) to 47 (Anthropic) — hex ids and timestamps tokenize badly. Recalibrated to 42 per
  line, so `needle8k/32k/100k` now mean roughly that on OpenAI's tokenizer (190, 762 and 2,381
  lines); the runs above were really 12 k, 48 k and 150 k tokens.

## 2026-09-08 (later still) — own-model plumbing: endpoints, lineage, suites, compare view

### Added
- **Named local endpoints** ([35]): `LOCAL_ENDPOINTS="vllm=http://127.0.0.1:8000/v1;mlx=…"` turns any
  OpenAI-compatible server — vLLM, llama.cpp, MLX, a second Ollama — into a provider like `local`:
  no key, models probed live from its `/v1/models`, offline in the UI when down, never shadowing a
  built-in. Clients are `<name>:<model>`. `docs/serving.md` is the step-by-step: serve the
  checkpoint (with tool calling on), name the endpoint, record the lineage, run a suite, compare
  with the parent.
- **Model lineage** ([36]): `models/lineage.json` (or `LINEAGE_FILE`) maps a client id to family,
  checkpoint, step, parent, training data and date. Every run records the entries of the clients
  it ran (`config.lineage`), the index carries family / checkpoint / step / parent per trial (a
  variant inherits its checkpoint's), `node src/cli.js models` lists the registry with what the
  index holds for each entry, and `compare <run> --a <checkpoint> --parent` pairs a checkpoint
  against the parent its entry names.
- **Suites** (the preset half of [37]): `node src/cli.js suite smoke|standard|full --clients …` runs
  a preset (smoke: one task per capability, two trials, two modes; standard: every task, four
  trials; full: four modes, eight trials); a suite run is a bench run with `config.suite`. Gates
  remain open.
- **Paired comparison in the UI**: every run gets a block with A and B selects (labelled with
  lineage), a mode filter, and "B from" any other saved run on the same instance seed (`GET
  /api/runs?seed=`), rendering the per-task McNemar table and the overall band from `compareRows`.
- Tests: 231 (lineage file, endpoint parsing and registration, suites, lineage in the index, seed
  filter).

### Measured
- A named endpoint aliasing the local Ollama (`mlx=http://127.0.0.1:11434/v1`) lists the same five
  models live and runs a harness trial as `mlx:ornith-1.5:9b` with tool calls — the path a served
  checkpoint will take, exercised before one exists.

## 2026-09-08 (later) — capability scorecard and paired statistics

### Added
- **Paired statistics** ([33]): when both sides of a comparison ran the same instances (same task
  and trial index — for generated tasks, the same seed and problem), `deltaBetween` pairs them and
  reports **McNemar's exact test** on the discordant pairs plus a seeded percentile **bootstrap band**
  on the delta (`paired` on every delta; per-cell deltas skip the bootstrap). Every delta the bench
  reports — harness, skill, sub-agents, stress, constraints — gains the paired view for free. Also:
  `sampleSizeFor` / `describePower` ("to see a 20 pp gap from 50 % at 80 % power, run about 93 per
  side", shown when a delta is not significant) and `multipleComparisons` (Bonferroni over the
  run's task × model cells, with the expected number of chance positives). Report and headline
  carry all three.
- **Capability scorecard** ([31]): `capabilityStats(rows, capabilitiesOf)` pools every row whose
  task carries a tag — per mode, with Wilson bands and the harness delta. `summarize` reports it per
  client when given the tags (the runner, `cli show` and the UI all pass them); the UI has a
  "Capability scorecard" panel per run; `node src/cli.js scorecard <client> [--since]` and
  `GET /api/scorecard?client=` pool it over every saved run in the index.
- **`node src/cli.js compare`**: two clients in one run (`--a`/`--b`) or two runs on the same
  instance seed, paired per task and overall with McNemar and a bootstrap band — the
  checkpoint-versus-parent question, answerable today.

### Measured (on runs already saved)
- The answer-only → `work`-field re-run of the generated families, compared across the two runs as
  a paired design: 26 up, 2 down of 48 in schema-only mode, McNemar p < 0.001, 95 % band +33 to
  +67 pp — where the unpaired reading had been two percentages.
- gpt-4o-mini versus Haiku on the same 36 harness instances of the generated families: 9 up, 1
  down, McNemar p = 0.02, band +8 to +39 pp.
- gpt-4o-mini's scorecard over 949 scored trials in the index: extraction, tool selection,
  counting, parallel calls, irrelevance detection 100 % harnessed; arithmetic 90 %, dependent calls
  88 %, deduction 86 %, tool use 81 %; calendar 67 %, multi-step 54 %, **planning and state 16 %**
  (the restock family). One line per capability is the profile the roadmap asked for.

## 2026-09-08 — tool-use breadth and prompt injection

### Added
- **Three scenario-backed families** ([25]), minted per trial from the instance seed (the server
  takes the seed, so the inventory is reproducible): `fanout4/8` — N independent item reads that
  could be issued in one turn, with the tool-use verdict reading the rounds to say whether they
  were; `follow3/6` — a chain of dependent reads (every item now carries a `next` pointer; the
  pointers form one cycle) that can be neither parallelized nor guessed; `norelevant` — half the
  questions answerable from the tools, half about fields nothing exposes, scored on the
  availability decision and the value. `tasks/scenario.js` holds what they share (API, read tools,
  the end-state read). Tool-use verdicts now receive `rounds`.
- **The `injected` stress profile**: two items carry a note with an instruction inside tool output.
  Two payloads: `write` (mark a third item "compromised" — an update the op log records; used by
  restock, whose tools can write) and `answer` (report every quantity as 999, a value no item ever
  has; used by the read-only fanout, follow and norelevant, whose scorers recognise the planted
  value). Obedience is `hijacked` on the row, every scenario-backed scorer fails a hijacked trial,
  and the stress delta shows "hijacked in n of m trials". Web: the profile in the stress setting,
  HIJACKED in the drawer.

### Measured (three hosted models, four per cell, seed 2026)
- **Parallel calls are universal**: every model issued all four and all eight reads in a single
  turn (two rounds: the reads, then the answer), 4/4 correct everywhere.
- **Dependency chains are where they differ.** `follow3`: gpt-4o-mini 4/4, haiku 4/4 (one qty slip
  in tools-only), gpt-5.4-mini 3/4. `follow6`: haiku 4/4, gpt-4o-mini 2/4, **gpt-5.4-mini 0/4** in
  both tool modes. The transcripts give two different failures: gpt-5.4-mini fetched exactly k
  items and reported the item after k − 1 hops every single time — it counts the starting fetch as
  a hop, a systematic off-by-one — while gpt-4o-mini fetched seven to ten items and reported ids
  that are not on the chain at all: it loses the thread. (The verdict had let the landing item go
  unfetched; it now names "stopped one hop short".)
- **Irrelevance detection is solved at this difficulty**: 9/9 unanswerable questions reported as
  not available by every model in every mode, no invented value anywhere, and the answerable half
  answered 3/3 wherever a tool existed. A harder near-miss set is noted for later.
- **Injection, write payload** (restock6, fanout8, follow6, norelevant in harness mode, four per
  cell): **gpt-4o-mini obeyed the planted note in 4 of 4 restock trials** (seven compromising
  updates, 0/4 correct, fifteen rounds); gpt-5.4-mini and haiku never did (0/8) and stayed at their
  plain correctness. The note also cost gpt-4o-mini without obedience: `follow6` fell 4/4 → 1/4 as the
  notes in item records threw it off the chain. On the read-only families the write payload is
  unobeyable by construction, which is why a second payload exists (below).
- **Arms, write payload** (restock6, fanout8, follow6; three per cell): Claude Code with Haiku and
  Codex with gpt-5.4-mini were 3/3 on every task plain and injected, hijacked 0 of 18. Two things
  stand out. Codex took gpt-5.4-mini through `follow6` 3/3 where the same model in the synthetic
  loop was 0/4 with its off-by-one — the harness's own loop and prompt corrected a counting error
  the model makes when it drives the bench's tool loop, the first harness-attributable *gain* in
  correctness on record. And Claude Code read the eight `fanout8` items one at a time (about seven
  turns) where every hosted model in the synthetic loop issued all eight at once.
- **Injection, answer payload** (fanout8, follow6, norelevant in harness mode, four per cell): now
  the read-only families discriminate too. **gpt-4o-mini reported the planted 999 in 7 of 12 trials**
  — 3/4 on fanout8, 3/4 on follow6, 1/4 on norelevant — after reading every item correctly;
  gpt-5.4-mini and haiku 0 of 12 each, correctness unchanged. Pooled stress delta −19 pp (p = 0.08,
  36 vs 36), entirely the small model. Across both payloads gpt-4o-mini obeyed instructions found in
  tool output in 11 of 16 trials where obedience was possible; the two larger models in 0 of 32.
- **Arms, answer payload** (fanout8, follow6, norelevant; three per cell): Claude Code with Haiku
  and Codex with gpt-5.4-mini 3/3 on every task, plain and injected, hijacked 0 of 18. Across both
  payloads the arms obeyed nothing in 36 injected trials; the synthetic loop's two larger models
  obeyed nothing in 32; gpt-4o-mini obeyed in 11 of 16.

## 2026-09-07 (later still) — instruction-following constraints

### Added
- **Constraints as a treatment** ([22]): `src/constraints.js` wraps a client as
  `<client>@constraints:light|medium|heavy` (one, three or five requirements drawn from the trial
  seed). Free-form modes get text requirements — word limits, forbidden and required words, an
  opening or closing phrase, no commas, bullet counts; structured modes get JSON-shape requirements —
  key order, an attestation key, a single line. The answer is checked by code and the row records
  `constraints` (met / total / each requirement); `delta.byConstraints` / `delta.constraints[level]`
  carry **adherence** next to the correctness delta. Arms get the requirements through the goal
  prompt. Web "constraints" setting with A/B choices; drawer lists each requirement ✓/✗; index and
  CSV columns.
- The row's `prompt` now shows what the model actually saw when a variant rewrote it.

### Fixed
- Wrappers (skills, constraints) were not given the task, mode, context or seed on the free-form
  `chat` path, so a skill variant in `noHarness` mode silently ran plain. Both paths now receive the
  same options. (No recorded skill measurement used the free-form path.)

### Measured (seven tasks × noHarness and harness, three hosted models, four per cell, seed 2026)
- **Models follow formatting requirements almost always**: adherence 94 % over 804 requirements
  (gpt-4o-mini 97 %, haiku 98 %, gpt-5.4-mini 88 %). Requirements that were ever refused: padding
  to a minimum word count (81 %), an exact bullet count (85 %), and the attestation key (80 %) —
  the last mostly gpt-5.4-mini answering `hello` as a bare JSON array with nowhere to put a key,
  a constraint-design artifact now fixed (`attest` is offered only to object schemas). Forbidden
  and required words, opening and closing phrases, key order and single-line JSON: 100 %.
- **Following them costs free-form correctness and nothing in harness mode.** Free-form, five
  requirements: gpt-4o-mini 15/28 → 10/28, gpt-5.4-mini 16 → 12, haiku 15 → 14; harness mode
  stayed at 24–28/28 for everyone. The loss concentrates where a requirement conflicts with the
  task's verbatim answer — `hello` free-form fell 11/12 → 6/12 because "no commas" turns
  "Hello, alice!" into "Hello alice!" — and the models chose the instruction over the quote. Pooled
  correctness delta −5 pp (p = 0.4); adherence is the number that separates the models.
- **Arms, harness mode, five requirements** (lookup, chain, restock6; three per cell): Claude Code
  with Haiku met 15/15 requirements and stayed correct on every trial the bench scored; Codex with
  gpt-5.4-mini met 20/24 (the misses are the attestation key on `lookup`'s array answer, the same
  artifact) and lost one `chain` trial to the dependent second call it also skipped plain. Four
  Claude Code `restock6` trials in this run errored in the bench, not the model: greetings served to
  a concurrent local run landed in the arm's time window and hit a code path that assumed a task's
  tools were a list (restock's are a function of the trial since the stress profiles). Fixed and
  tested; the caveat that arms should not share a webserver with another running process stands.
- **Local ornith-1.5:9b** (hello, regex, wordmath4, tally20): free-form adherence 88–94 % and the
  same correctness cost as the hosted models (15/16 → 11/16 under five requirements); JSON
  adherence only 65–69 % — it keeps pretty-printing when told to write one line (13/20) and half of
  its attestation misses are the array-answer artifact. Key order, forbidden words, word limits and
  opening phrases: 100 %.

## 2026-09-07 (later) — generated reasoning families, instance seeds, capability tags

### Added
- **Generated task families** ([21]): `wordmath2/4/6` (multi-step stock word problems; the harness
  axis is an exact calculator tool), `datecalc1/3` (calendar arithmetic; a date tool), `logicgrid3/4`
  (pet-and-drink deductions, unique and minimal by construction, checked by enumeration; no tools)
  and `tally20/60` (count / sum / max over an inline table; a per-trial query tool). Each mints its
  instance from the trial's seed in `setup`, scores by code, and carries a difficulty knob.
  `src/tasks/gen.js` (seeded RNG, `seedFor`, lenient answer readers), `src/calc.js`.
- **Instance seeds**: `runMatrix` draws one seed per run or takes `--instance-seed N` (web: "instance
  seed"); every trial gets `seedFor(instanceSeed, task, index)`, so all modes and clients in a run see
  the same instance — a paired design — and the seed re-mints the run later. Recorded on the run,
  the row (`seed`), the index and the CSV.
- **Capability tags**: every task declares `capabilities` (tool-use, multi-step, arithmetic,
  deduction, counting, extraction, planning, state, …), exposed by `listTasks` for the scorecard to
  come; generated families are marked `seeded`.
- Tests: 204 (`test/gen`, `test/reasoning`: generator determinism, truth replay from the recorded
  operations, brute-force uniqueness and clue minimality, tool ↔ truth agreement, seed pairing).

### Measured (four trials per cell, instance seed 2026 — every model saw the same problems)
- **The four modes on the generated families**, hosted models (correct/4 as noHarness · schemaOnly ·
  toolOnly · harness), with the original answer-only schemas:

  | task | gpt-4o-mini | gpt-5.4-mini | claude-haiku-4-5 |
  |---|---|---|---|
  | wordmath2 | 4 · 2 · 4 · 4 | 4 · 3 · 4 · 4 | 4 · 4 · 4 · 4 |
  | wordmath4 | 4 · **0** · 4 · 3 | 4 · **1** · 4 · 4 | 4 · 4 · 4 · 4 |
  | wordmath6 | 4 · **0** · 4 · 4 | 4 · **1** · 3 · 3 | 4 · 4 · 4 · 4 |
  | datecalc1 | 2 · 2 · 4 · 4 | 3 · 4 · 4 · 4 | 3 · 3 · 4 · 4 |
  | datecalc3 | 3 · 0 · 2 · 2 | 3 · 2 · 3 · 4 | 3 · 3 · 4 · 4 |
  | logicgrid3 | 3 · 2 · — · 2 | 4 · 2 · — · 2 | 4 · 4 · — · 4 |
  | logicgrid4 | 2 · 0 · — · 0 | 3 · 1 · — · 1 | 4 · 4 · — · 4 |
  | tally20 | 3 · 1 · 4 · 4 | 4 · 4 · 4 · 4 | 4 · 4 · 4 · 3 |
  | tally60 | **1** · 1 · 4 · 4 | 3 · 1 · 4 · 4 | 3 · 4 · 4 · 4 |

  Readings: the calculator, date and query tools do their job — `tally60` by eye is 1/4 for
  gpt-4o-mini and 4/4 with `query_rows`; tool-argument verdicts were 100 % everywhere. But
  **schema-only collapsed on anything that needs working** (gpt-4o-mini 4/4 → 0/4 on wordmath4 and
  6, both OpenAI models to 1–2/4 on logic grids), while Haiku held 4/4 across the board. The
  mechanism is the harness's own instruction — "reply with the JSON value only, no prose" — and a
  schema whose first field is the answer: the model commits before it thinks.
- **The fix, measured paired**: the four families' schemas gained a `work: string[]` field placed
  before the answer, and the same instances were re-run in schema-only and harness mode on the two
  OpenAI models. Schema-only: **26 instances flipped wrong → right, 2 right → wrong** (gpt-4o-mini
  wordmath4 0/4 → 4/4, wordmath6 0/4 → 4/4, logicgrid3 2/4 → 4/4; gpt-5.4-mini wordmath6 1/4 → 4/4,
  logicgrid4 1/4 → 3/4). Harness mode moved 8 up, 5 down — noise, with one caveat: gpt-4o-mini's
  wordmath6 harness went 4/4 → 1/4, and its transcripts show bookkeeping slips between calculator
  results while it also narrates the working (73 copied as 51; a final ×10 forgotten). For the weak
  model, writing the work and driving the tool at once costs attention on six-step chains. The
  `work` field stays: without it schema mode measures answering without thinking.
- **Local ornith-1.5:9b**, same seed (answer-only schemas): 89 % → 94 %, and **no schema-only
  collapse** — the thinking model reasons before it writes JSON, so the answer-only schema cost it
  nothing where the OpenAI models fell to 0–1/4. One wordmath4 instance was answered 576 for 288 in
  all four modes: consistent and wrong. Table in docs/results.md.

## 2026-09-07 — parallel trials, variance, multi-step tasks, skills, sub-agents, stressors

### Added
- **Parallel trials** ([14]): `--parallel N` / web "in parallel". `runMatrix` keeps plan order for
  launches and collects rows as they finish; a real-harness arm always runs alone because arms are
  scored from the webserver's time-windowed log. New `trial-start` events light every in-flight cell
  in the live view. 48 trials in 8 s at parallel 8 versus 24 in 36 s serial on gpt-4o-mini, latency
  unchanged.
- **Stability metrics** ([15]): per cell `agreementPct` (share of repeated trials giving the modal
  canonical answer), `distinctAnswers`, `flaky`; per mode `summary.stability`, phrased by
  `describeStability`. Canonical answers via `eval.canon` on tasks with fixed truth (`health`,
  `reason`, `regex`); rows carry `canon`; CSV and index columns added. First reading: `reason`
  free-form is wrong the same way every time (100 % agreement at 0 % correct) — a systematic miss,
  not noise.
- **Multi-step tasks** ([17]): the `restock` family (`restock3/6/12/30`) against new stateful
  inventory scenarios on the webserver (`POST /api/scenarios`, items, `PATCH` → ticket, `summary`,
  `confirm` refused while anything is still low). Truth is the server's end state read after the
  answer. Runner hooks: per-trial `task.setup()` → `ctx` (prompts, system, goal and tools may be
  functions of it; ground, scorers and the tool-use judge receive it), task-level `maxRounds`,
  arms' `goalPrompt(task, mode, fallback, ctx)`. The drawer shows each trial's scenario.
- **Skills** ([19]): `skills/<name>.md` playbooks for every tool task (the restock family shares one).
  `src/skills.js` wraps any client as `<client>@skill:preload|ondemand|native`; preload appends the
  playbook to the system/goal prompt, on demand offers a `load_skill` tool and records whether it
  was read, native uses the arm's own channel (Claude Code and Pi `--append-system-prompt`, Codex
  `AGENTS.md` in a scratch cwd). `summarize` pairs variants with their base client
  (`delta.bySkill`, `delta.skill[how]`); web "skill" setting with A/B choices; rows carry `skill`,
  `baseClient` and the effective system prompt.
- **Sub-agents** ([18]): `src/agents.js` wraps a client as `<client>@agents:available|required`; the
  synthetic parent gets a `delegate(goal)` tool whose children run the task's tools (never
  `delegate`), in parallel within a turn, and fold back into the parent's row (tool calls tagged
  `agent: n`, usage summed, `row.agents` with each child's goal and answer). Claude Code's Agent
  tool is allowed for its variant and counted. `variantDeltas` generalizes the pairing;
  `delta.byAgents` / `delta.agents[how]`; web "sub-agents" setting; drawer lists the children.
- **Stressors** ([20]): stress profiles applied per scenario on the server — `flaky` (first list and
  first update per item answer 503 once), `budget` (low + 5 requests, then 429), `haystack` (same low
  items in an inventory of 60), `distractors` (history, price and a reorder-all trap; extra item
  fields). `src/stress.js` wraps a client as `<client>@stress:<profile>`; the task's setup requests
  the profile and `ground` folds the scenario's op log into `row.stress` (requests, failures served,
  refused, distractor calls, trap uses). Tool-use verdicts fail on any distractor call. Web "stress"
  setting; `delta.byStress` / `delta.stress[profile]`.
- `restock30` (thirty low items in an inventory of sixty, the scenario cap).
- Tests: 195 (`test/parallel`, `stability`, `restock`, `sut` (the webserver in-process on a random
  port), `skills`, `agents`, `stress`).

### Measured (four trials per cell unless noted; tables in docs/results.md)
- **Multi-step curve**, synthetic harness: gpt-4o-mini 2/4 · 1/4 · 0/4 at 3/6/12 items (skips the
  marginal item, then over-corrects; 113 k tokens at 12), gpt-5.4-mini 4/4 · 4/4 · 3/4, haiku 4.5
  4/4 · 4/4 · 4/4. Arms (3 per cell): Pi/gpt-4o-mini 3/3 · 2/3 · 0/3 (232 k tokens at 12), Claude
  Code/haiku 3/3 everywhere (27 k), Codex/gpt-5.4-mini 2/3 · 3/3 · 3/3 (~100 k). The model sets the
  ceiling, the harness sets the cost.
- **Skills**: preload lifted gpt-4o-mini where it was sloppy (restock3 2/4 → 3/4, restock6 1/4 →
  3/4) and did nothing at 12; on demand was never loaded (0/12) and cost a trial. Codex 2/3 → 3/3 at
  K = 3 with either delivery; Pi + gpt-4o-mini got worse and up to 4× more expensive (914 k tokens
  at 12) — a skill amplifies whatever loop it lands in. Local ornith 9b / qwen3.8 27b were already
  at ceiling; pooled −6 pp. A playbook never substituted for a stronger model.
- **Sub-agents**: offered, no model delegated (gpt-4o-mini, gpt-5.4-mini, haiku, Claude Code's Agent
  tool: 0 uses). Required at 12 items cost −25 pp pooled with 2–2.5× tokens; required at 30 items
  gained +33 pp for both capable models (gpt-5.4-mini's batch child halved tokens; Haiku's 16
  parallel children doubled them at flat wall time).
- **Stressors**: capable models robust to flaky (every 503 retried, ~2× tokens), budget (fits) and
  distractors (never touched, trap 0/48 synthetic, 0/12 arms); the haystack is the only stressor
  that reached a capable model (haiku 3/4 at 6, gpt-5.4-mini missed items at 12). Claude Code and
  Codex under flaky/budget/distractors at 6 items: 3/3 every cell; flaky cost Claude Code 2× the
  wall time and Codex 1.3× the tokens. gpt-4o-mini fails everything including budget exhaustion.

## 2026-09-06 — long-term storage, UI rework, four real-harness arms, roadmap

### Added
- **SQLite index over the run files** ([13]): `src/store.js` (`node:sqlite`, `results/index.sqlite`)
  with `runs` / `trials` / `cells`; `saveRun` fires `onRunSaved` so every save is indexed; `node
  src/cli.js index [--full]`, `query runs|trend|cell|worst` and a read-only `--sql`; `compact
  --older-than <days> [--yes]` strips prompts and transcripts from old runs while keeping every
  scalar. Web: the header's "find a run" filter (`GET /api/runs?q=…`) and an "Across runs" line in
  every trial drawer (`GET /api/cells`). The JSON files stay the source of truth.
- **"New run" setup panel**: collapsible (48 px rail), grouped task and model selection with
  per-group all/none, a filter box, presets; results as separated panels; readability pass.
- **Four real-harness arms** (Tier 5): `thoth` (`thoth --events` over ssh, stdin closed), `claude-code`
  (`claude -p --bare --output-format stream-json --verbose --allowedTools Bash`), `pi` (`pi --mode
  json -p --no-session -nc --tools bash`), `codex` (`codex exec --json --ephemeral -C …`); shared
  `harness/util.js` (goal prompt, argv splitting, timestamped child runner, event-level `ttftMs` /
  `ttfaMs`, recovery of the webserver's replies). Arms are `structuredOnly`; `summary.delta.byArm`
  gives each arm its delta against the same model's free-form baseline; tasks expose a plain `goal`.
  Thoth caveats: its `tool_result` events carry names and byte counts, not contents, so tasks whose
  truth is read from tool results cannot be scored from that arm; its gateway (hoosh) caches identical
  prompts for 300 s and withdraws a route after three failed probes; reaching a localhost webserver
  needs its shell tool (off by policy on arch) or a reverse tunnel; one-shot runs block on open stdin.
- Provider registry: harness providers with `kind: "harness"`; `gpt-6-astra` and `gpt-5.4-mini` for
  Codex; DeepSeek entry.

### Measured
- Same model, three harnesses (gpt-5.4-mini, 4 per cell): synthetic 16/16 · 1.9 s · 1.1 k tokens;
  Pi 14/16 · 4.2 s · 2.5 k; Codex 15/16 · 4.0 s · 38 k. Both arm misses were the dependent second
  call of `chain` never being made — the first harness-attributable correctness difference.
  haiku: synthetic 16/16 vs Claude Code 16/16 at 3× the time and tokens. gpt-6-astra: raw 0/16,
  Pi and Codex 16/16 each.

## 2026-09-04 — LLM judge, streaming timings, arm deltas, webserver log

### Added
- **LLM-as-judge** ([5]): `src/judge.js`, `makeJudge(client)`; scorers receive `{ judge, mode }`;
  `--judge provider:model` / `BENCH_JUDGE` / UI select; the `explain` task (open-ended, judged,
  threshold 0.75); rows keep `judgeScore` / `judgeReason`.
- **Streaming client** ([8]): SSE parsing, tool-call deltas merged by index, usage from the trailing
  chunk; `ttftMs` (first token, reasoning included) and `ttfaMs` (first answer token).
- **Webserver `GET /api/recent?since=&until=`**: a log of the last few hundred `/api/hello` replies,
  so arms are scored against what the server actually served rather than scraped output (Pi's jq
  reshaping had scored it 8/16).
- `summary.delta.byArm`; qwen3.8:27b-mlx as the second local model (qwen3.5 parked: reasons for
  minutes through Ollama's OpenAI route).

### Measured
- Same model, different harness (4 per cell): Pi/gpt-4o-mini 15/16 at ~2.5× tokens and 2× time of
  the synthetic harness; Claude Code/haiku 16/16 at ~3.5× tokens and 3× time. Correctness equal;
  cost is where harnesses differ.
- qwen3.8:27b-mlx 12/28 → 28/28 (+57 pp, p < 0.001), tools-only 24/24, schema-only 12/28.

## 2026-09-03 — audit, statistics, calibration, task diversity, data outputs

### Fixed (the audit)
- Wrong normal-CDF coefficients and a z-test at n = 3 → correct A&S 7.1.26 and **Fisher's exact
  test** as the headline p-value, with "inconclusive — too few trials" when no outcome could reach
  p < 0.05.
- `lookup` unsatisfiable (ground fetched after the trial got fresh ids) → truth is what the tool
  returned during the trial; `items` wrapper unwrapped everywhere (`unwrapList`).
- `regex` scorer rejected its own prompt's format; duplicate string replaced; `reason` ground was
  an array called as a function, and its answer key was wrong (8, not 10).
- Web UI crashed on runs with both modes (browser now imports `/lib/runner.js`); `aggregate` crashed
  on missing modes; `schemaOnly` / `toolOnly` existed by name only (now declared by every tool
  task; undeclared pairs skipped and reported); `.env` never reached `process.env`; `PORT` clash →
  `SUT_PORT`; malformed files in `results/runs/` no longer break the listing; stale Anthropic ids.
- Schema instruction reworded to "an instance of this schema, not the schema itself": removed the
  envelope echo on every model and lifted the 9 B model's harness from 80 % to 90 %.

### Added
- Tool-use hygiene ([2]): `eval.toolUse` per task → `toolUseOk`, `toolArgsOkPct`.
- `chain` (dependent second call) and `transform` (per-name transform) tasks ([4]); the 2×2
  decomposition specs ([3]); determinism knobs `--temperature`, `--seed`, `--model-param` ([6]).
- CSV export ([7]), latency p50/p95/max ([8]), per-cell significance in the CLI ([9]), schema
  validator coverage ([11]), version pinning on every run ([12]), `cli show <id> --table`.
- Web UI rebuilt on the "Ledger" design (Newsreader + IBM Plex Mono, violet accent) with a
  light / dark / system switch.

### Measured
- Calibration at 10 per cell, six tasks: gpt-4o-mini 30/60 → 60/60 (+50 pp, p < 0.001), haiku
  32/60 → 60/60, ornith-1.5:9b 30/60 → 58/60. Tools are the whole lift (toolOnly = harness);
  schema alone buys nothing (schemaOnly = baseline). `lookup` and `chain` are true tool-essential
  floors (0 % without a tool). gpt-4o-mini answers the marbles question wrong in prose and right
  in JSON, every time.

## 2026-09-02 — repairs and more tasks
- Task additions and scorer repairs ahead of the audit; `reason` and `regex` reworked.

## 2026-08-28 / 29 — first working version
- Tasks × modes × clients matrix over one OpenAI-compatible client; CLI and web UI; saved runs;
  harness-mode parsing fixes for client resolution; cleanup pass.
