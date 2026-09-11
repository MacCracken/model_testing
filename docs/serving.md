# Serving your own checkpoints to the bench

The bench talks to every model through one OpenAI-compatible route (`/v1/chat/completions` with
function calling), so a checkpoint you trained is benchmarked by putting an OpenAI-compatible server
in front of it and naming that server as a **local endpoint**. Nothing else changes: the same tasks,
modes, treatments, statistics and scorecards apply, and the run records the checkpoint's lineage.

## 1. Serve the checkpoint

Pick whichever runtime fits the weights. Flags below are the common ones; check `--help` for the
version you have installed.

| Runtime | Serve | OpenAI route |
|---|---|---|
| **vLLM** (HF safetensors, GPU) | `vllm serve /path/to/checkpoint --served-model-name my-ckpt-2000 --port 8000 --enable-auto-tool-choice --tool-call-parser hermes` | `http://127.0.0.1:8000/v1` |
| **llama.cpp** (GGUF, CPU / Metal / CUDA) | `llama serve -m /path/to/model.gguf --alias my-ckpt-2000 --host 0.0.0.0 --port 8080 -c 16384` (the unified `llama` binary; older installs: `llama-server … --jinja`) | `http://<host>:8080/v1` |
| **MLX** (Apple Silicon, HF or MLX weights) | `python -m mlx_lm.server --model /path/to/checkpoint --port 8081` | `http://127.0.0.1:8081/v1` |
| **Ollama** (GGUF or safetensors via a Modelfile) | `printf 'FROM /path/to/model.gguf\n' > Modelfile && ollama create my-ckpt-2000 -f Modelfile` | `http://127.0.0.1:11434/v1` (already the `local` provider) |

Notes that matter for this bench:

- **Tool calling must be on.** Harness mode sends `tools`; a server that ignores them scores the
  model as if it never called a tool. vLLM needs `--enable-auto-tool-choice` and a
  `--tool-call-parser` matching the model's chat template; llama.cpp's unified `llama serve` has the
  jinja engine on by default (an older `llama-server` needs `--jinja`); MLX and Ollama follow the
  model's template. `node src/cli.js probe <endpoint>:<model>` is the check:
  it lists the model, gets an answer, has the model call a tool and repeat the token the result
  carried, asks for JSON, and sends the reasoning parameter — with a verdict and an exit code of
  1 when the endpoint is not ready for a harness-mode run.
- **The model id** the bench sends is what the server lists at `/v1/models` (vLLM:
  `--served-model-name`; llama.cpp: the file name unless `--alias`; MLX: the path; Ollama: the
  created name). `node src/cli.js list` shows what each endpoint reports.
- **Thinking models** may spend the whole token budget reasoning on a free-form answer; a local
  endpoint gets five minutes per request by default (a hosted route two), `BENCH_TIMEOUT_MS`
  sets either, and the runtime's own reasoning-effort knob (`--effort none`) is the better lever
  than `--model-param`.
- **Another machine can serve.** The address in `LOCAL_ENDPOINTS` is any http(s) URL, so a
  desktop or a server on the network hosts the model while the bench runs here: start the runtime
  bound to every interface (`--host 0.0.0.0`; vLLM and MLX bind so by default), name its LAN
  address, and `node src/cli.js list` shows the endpoint's address with the models it lists.
  Only the bench talks to the model host; the tools run in the bench process against the
  webserver on this machine, so the host never needs to reach it. Latencies then include the
  network, and the thermal record on the rows is this machine's, not the host's. Measured on
  2026-09-11 with the same ornith weights served by `llama serve` on the laptop's LAN address and
  by Ollama: the probe passes all six checks, and llama.cpp honours the per-request
  `reasoning_effort` ("none" gives zero reasoning tokens where Ollama's route needs its own
  `reasoning: { effort }` shape) — see docs/results.md.
- Requests under `--parallel` queue at the server; latency columns then include queueing. Compare
  latencies serial-to-serial. On a laptop, one request at a time (`--parallel 1`) is the setting
  that keeps the numbers steady: a second request in flight doubles the heat, macOS answers by
  lowering the clocks, and the same model then takes twelve seconds on one trial and five minutes
  on the next while the daemon may stop answering for a minute. A desktop or a server holds its
  clocks and takes whatever parallelism the runtime serves well. Nothing in the bench limits a
  local run either way; the rows just record what the machine was doing. Every trial's row records the thermal state
  at its start (`row.env.thermal`, from `pmset -g therm`), the run records it at start and end
  (`run.env.thermal`), and the report prints a line when any trial ran under pressure, so a slow
  local row is the laptop's doing and can be seen to be.

## 2. Name the endpoint

In `.env`:

```
LOCAL_ENDPOINTS=vllm=http://127.0.0.1:8000/v1;llamacpp=http://192.168.1.80:8080/v1;mlx=http://127.0.0.1:8081/v1
```

