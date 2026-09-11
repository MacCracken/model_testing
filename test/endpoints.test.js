// Named endpoints on the network: a key of their own, the served-from record on a run, the probe
// of an endpoint's model list with the key, and `cli probe <endpoint>` listing what a host serves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.MY_HOST_API_KEY = "s3cret";
const { registerLocalEndpoints, parseLocalEndpoints, endpointsFor, endpointKeyEnv, apiKeyFor, hasCredentials, PROVIDERS, probeLocalModels, describeProviders } = await import("../src/providers/index.js");

function fakeServer({ models, key = null }) {
  const seen = [];
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      seen.push(req.headers.authorization ?? null);
      if (key && req.headers.authorization !== `Bearer ${key}`) { res.statusCode = 401; res.end("{}"); return; }
      if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) })); return; }
      res.statusCode = 404; res.end("{}");
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, seen }));
  });
}

test("an endpoint's key comes from <NAME>_API_KEY and rides as the bearer token; without one the fixed local token goes out", () => {
  assert.equal(endpointKeyEnv("my-host"), "MY_HOST_API_KEY");
  assert.equal(endpointKeyEnv("vllm"), "VLLM_API_KEY");
  registerLocalEndpoints(parseLocalEndpoints("my-host=http://192.168.1.80:8080/v1;plain=http://127.0.0.1:9000/v1"));
  assert.equal(PROVIDERS["my-host"].keyEnv, "MY_HOST_API_KEY");
  assert.equal(apiKeyFor("my-host"), "s3cret");
  assert.equal(PROVIDERS["my-host"].auth(apiKeyFor("my-host")), "Bearer s3cret");
  assert.equal(apiKeyFor("plain"), "");
  assert.equal(PROVIDERS.plain.auth(apiKeyFor("plain") || "local"), "Bearer local");
  assert.equal(hasCredentials("plain"), true, "an endpoint works without a key");
});

test("endpointsFor records the address and host of every local provider among the clients, and whether it is another machine", () => {
  const e = endpointsFor(["my-host:ckpt-1", "my-host:ckpt-2", "plain:x", "openai:gpt-4o-mini", "local:ornith-1.5:9b"]);
  assert.deepEqual(e["my-host"], { url: "http://192.168.1.80:8080/v1", host: "192.168.1.80", remote: true });
  assert.deepEqual(e.plain, { url: "http://127.0.0.1:9000/v1", host: "127.0.0.1", remote: false });
  assert.ok(e.local && typeof e.local.url === "string", "the Ollama daemon is recorded too");
  assert.equal(e.openai, undefined, "hosted providers are not endpoints");
  assert.equal(endpointsFor(["openai:gpt-4o-mini"]), null);
  assert.equal(endpointsFor([]), null);
});

test("the model-list probe sends the endpoint's key, and describeProviders says whether one is set", async () => {
  const keyed = await fakeServer({ models: ["ckpt-2000"], key: "s3cret" });
  const open = await fakeServer({ models: ["m1", "m2"] });
  try {
    registerLocalEndpoints(parseLocalEndpoints(`my-host=http://127.0.0.1:${keyed.port}/v1;plain=http://127.0.0.1:${open.port}/v1`));
    assert.deepEqual(await probeLocalModels({ provider: "my-host" }), ["ckpt-2000"]);
    assert.deepEqual(keyed.seen, ["Bearer s3cret"]);
    assert.deepEqual(await probeLocalModels({ provider: "plain" }), ["m1", "m2"]);
    assert.deepEqual(open.seen, [null], "no header when no key is set");
    const d = await describeProviders({ probe: false });
    const mine = d.find((p) => p.name === "my-host"), plain = d.find((p) => p.name === "plain");
    assert.equal(mine.keyEnv, "MY_HOST_API_KEY"); assert.equal(mine.keyed, true);
    assert.equal(plain.keyEnv, "PLAIN_API_KEY"); assert.equal(plain.keyed, false); assert.equal(plain.hasKey, true);
  } finally { keyed.srv.close(); open.srv.close(); }
});

function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "src/cli.js"), ...args], { env: { ...process.env, ...env }, cwd: root });
    let out = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("cli probe <endpoint> with no model lists what the host serves, with the key, and says how to probe one", async () => {
  const keyed = await fakeServer({ models: ["ckpt-2000", "ckpt-1000"], key: "s3cret" });
  const dead = await fakeServer({ models: [] }); const deadPort = dead.port; dead.srv.close();
  try {
    const env = { LOCAL_ENDPOINTS: `my-host=http://127.0.0.1:${keyed.port}/v1;ghost=http://127.0.0.1:${deadPort}/v1`, MY_HOST_API_KEY: "s3cret" };
    const ok = await cli(["probe", "my-host"], env);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /my-host serves 2 models at http:\/\/127\.0\.0\.1:\d+\/v1 \(MY_HOST_API_KEY set\)/);
    assert.match(ok.out, /my-host:ckpt-2000/);
    assert.match(ok.out, /probe my-host:ckpt-2000/);
    const none = await cli(["probe", "ghost"], env);
    assert.equal(none.code, 1);
    assert.match(none.out, /nothing answers at http:\/\/127\.0\.0\.1:\d+\/v1/);
    const list = await cli(["list"], { ...env, OLLAMA_BASE_URL: `http://127.0.0.1:${keyed.port}/v1/chat/completions` });
    assert.match(list.out, /my-host {4}\[live, 2 model\(s\) · http:\/\/127\.0\.0\.1:\d+\/v1 · MY_HOST_API_KEY set\]/);
  } finally { keyed.srv.close(); }
});
