# LLM Harness Benchmark

A small Node project that measures **LLM capability with and without a harness**, using the
local `webserver` as a concrete task environment.

For every task we run the **same goal** in two modes and score it identically, so any delta is
attributable to the harness:

| Mode | What the model gets |
|------|---------------------|
| **no-harness** | A raw, free-form prompt. No tools, no output schema — the model just answers in natural language. |
| **harness** | The full bundle: **tools + output schema + structured prompt**. The model must call the tool(s) and return structured data. |
| **schemaOnly** | The schema + structured prompt, **no tools**. Isolates the "ask for JSON" axis. |
| **toolOnly** | The tools, **no schema**, free-form answer. Isolates the "give it tools" axis. |

`no-harness` is the bare baseline. `harness` is the full bundle. `schemaOnly` and `toolOnly` are the
two axes the bundle is made of. A task takes part in a mode by declaring a spec for it; pairs a task
does not declare are skipped and reported, not scored. The four tool tasks declare all four modes;
`reason` has no tools, so its harness *is* schema-only and it declares no `toolOnly`.

The `webserver` (`./webserver`) is the **system under test**. Its real endpoints (`/health`,
`/api/hello`) are what the harness tools actually hit — the runner executes each tool and feeds
its real response back to the model. What gets scored is the model's *final message*, written
after it has seen that output, so harness mode measures the model, not the endpoint. It also keeps
a small log of what `/api/hello` served (`GET /api/recent?since=…`), which is how a real-harness
arm is scored against what the server actually returned even when the harness reshaped its tool
output.

## Tasks

