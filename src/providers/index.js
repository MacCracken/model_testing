import { Client } from "./client.js";
import { parseEnv } from "../util.js";

// Provider registry: maps a stable provider name -> a list of models to try, plus the URL and
// auth scheme. Kept here so CLI flags can select providers/tasks/models without touching the
// client code. Add entries freely; the bench just iterates them.
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
    baseUrl: "http://localhost:11434/v1/chat/completions",
    auth: () => "Bearer local",
    // Models currently present in this environment's Ollama instance (from /v1/models).
    models: ["ornith-1.5:9b", "nemotron-3.5-lightning:30b-mlx", "gemma4:31b-mlx", "qwen3.8:27b-mlx"],
  },
};

// Model -> human label for reports. Optional; override by editing this map or via .env.
const MODEL_LABELS = {
  "gpt-4o-mini": "GPT-4o mini",
  "gpt-4o": "GPT-4o",
  "gpt-4.1-mini": "GPT-4.1 mini",
  "claude-3-5-sonnet-latest": "Claude 3.5 Sonnet",
  "claude-opus-4-20250514": "Claude Opus 4",
  "llama-3.3-70b-versatile": "Llama 3.3 70B",
  "gemma2-9b-it": "Gemma 2 9B",
  "ornith-1.5:9b": "Ornith 1.5",
  "nemotron-3.5-lightning:30b-mlx": "Nemotron 3.5 Lightning",
  "gemma4:31b-mlx": "Gemma 4 31B",
  "qwen3.8:27b-mlx": "Qwen 3.8 27B",
};

export function labelModel(model) {
  return MODEL_LABELS[model] ?? model;
}

// Build a Client for a single { provider, model } pair, or null if the key is missing.
export function buildClient({ provider, model }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  const key = parseEnv(`${provider.toUpperCase()}_API_KEY`);
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

// Parse a "provider:model" string into { provider, model }.
export function parseClientSpec(spec) {
  if (typeof spec === "string") {
    const idx = spec.indexOf(":");
    if (idx === -1) return spec;
    return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
  }
  return spec;
}

// Normalize a clients spec into an array of { provider, model } objects.
// Accepts: an array of specs, a single "provider:model" string, or a comma-separated
// string of "provider:model" specs.
export function normalizeClientSpecs(spec) {
  if (!spec) return [];
  const items = Array.isArray(spec) ? spec : String(spec).split(",").filter(Boolean);
  return items.map(parseClientSpec);
}

// Resolve the full list of clients to run. Accepts a single provider name (uses its default
// models) or an explicit list of { provider, model } objects or "provider:model" strings.
export function resolveClients(spec) {
  const clients = [];
  if (!spec) {
    for (const [provider, cfg] of Object.entries(PROVIDERS)) {
      for (const model of cfg.models) {
        const c = buildClient({ provider, model });
        if (c) clients.push(c);
      }
    }
  } else if (Array.isArray(spec) && spec.length === 2 && typeof spec[0] === "string" && typeof spec[1] === "string") {
    // Two-element array: treat as a single "provider:model" pair.
    const c = buildClient({ provider: spec[0], model: spec[1] });
    if (c) clients.push(c);
  } else {
    for (const { provider, model } of normalizeClientSpecs(spec)) {
      // A bare provider name (no ":model") expands to that provider's default models, in order.
      if (!model) {
        const cfg = PROVIDERS[provider];
        if (!cfg) continue;
        for (const m of cfg.models) {
          const c = buildClient({ provider, model: m });
          if (c) clients.push(c);
        }
        continue;
      }
      const c = buildClient({ provider, model });
      if (c) clients.push(c);
    }
  }
  return clients;
}

export { PROVIDERS, MODEL_LABELS };
