// Shared tools for the arms ([43]): the bench-side tool bridge and the stdio MCP server it
// spawns, the name mapping, the providers, and the runner judging a shared-tools arm's calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { startToolBridge, mcpServerSpec, bridgedToolName, sharedToolsNote, BRIDGE_SCRIPT, SERVER_NAME } from "../src/harness/toolbridge.js";
import { calcTool } from "../src/calc.js";
import { runTrial } from "../src/runner.js";
import { task as regex, TARGET, STRINGS } from "../src/tasks/regex.js";
import { describeProviders, buildClient, PROVIDERS } from "../src/providers/index.js";
import { withSkill } from "../src/skills.js";

// Speak JSON-RPC to the bridge child over stdio; resolve with every reply once `count` arrived.
function talk(spec, messages, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
    const replies = [];
    let buf = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`only ${replies.length} replies`)); }, 8000);
    child.stdout.on("data", (d) => { buf += d; let nl; while ((nl = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) replies.push(JSON.parse(line)); if (replies.length >= count) { clearTimeout(timer); child.stdin.end(); resolve(replies); } } });
    child.on("error", reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("the bridge lists the trial's tools, runs a call in the bench and records it; the MCP child forwards the protocol", async () => {
  const bridge = await startToolBridge([calcTool]);
  try {
    const spec = mcpServerSpec(bridge.url);
    assert.equal(spec.command, process.execPath);
    assert.deepEqual(spec.args, [BRIDGE_SCRIPT, "--url", bridge.url]);
    const replies = await talk(spec, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "calc", arguments: { expression: "6*7" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
      { jsonrpc: "2.0", id: 5, method: "ping" },
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
    ], 6);
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(byId[1].result.serverInfo.name, SERVER_NAME);
    assert.deepEqual(byId[1].result.capabilities, { tools: {} });
    assert.deepEqual(byId[2].result.tools.map((t) => t.name), ["calc"]);
    assert.equal(byId[2].result.tools[0].inputSchema.type, "object");
    assert.deepEqual(JSON.parse(byId[3].result.content[0].text), { expression: "6*7", result: 42 });
    assert.equal(byId[3].result.isError, undefined);
    assert.equal(byId[4].result.isError, true);
    assert.match(byId[4].result.content[0].text, /unknown tool: nope/);
    assert.deepEqual(byId[5].result, {});
    assert.equal(byId[6].error.code, -32601);
    // The bench side recorded both calls, bench-shaped.
    assert.deepEqual(bridge.calls.map((c) => [c.name, c.arguments]), [["calc", { expression: "6*7" }], ["nope", {}]]);
    assert.deepEqual(bridge.results.map((r) => [r.name, r.ok]), [["calc", true], ["nope", false]]);
    assert.equal(JSON.parse(bridge.results[0].content).result, 42);
  } finally {
    await bridge.close();
  }
});

test("a tool that throws comes back as a failed result, not a crash", async () => {
  const bridge = await startToolBridge([{ name: "boom", description: "d", parameters: { type: "object", properties: {} }, impl: async () => { throw new Error("kaput"); } }]);
  try {
    const res = await fetch(`${bridge.url}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "boom", arguments: {} }) });
    assert.deepEqual(await res.json(), { ok: false, content: "tool error: kaput" });
    assert.equal((await fetch(`${bridge.url}/nope`)).status, 404);
  } finally {
    await bridge.close();
  }
});

test("names: Claude Code's mcp__bench__x and Codex's bench.x are the bench's x; anything else is not bridged; the note names the tools", () => {
  assert.equal(bridgedToolName("mcp__bench__list_items"), "list_items");
  assert.equal(bridgedToolName("bench.calc"), "calc");
  assert.equal(bridgedToolName("Bash"), null);
  assert.equal(bridgedToolName("mcp__other__x"), null);
  assert.match(sharedToolsNote([calcTool]), /MCP server "bench": calc\)\. Use them/);
  assert.equal(sharedToolsNote([]), "");
});

test("the shared-tools arms are providers of their own, labelled, and build clients with the flag", async () => {
  assert.equal(PROVIDERS["claude-code-mcp"].sharedTools, true);
  assert.equal(PROVIDERS["codex-mcp"].sharedTools, true);
  const listed = await describeProviders({ probe: false });
  const cc = listed.find((p) => p.name === "claude-code-mcp"), cx = listed.find((p) => p.name === "codex-mcp");
  assert.deepEqual([cc.kind, cc.harness, cc.sharedTools], ["harness", "claude-code", true]);
  assert.deepEqual([cx.kind, cx.harness, cx.sharedTools], ["harness", "codex", true]);
  assert.equal(listed.find((p) => p.name === "codex").sharedTools, false);
  const codex = buildClient({ provider: "codex-mcp", model: "gpt-5.4-mini" });
  assert.equal(codex.sharedTools, true);
  assert.equal(codex.structuredOnly, true);
  assert.equal(buildClient({ provider: "codex", model: "gpt-5.4-mini" }).sharedTools, false);
});

// A fake arm with shared tools: it "runs" through a bridge the way the real arms do, so the trial
// gets bench-shaped calls and the task's verdict.
function fakeSharedArm({ right = true } = {}) {
  return {
    name: "fake-mcp:m", model: "m", structuredOnly: true, sharedTools: true,
    async chat() { throw new Error("structured only"); },
    async runWithTools(prompt, tools) {
      const bridge = await startToolBridge(tools);
      try {
        for (const s of STRINGS) await fetch(`${bridge.url}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: right ? "regex_match" : "word_count", arguments: right ? { pattern: TARGET, string: s } : { string: s } }) });
      } finally { await bridge.close(); }
      const results = bridge.results.map((r) => { try { return JSON.parse(r.content); } catch { return {}; } });
      const re = new RegExp(TARGET);
      const out = STRINGS.map((s, i) => ({ string: s, matched: right ? !!results[i]?.matched : re.test(s) }));
      const text = JSON.stringify(out);
      return { text, structured: JSON.parse(text), toolCalls: bridge.calls, toolResults: bridge.results, rounds: 1, usage: null, harness: { kind: "fake", sharedTools: true } };
    },
  };
}

