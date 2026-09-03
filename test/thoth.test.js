import { test } from "node:test";
import assert from "node:assert/strict";

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEvents, ThothClient } from "../src/harness/thoth.js";
import { runTrial } from "../src/runner.js";
import { getTask } from "../src/tasks/registry.js";

// A recorded --events stream (shape from thoth 0.44.3 src/events.cyr), with the noise a real
// stream carries: a stderr-ish banner line and a blank line.
const STREAM = [
  "thoth: session log -> /tmp/x.log",
  '{"event":"turn_start","turn":1,"model":"ornith-1.5:9b"}',
  '{"event":"tool_call","turn":1,"name":"web_fetch","args":"{\\"url\\":\\"http://localhost:3000/health\\"}"}',
  '{"event":"tool_result","turn":1,"name":"web_fetch","ok":true,"bytes":88}',
  "",
  '{"event":"response","turn":1,"text":"{\\"status\\":\\"ok\\",\\"uptimeSec\\":42}"}',
  '{"event":"turn_end","turn":1,"ok":true,"tokens":3658,"elapsed_ms":1718}',
].join("\n");

test("parseEvents folds a thoth --events stream into calls, results, text and usage", () => {
  const p = parseEvents(STREAM);
  assert.equal(p.model, "ornith-1.5:9b");
  assert.deepEqual(p.toolCalls, [{ id: "thoth_1", name: "web_fetch", arguments: { url: "http://localhost:3000/health" } }]);
  assert.deepEqual(p.toolResults, [{ id: "thoth_1", name: "web_fetch", ok: true, bytes: 88, content: "" }]);
  assert.equal(p.text, '{"status":"ok","uptimeSec":42}');
  assert.equal(p.tokens, 3658);
  assert.equal(p.error, null);
});

test("parseEvents keeps the response even when it arrives after turn_end, and surfaces errors", () => {
  const late = parseEvents('{"event":"turn_end","turn":1,"ok":true}\n{"event":"response","turn":1,"text":"pong"}');
  assert.equal(late.text, "pong");
  const err = parseEvents('{"event":"turn_start","turn":1,"model":"m"}\n{"event":"error","turn":1,"message":"gateway unreachable","http":502}');
  assert.equal(err.error, "gateway unreachable");
  assert.equal(err.text, null);
});

// The client is exercised through runTrial with a stand-in "thoth" — a script that prints the
// recorded stream — so the whole path from goal prompt to scored row runs without the real binary.
test("a thoth arm trial is scored like any structured trial, with the goal prompt and closed stdin", async () => {
  // A stand-in binary: checks it was given --events and the goal prompt, then prints the stream.
  const stub = join(mkdtempSync(join(tmpdir(), "thoth-stub-")), "thoth.js");
  writeFileSync(stub, `const a = process.argv.slice(2); if (a[0] !== "--events" || !a[1].includes("A webserver runs at")) { process.stderr.write("bad args: " + a.join(" ")); process.exit(3); } process.stdout.write(${JSON.stringify(STREAM)});`);
  const client = new ThothClient({ name: "thoth:test", model: "test", command: `${process.execPath} ${stub}`, timeoutMs: 20_000 });
  const task = { ...getTask("health"), eval: { ...getTask("health").eval, ground: async () => ({ status: "ok", uptimeSec: 40 }) } };
  const row = await runTrial({ task, mode: "harness", client });
  assert.equal(row.error, null, row.error ?? "");
  assert.equal(row.correct, true, row.reason);
  assert.equal(row.toolCalls.length, 1);
  assert.equal(row.usage.total_tokens, 3658);
  assert.equal(row.model, "ornith-1.5:9b", "the model Thoth routed to is recorded");
  assert.equal(row.toolUseOk, false, "web_fetch is not the bench's health tool, so the synthetic judge says no");
});

test("the thoth arm refuses free-form modes", async () => {
  const client = new ThothClient({ command: "true" });
  await assert.rejects(client.chat(), /free-form/);
});

test("every task has a goal for real-harness arms", () => {
  for (const name of ["health", "hello", "reason", "lookup", "regex", "chain"]) {
    const g = getTask(name).goal;
    assert.ok(typeof g === "string" && g.length > 40, `${name} goal`);
    assert.ok(!/\bthe (hello|lookup|health|regex_match) tool\b/.test(g), `${name} goal must not name a bench function tool`);
  }
});
