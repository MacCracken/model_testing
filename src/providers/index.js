import "../env.js";
import { Client } from "./client.js";
import { ThothClient } from "../harness/thoth.js";
import { ClaudeCodeClient } from "../harness/claude-code.js";
import { PiClient } from "../harness/pi.js";
import { CodexClient } from "../harness/codex.js";
import { envValue } from "../util.js";
import { withSkill, parseSkillSuffix } from "../skills.js";
import { withDelegation, parseAgentsSuffix } from "../agents.js";
import { withStress, parseStressSuffix } from "../stress.js";
import { withConstraints, parseConstraintsSuffix } from "../constraints.js";
import { withFormat, parseFormatSuffix } from "../format.js";
import { withEffort, parseEffortSuffix, effortParams } from "../effort.js";
import { withConfidence, parseConfidenceSuffix } from "../confidence.js";
import { withAbstain, parseAbstainSuffix } from "../abstain.js";
import { withPerturb, parsePerturbSuffix } from "../perturb.js";

// Provider registry: maps a stable provider name -> a list of models to try, plus the URL and
// auth scheme. Kept here so CLI flags and the web UI can select providers/tasks/models without
// touching the client code. Add entries freely; the bench just iterates them.
//
// URLs are *full* chat-completions endpoints (the client POSTs here directly).

const PROVIDERS = {
  openai: {
    baseUrl: "https://api.openai.com/v1/chat/completions",
    auth: (key) => `Bearer ${key}`,
    models: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-mini"],
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1/chat/completions",
    // Anthropic supports the OpenAI-compatible route at the URL above; auth is Bearer on the
    // key. This lets the same client drive Anthropic models.
    auth: (key) => `Bearer ${key}`,
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    auth: (key) => `Bearer ${key}`,
    models: ["llama-3.3-70b-versatile", "gemma2-9b-it"],
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    auth: (key) => `Bearer ${key}`,
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  // Gemini through its OpenAI-compatible route (GEMINI_API_KEY). The model list is a fallback: with
  // a key, the live list is probed from the route's /models like a local daemon's.
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    auth: (key) => `Bearer ${key}`,
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    probeModels: true,
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    auth: (key) => `Bearer ${key}`,
    models: ["mistral-small-latest", "mistral-large-latest"],
    probeModels: true,
  },
  xai: {
    baseUrl: "https://api.x.ai/v1/chat/completions",
    auth: (key) => `Bearer ${key}`,
    models: ["grok-4-fast", "grok-4"],
    probeModels: true,
  },
  // A real agent harness as the harness arm (see harness/thoth.js). Needs no key; THOTH_CMD says
  // how to invoke it (e.g. `ssh -n arch cd ~/Repos/thoth && thoth`). Structured modes only.
  thoth: {
    baseUrl: envValue("THOTH_CMD", "thoth"),
    auth: () => "",
    needsKey: false,
    harness: "thoth",
    models: ["default"],
  },
  // Claude Code as the harness arm (see harness/claude-code.js): `claude -p --bare`, Bash only,
  // permissions bypassed. Uses ANTHROPIC_API_KEY; CLAUDE_CODE_CMD overrides the binary.
  "claude-code": {
    baseUrl: envValue("CLAUDE_CODE_CMD", "claude"),
    auth: () => "",
    keyEnv: "ANTHROPIC_API_KEY",
    harness: "claude-code",
    models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
  },
  // Pi as the harness arm (see harness/pi.js): model ids are `provider/model`; the key for that
  // provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) is passed to Pi with --api-key.
  pi: {
    baseUrl: envValue("PI_CMD", "pi"),
    auth: () => "",
    needsKey: false,
    harness: "pi",
    models: ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5"],
  },
  // The same arms with the bench's tools shared over MCP (see harness/toolbridge.js): no shell for
  // Claude Code, the shell beside the shared tools for Codex; every bench tool call runs in the
  // bench and is scored by the task's tool-use verdict. Labelled apart from bring-your-own.
  "claude-code-mcp": {
    baseUrl: envValue("CLAUDE_CODE_CMD", "claude"),
    auth: () => "",
    keyEnv: "ANTHROPIC_API_KEY",
    harness: "claude-code",
    sharedTools: true,
    models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
  },
  "codex-mcp": {
    baseUrl: envValue("CODEX_CMD", "codex"),
    auth: () => "",
    needsKey: false,
    harness: "codex",
    sharedTools: true,
    models: ["gpt-5.4-mini"],
  },
  // Codex CLI as the harness arm (see harness/codex.js). Authenticates through `codex login`.
  codex: {
    baseUrl: envValue("CODEX_CMD", "codex"),
    auth: () => "",
    needsKey: false,
    harness: "codex",
    models: ["gpt-6-astra", "gpt-5.4-mini"],
  },
  local: {
    baseUrl: envValue("OLLAMA_BASE_URL", "http://localhost:11434/v1/chat/completions"),
    // Ollama ignores auth entirely, so there is no key to configure.
    auth: () => "Bearer local",
    needsKey: false,
    // Fallback list; the live set is probed from Ollama's /v1/models where it's reachable.
    models: ["ornith-1.5:9b", "qwen3.5:9b-mlx", "gemma4:31b-mlx", "qwen3.8:27b-mlx"],
    local: true,
  },
};