test("the runner judges a shared-tools arm's calls with the task's verdict, and leaves a bring-your-own arm unjudged", async () => {
  const good = await runTrial({ task: regex, mode: "harness", client: fakeSharedArm(), index: 1 });
  assert.equal(good.correct, true, good.reason);
  assert.equal(good.harness, "fake");
  assert.equal(good.sharedTools, true);
  assert.equal(good.toolUseOk, true, good.toolUseReason);
  assert.equal(good.toolCalls.length, 6);
  assert.ok(good.toolCalls.every((c) => c.name === "regex_match"));
  const decoy = await runTrial({ task: regex, mode: "harness", client: fakeSharedArm({ right: false }), index: 1 });
  assert.equal(decoy.correct, true, "the answer can still be right by hand");
  assert.equal(decoy.toolUseOk, false, "but the wrong tool was fired");
  const byo = { ...fakeSharedArm(), sharedTools: false, async runWithTools(prompt, tools) { const r = await fakeSharedArm().runWithTools(prompt, tools); return { ...r, harness: { kind: "fake" } }; } };
  const own = await runTrial({ task: regex, mode: "harness", client: byo, index: 1 });
  assert.equal(own.sharedTools, false);
  assert.equal(own.toolUseOk, null, "an arm with its own tools is not judged on the bench's");
});

test("an on-demand skill reaches a shared-tools arm as the load_skill tool, and the row says whether it was read", async () => {
  const seen = [];
  const arm = {
    name: "fake-mcp:m", model: "m", structuredOnly: true, sharedTools: true,
    async chat() { throw new Error("structured only"); },
    async runWithTools(prompt, tools, system) {
      seen.push({ tools: tools.map((t) => t.name), system });
      const load = tools.find((t) => t.name === "load_skill");
      const text = await load.impl({});
      return { text: JSON.stringify([]), structured: [], toolCalls: [{ id: "x", name: "load_skill", arguments: {} }], toolResults: [{ id: "x", name: "load_skill", ok: true, content: text }], rounds: 1, usage: null, harness: { kind: "fake", sharedTools: true } };
    },
  };
  const skilled = withSkill(arm, "ondemand");
  const r = await skilled.runWithTools("p", [calcTool], "sys", { task: regex, mode: "harness" });
  assert.deepEqual(seen[0].tools, ["calc", "load_skill"]);
  assert.match(seen[0].system, /A load_skill tool holds a playbook/);
  assert.equal(r.skill.loaded, 1);
  assert.equal(r.skill.applied, "ondemand");
});
