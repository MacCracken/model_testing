// OpenAI-compatible chat completion client.
//
// This is the single engine both "no-harness" and "with-harness" modes use. It speaks the
// OpenAI REST contract (messages + tools + function-calling). Both OpenAI and Anthropic
// (and Groq/DeepSeek/Together/Cerebras/LocalAI, etc.) accept these requests, which is what
// lets us support multiple providers behind one client without heavy SDKs.
//
//     - Anthropic: the same client posts to https://api.anthropic.com/v1/chat/completions
//     with the standard OpenAI body. Anthropic documents this as an OpenAI-compatible route.
//     - Others: point baseURL at their /v1/chat/completions endpoint.
//
// We deliberately avoid SDKs so the project stays dependency-light and the model-provider
// surface is transparent.

import { randomUUID } from "node:crypto";

export class Client {
   /**
    * @param {object} opts
    * @param {string} opts.name - stable label for results, e.g. "openai:gpt-4o-mini"
    * @param {string} opts.model
    * @param {string} opts.apiKey
    * @param {string} opts.url - full chat completions URL, e.g. https://api.openai.com/v1/chat/completions
    * @param {object} [opts.headers] - extra headers (e.g. auth scheme). Defaults to Bearer.
    * @param {object} [opts.fetchImpl] - override fetch (e.g. for tests/undici).
    * @param {number} [opts.timeoutMs] - per-request timeout.
    * @param {object} [opts.modelParams] - default model params merged into every request.
    */
  constructor(opts) {
    this.name = opts.name;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.url = opts.url;
    this.provider = opts.provider ?? "";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.modelParams = opts.modelParams ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch;

    const auth = opts.headers?.["Authorization"] ?? `Bearer ${opts.apiKey}`;
    this.headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      Authorization: auth,
      ...(opts.headers ?? {}),
    };
  }

  // ---- tool <-> openai spec conversion -------------------------------------

  // Public-facing tools are described to the model as { type: "function", function: {...} }.
  // We store tasks' tools in a friendlier { name, description, parameters } form and add the
  // `type`/`function` wrapper here so the wire format is uniform across providers.
  normalizeTools(tools) {
    if (!tools || tools.length === 0) return [];
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters,
      },
    }));
  }

  // The model returns { tool_calls: [{ id, function: { name, arguments } }] }.
  // We collect them into an array of invocation objects { name, arguments } on the next turn.
  extractToolCalls(messages) {
    const calls = [];
    for (const msg of messages) {
      const c = msg?.tool_calls;
      if (!Array.isArray(c)) continue;
      for (const call of c) {
        const args = call.function?.arguments ?? "{}";
        let parsed;
        try { parsed = JSON.parse(args); } catch { parsed = args; }
        calls.push({ id: call.id, name: call.function?.name, arguments: parsed });
      }
    }
    return calls;
  }

  // Parse a single tool-call's arguments (already isolated to one call) into an object.
  // Returns {} if the call has no arguments or the arguments are unparseable.
  parseToolArgs(call) {
    const args = call.function?.arguments ?? "{}";
    try { return JSON.parse(args); } catch { return args; }
  }

  // ---- request/response ----------------------------------------------------

  async chat(messages, tools) {
    const body = {
      model: this.model,
      messages,
      tools: this.normalizeTools(tools),
      ...(this.modelParams ?? {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // Surface provider errors as structured objects where possible.
        let detail = text;
        try { detail = JSON.parse(text).error?.message ?? text; } catch { /* keep raw */ }
        throw new Error(`HTTP ${res.status} from ${this.name}: ${detail}`);
      }
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  // Convenience wrapper: build the messages array with a system message, call, then (if the
  // model returned tool calls) run the tools and append their results for a follow-up call.
  // This implements the classic tool-use loop and is what the "with-harness" mode relies on.
  async runWithTools(initialPrompt, tools, systemMessage, { maxRounds = 4 } = {}) {
    const messages = [
      ...(systemMessage ? [{ role: "system", content: systemMessage }] : []),
      { role: "user", content: initialPrompt },
    ];

    let round = 0;
    let final = null;
    while (round < maxRounds) {
      round += 1;
      const resp = await this.chat(messages, tools);
      const choices = resp.choices ?? [];
      const finish = choices[choices.length - 1];

      // Model chose to stop -> return its text.
      if (!finish.message?.tool_calls?.length) {
        // Surface the latest tool state if we reached it via a tool turn this loop (the model may
        // have stopped after reading results). Otherwise fall back to the model's free text.
        if (final) {
          return final;
        }
        return {
          text: finish.message?.content ?? "",
          toolCalls: this.extractToolCalls(messages),
          finishReason: finish.finish_reason,
          usage: resp.usage,
          structured: null,
        };
      }

      // Model asked to use tools: build the assistant message and invoke each tool.
      const callIds = finish.message.tool_calls.map((tc) => tc.id);
      const assistantMsg = {
        role: "assistant",
        tool_calls: finish.message.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };
      messages.push(assistantMsg);

      const results = await Promise.all(
        finish.message.tool_calls.map(async (tc) => {
          const fn = tools.find((t) => t.name === tc.function.name);
          if (!fn) return { name: tc.function.name, content: `unknown tool: ${tc.function.name}` };

          try {
            const out = await fn.impl(this.parseToolArgs(tc));
            return { name: tc.function.name, content: typeof out === "string" ? out : JSON.stringify(out) };
          } catch (err) {
            return { name: fn.name, content: `tool error: ${err.message}` };
          }
        })
      );

      // Append one tool result per call so the model can reason about each independently on the
      // next turn.
      for (let i = 0; i < finish.message.tool_calls.length; i++) {
        messages.push({ role: "tool", tool_call_id: callIds[i], content: results[i].content });
      }

      // Track the latest tool state so we can surface it if the loop ends without a natural stop.
      final = {
        text: results[0].content,
        toolCalls: this.extractToolCalls(messages),
        toolResults: results,
        finishReason: "tool",
        usage: resp.usage,
        structured: (() => {
          try { return JSON.parse(results[0].content); } catch { return null; }
        })(),
      };
    }

    // Ran out of rounds. Surface the latest tool state if we have any, else an empty result.
    return final ?? { text: "", toolCalls: this.extractToolCalls(messages), finishReason: "max_rounds", usage: null, structured: null };
  }
}