// Named local endpoints — a vLLM, llama.cpp or MLX server serving a checkpoint through the
// OpenAI-compatible route: LOCAL_ENDPOINTS="vllm=http://127.0.0.1:8000/v1;mlx=http://127.0.0.1:8080/v1".
// Each becomes a provider like `local`: no key, models probed live from its /v1/models.
export function parseLocalEndpoints(spec) {
  const out = {};
  for (const part of String(spec ?? "").split(/[;,]/)) {
    const m = part.trim().match(/^([a-z][a-z0-9_-]*)\s*=\s*(https?:\/\/\S+)$/i);
    if (!m) continue;
    let url = m[2].replace(/\/+$/, "");
    if (!/\/chat\/completions$/.test(url)) url = `${url.replace(/\/v1$/, "")}/v1/chat/completions`;
    out[m[1].toLowerCase()] = url;
  }
  return out;
}

export function registerLocalEndpoints(map) {
  const added = [];
  for (const [name, url] of Object.entries(map)) {
    if (PROVIDERS[name] && !PROVIDERS[name].endpoint) continue; // never shadow a built-in provider
    PROVIDERS[name] = { baseUrl: url, auth: () => "Bearer local", needsKey: false, local: true, endpoint: true, models: [] };
    added.push(name);
  }
  return added;
}
registerLocalEndpoints(parseLocalEndpoints(envValue("LOCAL_ENDPOINTS", "")));

// Model -> human label for reports. Optional; override by editing this map.
const MODEL_LABELS = {
  "gpt-4o-mini": "GPT-4o mini",
  "gpt-4o": "GPT-4o",
  "gpt-4.1-mini": "GPT-4.1 mini",
  "gpt-5-mini": "GPT-5 mini",
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "llama-3.3-70b-versatile": "Llama 3.3 70B",
  "gemma2-9b-it": "Gemma 2 9B",
  "deepseek-chat": "DeepSeek V3 (chat)",
  "deepseek-reasoner": "DeepSeek R1 (reasoner)",
  "ornith-1.5:9b": "Ornith 1.5 9B",
  "qwen3.5:9b-mlx": "Qwen 3.5 9B",
  "nemotron-3.5-lightning:30b-mlx": "Nemotron 3.5 Lightning 30B",
  "gemma4:31b-mlx": "Gemma 4 31B",
  "qwen3.8:27b-mlx": "Qwen 3.8 27B",
  default: "Thoth (its own routed model)",
  "gpt-6-astra": "GPT-6 Astra (Codex default)",
  "gpt-5.4-mini": "GPT-5.4 mini",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "mistral-small-latest": "Mistral Small (latest)",
  "mistral-large-latest": "Mistral Large (latest)",
  "grok-4-fast": "Grok 4 Fast",
  "grok-4": "Grok 4",
};

export function labelModel(model) {
  return MODEL_LABELS[model] ?? model;
}

export function apiKeyFor(provider) {
  const cfg = PROVIDERS[provider];
  return envValue(cfg?.keyEnv ?? `${provider.toUpperCase()}_API_KEY`);
}

// A provider is usable when it needs no key (local) or has one configured.
export function hasCredentials(provider) {
  const cfg = PROVIDERS[provider];
  return !!cfg && (cfg.needsKey === false || !!apiKeyFor(provider));
}

