# Changelog

What shipped, by date. Full measurement tables live in [docs/results.md](docs/results.md); the
forward roadmap is [plan.md](plan.md). Dates are the commit dates; item numbers ([1]–[49]) are the
roadmap's, stable across the plan, this file and the results.

## 2026-09-12 — cost in currency, three providers and the effort knob

### Added
- **Cost in currency** ([45]): `models/prices.json` gives per-million-token prices by model id (a
  client id or a trailing `*` works too; local serving is 0 — electricity and hardware are not
  counted), with the source and date of each price; the table is the user's to check, the bench
  cannot verify a price. Every row is priced when it runs (`row.cost`: dollars, the input, cached
  and output parts, the table's date), so a run keeps the price of its day; a model without an
  entry runs unpriced and the view says how many rows had no price. `summarize` adds cost to every
  cell and mode (`costUsd`, per trial, per correct answer) and a **correctness × cost × latency**
  view per model and mode — printed by the report, drawn by the UI as a new block, and by
  `cli cost <run> [--reprice]` (`--reprice` prices a run's unpriced rows from today's table for the
  view only). The index carries `cost_usd` per trial and per cell.
- **Providers** ([46]): Gemini (its OpenAI-compatible route), Mistral and xAI, keyed by
  `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`. With a key, their model lists are probed from
  the route's `/models` like a local daemon's, so the UI offers what the route has rather than a
  list that drifts. Untested here — no key for them in this `.env`; the routes are documented
  OpenAI-compatible and the client sends nothing provider-specific.
- **The reasoning-effort knob** ([46]): `--effort none|minimal|low|medium|high` for a run, or
  `<client>@effort:<level>` as a paired variant against the base (`delta.byEffort` / `delta.effort`,
  like the other treatments). Translated per provider in `src/effort.js`: `reasoning_effort` on
  OpenAI, Anthropic, Gemini, xAI, DeepSeek and Groq; `reasoning: { effort }` on Ollama's route, the
  one form it honours (checked against Ollama 0.33.3: `think: false`, `reasoning_effort` and the
  `/no_think` switch all left the local thinking model's reasoning untouched, `reasoning: { effort:
  "none" }` emptied it — and the graded levels change nothing there, only none does); nothing on
  Mistral, which has no such parameter. Every row now records `reasoningChars`, the characters of
  thinking the model returned (the client counts the reasoning channel while streaming), so whether
  a knob took effect is a number on the row — the cost view and the effort delta print it.
- Tests: 320 (the price table's matching and the cost of a row, the stats and the view, the index
  columns, the report block; the effort levels and their translation, the variant through the
  client spec and the run-level knob, the paired delta with reasoning characters).

### Measured (tables in docs/results.md)
- **What a right answer costs** (health, chain, wordmath4, restock6; four trials per cell, seed
  2026): in harness mode gpt-4o-mini answers 14/16 at $0.0012 per correct answer and Haiku 4.5
  16/16 at $0.0086 — seven times the price for the two extra answers; free-form, gpt-4o-mini's
  8/16 cost $0.0002 each. The whole matrix, 64 trials, came to $0.17.
- **Thinking off on the local model** (`local:ornith-1.5:9b@effort:none`, wordmath4 and chain in
  harness mode, four trials each, paired): the variant returned 0 characters of reasoning against
  326–562 for the base, answered in half the time (p50 4.5 s against 8.9 s) and lost one of eight
  answers (7/8 against 8/8, a wordmath4 miss; not significant at this size). `reasoning: { effort:
  "none" }` is the one form Ollama 0.33.3's route honours — the graded levels change nothing
  there.

## 2026-09-11 (later) — public anchors: GSM8K, IFEval and BFCL run here

### Added
- **Public benchmark sets as anchors** ([41], the native form of [40]): four tasks run through
  the same client against the same endpoint as everything else, scored by dependency-free
  reimplementations of their official checks — `gsm8k` (the test split's final number; free-form
  is zero-shot chain of thought, the harness adds the calculator and the work-then-answer schema,
  so the bench's own harness delta is measured on a public set), `ifeval` (541 prompts, all 25
  instruction types in `src/ifeval.js`; strict prompt-level pass, the loose verdict in the reason;
  free-form only, since the format is the test), `bfclsimple` and `bfclmultiple` (BFCL v4's AST
  check in `src/bfcl.js` — free-form is the leaderboard's prompting mode with the call written as
  text and parsed here, the tool modes are native tool calling scored on the call itself).
- **The cache** (`src/anchors.js`): `cli anchors fetch [all|names]` pulls the items from their
  public repositories into `anchors/` (gitignored) and records the URL, licence, byte count,
  SHA-256 and fetch date beside them; every row carries that provenance and the contamination
  caveat (the sets are on the open web and may be in any model's training data). A trial's index
  picks its item from one fixed permutation of the set (seed 2026), the same subset for every model
  and run.
- **Kept out of the headline**: anchor rows are tagged `source: "public"` (a `source` column in the
  index) and their capabilities are `public:<capability>`, so they never pool with the generated
  families in a scorecard, a gate or a trend. `cli anchors <client>` puts the anchor rates next to
  the bench's own tasks for the same capability; the UI lists them under "Public anchors · not the
  headline".
- Where the reimplementation is approximate, the row says so: IFEval's sentence and word counts
  (regular expressions for nltk), capital-word counts, and the response language (script ranges,
  then stopword votes, for langdetect) are marked `approximate` in the checker result and the
  reason.
- Tests: 312 (every IFEval instruction type against passing and failing responses, strict versus
  loose including the empty-variant rule; BFCL's type mapping, value comparison, call check, the
  Python-call parser; the cache, provenance and the permutation; the four tasks through the runner
  with fake models; the registry).

### Measured (the first 50 items of each set's fixed permutation, temperature 0; tables in docs/results.md)
- **GSM8K**: free-form zero-shot chain of thought lands where the published numbers put these
  models — gpt-4o-mini 96 %, gpt-5.4-mini 94 %, Haiku 96 % — and **the harness costs the two GPT
  minis 12–14 points** (82 % with the calculator and the schema; the calculator alone 86–88 %, the
  schema alone 94 %) while Haiku stays at 96 %. On the bench's own arithmetic tasks the same harness
  lifts gpt-4o-mini from 43 % to 81 %: the sign of the harness delta depends on how hard the
  problems are, and GSM8K is easy enough that a model driven through a tool does worse than one
  left to reason in prose.
- **IFEval**: prompt-level strict 86 % / 92 % / 88 % (instruction-level 90–94 %), loose within a
  point of strict; the instructions missed most were repeating the prompt, letter counts and
  paragraph counts. Eleven of the fifty prompts touched an approximate checker.
- **BFCL**: 94–100 % in every mode for every model — the anchor sits far above the bench's own
  tool tasks (gpt-4o-mini 78 % harness), which is the point of an anchor. The misses are two calls
  where one was expected and a value off by a unit or a format (a growth rate as 6 for 0.06). The
  first scoring of dict-valued parameters compared them as literal objects; the leaderboard's
  rule (each key lists the values it accepts) flipped 18 rows on re-score, all in place.

## 2026-09-11 — scorecard and trend views

### Added
- **`src/charts.js`** ([49]): the pictures behind the views as pure functions to SVG strings —
  `radarSvg` (one axis per capability, one polygon per series: filled for the run, dashed for the
  index-pooled outline), `sparklineSvg` and `sparklineText` (▁▂▃▄▅▆▇█, · for a gap), and
  `lineageLayout` / `lineageSvg` / `lineageText` (a band per family, a child one column right of
  its parent, roots stacked in step order). Node-free and served to the browser as
  `/lib/charts.js`, so the CLI writes the same picture the UI draws.
- **A radar per model** in the UI's scorecard block (this run filled, every saved run of the client
  dashed behind it) and as a file: `cli scorecard <client> --svg <file>`.
- **A sparkline per capability**: `cli trend` prints one bar per run under its table
  (`familyScorecard`'s trend reads across checkpoints the same way); the UI's scorecard cells carry
  the capability's harness rate over the client's saved runs, from `GET /api/trend?client=`.
- **The scorecard pooled by lineage family**: `cli scorecard --family <family> [--mode]` and
  `GET /api/scorecard?family=` line a family's checkpoints up per capability in registry order
  (`familyScorecard` in trends.js), with the family pooled beside them.
- **Regression flags delivered elsewhere** ([49]): `regressionsReport` (trends.js) builds one
  document — per client its own flags and the gaps against its parent, plus one flat list sorted by
  the drop — and `src/notify.js` formats it as text, JSON or Markdown and delivers it:
  `cli regressions --json | --format md`, `--out <file>` (Markdown for a `.md` path, JSON
  otherwise: a step summary or an artifact), `--webhook <url>` (JSON POST; exit 2 when the delivery
  fails), `--fail` (exit 1 when any flag stands).
- **A lineage graph** in the UI (a new block, hidden while the registry is empty): every registered
  checkpoint by family with its pooled harness rate and regression flags from the index
  (`lineageStats`, `GET /api/lineage`), the run's own models highlighted; `cli models --graph`
  prints the same tree.
- `lineageFor` strips a `@format` suffix like the other variants (a formatted run of a checkpoint
  is still that checkpoint).
- Tests: 302 (radar geometry, sparklines, the layout with stacked roots, unregistered parents and a
  cycle; the family scorecard, the report's flags and order, delivery to files and an in-process
  webhook, lineage stats, the series behind a sparkline).

### Shown (over the index as of 2026-09-11)
- `cli trend --client openai:gpt-4o-mini` draws 40 runs per capability in one line each —
  multi-step `···██······▁▃▃▁▁█▆▇▇▇█···▇█▅··▃·▆▅······` reads as the restock family arriving and
  the harder tiers pulling the pooled rate down, not the model changing.
- `cli regressions --json --fail`: 0 flags over 13 clients, exit 0; `--out regressions.md`
  writes the step summary. `cli models --graph`: two singleton families (ornith 89 % harness over
  16 runs, qwen3.8 100 % over 2), no parent links yet — the graph earns its edges when the
  house checkpoints are registered.

## 2026-09-10 (night) — tool breadth: paged results, strict types and near misses

### Added
- **The `paged` family** ([48]): `paged3` and `paged6` — which of 24 or 48 scenario items are
  below their minimum, listed eight at a time; every page says which it is, how many there are
  and the number of the next one. Scored on the exact set of low ids and the count; the tool-use
  verdict says how many of the pages were read and where a model stopped. Capabilities tool-use /
  partial-results; the family's knob is the page count, so `cli curve paged` works.
- **`typed`** ([48]): three items to set to quantities given in words ("twenty-four") on a strict
  scenario that refuses a `qty` sent as a string, a float or a word — and a `status` that is not a
  string — with a 400 that names the type it got. Scored on the end state (the three counts and
  statuses, nothing else touched) and the report; the verdict counts the refusals and whether every
  item was set in the end. Capabilities tool-use / argument-types.
- **`nearmiss`** ([48]): `norelevant` with the distractors moved closer. Half the questions ask for
  an exposed field in other words ("below what quantity does it need restocking?" for `min`, "which
  item does it point at?" for `next`), half for something that echoes a field and is not exposed
  (the supplier's minimum order quantity, a target date, units on order, the previous count, days
  of stock left, the previous `next`). The scorer names the field a wrong answer was a near miss on.
  Capabilities tool-use / irrelevance-detection / abstention; all four modes.
- **Webserver**: `GET /api/scenarios/:sid/items?limit=&page=` serves the listing in pages
  (`{ items, page, pages, total, next }`, the page on the op log); `POST /api/scenarios { strict:
  true }` makes a scenario refuse the wrong JSON type on update. `test/sut.test.js` pins both.
- Tests: 293 (the pages and the strict refusals on the server; each task's generator, scorers and
  verdict; whole trials through the runner with fake models that stop after page one, send strings
  and recover or not, and take the nearest field).

### Measured (seed 2026, four trials per cell unless said; tables in docs/results.md)
- **Pagination is followed; the scan across pages is not**: 47 of 48 tool-mode paged trials read
  every page, yet 22 answered with the wrong set. gpt-4o-mini reads all three pages and lists five of
  six low items (1/4 on `paged3`, 0/4 on `paged6`); Haiku 4/4 and 3/4, gpt-5.4-mini 3/4 and 3/4.
  The misses are not boundary slips (6 of 52 missed items sat at qty = min − 1, in proportion to
  the population) and not the last page (9 of 52); the six ids listed that were not low were nowhere
  near it (qty 12 for min 6). gpt-5.4-mini fans the remaining pages out after reading the first
  one's page count (2 rounds); Haiku walks them one at a time (7 rounds, 14–16 k tokens on `paged6`).
- **No hosted model trips the strict server**: `typed` 36/36 across the three models and both tool
  modes with zero refusals — every quantity given in words arrived as a JSON integer. The task is a
  floor for the models trained in this house, not a discriminator between these three.
- **Near misses catch gpt-4o-mini, once**: over 24 trials per tool mode (8 near misses, 16
  answerable), it took `min` for "the minimum order quantity the supplier accepts" in both tool
  modes on one instance and the current `next` for "which item did it point at before its last
  update" in one free-form trial — 7/8 and 6/8 near misses abstained, every answerable question
  right; gpt-5.4-mini and Haiku 24/24 in both modes. Without tools every model abstains on the
  near misses (9/9) and cannot answer the rest: the control.
- **The local ornith-1.5:9b** in harness mode: 12/12 over the three tasks — no refusals on `typed`,
  every page read on `paged3` (4/4, against gpt-4o-mini's 1/4), both near misses reported not
  available.

## 2026-09-10 (later) — two-hop needles and the depth sweep

### Added
- **The `needlehop` family** ([48]): `needlehop8k`, `needlehop32k`, `needlehop100k` — the same
  seeded server log, with a fourth question kind: one line's message says it retried an earlier
  request (`msg="retry of req <id>"`), and the answer is that earlier request's latency. Two
  lookups, the second key only readable from the first; the tool-use verdict wants both ids
  searched. Same tools, schema, scorers and `remint` as the plain family (the kind list gains
  `hop`; the plain family's rotation over its three kinds is unchanged, so old rows re-mint as
  before). Capabilities long-context / retrieval / multi-hop; the family's knob is the log size.
- **The depth sweep** ([48]): rows that record a `depth` (the single-needle question, planted at
  10 %, 50 % or 90 %) are pooled per client, mode and depth by `depthSweep` in the runner —
  `summarize`'s `depths`, printed by the report and shown under the difficulty curves — and the
  index carries a `depth` column, so `node src/cli.js query depth [--client] [--mode]` pools the
  sweep over every saved run.
- Tests: 285 (the hop question and its keys, the plain rotation unchanged, `remint` of a hop row,
  the hop tasks and their tool-use verdict, a hop trial through the runner, the sweep in the
  summary and in the index).

### Measured (seed 2026, four trials per cell; tables in docs/results.md)
- **The second hop breaks gpt-4o-mini inline**: 0/8 at 8 k and 32 k (a wrong latency, or no number),
  against 8/8 for gpt-5.4-mini and Haiku; with grep every model is at or near ceiling (34/36 over
  8 k, 32 k and 100 k) on 2–4 k tokens a trial instead of 8–31 k.
- **The depth sweep over the index** says the same thing about the weaker model on the plain
  family: read inline, gpt-4o-mini finds the planted line at 10 % depth (6/7) and misses it at 50 %
  and 90 % (0/4); searched with grep it finds it everywhere (11/11). The other models have too few
  deep trials in the index yet; `query depth` pools them as runs accumulate.

## 2026-09-10 — the format axis on demand

### Added
- **`@format:nowork` / `@format:work`** ([48]): the `work` field as a treatment on any task
  (`src/format.js`). `nowork` strips the field from a schema that has one and tells the model to
  write no working; `work` adds it, first, to a schema that lacks one and asks for the working
  before the answer. The runner applies it to the spec before the schema hint is built, so the
  schema the model is shown is the treated one; validity is judged against that schema (a re-score
  re-applies the treatment from the row); the row records `format` (how, applied — the schema had
  or lacked the field — and complied — no `work` key, or a `work` array that was used). Free-form
  modes are left alone. `summarize` pairs the variant with its base like the other treatments
  (`delta.byFormat` / `delta.format[how]`, with applied and complied counts), the report and the
  headline show the format delta, the index and the CSV carry the variant.
- Pooled treatment deltas now pair across models: a treated row is keyed by its base client for
  the pooled pairing, so the pooled McNemar reading exists for every treatment, not only per cell.
- Tests: 281 (the suffix and the resolver, the wrapper, stripping and adding with the prompt note,
  the no-ops including an array schema, compliance, a trial under each variant with the treated
  schema hint and validity, the re-score path, the paired summary per cell and pooled over models).

### Measured (seed 2026, four trials per cell; tables in docs/results.md)
- **Stripping the field** on six tasks that carry one (wordmath4/6, datecalc3, logicgrid4, tally60,
  extract3; schema-only and harness; gpt-4o-mini and Haiku): 77.1 % → 51.0 %, −26 pp, p < 0.001
  over 96 paired instances, 94 of 96 answers complying. The whole effect sits where the reasoning
  has nowhere else to go: with no tool in play, wordmath6 goes 8/8 → 0/8 and datecalc3 4/8 → 0/8
  for both models, Haiku's logicgrid4 8/8 → 1/8; with a calculator or date tool in the loop the
  field stops mattering, and on extraction it never did. Stripped answers cost about 40 % fewer
  tokens. The 2026-09-07 finding (4/4 → 0/4 on wordmath4) now stands as a treatment anyone can
  apply to any task.
- **Adding the field** to five object-schema tasks without one (reason, chain, health, restock6,
  dialogue2; gpt-4o-mini, harness): 70 % → 60 %, 0 up and 2 down of 20 pairs, McNemar p = 0.50 —
  nothing gained where no working is needed, 30–50 % more tokens.
- A first `work` run had applied the field to array-typed schemas (regex, transform, hello) and
  broke them (the list moved under a key the scorers do not read); the treatment now applies only to
  object schemas, and that run was discarded.

## 2026-09-09 (later that night) — a fourth extraction tier

### Added
- **`extract4`** ([48], the first follow-up: a harder tier where the current ones saturate): a
  month's account statement — 20 to 30 lines with a running balance: payments against the open
  invoices in full, in part, in two instalments that add up, one paid and then reversed; payments
  from customers who are not on the list under references that look right; supplier payments, fees,
  payroll — reconciled against the open-invoices list, the second document. The answer is each open
  invoice's outcome (paid / partial / unpaid) with the net amount received, and the month's total
  credits, total debits and closing balance; the statement prints the closing balance but never the
  column totals, so the sums have to be made (the tool modes get `calc`). Same scoring rules and
  injection profile as the family; `remint` from the seed as before. Tests cover the generator's
  invariants (closing = opening + credits − debits, every outcome present, a reversal reads unpaid,
  instalments add up, a distractor reference on every statement), the reader, the scorer, the
  hijack, and the trial in all four modes.

### Measured (seed 2026, four trials per cell; table in docs/results.md)
- **It does not saturate**: 10 of 48 across the four modes — gpt-4o-mini 0/16, gpt-5.4-mini 2/16,
  Haiku 8/16 — against 141 of 144 on the first three tiers. The failure is one thing: summing the
  statement's columns. 36 of 38 misses have the total credits wrong and 35 the total debits, while
  the invoice-by-invoice reconciliation is mostly right and the printed closing balance nearly
  always read correctly. The generator re-sums to its own truth over sixty seeds and no miss is the
  reversal netted out of both totals; the errors are transcription and addition over 25 lines, with
  or without the calculator — the aggregation weakness the long-context family found, now in a
  document a page long. The local 9B model gave no reading: every request hit the 120-second
  timeout on the page-long prompt (error rows, not misses; `BENCH_TIMEOUT_MS` is the knob).

## 2026-09-09 (night) — multi-turn with a scripted user

### Added
- **The `dialogue` family** ([26]): `dialogue2`, `dialogue3`, `dialogue4` (`src/tasks/dialogue.js`,
  family `dialogue`, level = the number of user turns, capabilities multi-turn / multi-step /
  tool-use / policy / state). The restock scenario over a conversation the bench scripts from the
  scenario itself (the same seed, the same script for every model and mode): the request (restock
  every low item, do not confirm yet), then a change of mind (one item only to its minimum), a hold
  (keep the quantity, status "hold", never touch it again), and a request the policy caps (bump a
  healthy item above its target — allowed only up to it); the last turn asks for the confirm and the
  report. A policy in the system prompt (nothing above target, nothing changed after a hold, confirm
  only when asked and only once) is judged from the server's op log and the per-turn tool calls, and
  the score needs the end state, the policy and the final report right. Free-form mode has no tools
  and is the control. The plan puts the user on the SUT; the script lives in the task because it is
  a pure function of the scenario the SUT minted, which keeps the webserver minimal.
- **Scripted dialogues in the runner** (`runDialogue`): a spec's `turns(ctx)` are the user's later
  messages; each is answered by a full tool loop that continues the same conversation, and the row
  keeps `dialogue` (one entry per user turn: the message, the answer, calls, rounds, time) with every
  call, result and loop turn tagged by its `turn`, the final message and JSON from the last turn, and
  usage and rounds summed. The free-form path continues its messages the same way. The synthetic
  client's `runWithTools` takes `history` and returns `messages`; sub-agents start their own
  conversation. Real-harness arms run one prompt to completion, so the planner skips `multiTurn`
  tasks for them with a note. The drawer, `show --trial`, `export --jsonl` and `compact` know the
  dialogue shape.
- Tests: 275 (the script and the expected state per level, the policy verdict, the end-state verdict,
  whole dialogues through the runner and the real tools against the in-process webserver — the
  follower, and three that bend the script: an over-target bump, a touch after the hold, an early
  confirm — the control, the planner's skip, the registry entry, trace events over a dialogue, and
  the client's history in / messages out).

### Measured (seed 2026, four trials per cell; table in docs/results.md)
- **The turns separate the models.** Pooled over the tool modes: gpt-4o-mini 5/24, gpt-5.4-mini
  15/24, Haiku 23/24; the control 0/36 (no tools), harness delta 0 % → 63.9 % (p < 0.001).
  gpt-4o-mini breaks at level 2 by the curve rule (0/8); gpt-5.4-mini halves once the hold arrives
  (7/8, 4/8, 4/8); Haiku holds (8/8, 8/8, 7/8).
- **Nobody broke the policy** in 72 tool-mode trials: the level-4 bump was capped at the target
  every time, no held item was touched, no confirm came early or twice. The failures are state
  across turns: healthy items restocked as if low (gpt-4o-mini, nine times), low items missed in the
  opening turn, the change of mind ignored (gpt-5.4-mini, five times), the hold not applied, and
  twice a stale total reported over a correct server state.

## 2026-09-09 (evening) — structured extraction from generated documents

### Added
- **The `extract` family** ([24]): `extract1`, `extract2`, `extract3` (`src/tasks/extract.js`,
  family `extract`, levels 1–3, capabilities extraction / cross-document / arithmetic). Each trial
  mints its documents from the run's instance seed with exact truth: an invoice whose seven header
  fields are asked for (level 1); its line-item table and grand total, with wrapped descriptions, a
  discount and shipping (level 2); a purchase order and the invoice billed against it, one to three
  lines off in quantity or price — the discrepancies and the amount over-billed (level 3). Layout is
  seeded too: three label vocabularies, four date formats, a currency symbol or code, thousands
  separators, pipe or aligned columns, and distractor fields (a PO number, an order date, a quoted
  total, a previous balance). Free-form and schema-only modes read the documents inline; the tool
  modes fetch them from the webserver with `get_document` (and get `calc`), so the tool axis is
  "fetch and compute" and the schema axis is the structured output the task is about. Scoring uses
  tolerance rules: amounts within a cent, dates in any of the document's formats read back to ISO,
  strings without case, punctuation or spacing; every miss is named. The row keeps the document ids
  and the truth and `remint` brings the text back from the seed. Under `@stress:injected` the
  document carries a note asking automated readers to report 999 — injection through a document
  rather than through tool output — and an answer that obeys is scored as hijacked, in every mode.
- Webserver: `POST /api/docs` (text) and `GET /api/docs/:id` (text/plain), pinned in
  test/sut.test.js.
- Tests: the generator (determinism, truth readable off the text, the join's over-billed sum), the
  tolerant readers, the scorers and their reasons, the hijack verdict, canonical answers, a trial in
  all four modes through the runner with the document store stubbed, the injected profile end to
  end, and the registry entry.

### Fixed (found by the first run of the family)
- **The JSON reader took the first fenced block, whatever it held.** Haiku fenced its working
  (` ``` Work: … ``` `) before its ` ```json ` answer, and `parseJSONLoose` read the working, found
  no JSON and gave up — "no answer" for a row whose answer was complete. It now tries every fenced
  block, the `json`-tagged ones first, then the whole text.
- **A re-score reads structured answers again from the recorded text** (`rescoreRun` re-runs
  `parseJSONLoose` over `answerText` for the structured modes and counts the rows it re-read), so a
  reader fix reaches saved rows the way a scorer fix does: `rescore 20260909T160214-7b2b --yes`
  flipped that Haiku row to 7/7 fields.
- **A turn that stops "for tool calls" and carries none is asked once more.** Once in the same run,
  Haiku's reply through the OpenAI-compatible route ended with `finish_reason: tool_calls` and no
  tool call in the stream; the loop had taken its one line of text as the final answer. The loop now
  pushes that text and one nudge ("make the call now, or give your final answer") and reads the next
  turn; the turn is marked `retried` in the row, and it happens at most once per trial.
- Tests: 268 (the reader over fenced working, a broken json fence, a fence with no JSON; the retry
  and its one-time limit; a re-score that re-reads and flips a row).

### Measured (seed 2026, four trials per cell; tables in docs/results.md)
- **Three hosted models sit at the ceiling**: 141 of 144 across the three levels and four modes
  (gpt-4o-mini 46/48, gpt-5.4-mini 47/48, Haiku 48/48); the misses are one vendor/customer swap and
  two `overbilled` sums with every discrepancy line right. Tool use was judged right in every
  tool-mode trial. Harness mode costs about seven times the tokens of reading inline (4.6 k against
  0.7 k per trial) for no accuracy at these sizes: on this family the schema axis, not the tools,
  is the treatment, and it does not move capable models.
- **Injection through the document does not land**: under `@stress:injected`, 0 of 48 trials
  (gpt-4o-mini and Haiku, free-form and harness) reported the planted 999; Haiku named the note
  in its working and extracted the real figures. The three misses under the note were ordinary
  errors, not obedience.
- **A 9B model separates**: `local:ornith-1.5:9b` scored 7 of 12 (two trials per cell, 20-minute
  time box, all completed): extract1 3/4, extract2 3/4, extract3 1/4 — the join breaks it, with
  lines that match the order reported as discrepancies.

## 2026-09-09 (later) — gates: thresholds with exit codes, time boxes, a nightly suite

### Added
- **Gates** ([37], the half that was open): `--gate <spec>` (repeatable) and `--gates <file>` on
  `bench.js` — so on `cli bench`, `replay` and every `suite` — and `node src/cli.js gate <run> …`
  over a saved run with no model. A spec names what to measure and the bar: a capability
  (`tool-use>=80`), a task (`health>=100`), a family level (`restock:6>=50`), a family's breaking
  point (`break:restock>=12`: it must not break below 12), a whole mode (`overall@noHarness>=60`),
  the error rows (`errors<=0`) or the index's regression flags for the client (`regressions<=0`:
  the [34] rule against its own earlier runs and its lineage parent); `@mode` defaults to harness.
  `src/gates.js` reads the grammar and a JSON file form (`gates/nightly.json`: `minTrials`, a
  default `mode`, `strict`, gates as strings or objects) and judges each gate on the Wilson band
  rather than the bare rate: **pass** when the rate reaches the bar, **fail** when the whole band
  lies under it, **inconclusive** in between (four trials cannot tell 75 % from 80 %), **incomplete**
  under `minTrials` (the file's, `--min-trials`, else the run's trials per cell). Exit codes: 0 pass (inconclusive included unless `--strict`), 1 fail,
  2 incomplete. Every client of the run is gated and the run's verdict is the worst; the result is
  written on the run (`run.gates`: file, specs, per-client results with reasons), indexed
  (`gate_verdict`, shown by `show` and `query runs`) and shown in the headline with what missed.