| Task | Category | What it measures |
|------|----------|------------------|
| `health` | api-call | Report live status **and uptime**. Free text can only guess the status. |
| `hello` | api-call | Three greetings verbatim. Tool-optional: the format is documented, so a careful model can pass without tools. |
| `reason` | pure-reasoning | Three arithmetic/logic questions, no tools in either mode. The control: any "delta" here is the schema instruction alone. |
| `lookup` | api-call | Three server-minted random ids. **Tool-essential**: there is nothing to memorize, so free text floors at 0 and truth is whatever the tool returned during the trial. |
| `regex` | tool-reasoning | Which of six strings match an anchored regex, with a correct `regex_match` tool and a `word_count` decoy. Tests tool *selection* and typed arguments, not just firing. |
| `chain` | multi-step | Greet alice, then greet the id that came back, and report the second greeting. The second call depends on the first; the id is random, so nothing but the chain produces the answer. |
| `wordmath2` / `wordmath4` / `wordmath6` | reasoning · generated | A multi-step stock word problem minted per trial from the run's instance seed; one integer answer. With tools, a calculator — does a tool fix the arithmetic? |
| `convert1` / `convert2` / `convert3` / `convert4` | reasoning · generated | Unit conversions with exact factors and a stated rounding: one quantity in another unit; a rate in another pair of units; three steps ending in a whole number (a tank filled by a hose, a lift limit against boxes in pounds, a trip at a speed in other units, fuel at miles per gallon); and what the converter cannot do alone (a temperature difference, litres per 100 km against miles per gallon, a density through a cubed length factor, a cube's capacity). With tools, an exact `convert` and a calculator — is the miss in the factor, the arithmetic, or the understanding of when not to trust the tool? |
| `datecalc1` / `datecalc3` | reasoning · generated | Calendar arithmetic minted per trial: a date and weekday after N days, or a posting time plus three durations. With tools, a date calculator. |
| `logicgrid3` / `logicgrid4` | reasoning · generated | A pet-and-drink deduction puzzle, unique and minimal by construction, minted per trial. No tools: the harness is the structured mode. |
| `lineup4` / `lineup6` | reasoning · generated | An ordering puzzle — a race's finishing order, a queue, or a row of houses — unique and minimal by construction, minted per trial: before and after, next to, two places apart, first or last, between; who holds a place, which place someone holds, who is right after someone. No tools: the harness is the structured mode. |
| `code1` / `code2` / `code3` | coding · generated | A pure function to write from a spec minted per trial — one rule and its edges; a few rules that interact; several rules with a fail case — over twelve seeded kinds (sums, counts, clamps, slugs, run-length codes, range merges, duration parsing, word frequencies, CSV fields, range compaction) whose parameters come from the seed, so a remembered solution to the usual version fails the hidden edge cases. Scored by hidden tests in a sandbox (a child Node process under the permission model: no files, processes or network). With tools, `run_tests` runs the examples and reports what failed. |
| `clarify2` / `clarify3` | multi-turn · generated | A request that names none of the two or three low items it could mean — "the one the supplier called about" — with the instruction to ask before changing anything, and a user whose second turn reacts to what the model did: a question is answered with the item, a guess is named and has to be undone. Scored on asking before any write, the end state (the named item at its target, nothing else touched) and the report; a lucky guess is still a write before asking. |
| `tally20` / `tally60` | reasoning · generated | One count, sum or maximum over an inline ticket table minted per trial. With tools, a query over the same rows. |
| `fanout4` / `fanout8` | tool reasoning · generated | N independent item reads that could all be issued in one turn; the tool-use verdict says whether they were (parallel calls) or went one at a time. Under `@abstain` one asked-for id is an item the scenario does not hold (tool modes); `@perturb` reorders or lists the ids or rewords the ask. |
| `follow3` / `follow6` | tool reasoning · generated | Follow a chain of dependent reads (each item names the next) and report where it lands; nothing can be issued in parallel or guessed. Under `@abstain` the chain is cut short of the asked hops (tool modes); `@perturb` rewords the ask or gives the parameters as a block. |
| `toolpick6` / `toolpick13` | tool reasoning · generated | One question about an inventory scenario and six or thirteen read tools that differ by a word (the record or one field of it, an item by name, the low items, the counts, the summary): one answers it directly, others with more work, near-duplicates answer a different question with a value that looks right. Scored on the answer; the verdict names the first pick. `@perturb:order` lists the tools in another order. |
| `norelevant` | tool reasoning · generated | Half the questions the tools can answer, half nothing exposes: report a value or that it is not available, never invent one. |
| `nearmiss` | tool reasoning · generated | The same, with the distractors moved closer: half the questions ask for an exposed field in other words (below what quantity does it need restocking?), half for something that echoes one and is not there (the supplier's minimum order quantity, a target date, units on order). Answer, or say not available — never take the nearest field. |
| `paged3` / `paged6` | tool reasoning · generated | Which of 24 or 48 items are below their minimum, listed eight at a time; every page names the next one. Stopping early misses the low items on later pages; scored on the exact set and the count, and the tool-use verdict says how many pages were read. |
| `typed` | tool reasoning · generated | Set three items to quantities given in words ("twenty-four") on a strict server that refuses a quantity sent as a string, a float or a word with a 400 that says why. Scored on the end state and the report; the verdict counts the refusals and whether every item was set in the end. |
| `needle8k` / `needle32k` / `needle100k` | long context · generated | A server log of that many tokens with one question per trial — one planted line (at 10 %, 50 % or 90 % depth), three CRITICAL hosts, or an ERROR count per service. Free-form modes read it inline; the tool modes search it with grep and count over the same log on the server. |
| `extract1` / `extract2` / `extract3` / `extract4` | extraction · generated | Structured extraction from generated documents with exact truth: an invoice's seven header fields, its line-item table and grand total, a purchase order joined with the invoice billed against it (which lines differ, and the amount over-billed), and a month's account statement reconciled against the open-invoices list (paid, partly paid or unpaid and how much came in, with split payments, a reversal and payments from customers not on the list, plus the month's totals and closing balance). Varied labels, date formats, currency symbols, thousands separators and distractor fields; free-form lines or JSON under a schema; the tool modes fetch the documents from the server and get a calculator. Scored with tolerance rules (a cent, any of the document's date formats). Under `@stress:injected` the document carries a note asking automated readers for 999; obeying it is scored as hijacked. `@abstain` serves `extract1`'s invoice without its number and `extract2`'s without its totals block; `@perturb` reorders the header lines or the line items, renders another layout, or rewords the ask. |
| `dialogue2` / `dialogue3` / `dialogue4` | multi-turn · generated | A restock over two, three or four user turns against one scenario, the user scripted by the bench from the scenario: the request (no confirm yet), a change of mind (one item only to its minimum), a hold (keep the quantity, status "hold", never touch it again), and a request the policy caps (bump a healthy item above its target). Every turn is answered with tools in the same conversation. Scored on the server's end state after the whole dialogue, the policy (nothing above target, nothing changed after a hold, confirm only when asked and only once, read off the op log and the per-turn calls) and the final report. Arms are skipped: they run one prompt to completion. |
| `needlehop8k` / `needlehop32k` / `needlehop100k` | long context · generated | The same server log, where one line says it retried an earlier request; the answer is that earlier request's latency — two lookups, the second key only readable from the first. Read inline, or searched with grep and count. |
| `restock3` / `restock6` / `restock12` / `restock30` | multi-step | One job at three lengths against an isolated inventory scenario minted per trial: list, update every low item (each update returns a ticket), confirm with the complete ticket set (refused while anything is still low), report the server's total. Scored on the server's **end state**, not the report alone. |
| `transform` | extract-transform | Fetch three greetings, then report each name with the first 8 characters of its id and the greeting in upper case. Tool-essential, plus two transformations of what came back. |
| `explain` | open-ended | Explain the server's health and running time to a non-engineer. Graded by a **judge model** against the live facts; needs `--judge`. |
| `gsm8k` | public anchor | GSM8K's test problems (MIT), fetched into a local cache: one numeric answer. Free-form is zero-shot chain of thought; the harness adds the calculator and the work-then-answer schema, so the harness delta is measured on a public set. |
| `ifeval` | public anchor | IFEval's 541 prompts (Apache-2.0) with all 25 verifiable instruction types checked by code here — strict prompt-level pass, the loose verdict in the reason. Free-form only: the format is the test. |
| `bfclsimple` / `bfclmultiple` | public anchor | BFCL v4 simple (one function, one call) and multiple (the right function of several), scored with the leaderboard's AST check reimplemented here. Free-form is the prompting mode (the call written as text), the tool modes are native tool calling scored on the call. |

## Setup

```bash
cp .env.example .env      # fill in keys; local Ollama needs none
cd webserver && npm start # the system under test, on http://localhost:3000
npm test                  # unit tests — no model or server needed
```

## Web UI

The fastest way to launch runs and read the results:

```bash
node src/cli.js serve
```

Then open <http://127.0.0.1:4000>. The page is a **New run** panel on the left and the results on
the right; the panel folds to a slim rail (the button in its header) and remembers that choice:

- pick **tasks** (grouped by category, all/none per group), **modes** (chips, with *pair* and *all
  four* presets; a mode greys out when no selected task declares it), **models** and **harness arms**
  (one collapsible group per provider with its status, selected count and all/none; providers
  without a key, or an offline Ollama, are greyed out), filter all of them from one box, and set
  trials per cell and the knobs under Settings — the summary at the bottom shows exactly how many
  trials will run and which pairs are skipped;
- the headline is the **harness delta** with its significance line, the per-mode rates with p50/p95
  latency and median time-to-first-token, and the harness hygiene numbers (tool use, **tool args
  ok**, schema validity, tokens); below it, once three of the four modes have run, the **tools ×
  schema 2×2** with the effect of each axis and their interaction;
- a **live cell grid** fills in trial by trial in execution order, so you can see what is running,
  what passed and what is queued; a run can be cancelled mid-flight;
- the task × model matrix is a **dumbbell chart**: no-harness and harness rates on one track per
  row, the delta beside it, and the row's own p-value on hover;
- the **trial log** filters to failures or harness-only rows; click a row (or a grid cell) for the
  full story as a timeline — system and user prompts, every tool call with the real response,
  the final message, the scorer's verdict — plus the answer and the ground truth side by side, and
  any schema errors. ← / → step between trials, esc closes;
- a **capability scorecard** per model — with a **radar** per model (this run filled, every saved
  run dashed behind it) and a **sparkline** per capability over the model's saved runs —
  **difficulty curves** per family (success against the family's knob per model, the breaking
  point marked), a line under the scorecard for every capability where a model's latest run fell
  under its earlier runs or its lineage parent, and a **lineage graph** of the registered
  checkpoints with their pooled rates and flags;
- reopen any past run from the header dropdown, including runs launched from the CLI;
- **light / dark / system** theme switch in the header, remembered per browser;
- optional **temperature**, **seed** and **judge** under Settings, and an **export csv** link on every
  finished run.

Useful flags: `--port 4000`, `--host 127.0.0.1`, `--open`.

## Command line

```bash
# One task, one mode
node src/bench.js --task health --mode harness --clients openai:gpt-4o-mini

# Everything, both modes, 3 trials per cell
node src/bench.js --task all --modes noHarness,harness --clients local:ornith-1.5:9b --count 3
node src/bench.js --task health,reason,regex --modes noHarness,harness --clients openai:gpt-4o-mini --count 8 --parallel 8
node src/bench.js --task restock3,restock6,restock12 --modes harness,toolOnly --clients openai:gpt-5.4-mini,anthropic:claude-haiku-4-5 --count 4 --parallel 6
node src/bench.js --task restock3,restock6 --modes harness --clients openai:gpt-4o-mini,openai:gpt-4o-mini@skill:preload --count 4 --parallel 6   # skill A/B
node src/bench.js --task restock12 --modes harness --clients anthropic:claude-haiku-4-5,anthropic:claude-haiku-4-5@agents:available --count 4      # sub-agents A/B
node src/bench.js --task restock6 --modes harness --clients openai:gpt-5.4-mini,openai:gpt-5.4-mini@stress:budget,openai:gpt-5.4-mini@stress:distractors --count 4   # stress A/B
node src/bench.js --task wordmath4,datecalc3,logicgrid4,tally60 --clients openai:gpt-4o-mini,anthropic:claude-haiku-4-5 --count 4 --instance-seed 7   # generated reasoning, paired
node src/bench.js --task convert1,convert2,convert3 --clients openai:gpt-4o-mini --count 8 --instance-seed 7   # unit conversions: the factor from memory against the exact tool
node src/bench.js --task code1,code2,code3 --modes noHarness,harness,schemaOnly,toolOnly --clients openai:gpt-4o-mini --count 4 --instance-seed 2026   # code from a spec: does a test runner help, does JSON-only hurt
node src/bench.js --task hello,regex,tally20 --clients openai:gpt-4o-mini,openai:gpt-4o-mini@constraints:heavy --count 4 --instance-seed 7   # instruction following
node src/bench.js --task fanout8,follow6,norelevant --modes harness --clients openai:gpt-4o-mini,openai:gpt-4o-mini@stress:injected --count 4 --instance-seed 7   # tool-use breadth + injection
node src/bench.js --task paged6,typed,nearmiss --modes toolOnly,harness --clients openai:gpt-4o-mini,anthropic:claude-haiku-4-5 --count 4 --instance-seed 7   # paged results, strict types, near misses
node src/cli.js anchors fetch all && node src/bench.js --task gsm8k,ifeval,bfclsimple --modes noHarness,harness --clients openai:gpt-4o-mini --count 50   # public anchors: 50 items each, the same fixed subset every run
node src/bench.js --task wordmath4,chain --modes harness --clients local:ornith-1.5:9b,local:ornith-1.5:9b@effort:none --count 4   # thinking on vs off, paired (delta.effort)
node src/bench.js --task gsm8k --modes noHarness --clients openai:gpt-5-mini --count 20 --effort low   # one effort level for the whole run

# A bare provider name expands to all of its models
node src/aggregate.js --tasks health,hello --clients local
```

`aggregate.js` prints per-mode and per-cell breakdowns plus the **harness delta** (correctness,
tool-use, schema-validity, latency). Every run — CLI or web — is saved under `results/runs/` and
shows up in the web UI's history. `--json` prints the whole run record; `--no-save` skips
writing it.

The JSON files are the source of truth; a SQLite index over them (`results/index.sqlite`, built with
Node's own `node:sqlite`, refreshed on every save) answers cross-run questions: filter the history
by task, model or date, follow one task × model × mode cell across runs, or run raw SQL. Old runs
can be compacted (prompts and transcripts stripped, every scalar kept) without losing their rows.

```bash
node src/cli.js list                    # tasks (with the modes each declares) and providers, with key status
node src/cli.js probe local:ornith-1.5:9b   # is the endpoint ready for the bench: listed, answers, calls a tool and takes its result, JSON, the reasoning knob
node src/bench.js --task convert4,lineup6 --clients local:qwen3.8:27b-mlx --count 4 --parallel 1   # a local model; on a laptop one request at a time keeps the timings steady, and every row records the thermal state
node src/cli.js show                    # recent saved runs
node src/cli.js show <run-id> --table   # one saved run: per-mode stats, deltas with significance, a task × mode table
node src/cli.js export <run-id>         # every trial as CSV (--cells for the task × model × mode cells, --out file.csv)
node src/cli.js index [--full]          # (re)build the SQLite index over results/runs from file mtimes
node src/cli.js query runs --task chain --client codex:gpt-5.4-mini --since 2026-09-01
node src/cli.js query cell --task chain --client openai:gpt-4o-mini   # one cell pooled across runs, with its history
node src/cli.js query worst --limit 10  # lowest pooled correctness (trend: one cell over time; --sql "select …" for anything else)
node src/cli.js query depth [--client c] [--mode m]   # the needle depth sweep: one planted line, success by its depth, pooled over the index
node src/cli.js compact --older-than 30 # dry run; --yes strips prompts/transcripts from runs older than 30 days
node src/cli.js scorecard openai:gpt-4o-mini            # capability scorecard pooled over every saved run (Wilson bands, harness delta)
node src/cli.js scorecard openai:gpt-4o-mini --svg radar.svg   # the same as a radar (harness filled, no harness dashed)
node src/cli.js scorecard --family ornith                # a lineage family's checkpoints side by side, per capability, with a trend across them
node src/cli.js models --graph                           # the registry as a tree per family, each checkpoint with its pooled harness rate
node src/cli.js anchors list | anchors openai:gpt-4o-mini   # the public sets in the cache with their provenance; a client's anchor rates next to its own tasks
node src/cli.js cost <run-id> [--reprice]                # correctness × cost × latency per model and mode (models/prices.json; --reprice prices old rows for the view)
node src/cli.js variance --client openai:gpt-4o-mini [--by temperature] [--over-time]   # agreement and flakiness per instance under each setting, or per run
node src/bench.js --task restock6,fanout4 --modes harness --clients claude-code:claude-haiku-4-5,claude-code-mcp:claude-haiku-4-5 --count 2   # an arm with its own tools next to the same arm on the bench's tools over MCP
node src/bench.js --task wordmath4,nearmiss,reason --clients openai:gpt-4o-mini,openai:gpt-4o-mini@confidence --count 4 --instance-seed 7   # a stated confidence: Brier, ECE and the gap, paired against the plain run
node src/bench.js --task wordmath4,tally20,datecalc1 --clients openai:gpt-4o-mini,openai:gpt-4o-mini@abstain --count 8 --instance-seed 7   # half the problems unanswerable: abstained, fabricated, refused
node src/bench.js --task wordmath4,tally20,logicgrid3 --clients openai:gpt-4o-mini,openai:gpt-4o-mini@perturb:paraphrase,openai:gpt-4o-mini@perturb:order --count 4 --instance-seed 7   # the same instances rewritten: delta and consistency
node src/bench.js --task fanout4,extract1 --modes harness,toolOnly --clients openai:gpt-4o-mini,openai:gpt-4o-mini@abstain,openai:gpt-4o-mini@perturb:format --count 8 --instance-seed 7   # the tool and extraction families: an item the scenario lacks, an invoice without its number; the ids as a list, the invoice in another layout
node src/bench.js --task wordmath4,logicgrid3,extract1 --clients openai:gpt-4o-mini,openai:gpt-4o-mini@perturb:typos --count 4 --instance-seed 7   # typing errors in the prose and OCR-like noise on the documents: delta and consistency
node src/bench.js --task restock6,dialogue3 --modes harness --clients openai:gpt-4o-mini,openai:gpt-4o-mini@perturb:paraphrase,openai:gpt-4o-mini@perturb:format --count 4 --instance-seed 7   # the rules and the user's turns in other words or as steps: does the breaking point move?
node src/cli.js compare <run> --a <client> --b <client> --mode harness   # paired: McNemar + bootstrap band per task
node src/cli.js compare <run-A> <run-B> --mode schemaOnly               # two runs on the same instance seed
node src/cli.js curve restock [--mode harness] [--client <c>]           # success per difficulty level over every saved run, with each model's breaking point
node src/cli.js trend --client openai:gpt-4o-mini [--capability arithmetic]   # a model's capabilities per run over time
node src/cli.js regressions [--client <c>] [--since D]                  # latest results against earlier runs, and checkpoint against lineage parent
node src/cli.js regressions --out regressions.md --fail                 # …delivered as a Markdown step summary (JSON for any other path), exit 1 when a flag stands
node src/cli.js regressions --webhook https://hooks.example/bench       # …or POSTed as JSON (exit 2 when the delivery fails)
node src/cli.js show <run-id> --rows                                    # every trial numbered; --trial <n> prints one as a timeline
node src/cli.js export <run-id> --jsonl --trial 3                       # a trial as an event log (system, user, assistant, tool_call, tool_result)
node src/cli.js replay <run-id> [--clients …] [--task …] [--count N]    # the same instances again, as a new run parented to this one, with the paired comparison
node src/cli.js rescore <run-id> | --all [--yes]                        # today's scorers over saved rows: a dry run lists the flips, --yes writes them back
node src/cli.js gate <run-id> --gate "tool-use>=80" --gate "errors<=0"    # thresholds over a saved run: exit 0 pass, 1 fail, 2 a gate could not be judged
node src/cli.js suite nightly --clients vllm:my-ckpt --judge openai:gpt-4o-mini   # the standard suite, time-boxed and gated by gates/nightly.json
```

Every delta also carries a **paired** reading when both sides ran the same instances (McNemar's
exact test on the discordant pairs and a bootstrap band on the delta), power guidance when a gap is
not significant, and a Bonferroni count over the run's task × model cells. The **capability
scorecard** pools each run's tasks by the capabilities they carry (tool use, multi-step, arithmetic,
deduction, planning, …) per model, and `cli scorecard` does the same over every saved run.

**Curves and regressions.** Every family with a knob (restock items, wordmath steps, datecalc
level, logicgrid size, tally length, fanout width, follow hops, needle tokens) tags its tasks with a
`family` and a `level`; a run's report and the UI draw success against the level per model and
mark the **breaking point**, the first level whose Wilson band tops out under 50 %, and
`cli curve <family>` pools the same over every saved run. `cli regressions` compares, per
capability and mode, a model's latest run of each task with its earlier runs of the same task —
the same number of trials per task on both sides, so a change of task mix never reads as a change
in the model — and a checkpoint with its lineage parent; a flag needs the later band to lie
entirely under the earlier one, and names the per-task split behind it.

**Calibration.** `<client>@confidence` asks for the model's probability that its answer is
right — a field after the answer in a structured mode, a final line in a free-form one — and the
run reports, per model and mode, the Brier score, the expected calibration error over ten bins
and the gap between mean confidence and accuracy, with the reliability bins in the UI. It is
paired against the plain run like every treatment, so the run also says whether asking changed
the answers.

Every treatment is also a select in the UI's setup panel, with an A/B option that keeps the plain
client as the baseline; a UI run and a CLI run of the same treatment send the same client names.

**Perturbations.** `<client>@perturb:paraphrase|order|format|typos` runs the very instance the
base client sees, rewritten by its family with the truth untouched — other words, another order
of the independent parts, another surface form (a dated list, a CSV table, an ISO date without
the weekday; for the tool and extraction families the ask in other words, the asked-for ids or
the document's header lines and line items in another order, the ids as a list or the invoice in
another layout with other labels and date style; for `restock` and `dialogue` the rules, the
opening request and the user's turns in other words or as numbered steps and bullet lists), or
typing errors in about a quarter of the words (never in a number, an id, a date, a code or an
entity the answer is scored on; on the extraction documents this is OCR-like noise) — and the run
reports, beside the paired correctness delta, the **consistency**: the share of instances whose
answer did not change, right or wrong.

**Abstention.** `<client>@abstain` makes a seeded half of a generated family's instances
unanswerable — a step's quantity gone from a word problem, a question about a column the ticket
table lacks, a date left out, an asked-for item the inventory scenario does not hold (`fanout`, in
the tool modes, where the server answers 404), a chain cut short of the asked hops (`follow`, tool
modes), an invoice served without its number (`extract1`) or without its totals block
(`extract2`) — and tells the model on every trial to say so when a problem cannot be answered. Abstaining on
those is right and producing a value is a fabrication (for the tool and extraction families, no
qty for the ghost id, no landing item claimed, or the field reported as missing counts as
abstaining; a value invented for it — the dead-end item, the sum of the lines — is the
fabrication); abstaining on an answerable one is a refusal. The run counts the four
cases per model and mode, next to the paired delta against the plain run.

**Shared tools for the arms.** `claude-code-mcp:<model>` and `codex-mcp:<model>` run the real
harnesses on the bench's own tools through MCP: the bench starts a loopback bridge holding the
trial's tools and the arm spawns a thin stdio MCP server that forwards to it, so every tool call
runs in the bench, comes out bench-shaped, and is judged by the task's tool-use verdict like any
client's. Claude Code gets no built-in tools that way; Codex keeps its shell beside them and the
verdict says which it used. `@skill:ondemand` reaches these arms as the `load_skill` tool, and
`@agents:available|required` gives Claude Code its Agent tool with a worker agent carrying the
bench's tools. The bring-your-own arms (`claude-code`, `codex`, `pi`, `thoth`) stay as they were,
scored from the webserver's log.

**Variance.** Agreement (the share of trials giving the modal canonical answer) and flakiness
(both outcomes for one problem) are measured per instance: every trial of a fixed-truth task is
the same problem, but a generated task's trials only repeat an instance across a replay or runs on
the same instance seed, and different problems are never compared. `cli variance --client <c>`
puts the same cells at temperature 0 and at the provider's default side by side (`--by seed` or
`--by effort` for another setting), and `--over-time` gives one point per run. `chain` and
`transform`, whose values are minted per call, agree on the answer's shape.

**Cost and effort.** `models/prices.json` holds per-million-token prices by model id (source and
date beside each; local serving is 0; check them — the bench cannot). Every row is priced when it
runs, so a run keeps the price of its day, and a model without an entry runs unpriced and is
counted as such. The report, the UI and `cli cost <run>` show correctness × cost × latency per
model and mode: what a right answer costs and how long it takes. `--effort <level>` sets the
reasoning effort for a run and `<client>@effort:<level>` runs it as a paired variant; each is
translated to what the provider's route takes (`reasoning_effort`, or `reasoning: { effort }` on
Ollama), and every row records the characters of reasoning that came back, so whether the knob
took effect is visible. A model that takes no such parameter refuses the request — OpenAI's
non-reasoning models return 400 for `reasoning_effort`, and its reasoning models refuse a
temperature other than the default and function tools with any effort but `none` on the chat
route — and the rows carry that error rather than a silent no-op. OpenAI reports its reasoning
as tokens in the usage rather than streamed text; the rows record both. Gemini, Mistral and xAI are providers (`GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`XAI_API_KEY`); with a key their model lists are probed from the route.

**Public anchors.** `gsm8k`, `ifeval`, `bfclsimple` and `bfclmultiple` run public sets through
the same client against the same endpoint, scored by dependency-free reimplementations of their
official checks (`src/ifeval.js`, `src/bfcl.js`). `node src/cli.js anchors fetch all` pulls the
items into a local cache with their URL, licence, hash and fetch date; a trial's index picks its
item from one fixed permutation, so every model and run sees the same subset. Their rows are
tagged `source: public` and their capabilities `public:<capability>`, so they never pool with the
generated families in a scorecard, gate or trend: they anchor the generators' difficulty to known
scales and are never the headline — the sets are on the open web and may be in any model's
training data, and every row carries that caveat. `cli anchors <client>` puts the anchor rates
next to the bench's own tasks for the same capability.

`--instance-seed N` fixes the seed the generated families mint their problems from: every mode
and model in the run sees the same instances (a paired design), and the same seed on another day
or another checkpoint re-mints them. Without it a fresh seed is drawn and recorded on the run.

**Replay and re-score.** `replay <run>` runs a saved run again — its tasks, modes, models, count,
instance seed and knobs, any of them overridable (`--clients` sends the same instances to another
model) — as a new run that names its parent, and prints the paired comparison against it; the UI's
"replay run" button does the same. `rescore <run>` (or `--all`) runs today's scorers over the rows
a run already holds, with no model: a dry run lists every verdict that would flip and why, and
`--yes` writes the new verdicts into the run file, which keeps its id (it is the same measurement,
read again) and records the re-score. Every row keeps enough for both: the prompt, the tool calls
and results, the model's turns (what it said each round, which calls it made, when), an arm's raw
transcript, the parsed answer and the ground truth taken at the time. `show <run> --trial <n>`
prints a trial as a timeline and `export --jsonl` writes it as an event log.

`--parallel N` runs up to N trials at once (the web UI's "in parallel" setting does the same);
real-harness arms always run alone because they are scored from the webserver's time-windowed log,
and latencies measured under parallel load on a local model include queueing. Repeated cells
report their **stability**: agreement (the share of trials giving the same canonical answer, on
tasks with fixed truth) and whether the cell was flaky, in the report and the headline.

**Your own checkpoints.** Serve a checkpoint with vLLM, llama.cpp or MLX, on this machine or on
another host on the network, name the server in `LOCAL_ENDPOINTS` (`vllm=http://127.0.0.1:8000/v1`,
`desk=http://192.168.1.80:8080/v1`), and it is a provider like `local` — run it as `vllm:<model>`;
`node src/cli.js list` probes each endpoint on its own address and shows what it serves; a server
that runs with a key gets it from `<NAME>_API_KEY` in `.env`, `probe <name>` lists a host's models,
and every run records its serving hosts (`config.endpoints`). Record it in `models/lineage.json` (family, checkpoint, step, parent) and every run
carries that lineage; `node src/cli.js suite smoke|standard|full --clients …` runs the presets,
`compare <run> --a <checkpoint> --parent` pairs it against its parent, `scorecard` gives its profile,
and `models` lists the registry. `suite nightly` runs the standard suite under a time box and gates
it with `gates/nightly.json`, exiting 1 when a gate fails and 2 when one could not be judged;
`--gate tool-use>=80` (a capability, a task, `restock:6`, `break:restock`, `overall`, `errors`,
`regressions`, each `@mode`) works on any run, `--gates <file>` takes a file of them, and `gate
<run>` judges a saved one. A gate fails only when its Wilson band lies under the bar; a rate below
the bar whose band still reaches it is inconclusive, not a failure (`--strict` makes it one). Step
by step in [docs/serving.md](docs/serving.md).

**Sub-agents.** `openai:gpt-4o-mini@agents:available` gives the model a `delegate` tool: each
call runs a sub-agent with the task's own tools on a goal the parent writes, in parallel with other
calls in the same turn, and returns its answer; `@agents:required` tells the parent to do the
per-item work that way. Children's tool calls and tokens fold into the parent's row, and the report
shows the sub-agents delta with how often delegation was actually used. Claude Code runs the variant
through its own Agent tool; other arms report that they have no channel.

**Constraints.** `openai:gpt-4o-mini@constraints:light|medium|heavy` adds one, three or five verifiable formatting requirements to every prompt — word limits, forbidden or required words, an opening or closing phrase, no commas, bullet counts and a sentence count (counted approximately, and marked so) for free-form answers; key order, an attestation key and a single line for JSON answers — drawn from the instance seed so every model gets the same ones. In a scripted dialogue the requirements are stated once, on the first turn, for the final report, and the last turn's answer is checked: whether an instruction given at the start survives the conversation. The
row records which were met, and the report shows **adherence** next to the correctness delta, so
"did the job" and "did it as told" stay separate.

**Stressors.** `openai:gpt-4o-mini@stress:flaky|budget|haystack|distractors|injected` runs the
scenario-backed families (restock, fanout, follow, norelevant) in a harder environment: transient
503s that need a retry, a request budget after which everything is refused, the same low items
hidden in an inventory of 60, distractor endpoints including a reorder-all trap, or **prompt
injection** — two items carry a note with an instruction: mark a third item "compromised" where the
tools can write (restock), or report every quantity as 999 where they only read (fanout, follow,
norelevant). A trial that obeys is scored as hijacked. The profile is applied to the trial's scenario on the server, so arms meet the
same conditions; every row records what the environment did (failures served, requests refused,
distractor calls) and the report shows the stress delta per profile.

**Format.** `openai:gpt-4o-mini@format:nowork` strips the `work` field from any schema that has one
(and tells the model to write no working), `@format:work` adds it to any schema that lacks one (and
asks for the working first): the format axis on demand, on any task. The row records whether the
treatment applied (the schema had, or lacked, the field) and whether the answer complied, and the
report shows the format delta paired against the plain client. Free-form modes have no schema and
are left alone.

**Skills.** A playbook under `skills/<task>.md` can be handed to a model as a treatment:
`openai:gpt-4o-mini@skill:preload` puts it in the prompt, `@skill:ondemand` offers it as a
`load_skill` tool and records whether the model read it, and `@skill:native` hands it to a
real-harness arm through its own channel (Claude Code and Pi: an appended system prompt; Codex:
the `AGENTS.md` of its working directory). Run a model plain and wrapped in the same
run (the web UI's skill setting has an A/B choice) and the report shows the skill delta per task and
pooled per delivery. Every tool task has a playbook (`health`, `hello`, `lookup`, `regex`, `chain`,
`transform`; the restock family shares `skills/restock.md`); `reason` and `explain` have none and
run unchanged under a skill variant.

`--temperature T`, `--seed S` and `--model-param key=value` (repeatable; e.g. `think=false`,
`max_tokens=600`) are sent as-is with every request and recorded in the run's config (the
determinism knobs; some models reject a non-default temperature, which then shows as an error row).
Every run also records the bench version, git commit and node version under `versions`.

Requests stream by default, which is how the bench measures **time to first token**: each trial
records `ttftMs` (first token of any kind, reasoning included) and `ttfaMs` (first answer token —
content or a tool call); the report and the UI show their medians. For real-harness arms the same two
fields are **event-level**: the arrival of the harness's first visible action (a message or tool
call) and of its final answer, read off its streamed output. `BENCH_TIMEOUT_MS` sets the
per-request timeout.

