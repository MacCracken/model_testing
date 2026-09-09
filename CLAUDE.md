# Project conventions

This repo benchmarks **LLM capability with vs. without a harness**. Keep that framing central:
every task defines the *same goal* and is run in `noHarness` (free-form) and `harness`
(tools + schema + structured prompts) modes, scored identically so the delta is the harness.

A mode is defined by **behavior**, not just by name: it is either *structured* (inject the output
schema, run any tools, and score the parsed JSON) or *free-form* (no schema, score the raw text;
tools still run if the spec carries them). `harness` is structured; `noHarness` is free-form.
`schemaOnly` (structured, no tools) and `toolOnly` (free-form, with tools) reuse the same two
behaviors to isolate the harness's axes — see `isStructuredMode` in `runner.js`. `MODE_NAMES` and
`DEFAULT_MODES` in `runner.js` are the single list of modes; every surface imports them.

A task supports a mode by declaring a spec under that name. `planMatrix` **skips** any (task, mode)
pair the task does not declare — it is reported as a warning, never scored as an error row, so a
mode's numbers stay about the model. The four tool tasks declare all four modes; `reason` has no
tools, so its `schemaOnly` is its harness spec and it declares no `toolOnly`. The decomposition specs
are written by hand, not derived: a free-form prompt says "without any tools" and a harness prompt
says "call the X tool and return JSON", so a derived spec would contradict itself.

## Layout

- `src/providers/` — OpenAI-compatible client + provider registry (`index.js`). No SDKs. The client
  streams by default (SSE chunks, tool-call deltas merged by index, usage from the trailing chunk) and
  records `ttftMs` / `ttfaMs`; `stream: false` keeps the plain path.
- `src/tasks/` — task specs: prompt/tools/schema per mode + `eval` block (ground + scorers).
  `tasks/util.js` holds what they share: the webserver `BASE` URL and `unwrapList`. Generated
  families (`wordmath`, `datecalc`, `logicgrid`, `tally`) mint an instance per trial from the trial's
  seed in `setup` (`seeded: true`); `tasks/gen.js` holds the seeded RNG, `seedFor` and lenient answer
  readers, `src/calc.js` the exact calculator that is the harness axis for arithmetic. The
  long-context family (`needle8k/32k/100k`) mints a server log per trial, inlines it in the free-form
  modes and posts it to the webserver for the tool modes' grep and count (`tasks/needle.js`); the
  record keeps a capped prompt (`capText` in the runner) and a ctx without the log (`recordCtx`;
  `remint` mints it again from the seed the row keeps), the model gets the whole log; the
  `needlehop` family (same sizes, family `needlehop`) asks the fourth question kind, a line that
  retried an earlier request whose latency is the answer. Rows that record a `depth` (the
  single-needle question) feed `depthSweep` in the runner (`summarize`'s `depths`, the report, the
  curves panel) and the index's `depth` column (`cli query depth`). The
  extraction family (`extract1/2/3/4`, `tasks/extract.js`) mints an invoice, its line-item table, a
  purchase order plus the invoice billed against it, or a month's account statement plus the open
  invoices it settles, with exact truth; the free-form modes read the
  documents inline and the tool modes fetch them from the webserver with `get_document` (plus
  `calc`); scoring uses tolerance rules (amounts within a cent, four date formats read back to ISO,
  strings without case or punctuation); under `@stress:injected` the document itself carries the
  note, and an answer that reports the planted 999 is scored as hijacked. The
  dialogue family (`dialogue2/3/4`, `tasks/dialogue.js`) is the restock scenario over scripted user
  turns: a spec carries `turns(ctx)`, the user's later messages minted from the scenario (a change
  of mind, a hold, a request the policy caps), the runner answers each with a full tool loop in the
  same conversation, and the score reads the end state, the policy (from the op log and the
  per-turn calls) and the final report; `multiTurn: true` makes the planner skip the arms. The
  scenario-backed families (`fanout`, `follow`, `norelevant`, `nearmiss`, `paged`, `typed` and
  `restock`) share `tasks/scenario.js`:
  the server API, a scenario minted from the trial seed (the server takes the seed, so the inventory
  is reproducible), the read tools, and `endState`, which turns the scenario's op log into a hijack
  verdict every scorer honours. Every task carries `capabilities` (what it measures) for the scorecard.