// Build a Client for a single { provider, model } pair, or null if the credentials are missing.
// `modelParams` (e.g. { temperature, seed }) are sent as-is with every request — the determinism
// knobs, recorded in the run so results stay comparable.
export function buildClient({ provider, model, modelParams = {} }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  if (!hasCredentials(provider)) return null;
  if (cfg.harness === "thoth") return new ThothClient({ name: `${provider}:${model}`, model, command: cfg.baseUrl });
  if (cfg.harness === "claude-code") return new ClaudeCodeClient({ name: `${provider}:${model}`, model, command: cfg.baseUrl, apiKey: apiKeyFor(provider), sharedTools: !!cfg.sharedTools });
  if (cfg.harness === "pi") {
    const upstream = model.includes("/") ? model.slice(0, model.indexOf("/")) : null;
    return new PiClient({ name: `${provider}:${model}`, model, command: cfg.baseUrl, apiKey: upstream ? envValue(`${upstream.toUpperCase()}_API_KEY`) || null : null });
  }
  if (cfg.harness === "codex") return new CodexClient({ name: `${provider}:${model}`, model, command: cfg.baseUrl, sharedTools: !!cfg.sharedTools });
  const key = apiKeyFor(provider) || "local";
  // A run-level effort knob (--effort) is translated per provider here; the knob itself stays in
  // the run's recorded model params, the translated parameters are what is sent.
  const { effort, ...plain } = modelParams ?? {};
  const sent = effort ? { ...plain, ...effortParams(provider, effort) } : plain;
  return new Client({
    name: `${provider}:${model}`,
    provider,
    model,
    apiKey: key,
    url: cfg.baseUrl,
    headers: { Authorization: cfg.auth(key) },
    modelParams: sent,
    // Per-request timeout: two minutes for a hosted route, five for a local one — a thinking model
    // served locally can spend minutes on a free-form answer (four lineup6 trials of ornith hit the
    // old two-minute default). BENCH_TIMEOUT_MS overrides either.
    timeoutMs: Number(envValue("BENCH_TIMEOUT_MS", cfg.local ? "300000" : "120000")) || (cfg.local ? 300_000 : 120_000),
  });
}

// Parse a "provider:model" string into { provider, model }. A bare provider name stays a
// string and is expanded to that provider's default models by resolveClients.
export function parseClientSpec(spec) {
  if (typeof spec !== "string") return spec;
  // A trailing "@skill[:how]" asks for the client wrapped with the task's playbook; "@agents[:how]"
  // for the client with a delegate tool. One variant per client — a treatment is one thing.
  const sk = parseSkillSuffix(spec);
  const ag = parseAgentsSuffix(sk.base);
  const st = parseStressSuffix(ag.base);
  const co = parseConstraintsSuffix(st.base);
  const fo = parseFormatSuffix(co.base);
  const ef = parseEffortSuffix(fo.base);
  const cf = parseConfidenceSuffix(ef.base);
  const ab = parseAbstainSuffix(cf.base);
  const pe = parsePerturbSuffix(ab.base);
  const base = pe.base;
  if (/@(skill|agents|stress|constraints|format|effort|confidence|abstain|perturb)(:|$)/.test(base)) throw new Error(`"${spec}": one variant per client — @skill:<how>, @agents:<how>, @stress:<profile>, @constraints:<level>, @format:<how>, @effort:<level>, @confidence, @abstain or @perturb:<kind>, not several`);
  const variant = { ...(sk.how ? { skill: sk.how } : {}), ...(ag.how ? { agents: ag.how } : {}), ...(st.how ? { stress: st.how } : {}), ...(co.how ? { constraints: co.how } : {}), ...(fo.how ? { format: fo.how } : {}), ...(ef.how ? { effort: ef.how } : {}), ...(cf.how ? { confidence: cf.how } : {}), ...(ab.how ? { abstain: ab.how } : {}), ...(pe.how ? { perturb: pe.how } : {}) };
  const idx = base.indexOf(":");
  if (idx === -1) return Object.keys(variant).length ? { provider: base, ...variant } : base;
  return { provider: base.slice(0, idx), model: base.slice(idx + 1), ...variant };
}

// Normalize a clients spec into an array of { provider, model } objects / bare provider names.
// Accepts an array of specs, a single "provider:model" string, or a comma-separated string.
export function normalizeClientSpecs(spec) {
  if (!spec) return [];
  const items = Array.isArray(spec) ? spec : String(spec).split(",").map((s) => s.trim());
  return items.filter(Boolean).map(parseClientSpec);
}

