# Changelog

What shipped, by date. Full measurement tables live in [docs/results.md](docs/results.md); the
forward roadmap is [plan.md](plan.md). Dates are the commit dates; item numbers ([1]–[20]) are the
roadmap tiers as they were numbered while being built.

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