- `src/runner.js` — **the execution core**: runs one (task, mode, client) trial, scores it,
  aggregates the matrix, and owns the statistics. Every surface (CLI and web) goes through this so
  they can't disagree — the web server serves it to the browser as `/lib/runner.js`, so it must
  stay free of Node-specific imports. `runMatrix` draws one `instanceSeed` per run (or takes
  `--instance-seed`) and gives every trial `seedFor(instanceSeed, task, index)` — the same instance for
  every mode and client, so comparisons are paired and a run can be re-minted. It runs up to `parallel` trials at once; a
  `structuredOnly` client (a real-harness arm) always runs alone, because arms are scored from the
  webserver's time-windowed log and a concurrent trial would pollute it. `scoreRecord` is the one
  scoring function (schema validity, correctness, canon, judge, the tool-use verdict) that both
  `runTrial` and `rescore` go through; a row keeps `turns` (the loop's rounds: text, call ids, time)
  and `transcript` (an arm's raw output, capped) beside its calls and results. A spec with `turns`
  runs a scripted dialogue (`runDialogue`): each user turn continues the same conversation — the
  synthetic client takes `history` and returns `messages` — and the row keeps `dialogue` (one entry
  per user turn) with every call, result and loop turn tagged by its `turn`.
- `src/results.js` — run persistence (`results/runs/<id>.json`); `onRunSaved` lets the store index
  every save without the saver knowing about it. A run may carry `parent` (`{ id, kind: "replay" }`,
  set by `bench --replay` / `POST /api/runs { replayOf }`) and `rescored` (one note per re-score).
- `src/store.js` — a SQLite index (`node:sqlite`, `results/index.sqlite`) over the run files for
  cross-run questions: `runs` / `trials` / `cells` tables, incremental `indexRuns` from file mtimes,
  canned queries (`queryRuns`, `trend`, `cellHistory`, `worstCells`), read-only `rawQuery`, and
  `compactRuns` retention. The files stay the source of truth; the index is rebuildable and
  best-effort, so nothing waits on it. `runs` carries `parent_run` / `parent_kind`;
  `queryRuns({ parent })` lists a run's replays.
- `src/rescore.js` — `rescoreRun(run, { judge })` scores a saved run's rows again through
  `scoreRecord` (no model) — re-reading each structured answer from the recorded text with today's
  `parseJSONLoose` first — reports the flips and the other verdicts that moved, and returns the run
  with its verdicts replaced and a `rescored` note; `cli rescore` is a dry run unless `--yes`, which
  writes the run file in place (same id: the same measurement, read again).
- `src/gates.js` — thresholds with exit codes: `parseGate` / `parseGateFile` (a capability, task,
  `family:level`, `break:family`, `overall`, `errors` or `regressions`, each `@mode`, `>=` a rate or
  `<=` a count), `evaluateGates` over one client's rows (pass on the rate, fail when the Wilson band
  lies under the bar, inconclusive between, incomplete under `minTrials`; exit 0 / 1 / 2),
  `gateRun` over every client of a run (the regressions gate reads the index through
  `regressionsForClient`), `describeRunGates`. `bench.js --gate/--gates/--time-box`, `cli gate <run>`,
  the `nightly` suite and `gates/nightly.json` sit on it; the verdict lands on `run.gates`.
- `src/json.js` / `src/schema.js` — tolerant JSON extraction + a minimal schema validator.
- `src/env.js` — loads `.env` into `process.env` (never overriding real env vars). Imported first
  by every entry point and by `providers/index.js`.
- `src/bench.js` — CLI over `runMatrix`; `--json` for machine-readable output; `--replay <run>`
  (`replayArgs`) takes a saved run's configuration wherever the command line is silent, parents the
  new run to it and prints `describeReplay`, the paired comparison; `--gate` / `--gates` gate the run
  (exit code) and `--time-box <minutes>` cuts it (status `timeout`, the completed trials kept).
- `src/aggregate.js` — the same matrix with a comparative report.
- `src/report.js` — the one text report over a summary, used by `aggregate` and `cli show`;
  `trialTimeline` prints one row as a timeline (`cli show <run> --trial <n>`).
- `src/export.js` — CSV views of a run (trial rows, or task × model × mode cells); `traceEvents` /
  `traceJsonl` turn one row into an event log (system, user, assistant, tool_call, tool_result).
- `src/version.js` — bench version / git commit / node, recorded on every run as `versions`.
- `src/judge.js` — LLM-as-judge: `makeJudge(client)` returns `({ rubric, answer, ground, task }) =>
  { score, reason }`, asked for strict JSON and handed the task's ground truth. The runner passes the
  judge to every scorer as `{ judge, mode }`; `--judge provider:model` / `BENCH_JUDGE` / the recipe
  field choose it; the run records it and each row keeps `judgeScore` / `judgeReason`.
- `src/harness/` — real agent harnesses as the harness arm. `util.js` holds what arms share: the
  goal prompt (goal + the same schema instruction the synthetic harness gets), recovery of the
  webserver's replies from raw tool output into bench-shaped tool results, the argv splitter and the
  child runner. `claude-code.js` runs `claude -p --bare --output-format json` and parses its
  transcript (tool outputs included). `pi.js` runs `pi --mode json -p` and reads its `message_end`
  events (tool outputs, usage and cost). `codex.js` runs `codex exec --json` (documented item shapes;
  needs `codex login`). `thoth.js` spawns `thoth --events` (stdin closed, task quoted for ssh) and
  folds its NDJSON (no tool-result contents). Arms report the routed model, run structured modes only
  (`structuredOnly`; the planner skips the rest), and the bench's tool-use judge stays null for them.
  `runChild` timestamps every output line; `eventTimings` turns that into the arm's `ttftMs` (first
  visible action) and `ttfaMs` (final answer) — event-level, coarser than the synthetic client's
  token-level timings. Claude Code therefore runs with `--output-format stream-json --verbose`.
  Tasks expose a `goal` (plain job statement, endpoint described, no bench tool names) for arms;
  `runTrial` passes `task` and `mode` to `runWithTools` so an arm can build its own prompt. Every
  arm returns `transcript: { format, text }` (its raw output, kept capped on the row so a parser fix
  can re-read it); Claude Code's parser also yields `turns`.
