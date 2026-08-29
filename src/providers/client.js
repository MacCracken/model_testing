// OpenAI-compatible chat completion client.
import { randomUUID } from "node:crypto";

export class Client {
    /** @param {object} opts - Client configuration options */
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
        this.headers = { "Content-Type": "application/json", "Accept": "application/json", Authorization: auth, ...(opts.headers ?? {}) };
    }

    /** Normalize user-friendly tool definitions to OpenAI-compatible format */
    normalizeTools(tools) {
        if (!tools || tools.length === 0) return [];
        const normalized = tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description ?? "", parameters: t.parameters }
        }));
        return normalized;
    }

    /** Extract tool calls from messages into an array of invocation objects */
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

    /** Parse a single tool-call's arguments (already isolated to one call) into an object */
    parseToolArgs(call) {
        const args = call.function?.arguments ?? "{}";
        try { return JSON.parse(args); } catch { return args; }
    }

    /** Send a chat completion with optional tools */
    async chat(messages, tools) {
        // Normalize tools if provided
        const normalizedTools = tools ? this.normalizeTools(tools) : [];

        const body = { model: this.model, messages, tools: normalizedTools, ...(this.modelParams ?? {}) };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await this.fetchImpl(this.url, { method: "POST", headers: this.headers, body: JSON.stringify(body), signal: controller.signal });
            const text = await res.text();
            if (!res.ok) {
                let detail = text;
                try { detail = JSON.parse(text).error?.message ?? text; } catch { /* keep raw */ }
                throw new Error(`HTTP ${res.status} from ${this.name}: ${detail}`);
            }

            const parsed = JSON.parse(text);
            const choice = parsed.choices?.[0];
            if (!choice) throw new Error("No choice returned from API");

            // Extract tool calls from the assistant message
            const toolCalls = [];
            if (Array.isArray(choice.message?.tool_calls)) {
                for (const tc of choice.message.tool_calls) {
                    const args = tc.function?.arguments ?? "{}";
                    let parsedArgs;
                    try { parsedArgs = JSON.parse(args); } catch { parsedArgs = args; }
                    toolCalls.push({ id: tc.id, name: tc.function.name, arguments: parsedArgs });
                }
            }

            // Build structured output from tool calls if available
            let structured = null;
            if (toolCalls.length > 0) {
                const firstResult = toolCalls[0].arguments || {};
                structured = firstResult;
            }

            return { text: choice.message?.content ?? "", toolCalls, finishReason: choice.finish_reason ?? "stop", usage: parsed.usage, structured };
        } finally {
            clearTimeout(timer);
        }
    }

    /** Convenience wrapper: build messages array, call tools iteratively, and append results */
    async runWithTools(initialPrompt, tools, systemMessage, { maxRounds = 4 } = {}) {
        const messages = [ ...(systemMessage ? [{ role: "system", content: systemMessage }] : []), { role: "user", content: initialPrompt } ];
        let round = 0;
        let final = null;

        while (round < maxRounds) {
            round += 1;
            const resp = await this.chat(messages, tools);

            // Check if the model chose to stop generating tool calls - preserve structured data if we have it
            const hasStructured = resp.structured !== null;
            const hasToolCalls = Array.isArray(resp.toolCalls) && resp.toolCalls.length > 0;

            if (!hasToolCalls || hasStructured) {
                // If we got structured data, return it immediately - don't lose it to more iterations
                return { text: resp.text ?? "", toolCalls: resp.toolCalls ?? [], finishReason: resp.finishReason, usage: resp.usage, structured: resp.structured };
            }

            // Model asked to use tools: build the assistant message and invoke each tool.
            const callIds = resp.toolCalls.map((tc) => tc.id);
            const assistantMsg = {
                role: "assistant",
                tool_calls: resp.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) }
                }))
            };
            messages.push(assistantMsg);

            const results = await Promise.all(
                resp.toolCalls.map(async (tc) => {
                    const fn = tools.find((t) => t.name === tc.name);
                    if (!fn) return { name: tc.name, content: `unknown tool: ${tc.name}` };
                    try {
                        const out = await fn.impl(this.parseToolArgs(tc));
                        return { name: tc.name, content: typeof out === "string" ? out : JSON.stringify(out) };
                    } catch (err) {
                        return { name: fn.name, content: `tool error: ${err.message}` };
                    }
                })
            );

            // Append tool results so model can see what happened
            for (let i = 0; i < resp.toolCalls.length; i++) {
                messages.push({ role: "tool", tool_call_id: callIds[i], content: results[i].content });
            }

            // Track the latest tool state - store structured result from last tool invocation
            final = { text: resp.text ?? results[0]?.content ?? "", toolCalls: resp.toolCalls ?? [], toolResults: results, finishReason: "tool", usage: resp.usage, structured: (() => { try { return JSON.parse(results[0].content); } catch (e) { return null; } })() };
        }

        // Ran out of rounds. Surface the latest tool state if we have any, else an empty result.
        return final ?? { text: "", toolCalls: [], finishReason: "max_rounds", usage: null, structured: null };
    }
}
