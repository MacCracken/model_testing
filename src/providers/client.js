// OpenAI-compatible chat completion client.
//
//   chat(messages, tools)                     — one round trip.
//   runWithTools(prompt, tools, system, opts) — the full loop: the model requests tools, we
//                                               execute their real `impl`s, feed the results
//                                               back, and repeat until it answers in prose.
//
// The distinction is the whole benchmark: harness mode only means anything if the tools
// actually run. What gets scored is the model's FINAL message, written after it has seen real
// tool output — never the arguments it passed in (those are the model's guess, not the answer).

import { parseJSONLoose } from "../json.js";

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
        return tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description ?? "", parameters: t.parameters }
        }));
    }

    /** Parse a single tool-call's arguments into an object */
    parseToolArgs(call) {
        const args = call.function?.arguments ?? call.arguments ?? "{}";
        if (typeof args === "object") return args;
        try { return JSON.parse(args); } catch { return {}; }
    }

    /** Send a chat completion with optional tools. One round trip; no tool execution. */
    async chat(messages, tools, { signal } = {}) {
        const normalizedTools = tools && tools.length ? this.normalizeTools(tools) : undefined;

        const body = {
            model: this.model,
            messages,
            ...(normalizedTools ? { tools: normalizedTools } : {}),
            ...(this.modelParams ?? {}),
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("request timed out")), this.timeoutMs);
        const onAbort = () => controller.abort(signal?.reason ?? new Error("cancelled"));
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        }

        try {
            let res;
            try {
                res = await this.fetchImpl(this.url, {
                    method: "POST",
                    headers: this.headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
            } catch (err) {
                // Timeouts and cancellations carry their own reason; a bare "fetch failed" does not
                // say which endpoint was unreachable, which is the first thing anyone needs to know.
                if (controller.signal.aborted) throw err;
                throw new Error(`${this.name}: ${err?.message ?? err} — is ${this.url} reachable?`);
            }
            const text = await res.text();
            if (!res.ok) {
                let detail = text;
                try { detail = JSON.parse(text).error?.message ?? text; } catch { /* keep raw */ }
                throw new Error(`HTTP ${res.status} from ${this.name}: ${detail}`);
            }

            const parsed = JSON.parse(text);
            const choice = parsed.choices?.[0];
            if (!choice) throw new Error(`no choice returned from ${this.name}`);

            const toolCalls = [];
            if (Array.isArray(choice.message?.tool_calls)) {
                for (const tc of choice.message.tool_calls) {
                    toolCalls.push({
                        id: tc.id ?? `call_${toolCalls.length}`,
                        name: tc.function?.name,
                        arguments: this.parseToolArgs(tc),
                    });
                }
            }

            return {
                text: choice.message?.content ?? "",
                toolCalls,
                finishReason: choice.finish_reason ?? "stop",
                usage: parsed.usage ?? null,
            };
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener?.("abort", onAbort);
        }
    }

    /**
     * Run the model against real tools until it produces a final answer.
     *
     * Returns { text, structured, toolCalls, toolResults, rounds, finishReason, usage }.
     * `structured` is the final message parsed as JSON (tolerantly) — null if it wasn't JSON.
     */
    async runWithTools(initialPrompt, tools, systemMessage, { maxRounds = 4, signal } = {}) {
        const messages = [
            ...(systemMessage ? [{ role: "system", content: systemMessage }] : []),
            { role: "user", content: initialPrompt },
        ];

        const allCalls = [];
        const allResults = [];
        let usage = null;
        let rounds = 0;

        while (rounds < maxRounds) {
            rounds += 1;
            const resp = await this.chat(messages, tools, { signal });
            usage = addUsage(usage, resp.usage);

            // No tool calls: this is the model's answer.
            if (!resp.toolCalls.length) {
                return {
                    text: resp.text ?? "",
                    structured: parseJSONLoose(resp.text),
                    toolCalls: allCalls,
                    toolResults: allResults,
                    rounds,
                    finishReason: resp.finishReason,
                    usage,
                };
            }

            allCalls.push(...resp.toolCalls);
            messages.push({
                role: "assistant",
                content: resp.text ?? "",
                tool_calls: resp.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
                })),
            });

            // Execute the real implementations.
            const results = await Promise.all(resp.toolCalls.map(async (tc) => {
                const fn = tools.find((t) => t.name === tc.name);
                if (!fn) return { id: tc.id, name: tc.name, ok: false, content: `unknown tool: ${tc.name}` };
                try {
                    const out = await fn.impl(tc.arguments ?? {});
                    return {
                        id: tc.id,
                        name: tc.name,
                        ok: true,
                        arguments: tc.arguments ?? {},
                        content: typeof out === "string" ? out : JSON.stringify(out),
                    };
                } catch (err) {
                    return { id: tc.id, name: tc.name, ok: false, arguments: tc.arguments ?? {}, content: `tool error: ${err.message}` };
                }
            }));

            allResults.push(...results);
            for (const r of results) {
                messages.push({ role: "tool", tool_call_id: r.id, name: r.name, content: r.content });
            }
        }

        // Out of tool rounds. Ask once more *without* tools so the model has to commit to an
        // answer instead of looping — otherwise a chatty model scores as a non-answer.
        const finalResp = await this.chat(
            [...messages, { role: "user", content: "Now give your final answer. Do not call any more tools." }],
            undefined,
            { signal },
        );
        usage = addUsage(usage, finalResp.usage);

        return {
            text: finalResp.text ?? "",
            structured: parseJSONLoose(finalResp.text),
            toolCalls: allCalls,
            toolResults: allResults,
            rounds,
            finishReason: "max_rounds",
            usage,
        };
    }
}

function addUsage(a, b) {
    if (!b) return a;
    return {
        prompt_tokens: (a?.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
        completion_tokens: (a?.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
        total_tokens: (a?.total_tokens ?? 0) + (b.total_tokens ?? 0),
    };
}
