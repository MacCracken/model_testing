// agents.js — sub-agents as a treatment: the same goal with and without the ability to offload work.
//
// `withDelegation(client, how)` wraps a client as `<client>@agents:<how>`. For the synthetic client
// the parent gets one extra tool, `delegate(goal)`: each call runs a fresh model turn (a child) with
// the task's own tools — never `delegate` itself, so depth stays at one — and returns the child's
// final answer as the tool result. Children started in the same turn run in parallel, because the
// tool loop executes a turn's calls together. Everything a child did is folded back into the
// parent's record (tool calls and results tagged with the child's number, usage summed), so scoring,
// tool-use verdicts and cost all see the whole tree; `agents` on the response says how much of the
// work was delegated.
//   available — the parent is told it may delegate independent pieces of work;
//   required  — the parent is told to do the per-item work through sub-agents.
// A real-harness arm gets `opts.agents` and decides for itself (Claude Code allows its Agent tool);
// an arm without a channel leaves `applied` false, so the row says the treatment did not happen.

const CHILD_SYSTEM =
  "You are a sub-agent working one piece of a larger job. Use the tools to complete exactly the goal below, " +
  "then reply with a concise final answer stating the concrete results (ids, tickets, numbers). " +
  "Do not ask questions; if part of the goal is impossible, say so in the answer.";

const PARENT_NOTE = {
  available:
    "Sub-agents: you have a delegate tool. Each call runs a sub-agent with the same tools on a self-contained goal " +
    "you write (include every id and value it needs — it cannot see this conversation), in parallel with any other " +
    "delegate calls in the same turn, and returns its answer. Use it to offload independent pieces of work, such as " +
    "one item or one batch per sub-agent. You remain responsible for checking the results and giving the final answer.",
  required:
    "Sub-agents: you have a delegate tool. Each call runs a sub-agent with the same tools on a self-contained goal " +
    "you write (include every id and value it needs — it cannot see this conversation), in parallel with any other " +
    "delegate calls in the same turn, and returns its answer. Do the per-item work through sub-agents rather than " +
    "yourself: after reading the state, delegate the updates, then collect what the sub-agents return, verify, and " +
    "finish the job yourself. You remain responsible for the final answer.",
};

export const AGENT_MODES = Object.keys(PARENT_NOTE);
export const MAX_CHILDREN = 16;

// "<client>@agents" or "@agents:<how>" → { base, how }; anything else → { base: spec, how: null }.
export function parseAgentsSuffix(spec) {
  const m = String(spec).match(/^(.*)@agents(?::([a-z]+))?$/);
  if (!m) return { base: spec, how: null };
  const how = m[2] ?? "available";
  if (!AGENT_MODES.includes(how)) throw new Error(`unknown sub-agent mode "${how}" in "${spec}" — use @agents:available or @agents:required`);
  return { base: m[1], how };
}

function addUsage(a, b) {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    prompt_tokens: (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
    completion_tokens: (a.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0),
  };
}

export function withDelegation(client, how = "available", { maxChildren = MAX_CHILDREN } = {}) {
  if (!AGENT_MODES.includes(how)) throw new Error(`unknown sub-agent mode "${how}" (available | required)`);
  const none = () => ({ how, applied: false, delegations: 0, childCalls: 0, childTokens: 0, children: [] });
  return {
    ...client,
    name: `${client.name}@agents:${how}`,
    baseName: client.name,
    agents: how,

    // Free-form path: no tool loop, nothing to delegate.
    async chat(messages, tools, opts = {}) {
      return { ...(await client.chat(messages, tools, opts)), agents: none() };
    },

    async runWithTools(prompt, tools, system, opts = {}) {
      if (client.structuredOnly) {
        // The arm owns its loop; it reports whether it could offer delegation and how often it was used.
        const resp = await client.runWithTools(prompt, tools, system, { ...opts, agents: { how } });
        return { ...resp, agents: resp.agents ?? none() };
      }
      const children = [];
      const taskTools = tools ?? [];
      const delegate = {
        name: "delegate",
        description:
          "Hand an independent piece of this job to a sub-agent. It gets the same tools (not delegate itself), works on " +
          "its own, and returns its final answer as text. Write a complete, self-contained goal — include every id and " +
          "value it needs, it cannot see this conversation. Several delegate calls in one turn run in parallel.",
        parameters: { type: "object", properties: { goal: { type: "string", description: "The self-contained goal for the sub-agent." } }, required: ["goal"] },
        impl: async ({ goal }) => {
          if (children.length >= maxChildren) throw new Error(`sub-agent limit (${maxChildren}) reached — finish the rest yourself`);
          const child = { index: children.length + 1, goal: String(goal ?? ""), startedAt: performance.now(), toolCalls: [], toolResults: [], usage: null, rounds: 0, text: "" };
          children.push(child);
          const resp = await client.runWithTools(child.goal, taskTools, CHILD_SYSTEM, { ...opts, history: [] });
          child.toolCalls = resp.toolCalls ?? [];
          child.toolResults = resp.toolResults ?? [];
          child.usage = resp.usage ?? null;
          child.rounds = resp.rounds ?? 0;
          child.text = resp.text ?? "";
          child.latencyMs = Math.round(performance.now() - child.startedAt);
          return { subAgent: child.index, answer: child.text, toolCalls: child.toolCalls.length };
        },
      };
      const sys = `${system ? `${system}\n\n` : ""}${PARENT_NOTE[how]}`;
      const resp = await client.runWithTools(prompt, [...taskTools, delegate], sys, opts);

      // Fold the children back into the parent's record.
      const childCalls = children.flatMap((c) => c.toolCalls.map((tc) => ({ ...tc, agent: c.index })));
      const childResults = children.flatMap((c) => c.toolResults.map((r) => ({ ...r, agent: c.index })));
      const childUsage = children.reduce((u, c) => addUsage(u, c.usage), null);
      return {
        ...resp,
        effectiveSystem: sys,
        toolCalls: [...(resp.toolCalls ?? []), ...childCalls],
        toolResults: [...(resp.toolResults ?? []), ...childResults],
        usage: addUsage(resp.usage ?? null, childUsage),
        agents: {
          how,
          applied: true,
          delegations: children.length,
          childCalls: childCalls.length,
          childTokens: childUsage?.total_tokens ?? 0,
          children: children.map((c) => ({ goal: c.goal.slice(0, 300), calls: c.toolCalls.length, rounds: c.rounds, tokens: c.usage?.total_tokens ?? 0, latencyMs: c.latencyMs, answer: c.text.slice(0, 400) })),
        },
      };
    },
  };
}
