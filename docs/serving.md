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
| **llama.cpp** (GGUF, CPU / Metal / CUDA) | `llama-server -m /path/to/model.gguf --port 8080 --jinja -c 16384` | `http://127.0.0.1:8080/v1` |
| **MLX** (Apple Silicon, HF or MLX weights) | `python -m mlx_lm.server --model /path/to/checkpoint --port 8081` | `http://127.0.0.1:8081/v1` |
| **Ollama** (GGUF or safetensors via a Modelfile) | `printf 'FROM /path/to/model.gguf\n' > Modelfile && ollama create my-ckpt-2000 -f Modelfile` | `http://127.0.0.1:11434/v1` (already the `local` provider) |

Notes that matter for this bench:

- **Tool calling must be on.** Harness mode sends `tools`; a server that ignores them scores the
  model as if it never called a tool. vLLM needs `--enable-auto-tool-choice` and a
  `--tool-call-parser` matching the model's chat template; llama.cpp needs `--jinja`; MLX and
  Ollama follow the model's template. `node src/bench.js --task health --modes harness --clients
  <endpoint>:<model> --count 1` is the one-trial check: `toolCalls` in the saved row should be non-empty.
- **The model id** the bench sends is what the server lists at `/v1/models` (vLLM:
  `--served-model-name`; llama.cpp: the file name unless `--alias`; MLX: the path; Ollama: the
  created name). `node src/cli.js list` shows what each endpoint reports.
- **Thinking models** may spend the whole token budget reasoning on a free-form answer; raise
  `BENCH_TIMEOUT_MS` and prefer the runtime's own reasoning-effort knob over `--model-param`.
- Requests under `--parallel` queue at the server; latency columns then include queueing. Compare
  latencies serial-to-serial.

## 2. Name the endpoint

In `.env`:

```
LOCAL_ENDPOINTS=vllm=http://127.0.0.1:8000/v1;llamacpp=http://127.0.0.1:8080/v1;mlx=http://127.0.0.1:8081/v1
```

Each name becomes a provider like `local`: no key, models probed live from its `/v1/models`, marked
offline in the UI when the server is down. Clients are `<name>:<model>` — `vllm:my-ckpt-2000`. A
name never shadows a built-in provider.

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