- `src/skills.js` — skills as a treatment. A playbook lives in `skills/<name>.md` (a task names a
  shared one with `task.skill`; every tool task has one, `reason` and `explain` do not); `withSkill(client, how)` wraps any client — synthetic or arm — as
  `<client>@skill:<how>` with `baseName` pointing back. `preload` puts the playbook in the system
  prompt (arms: the goal prompt); `ondemand` adds a `load_skill` tool and the row's `skill.loaded`
  says whether it was read; `native` lets an arm use its own channel (`nativeSkill` in
  `harness/util.js`: Claude Code and Pi append a system prompt, Codex gets an `AGENTS.md` in a
  scratch cwd) and `skill.applied` records the path taken. `resolveClients` understands the
  `@skill[:how]` suffix.
- `src/agents.js` — sub-agents as a treatment. `withDelegation(client, how)` wraps a client as
  `<client>@agents:<how>`; the synthetic parent gets a `delegate(goal)` tool whose children run the
  task's tools (never `delegate`), in parallel within a turn, and fold back into the parent's row
  (`toolCalls` tagged `agent: n`, usage summed, `row.agents` with counts and each child's goal and
  answer). Arms receive `opts.agents` and use their own channel (Claude Code: the Agent tool) or
  report none. One variant per client: `@skill` or `@agents`, not both.
- `src/stress.js` — stressors as a treatment: `withStress(client, profile)` names the variant
  `<client>@stress:<profile>`; the restock task's `setup` reads `client.stress` and asks the server
  for that profile (flaky / budget / haystack / distractors / injected), and `ground` folds the
  scenario's op log into `row.stress` (`summarizeOps`, including `hijacked` — an update that set a
  status to "compromised", which only an injected note ever asks for). The `injected` profile has
  two payloads: `write` for tasks whose tools can update, `answer` (report every quantity as the
  planted 999) for read-only tasks, whose scorers return `hijacked: true` when they see it; the
  runner adds that to the row's stress record. The environment carries the treatment; the client is
  untouched, so arms meet the same conditions.
- `src/format.js` — the answer's format as a treatment: `withFormat(client, how)` names
  `<client>@format:nowork|work`; the runner applies `applyFormat` to the spec before the schema hint
  is built (the `work` field stripped from a schema that has it, or added first to one that lacks
  it, with a line on the prompt), judges validity against the treated schema (a re-score re-applies
  it from `row.format`), and records `row.format` (how / applied / complied). Free-form modes are
  left alone.