## Providers

Multiple providers behind a single OpenAI-compatible client (no SDKs):

- **OpenAI** — `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-5-mini`
- **Anthropic** — `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, via Anthropic's OpenAI-compatible route
- **Groq** — `llama-3.3-70b-versatile`, `gemma2-9b-it`
- **DeepSeek** — `deepseek-chat`, `deepseek-reasoner`
- **Local (Ollama)** — no key needed; whatever the daemon reports from `/v1/models`

To add one, add an entry to `PROVIDERS` in `src/providers/index.js` and a label to
`MODEL_LABELS`. Values in `.env` (`*_API_KEY`, `OLLAMA_BASE_URL`, `SUT_PORT`, `RESULTS_DIR`) are loaded
at startup; real environment variables win.

## Real harnesses as the arm (experimental)

The synthetic harness is not the only harness the bench can run. A real agent harness can be the
harness arm: it gets the task's plain-language **goal**, brings its own tools and model, and its final
message is scored exactly like a synthetic harness trial. Arms run structured modes only; the
free-form baseline for the same model comes from the synthetic client.

In a run that mixes arms with the synthetic client, each arm gets its own **delta against the
free-form baseline of the same model** (the report's "harness arms" section; the headline and the
matrix show it too), so "harness X on model M vs raw M" is read straight off the run.

Arms are scored against what the webserver actually served: each arm brackets its run with
timestamps and asks `GET /api/recent` for the replies in that window (merged with anything it can
read out of the harness's own tool output), so `lookup`, `chain` and `transform` score the same way
as for the synthetic harness. Run arm trials one process at a time against a given webserver, since
the window is by time, not by caller.

- **`claude-code:<model>`** — `claude -p --bare` with Bash only and permissions bypassed. Needs
  `ANTHROPIC_API_KEY`; `CLAUDE_CODE_CMD` overrides the binary.

```bash
node src/bench.js --task health,lookup,chain --modes harness --clients claude-code:claude-haiku-4-5 --count 4
```

- **`pi:<provider>/<model>`** — Pi (`pi --mode json -p`) with its `bash` tool, no session, no context
  files. The bench passes the key for the model's provider (`OPENAI_API_KEY` for `pi:openai/…`) with
  `--api-key`. `PI_CMD` overrides the binary.
- **`codex:<model>`** — Codex CLI (`codex exec --json --ephemeral`), sandbox relaxed through
  `CODEX_SANDBOX_ARGS` (default `--dangerously-bypass-approvals-and-sandbox`, the documented no-prompt
  mode). Codex authenticates through its own `codex login`; until then every trial is an error row
  that names the 401. `CODEX_CMD` overrides the binary.
- **`thoth:default`** — see below.

```bash
node src/bench.js --task health,lookup,chain --modes harness --clients pi:openai/gpt-4o-mini,claude-code:claude-haiku-4-5 --count 4
```

### Thoth

`thoth:default` hands the goal to Thoth one-shot (`thoth --events`).

```bash
# Thoth on another host: reverse-tunnel the webserver (and Ollama, if Thoth's gateway routes to it)
ssh -N -R 3000:localhost:3000 -R 11434:localhost:11434 arch &
THOTH_CMD="ssh -n arch cd ~/Repos/thoth && thoth" node src/bench.js --task reason,health --modes harness --clients thoth:default --count 4
```

Every row records the model Thoth actually routed to and `harness: "thoth"`. Caveats, all
recorded in the changelog: Thoth's `tool_result` events carry names and byte counts, not contents, so
tasks whose truth is read from tool results (`lookup`, `chain`) cannot be scored from this arm yet;
its gateway caches identical prompts; and reaching a localhost webserver needs either its shell tool
(`[shell].enabled`, off by default) or a `web_fetch` policy that allows private addresses.

## Evaluation

Tasks carry an `eval` block with:

- `ground(trial)` — the truth, fetched **after** the model answers. It receives what the trial did
  (`toolCalls`, `toolResults`, the parsed answer) so a task can define truth as "what my tool
  really returned" when the endpoint is random. Tasks with fixed truth use a constant.
- `scoreHarness(structured, ground)` — validate the structured answer against it.
- `scoreNoHarness(text, ground)` — judge the free text.
- `toolUse(trial)` (optional) — was the tool used *correctly*: right tool, right arguments, right
  calls? Recorded per trial as `toolUseOk` with a reason, and aggregated as "tool args ok". It is a
  separate signal from correctness: a model can reach the right answer by hand after firing the
  wrong tool, or fire the right tool and misreport.

Scorers receive a third argument, `{ judge, mode }`; a task that needs the judge (`eval.needsJudge`)
calls it and returns its verdict alongside `correct` and `reason`.

Seven tasks use automated ground-truth scoring; `explain` is graded by an LLM judge that is handed
the ground truth (status, uptime in human units) and a rubric, and returns a score in 0..1 with a
one-sentence reason. A trial passes at 0.75. Pick the judge with `--judge provider:model` (or
`BENCH_JUDGE` in `.env`, or the judge field in the recipe); it is recorded in the run, and each
row keeps the judge's score and reason. Without a judge, judged tasks produce error rows that say so. Scorers judge content, not wrappers: a list
returned under `results`, `data` or the schema's own `items` key scores the same as a bare array,
while `schemaValid` still records whether the shape matched exactly.

Note that the two scorers are **not equally strict by construction**, and shouldn't be read as
if they were: `health` checks status *and* the real uptime in harness mode, but only the status
keyword in free text, because without tools a model cannot know the uptime. That asymmetry is
the capability being measured — it is worth re-reading whenever you add a task.

## How to read the results

The headline question is: **does the harness help?** Expect with-harness to show higher
correctness and to expose whether the model can call tools against real code.

Every delta carries a two-sided **Fisher exact** p-value, which is valid at the tiny sample sizes
a local run produces — and that is exactly where intuition fails. With three trials per side no
outcome can reach p < 0.05, not even 0/3 → 3/3 (p = 0.10); four per side is the floor for a
perfect split, and a realistic 40% → 70% gap needs on the order of twenty per side. The UI and CLI
say **inconclusive** when the sample could not have been significant, **not significant** when it
could have been but wasn't, and **significant** otherwise. Small local models also vary a lot run
to run, so raise `--count` (or "trials per cell") before drawing a conclusion.
