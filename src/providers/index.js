import { Client } from "./client.js";
import { parseEnv } from "../util.js";

// Provider registry: maps a stable provider name -> a list of models to try, plus the URL and
// auth scheme. Kept here so CLI flags and the web UI can select providers/tasks/models without
// touching the client code. Add entries freely; the bench just iterates them.
//
// URLs are *full* chat-completions endpoints (the client POSTs here directly).

const PROVIDERS = {
  openai: {
    baseUrl: "https://api.openai.com/v1/chat/completions",
    auth: (key) => `Bearer ${key}`,
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1/chat/completions",
    // Anthropic supports the OpenAI-compatible route at the URL above; auth is Bearer on the
    // key. This lets the same client drive Anthropic models.
    auth: (key) => `Bearer ${key}`,
    models: ["claude-3-5-sonnet-latest", "claude-opus-4-20250514"],
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    auth: (key) => `Bearer ${key}`,
    models: ["llama-3.3-70b-versatile", "gemma2-9b-it"],
  },
  local: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1/chat/completions",
    auth: () => "Bearer local",
    // Fallback list; the live set is probed from Ollama's /v1/models where it's reachable.
    models: ["ornith-1.5:9b", "qwen3.5:9b-mlx", "gemma4:31b-mlx", "qwen3.8:27b-mlx"],
  },
};

// Model -> human label for reports. Optional; override by editing this map.
const MODEL_LABELS = {
  "gpt-4o-mini": "GPT-4o mini",
  "gpt-4o": "GPT-4o",
  "gpt-4.1-mini": "GPT-4.1 mini",
  "claude-3-5-sonnet-latest": "Claude 3.5 Sonnet",
  "claude-opus-4-20250514": "Claude Opus 4",
  "llama-3.3-70b-versatile": "Llama 3.3 70B",
  "gemma2-9b-it": "Gemma 2 9B",
  "ornith-1.5:9b": "Ornith 1.5 9B",
  "qwen3.5:9b-mlx": "Qwen 3.5 9B",
  "nemotron-3.5-lightning:30b-mlx": "Nemotron 3.5 Lightning 30B",
  "gemma4:31b-mlx": "Gemma 4 31B",
  "qwen3.8:27b-mlx": "Qwen 3.8 27B",
};

export function labelModel(model) {
  return MODEL_LABELS[model] ?? model;
}

export function apiKeyFor(provider) {
  return parseEnv(`${provider.toUpperCase()}_API_KEY`);
}

// Build a Client for a single { provider, model } pair, or null if the key is missing.
export function buildClient({ provider, model }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  const key = apiKeyFor(provider);
  if (!key) return null;
  return new Client({
    name: `${provider}:${model}`,
    provider,
    model,
    apiKey: key,
    url: cfg.baseUrl,
    headers: { Authorization: cfg.auth(key) },
  });
}

// Parse a "provider:model" string into { provider, model }. A bare provider name stays a
// string and is expanded to that provider's default models by resolveClients.
export function parseClientSpec(spec) {
  if (typeof spec !== "string") return spec;
  const idx = spec.indexOf(":");
  if (idx === -1) return spec;
  return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
}

// Normalize a clients spec into an array of { provider, model } objects / bare provider names.
// Accepts an array of specs, a single "provider:model" string, or a comma-separated string.
export function normalizeClientSpecs(spec) {
  if (!spec) return [];
  const items = Array.isArray(spec) ? spec : String(spec).split(",").map((s) => s.trim());
  return items.filter(Boolean).map(parseClientSpec);
}

// Resolve the full list of clients to run. With no spec, every configured provider/model that
// has a key. Bare provider names expand to that provider's default models.
export function resolveClients(spec) {
  const clients = [];
  const seen = new Set();
  const push = (provider, model) => {
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    const c = buildClient({ provider, model });
    if (c) clients.push(c);
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
    if (!PROVIDERS[provider]) continue;
    if (model === undefined) {
      for (const m of PROVIDERS[provider].models) push(provider, m);
    } else {
      push(provider, model);
    }
  }
  return clients;
}

// Ask an Ollama-compatible server what it actually has loaded, so the UI offers real models
// instead of a list that drifts out of date. Returns null when unreachable.
export async function probeLocalModels({ timeoutMs = 1500 } = {}) {
  const url = PROVIDERS.local.baseUrl.replace(/\/chat\/completions$/, "/models");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

// Provider metadata for the web UI: which providers have keys, and what models to offer.
export async function describeProviders({ probe = true } = {}) {
  const live = probe ? await probeLocalModels() : null;
  return Object.entries(PROVIDERS).map(([name, cfg]) => ({
    name,
    baseUrl: cfg.baseUrl,
    hasKey: !!apiKeyFor(name),
    live: name === "local" ? live !== null : null,
    models: (name === "local" && live ? live : cfg.models).map((model) => ({
      id: model,
      label: labelModel(model),
      client: `${name}:${model}`,
    })),
  }));
}

export { PROVIDERS, MODEL_LABELS };