Each name becomes a provider like `local`: no key, models probed live from its `/v1/models`, marked
offline in the UI when the server is down. Clients are `<name>:<model>` — `vllm:my-ckpt-2000`. A
name never shadows a built-in provider.

**A key, another machine.** A server that runs with a key (`llama serve --api-key …`, `vllm serve
--api-key …`) gets it from `.env` as `<NAME>_API_KEY` — the endpoint's name upper-cased, dashes to
underscores: `LLAMACPP_API_KEY`, `MY_HOST_API_KEY` — sent as the bearer token on every request and on
the model-list probe; without one the fixed local token goes out, so a keyless server needs nothing.
The address may be any host on the network: bind the runtime to every interface (`--host 0.0.0.0`),
name its LAN address (`desk=http://192.168.1.80:8080/v1`), and `node src/cli.js probe desk` lists
what that host serves with the key (a keyed server with no key set answers 401, and the line says
so), `probe desk:<model>` runs the six checks, `list` shows the address and whether the key is set.
Every run records where its models were served from (`config.endpoints`: the address, the host,
and whether it is another machine), `show <run>` prints it above the summary, and the thermal
record on the rows stays this machine's — a model on a desktop has its own heat.

## 3. Record the lineage

Add the checkpoint to `models/lineage.json` (or the file `LINEAGE_FILE` points at):

```json
"vllm:my-ckpt-2000": {
  "family": "mine",
  "checkpoint": "2000",
  "step": 2000,
  "parent": "vllm:my-ckpt-1000",
  "trainedOn": "mix-v2",
  "date": "2026-09-08",
  "notes": "second run, same data, lr halved"
}
```

Every run records the entries of the clients it ran; the index carries `family`, `checkpoint`,
`step` and `parent` per trial; `node src/cli.js models` lists the registry with what the index holds
for each entry. A variant of a checkpoint (`…@skill:preload`, `…@stress:budget`) inherits its lineage.

## 4. Run the suite, then compare with the parent

```bash
node src/cli.js suite smoke --clients vllm:my-ckpt-2000 --instance-seed 7      # a few minutes: one task per capability, two trials per cell
node src/cli.js suite standard --clients vllm:my-ckpt-1000,vllm:my-ckpt-2000 --instance-seed 7
node src/cli.js compare <run-id> --a vllm:my-ckpt-2000 --parent --mode harness  # paired against the parent named in the lineage
node src/cli.js scorecard vllm:my-ckpt-2000                                      # the capability profile pooled over every run
```

`--instance-seed` matters: with the same seed, the generated families mint the same problems for
both checkpoints (and for the same checkpoint next week), so `compare` pairs them and McNemar's
test applies. In the web UI a run's "Paired comparison" block does the same, and can take B from any
other saved run on the same seed.

## 5. Gate it

```bash
node src/cli.js gate <run-id> --gates gates/nightly.json --client vllm:my-ckpt-2000     # exit 0 pass · 1 fail · 2 a gate could not be judged
node src/cli.js suite smoke --clients vllm:my-ckpt-2000 --gate "tool-use>=80" --gate "errors<=0"
```

A gate names what to measure and the bar: a capability (`tool-use>=80`), a task (`health>=100`), a
family level (`restock:6>=50`), a family's breaking point (`break:restock>=12`, it must not break
below 12), a whole mode (`overall@noHarness>=60`), the error rows (`errors<=0`) or the index's
regression flags for the checkpoint (`regressions<=0`: its own earlier runs and its lineage parent).
Verdicts follow the Wilson band: a gate fails only when the whole band lies under the bar; a rate
below the bar whose band still reaches it is inconclusive (four trials cannot tell 75 % from 80 %),
and `--strict` turns that into a failure. A gate with fewer trials than `minTrials` (the file's,
`--min-trials`, else the run's trials per cell) is incomplete. `gates/nightly.json` is the file
form, with `minTrials` and a default mode; tune its bars to the family you train, and keep them where a checkpoint you
would ship passes.

## 6. Nightly

```bash
node src/cli.js suite nightly --clients vllm:my-ckpt-2000 --instance-seed 7 --judge openai:gpt-4o-mini
```

The standard suite (every task, four trials per cell, both headline modes) under a 90-minute time
box, gated by `gates/nightly.json`; the judge grades `explain`. The exit code is the verdict, the
run carries it (`run.gates`; `gate_verdict` in the index; the headline in the UI), and
`regressions<=0` compares the run with the checkpoint's earlier runs and its parent. A time box that
runs out saves what completed as `timeout`, and the gates it could not judge are incomplete (exit 2),
not failures. From cron:

```
15 2 * * *  cd /path/to/bench && node src/cli.js suite nightly --clients vllm:my-ckpt-latest --instance-seed 7 --judge openai:gpt-4o-mini >> results/nightly.log 2>&1 || echo "bench gate exited $?" | mail -s "nightly bench" you@example.com
```
