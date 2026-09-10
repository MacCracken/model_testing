// harness/toolbridge.js — the bench's tools, shared with a real harness arm.
//
// An arm brings its own tools (a shell and curl) and the bench scores its answer from the
// webserver's log. With shared tools the arm gets the *same* tools the synthetic harness gets —
// `health_check`, `list_items`, the calculator, a `load_skill` playbook, a stress profile's
// distractors — through MCP, and every call runs here, in the bench's process, where the tool's
// `impl` lives. This module is the bench side: a loopback HTTP server that lists the trial's tools
// and executes calls, recording each one; `src/mcp/bridge.js` is the thin stdio MCP server the arm
// spawns, which forwards to it. Calls and results therefore come out bench-shaped, and the task's
// tool-use verdict applies to the arm like to any client.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const BRIDGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "bridge.js");
export const SERVER_NAME = "bench";

const readBody = (req) => new Promise((resolve, reject) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => resolve(s)); req.on("error", reject); });

// Start the bridge for one trial's tools. Returns { url, calls, results, close }.
export async function startToolBridge(tools, { host = "127.0.0.1" } = {}) {
  const byName = new Map((tools ?? []).map((t) => [t.name, t]));
  const calls = [];
  const results = [];
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === "GET" && req.url === "/tools") {
        return send(200, { tools: [...byName.values()].map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.parameters ?? { type: "object", properties: {} } })) });
      }
      if (req.method === "POST" && req.url === "/call") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return send(400, { error: "invalid JSON" }); }
        const tool = byName.get(body.name);
        const id = `mcp_${calls.length + 1}`;
        const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};
        calls.push({ id, name: body.name, arguments: args });
        if (!tool) { results.push({ id, name: body.name, ok: false, content: `unknown tool: ${body.name}` }); return send(200, { ok: false, content: `unknown tool: ${body.name}` }); }
        try {
          const out = await tool.impl(args);
          const content = typeof out === "string" ? out : JSON.stringify(out);
          results.push({ id, name: body.name, ok: true, arguments: args, content });
          return send(200, { ok: true, content });
        } catch (err) {
          const content = `tool error: ${err?.message ?? String(err)}`;
          results.push({ id, name: body.name, ok: false, arguments: args, content });
          return send(200, { ok: false, content });
        }
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: err?.message ?? "bridge error" });
    }
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const url = `http://${host}:${server.address().port}`;
  return { url, calls, results, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// The MCP server definition an arm is handed: how to spawn the bridge for this trial.
export function mcpServerSpec(url) {
  return { command: process.execPath, args: [BRIDGE_SCRIPT, "--url", url] };
}

// Claude Code names an MCP tool `mcp__<server>__<tool>`, Codex `<server>.<tool>`; the bench name is
// the tool's own. Null when the name is not one of the bridge's.
export function bridgedToolName(name) {
  const s = String(name ?? "");
  if (s.startsWith(`mcp__${SERVER_NAME}__`)) return s.slice(`mcp__${SERVER_NAME}__`.length);
  if (s.startsWith(`${SERVER_NAME}.`)) return s.slice(SERVER_NAME.length + 1);
  return null;
}

// What the arm is told about the tools it was given, on top of the task's goal.
export function sharedToolsNote(tools) {
  const names = (tools ?? []).map((t) => t.name);
  if (!names.length) return "";
  return `Tools are provided for this job (MCP server "${SERVER_NAME}": ${names.join(", ")}). Use them — do not reach the webserver any other way.`;
}
