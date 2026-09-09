// effort.js — the reasoning-effort knob, per provider. One word on the command line
// (`--effort low`, or `<client>@effort:none` for a paired A/B against the base) becomes what each
// provider's OpenAI-compatible route understands: `reasoning_effort` where the route takes it
// (OpenAI, Anthropic, Gemini, xAI, DeepSeek, Groq), and `reasoning: { effort }` on Ollama's
// route, the one form it honours (checked against Ollama 0.33.3: `think: false`,
// `reasoning_effort` and the `/no_think` switch all left the local thinking model's reasoning
// untouched; `reasoning: { effort: "none" }` emptied it). Mistral's route has no such parameter,
// so the knob is recorded and nothing is sent. The run records the knob and the translated
// parameters, and every row records the reasoning characters that came back, so whether a knob
// took effect is a number on the row, not an assumption.

export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high"];

export function parseEffortSuffix(spec) {
  const m = String(spec).match(/^(.*)@effort(?::([a-z]+))?$/);
  if (!m) return { base: spec, how: null };
  const how = m[2] ?? "none";
  if (!EFFORT_LEVELS.includes(how)) throw new Error(`unknown effort level "${how}" in "${spec}" — use @effort:${EFFORT_LEVELS.join("|")}`);
  return { base: m[1], how };
}

// The request parameters a level turns into for a provider: Ollama's route wants the
// `reasoning: { effort }` object; every other route the flat `reasoning_effort`, the common form.
export function effortParams(provider, level) {
  if (!level) return {};
  if (!EFFORT_LEVELS.includes(level)) throw new Error(`unknown effort level "${level}" (${EFFORT_LEVELS.join(" | ")})`);
  if (provider === "mistral") return {};
  if (provider === "local" || provider === "ollama") return { reasoning: { effort: level } };
  return { reasoning_effort: level };
}

export function describeEffort(provider, level) {
  const p = effortParams(provider, level);
  return Object.keys(p).length ? `${level} → ${Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}` : `${level} → nothing sent (${provider} has no such parameter)`;
}

// A client wrapped as "<client>@effort:<level>": the same requests with the level's parameters,
// paired by summarize against the base client like the other treatments (`delta.byEffort`).
export function withEffort(client, level) {
  if (!EFFORT_LEVELS.includes(level)) throw new Error(`unknown effort level "${level}" (${EFFORT_LEVELS.join(" | ")})`);
  const provider = client.provider || String(client.name).split(":")[0];
  const params = effortParams(provider, level);
  return {
    ...client,
    name: `${client.name}@effort:${level}`,
    baseName: client.name,
    effort: level,
    effortParams: params,
    chat: (messages, tools, opts = {}) => client.chat(messages, tools, { ...opts, extraParams: { ...(opts.extraParams ?? {}), ...params } }),
    runWithTools: (prompt, tools, system, opts = {}) => client.runWithTools(prompt, tools, system, { ...opts, extraParams: { ...(opts.extraParams ?? {}), ...params } }),
  };
}