// Resolve the full list of clients to run. With no spec, every configured provider/model that
// has credentials. Bare provider names expand to that provider's default models.
export function resolveClients(spec, { modelParams = {} } = {}) {
  const clients = [];
  const seen = new Set();
  const push = (provider, model, variant = {}) => {
    const key = `${provider}:${model}${variant.skill ? `@skill:${variant.skill}` : ""}${variant.agents ? `@agents:${variant.agents}` : ""}${variant.stress ? `@stress:${variant.stress}` : ""}${variant.constraints ? `@constraints:${variant.constraints}` : ""}${variant.format ? `@format:${variant.format}` : ""}${variant.effort ? `@effort:${variant.effort}` : ""}${variant.confidence ? "@confidence" : ""}${variant.abstain ? "@abstain" : ""}${variant.perturb ? `@perturb:${variant.perturb}` : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const c = buildClient({ provider, model, modelParams });
    if (!c) return;
    clients.push(variant.skill ? withSkill(c, variant.skill) : variant.agents ? withDelegation(c, variant.agents) : variant.stress ? withStress(c, variant.stress) : variant.constraints ? withConstraints(c, variant.constraints) : variant.format ? withFormat(c, variant.format) : variant.effort ? withEffort(c, variant.effort) : variant.confidence ? withConfidence(c) : variant.abstain ? withAbstain(c, variant.abstain) : variant.perturb ? withPerturb(c, variant.perturb) : c);
  };

  if (!spec || (Array.isArray(spec) && !spec.length)) {
    for (const [provider, cfg] of Object.entries(PROVIDERS)) {
      for (const model of cfg.models) push(provider, model);
    }
    return clients;
  }

  for (const item of normalizeClientSpecs(spec)) {
    const provider = typeof item === "string" ? item : item.provider;
    const model = typeof item === "string" ? undefined : item.model;
    const variant = typeof item === "string" ? {} : { skill: item.skill ?? null, agents: item.agents ?? null, stress: item.stress ?? null, constraints: item.constraints ?? null, format: item.format ?? null, effort: item.effort ?? null, confidence: item.confidence ?? null, abstain: item.abstain ?? null, perturb: item.perturb ?? null };
    if (!PROVIDERS[provider]) continue;
    if (model === undefined) {
      for (const m of PROVIDERS[provider].models) push(provider, m, variant);
    } else {
      push(provider, model, variant);
    }
  }
  return clients;
}

// Ask an Ollama-compatible server what it actually has loaded, so the UI offers real models
// instead of a list that drifts out of date. Returns null when unreachable.
export async function probeLocalModels({ timeoutMs = 1500, provider = "local" } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return null;
  const url = cfg.baseUrl.replace(/\/chat\/completions$/, "/models");
  try {
    // A hosted route wants the key; a local daemon ignores the header.
    const key = cfg.local ? null : apiKeyFor(provider);
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...(key ? { headers: { Authorization: cfg.auth(key) } } : {}) });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

// Provider metadata for the web UI: which providers are usable, and what models to offer.
// `live` is null for hosted providers, true/false for the local daemon.
export async function describeProviders({ probe = true } = {}) {
  // Every local provider (Ollama and any named endpoint) is probed; a hosted one is probed when it
  // opts in (`probeModels`) and has a key, so its list is the route's rather than a fallback.
  const live = {};
  if (probe) {
    await Promise.all(Object.entries(PROVIDERS).filter(([name, c]) => c.local || (c.probeModels && hasCredentials(name))).map(async ([name]) => { live[name] = await probeLocalModels({ provider: name, timeoutMs: PROVIDERS[name].local ? 1500 : 4000 }); }));
  }
  return Object.entries(PROVIDERS).map(([name, cfg]) => ({
    name,
    baseUrl: cfg.baseUrl,
    kind: cfg.harness ? "harness" : "model",
    harness: cfg.harness ?? null,
    sharedTools: !!cfg.sharedTools,
    needsKey: cfg.needsKey !== false,
    hasKey: hasCredentials(name),
    local: !!cfg.local,
    endpoint: !!cfg.endpoint,
    live: cfg.local || cfg.probeModels ? (live[name] ?? null) !== null : null,
    models: (live[name] ? live[name] : cfg.models).map((model) => ({
      id: model,
      label: labelModel(model),
      client: `${name}:${model}`,
    })),
  }));
}

export { PROVIDERS, MODEL_LABELS };