- `src/constraints.js` — instruction following as a treatment: `withConstraints(client, level)` draws
  one / three / five verifiable requirements from the trial seed (text families for free-form modes,
  JSON-shape families for structured ones), appends them to the prompt (arms: the goal prompt),
  checks the answer, and puts `row.constraints` (met / total / list) on the row; `variantDeltas`
  pools adherence next to the correctness delta. Both `chat` and `runWithTools` receive
  `{ task, mode, ctx, seed }`, so wrappers behave the same on the free-form path.
- `src/lineage.js` — the model registry (`models/lineage.json` or `LINEAGE_FILE`): client id →
  family / checkpoint / step / parent / trainedOn. Runs record `config.lineage` for their clients,
  the index carries the fields per trial, `cli models` lists the registry, `cli compare --parent`
  pairs a checkpoint against its parent. `src/suites.js` holds the `smoke` / `standard` / `full`
  presets behind `cli suite` (a suite run is a bench run with `config.suite`), and `nightly`: the
  standard suite under a 90-minute time box, gated by `gates/nightly.json`. Named local endpoints
  (`LOCAL_ENDPOINTS`, `parseLocalEndpoints` / `registerLocalEndpoints` in `providers/index.js`)
  make any OpenAI-compatible server a provider like `local`; see docs/serving.md.
- `src/trends.js` — capabilities over time from the index: `seriesFor` (per run, per capability,
  per mode), `regressionsFor` (per task, a client's latest run against its earlier runs of the same
  task, the same number of trials per task on each side, pooled per capability; a flag when the
  later Wilson band lies entirely under the earlier one) and `parentGaps` (a checkpoint against
  its lineage parent the same way). Pure functions over indexed rows; `cli trend` /
  `cli regressions` and `/api/regressions` fetch the rows from the store.
