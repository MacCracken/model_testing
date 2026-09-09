import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hb-lineage-"));
const file = join(dir, "lineage.json");
writeFileSync(file, JSON.stringify({
  _comment: "ignored",
  "vllm:ckpt-1000": { family: "mine", checkpoint: "1000", step: 1000, parent: null, date: "2026-09-01" },
  "vllm:ckpt-2000": { family: "mine", checkpoint: "2000", step: 2000, parent: "vllm:ckpt-1000", trainedOn: "mix-v2" },
  "local:other": { family: "other" },
}));
process.env.LINEAGE_FILE = file;
const { loadLineage, lineageFor, lineageOf, familyMembers, parentOf, describeLineage } = await import("../src/lineage.js");
const { parseLocalEndpoints, registerLocalEndpoints, resolveClients, describeProviders, PROVIDERS } = await import("../src/providers/index.js");
const { SUITES, suiteArgs } = await import("../src/suites.js");

test("the lineage file loads, ignores comments, and answers by client id with any variant suffix stripped", () => {
  const { entries } = loadLineage({ force: true });
  assert.deepEqual(Object.keys(entries), ["vllm:ckpt-1000", "vllm:ckpt-2000", "local:other"]);
  assert.equal(lineageFor("vllm:ckpt-2000").step, 2000);
  assert.equal(lineageFor("vllm:ckpt-2000@skill:preload").parent, "vllm:ckpt-1000");
  assert.equal(lineageFor("openai:gpt-4o-mini"), null);
  assert.deepEqual(Object.keys(lineageOf(["vllm:ckpt-1000", "openai:gpt-4o-mini", "vllm:ckpt-2000@stress:budget"])), ["vllm:ckpt-1000", "vllm:ckpt-2000@stress:budget"]);
  assert.deepEqual(familyMembers("mine").map((e) => e.checkpoint), ["1000", "2000"]);
  assert.equal(parentOf("vllm:ckpt-2000"), "vllm:ckpt-1000");
  assert.equal(parentOf("vllm:ckpt-1000"), null);
  assert.equal(describeLineage(lineageFor("vllm:ckpt-2000")), "mine · 2000 · step 2000 · from vllm:ckpt-1000 · on mix-v2");
});

test("named local endpoints become providers, never shadowing built-ins", async () => {
  assert.deepEqual(parseLocalEndpoints("vllm=http://127.0.0.1:8000/v1; mlx=http://127.0.0.1:8080/v1/chat/completions,bad entry,llamacpp=http://127.0.0.1:8081"), {
    vllm: "http://127.0.0.1:8000/v1/chat/completions",
    mlx: "http://127.0.0.1:8080/v1/chat/completions",
    llamacpp: "http://127.0.0.1:8081/v1/chat/completions",
  });
  const added = registerLocalEndpoints({ vllm: "http://127.0.0.1:8000/v1/chat/completions", openai: "http://evil/v1/chat/completions" });
  assert.deepEqual(added, ["vllm"]);
  assert.equal(PROVIDERS.vllm.local, true);
  assert.equal(PROVIDERS.vllm.needsKey, false);
  assert.match(PROVIDERS.openai.baseUrl, /api\.openai\.com/, "a built-in is never replaced");
  const [c] = resolveClients("vllm:my-ckpt");
  assert.equal(c.name, "vllm:my-ckpt");
  assert.equal(c.model, "my-ckpt");
  const described = await describeProviders({ probe: false });
  const v = described.find((p) => p.name === "vllm");
  assert.equal(v.local, true);
  assert.equal(v.endpoint, true);
  assert.equal(v.hasKey, true);
  assert.equal(described.find((p) => p.name === "local").local, true);
  assert.equal(described.find((p) => p.name === "openai").local, false);
});

test("suites are bench arguments with a recorded name", () => {
  assert.deepEqual(Object.keys(SUITES), ["smoke", "standard", "full", "nightly"]);
  const argv = suiteArgs("smoke", ["--clients", "vllm:my-ckpt", "--instance-seed", "7"]);
  assert.deepEqual(argv.slice(0, 8), ["--task", SUITES.smoke.tasks, "--modes", "noHarness,harness", "--count", "2", "--parallel", "4"]);
  assert.deepEqual(argv.slice(8), ["--clients", "vllm:my-ckpt", "--instance-seed", "7"]);
  assert.throws(() => suiteArgs("nope"), /unknown suite/);
  assert.ok(SUITES.smoke.tasks.split(",").length >= 10);
});
