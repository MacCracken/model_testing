// The `list` command probes every local provider on its own address: a named endpoint's line says
// what that server lists (and where it is), an endpoint nothing answers at says so, and neither
// borrows the Ollama daemon's count. Hermetic: the daemon's address is pointed at the same fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeServer(models) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) })); return; }
      res.statusCode = 404; res.end("{}");
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "src/cli.js"), "list"], { env: { ...process.env, ...env }, cwd: root });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("cli list probes each named endpoint on its own address and never borrows the daemon's count", async () => {
  const daemon = await fakeServer(["a-model", "b-model", "c-model"]);
  const endpoint = await fakeServer(["my-ckpt-2000"]);
  const dead = await fakeServer([]); const deadPort = dead.port; dead.srv.close();
  try {
    const { code, out } = await run({
      OLLAMA_BASE_URL: `http://127.0.0.1:${daemon.port}/v1/chat/completions`,
      LOCAL_ENDPOINTS: `mine=http://127.0.0.1:${endpoint.port}/v1;ghost=http://127.0.0.1:${deadPort}/v1`,
    });
    assert.equal(code, 0, out);
    const lines = out.split("\n");
    const at = (name) => lines.findIndex((l) => l.startsWith(`  ${name.padEnd(10)}`));
    assert.match(lines[at("local")], /live, 3 model\(s\)/);
    assert.match(lines[at("mine")], new RegExp(`live, 1 model\\(s\\) · http://127\\.0\\.0\\.1:${endpoint.port}/v1`));
    assert.match(lines[at("mine") + 1], /^ {4}mine:my-ckpt-2000/);
    assert.match(lines[at("ghost")], new RegExp(`offline — nothing answers at http://127\\.0\\.0\\.1:${deadPort}/v1`));
    assert.ok(!lines.slice(at("ghost") + 1).some((l) => l.startsWith("    ghost:")), "a dead endpoint lists no models");
  } finally {
    daemon.srv.close(); endpoint.srv.close();
  }
});