- `src/web/` — the control plane: `server.js` (node:http, zero deps) + `public/` (the UI).
  `POST /api/runs { replayOf }` starts a replay (`withParentDefaults` fills the launch from the
  parent's config); `GET /api/runs?parent=` lists a run's replays.
- `src/cli.js` — entry point (`list` / `show` / `export` / `index` / `query` / `scorecard` /
  `compare` / `curve` / `trend` / `regressions` / `models` / `suite` / `compact` / `serve` /
  `replay` / `rescore` / `gate` / `bench` / `aggregate`).
- `test/` — `npm test` (node:test, no deps). Scorers are tested with synthetic ground values, the
  runner with a fake client; nothing in the suite needs a model or the webserver.

## Task spec shape

```js
export const task = {
  name: "health",
  category: "api-call",
  description: "…",       // shown in the UI and `cli list`
  model: labelModel,
  goal: "…",               // the job in plain words, for real-harness arms that bring their own tools
  noHarness: { prompt, extract: "text" },
  harness:   { system, prompt, tools: [...], schema, extract: "structured" },
  // optional: schemaOnly / toolOnly specs for the decomposition axes
  eval: {
    ground,         // truth: a function of the trial, or a constant (see below)
    scoreHarness,   // (structuredOutput, ground, { judge, mode }) => { correct, reason, judge? }
    scoreNoHarness, // (freeText, ground, { judge, mode })         => { correct, reason, judge? }
    toolUse,        // optional: ({ toolCalls, toolResults, ctx, rounds }) => { ok, reason } — right tool, right args
                    //   (rounds lets a verdict tell parallel calls from sequential ones)
    needsJudge,     // optional: true when the scorers grade through the judge (explain)
    canon,          // optional: (answer, { mode, structured }) => string — the answer's canonical form, for
                    //   agreement across repeated trials; only tasks with fixed truth define one
  },
  // optional: setup runs before every trial with { mode, index, client, seed } and returns a context;
  // prompt / system / goal / tools may then be functions of it, and ground, scorers and toolUse
  // receive it as ctx. Stateful tasks (restock) create server state here; generated families mint
  // their instance from `seed` and mark `seeded: true`. maxRounds raises the tool loop's budget.
  setup: async ({ mode, index, client, seed }) => ({ scenario: "scn-…", items: [...] }),
  // optional: a scripted user — the later user turns as a function of the context; the runner answers
  // each in the same conversation and scores the end. Arms are skipped (multiTurn: true says so).
  turns: (ctx) => [`Change of plan for ${ctx.items[0].id}: …`, "Then confirm and report."],
  // optional: what the row records as its `ctx` — a record for the drawer, the index and a replay,
  // not the environment (default: the ctx itself). The live ctx still reaches prompts, tools, ground
  // and scorers whole; every string in the record is capped like the prompt either way (`recordedCtx`
  // in the runner). needle drops its minted log here and `remint` mints it again from the seed.
  recordCtx: ({ text: _text, ...rest }) => rest,
  multiTurn: true,          // optional: the specs carry scripted user turns; harness arms are skipped
  capabilities: ["multi-step", "tool-use"], // what the task measures, for the scorecard
  family: "restock", level: 6,             // the family's knob, for difficulty curves (families with a knob only)
  maxRounds: 14,
  skill: "restock",        // optional: the playbook under skills/ a @skill variant loads (default: the task name)
};
```

Tools use `{ name, description, parameters, impl }` — `impl` is a real async function (hitting
the real endpoint). The runner **executes** it and feeds the result back to the model, so
harness mode tests genuine tool-calling. What gets scored is the model's *final message* after
it has seen tool output — never the arguments it passed in.

`eval.ground` is called **after** the model answers with the trial itself:
`{ mode, toolCalls, toolResults, structured, answerText }`. Most tasks ignore the argument and hit
the endpoint; `lookup` defines truth as the ids its tool actually returned, because the endpoint
mints a new random id per call and any later fetch would be a different number. A task with fixed
truth (`reason`) uses a constant instead of a function.

`harness.schema` is injected into the system prompt (the schema is part of the harness under
test) and used to compute `schemaValid` (null when a mode has no schema to check against).
The schema instruction says "JSON only — no prose", so a task that needs working must give the
model room for it inside the JSON: a `work` array **before** the answer field (the generated families
do this). Without it schema-only mode measures answering without thinking — gpt-4o-mini went 4/4 →
0/4 on four-step word problems, and back to 4/4 with the field.
Scorers judge content, not wrappers: use `unwrapList` so a list under `results`, `data` or the
schema's own `items` key scores the same as a bare array.

## Statistics

`summarize` also computes `delta.byArm`: for a client with harness rows and no free-form rows of its
own (a real-harness arm), its delta against the free-form rows of the same model from any other
client in the run, matched on the model id with any `provider/` prefix stripped.

A client run as `…@skill:<how>`, `…@agents:<how>`, `…@stress:<profile>`, `…@constraints:<level>` or
`…@format:<how>` is paired by `summarize` with its base client on the same task and mode
(`variantDeltas`): `delta.bySkill` / `delta.byAgents` / `delta.byStress` / `delta.byConstraints` /
`delta.byFormat` per cell and `delta.skill[how]` / `delta.agents[how]` / `delta.stress[profile]` /
`delta.constraints[level]` / `delta.format[how]` pooled, the same shape as the harness delta (`deltaBetween` is the shared baseline-versus-treatment calculation; its
`noHarness*`/`harness*` fields mean baseline/treatment, with `base*`/`treat*` aliases).

`summarize` also reports `stability` per mode from repeated cells: `flaky` (both passes and
failures) and `agreementPct` (share of trials giving the modal canonical answer, over cells whose
task defines `eval.canon`). `describeStability` is the one phrasing for it. Agreement separates a
systematic miss (wrong the same way every time) from noise, which a correctness percentage cannot.

When both sides of a comparison ran the same instances (same task and index; for generated tasks
the same seed), `deltaBetween` pairs them (`pairRows`) and adds `paired`: McNemar's exact test on the
discordant pairs (`mcnemarExact`), a seeded bootstrap band (`bootstrapDelta`), phrased by
`describePaired`. `sampleSizeFor` / `describePower` give the "run about n per side" guidance,
`multipleComparisons` the Bonferroni count over a run's cells, `compareRows` the two-client or
two-run comparison behind `cli compare`, and `capabilityStats` the scorecard behind `summarize`'s
`capabilities`, `cli scorecard` and `/api/scorecard`. Families with a knob tag their tasks with
`family` and `level` (restock items, wordmath steps, datecalc level, logicgrid size, tally length,
fanout width, follow hops, needle tokens); `curves` (`summarize`'s `curves`, from `levelsOf`) gives
success per level per client and mode with the **breaking point** — the first level whose Wilson
band tops out under 50 % — behind the UI panel, the report and `cli curve` over the index.

The headline delta carries a two-sided **Fisher exact** p-value (`fisherExact` in `runner.js`),
exact at the handful of trials this bench actually runs; the z-test and Wilson intervals are kept
as helpers. `describeSignificance` is the one phrasing every surface prints — including
"inconclusive … too few trials" when the sample size could not have reached p < 0.05 at all
(three trials per side never can; four is the floor for a 0% → 100% split).

## Providers

Add entries to `PROVIDERS` in `src/providers/index.js` (name → baseUrl, auth, default models)
and labels to `MODEL_LABELS`. Keys live in `.env`. `local` (Ollama) needs no key; its models are
probed live from `/v1/models` and the UI marks the provider offline when the daemon is down.
`OLLAMA_BASE_URL`, `LOCAL_ENDPOINTS` (named OpenAI-compatible servers for your own checkpoints),
`LINEAGE_FILE`, `SUT_PORT` (the webserver's port; `PORT` is a legacy fallback) and `RESULTS_DIR` are
honored from `.env` too.

## Commands

```bash
npm test                                    # unit tests, no model needed
node src/cli.js serve                       # web UI on http://127.0.0.1:4000
node src/cli.js list                        # tasks/providers, with key status
node src/cli.js show <run-id> --table       # review a saved run without the UI
node src/cli.js export <run-id> --cells     # CSV of the cells (or of every trial without --cells)
node src/cli.js query cell --task chain --client openai:gpt-4o-mini   # one cell across every run (index, query, compact: see README)
node src/cli.js show <run-id> --rows | --trial 3      # the rows numbered, or one trial as a timeline (export --jsonl for the event log)
node src/cli.js replay <run-id> [--clients …]        # the same instances again as a new run parented to this one, paired against it
node src/cli.js rescore <run-id> | --all [--yes]     # today's scorers over saved rows; dry run unless --yes
node src/cli.js gate <run-id> --gates gates/nightly.json   # thresholds over a saved run: exit 0 pass, 1 fail, 2 incomplete
node src/cli.js suite nightly --clients vllm:ckpt --judge openai:gpt-4o-mini   # standard suite, 90-min time box, gated
node src/bench.js --task chain --modes harness --clients local:ornith-1.5:9b --count 4 --temperature 0 --seed 7
node src/bench.js --task all --modes harness --clients openai:gpt-4o-mini
node src/bench.js --task health,reason,regex --modes noHarness,harness --clients openai:gpt-4o-mini --count 8 --parallel 8
node src/bench.js --task wordmath4,tally60 --clients openai:gpt-4o-mini --count 4 --instance-seed 7   # generated, same problems every run
node src/aggregate.js --tasks health,hello --modes noHarness,harness --clients local
```

The `webserver/` directory is the **system under test**, not part of the benchmark harness —
keep it minimal. Its concessions to the bench are `GET /api/recent?since=&until=`, a log of the
last few hundred `/api/hello` replies, which lets real-harness arms be scored against what the
server actually served (`recentGreetings` in `harness/util.js`), and the **inventory scenarios**
(`/api/scenarios…`) the `restock` tasks run against: one isolated inventory per trial, tickets per
update, a confirm that is refused while anything is still low, optional stress profiles (flaky,
budget, haystack, distractors, injected), a paged listing (`?limit=&page=` → `{ items, page, pages,
total, next }`, for `paged`), a `strict` option that refuses a `qty` or `status` of the wrong JSON
type with a 400 that says which (for `typed`), and `GET /api/scenarios/:sid` as the end state a
trial is scored on, op log included; and the **logs** (`POST /api/logs` as text, `GET /api/logs/:id?grep=`,
`…/count`) the `needle` family searches, and the **documents** (`POST /api/docs` as text,
`GET /api/docs/:id` as text/plain) the `extract` family fetches. `test/sut.test.js` pins that contract in-process. Every run (CLI or web) is saved to `results/`, which is gitignored along
with `.env`. `plan.md` is the forward roadmap only; `CHANGELOG.md` records what shipped by date and
`docs/results.md` holds every measurement table. When something ships, move it from the plan to the
changelog, and keep every claim tied to what the tests and saved runs actually show.