- **Time boxes**: `--time-box <minutes>` stops starting trials when the box is up, cancels the ones
  in flight, and saves what completed with status `timeout` and a warning; gates then judge the
  completed trials and report the rest as incomplete (exit 2), never as failures.
- **The nightly suite**: `node src/cli.js suite nightly --clients <checkpoint>` is the standard
  suite under a 90-minute time box, gated by `gates/nightly.json` (thresholds in harness mode over
  four trials per cell — a starting point to tune per model family); `--time-box`, `--gates` or
  `--gate` on the command line replace the preset's. `docs/serving.md` has the cron line and the
  exit codes a scheduler reads.
- Tests: 257 (the grammar and its errors, the file form, every verdict rule including strict,
  cancelled rows and the errors gate, the regressions gate with and without a count, the breaking
  point gate, per-client run verdicts, the nightly preset's arguments, a time-boxed matrix through
  the runner).

### Measured
- **The nightly on gpt-4o-mini** (`suite nightly --clients openai:gpt-4o-mini --instance-seed 2026
  --judge openai:gpt-4o-mini`, run `20260909T154825-4cd7`): 232 trials in 3.0 minutes at six in
  parallel (the 90-minute box is sized for slow local checkpoints), 3.0 M tokens, no error rows,
  harness delta 38.8 % → 77.6 % (p < 0.001). Verdict **inconclusive, exit 0**: nine gates pass, none
  fail, four sit under their bar with a band that still reaches it — tool-use 78.3 % against 80 over
  60 trials, multi-step 57.5 % against 60 over 40, arithmetic 66.7 % against 75 over 24, planning
  31.3 % against 50 over 16 (band 14–56 %). That is the honest reading of four trials per cell: the
  shipped bars are neither cleared nor refuted; `--strict` would fail the run, and eight trials per
  cell (the `full` suite) would settle most of them. The regressions gate compared 34 capability ×
  mode pairs against the index and found nothing.
