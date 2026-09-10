#!/usr/bin/env node
// mcp/bridge.js — a stdio MCP server that forwards to the bench's tool bridge.
//
// A real harness arm (Claude Code, Codex) spawns this as an MCP server; it answers the protocol —
// initialize, tools/list, tools/call, ping — by asking the bench process, which holds the trial's
// tools, over the loopback URL it is given. Newline-delimited JSON-RPC on stdin and stdout, no
// dependencies. Errors in a tool come back as a tool result with isError, never as a crash.

const args = process.argv.slice(2);
const url = args[args.indexOf("--url") + 1];
if (!url) { process.stderr.write("mcp/bridge.js: --url <bench tool bridge> is required\n"); process.exit(2); }

const PROTOCOL = "2025-06-18";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function listTools() {
  const res = await fetch(`${url}/tools`);
  const data = await res.json();
  return (data.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object", properties: {} } }));
}

async function callTool(name, toolArgs) {
  const res = await fetch(`${url}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, arguments: toolArgs ?? {} }) });
  const data = await res.json();
  return { content: [{ type: "text", text: String(data.content ?? "") }], ...(data.ok ? {} : { isError: true }) };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return reply(id, { protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "bench", version: "1" } });
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: await listTools() });
  if (method === "tools/call") {
    try { return reply(id, await callTool(params?.name, params?.arguments)); } catch (err) { return reply(id, { content: [{ type: "text", text: `bridge error: ${err?.message ?? err}` }], isError: true }); }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, nl).trim();
    buffered = buffered.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((err) => { if (msg?.id !== undefined) fail(msg.id, -32603, err?.message ?? String(err)); });
  }
});
process.stdin.on("end", () => process.exit(0));