- **A saved run gated without a model** (the seed-2026 reasoning run, gpt-4o-mini, `--min-trials 4`):
  deduction ≥ 75 % fails (2/8, band 7–59 %), arithmetic ≥ 90 % (17/20) and calendar ≥ 90 % (6/8) are
  inconclusive, six other gates pass — exit 1.
- **A time box** of 15 seconds over four restock6 trials: one completed, two cancelled, one never
  started, status `timeout`; with the floor at the run's four trials per cell the gate is incomplete
  (exit 2). Before that floor the same gate passed on the one trial that finished, which is why the
  floor exists.

## 2026-09-09 — replay, re-score, and the session as recorded

### Added
- **Replay** ([39]): `node src/cli.js replay <run> [--clients …] [--task …] [--modes …] [--count N]`
  (`bench.js --replay`) runs a saved run's tasks, modes, models, count, parallelism, instance seed
  and model knobs again — each overridable, so the same instances can go to another model — as a
  new run that names its **parent** (`run.parent = { id, kind: "replay" }`, indexed as `parent_run`
  / `parent_kind`, `GET /api/runs?parent=`), and prints the paired comparison against the parent
  (`describeReplay`: per-task McNemar, the overall band). The UI has a "replay run" button on every
  finished run (`POST /api/runs { replayOf }`; `withParentDefaults` fills the launch from the
  parent's config) and labels replays in the history and the headline.
- **Re-score**: `node src/cli.js rescore <run>… | --all [--judge …] [--yes]` (`src/rescore.js`) runs
  today's scorers over a saved run's rows without a model, through `scoreRecord` in `runner.js` —
  the one function a live trial now scores through too, so a re-score lands on exactly what a
  trial would (tested on a generated task in all four modes). A dry run lists every flipped row with
  both reasons and counts the other verdicts that moved (tool use, schema validity, canon, judge);
  `--yes` writes the verdicts back into the run file, which keeps its id and its place in the index
  (the same measurement, read again — a second run would double-count in every pooled view) and
  notes each re-score under `run.rescored` (when, from which bench version, how many moved). Left
  alone: error rows, tasks the registry no longer knows, judged tasks without a judge, rows whose
  scorer throws, compacted and running runs, and the stress record.
- **The session as it unfolded.** The synthetic loop records `turns` (per round: the model's text,
  the ids of the calls it made, the time since the trial started, the finish reason, the usage; a
  forced final turn is marked), and every arm keeps its raw `transcript` (format and text, capped at
  200 k characters); Claude Code's parser yields turns as well. `cli show <run> --rows` numbers the
  rows and `--trial <n>` prints one as a timeline (`trialTimeline` in `report.js`); `cli export <run>
  --jsonl [--trial <n>]` writes a trial as an event log (`traceEvents` in `export.js`: system, user,
  assistant, tool_call, tool_result, results paired by id — the transcript protocol trace tools
  speak). The drawer shows each turn's text before its calls and an arm's raw transcript under a
  disclosure; `compact` strips transcripts and turn text as it strips prompts.
- Tests: 251 (replay defaults from the CLI and the web, the paired reading, trace events with and
  without turns, the timeline, re-scoring with a changed scorer and the rows it must leave alone, a
  re-score reproducing a live trial's verdicts, the loop's turns including the forced one, Claude
  Code turns and transcript on the row, the parent in the index, compaction of the new fields).

### Measured
- **Re-scoring the whole index (dry run, 70 runs, 3966 rows).** Four verdicts flip: the four
  pre-audit `regex` rows of `ornith-1.5:9b` from 2026-09-03 (fail → pass; the positional reader and
  the `results` unwrapping the audit added). Nothing else changes correctness. Of the other
  verdicts, 21 tool-use verdicts move on `follow3/6` (true → false: the hop check was tightened
  after the 2026-09-08 morning runs, the off-by-one recorded that day), four arm rows from
  2026-09-03/04 lose a tool-use verdict they should never have carried, and the rest is fill-in:
  canon on 634 rows and tool-use verdicts on about 185 rows from before those measures existed,
  seven `health` reasons reworded. So the audit's fixes reach every saved run without a model, and
  the pre-audit runs can come back into the index with today's verdicts (`rescore --all --yes`).
- **Replay, same model.** `replay 20260907T092009-836c` (health, reason, regex × two modes ×
  gpt-4o-mini × 4): 24 paired trials, parent 79.2 % → replay 83.3 %, one pair up and none down,
  McNemar p = 1.00, band +0 to +13 pp; the same four free-form `reason` trials fail on both days.
- **Replay, seeded instances, two models.** `replay 20260908T035855-c46b --task wordmath4,tally60
  --modes harness --clients openai:gpt-4o-mini,anthropic:claude-haiku-4-5`: 16 paired trials on the
  same seed-2026 instances, identical outcomes on both sides (0 up, 0 down); gpt-4o-mini misses the
  same `wordmath4` instance with the same wrong answer both times (175 for 189), which is what the
  paired design is for.

## 2026-09-08 (late) — run records without the log

### Changed
- **A row's `ctx` is a record, not the environment.** `runTrial` records the trial context through a
  task-level `recordCtx` hook when the task defines one, and caps every string in what it records at
  the prompt's 20,000 characters either way (`recordedCtx` in `runner.js`; the marker says how long
  the string was, as for the prompt). The live ctx — prompts, tools, ground, scorers, wrappers and
  arms — is untouched. The needle family drops its minted log (`text`) and keeps seed, tokens, kind,
  depth, lines, question, answer, key and the webserver's log id; `remint(ctx)` in `tasks/needle.js`
  mints the log again from what the row keeps, so a replay ([39]) or a re-score has it, and the
  tool-mode prompt re-renders from the recorded ctx alone. Before: 36 needle100k rows made a 15.4 MB
  run file (`20260908T205940-a64b`), 14.9 MB of it the log under `ctx.text`; the same run would now
  be 0.5 MB. Saved runs are not rewritten. The spec shape in CLAUDE.md documents the hook.
- Tests: 241 (a needle row records no log text while the model and the webserver get the whole log;
  ground, both scorers, the tool-use verdict and the tool-mode prompt work from the recorded ctx and
  the seed re-mints the log, for all three question kinds; the runner caps strings in any context,
  nested ones included, while scoring sees the whole thing).

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
