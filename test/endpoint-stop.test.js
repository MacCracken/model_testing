// Runs that can be left alone: whose failure an error row records, the stop on an endpoint that
// stays down, and the questions a run asks before it starts. Fake clients and injected checks — no
// model, no server, no waiting (the waits are handed in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMatrix, errorKindOf, errorSourceOf, ENDPOINT_WAITS_MS } from "../src/runner.js";
import { preflight, checkClientWith, checkServer } from "../src/preflight.js";
import { pingClient } from "../src/probe.js";
import { describeSkipped, describeErrors } from "../src/bench.js";
import { tasks } from "../src/tasks/registry.js";
import { readFileSync, readdirSync } from "node:fs";

const task = (name, extra = {}) => ({
  name,
  noHarness: { prompt: "hi" },
  eval: { ground: "ok", scoreNoHarness: (o) => ({ correct: String(o).trim() === "ok", reason: "free" }) },
  ...extra,
});

// A client whose endpoint answers while `up()` says so.
const makeClient = (name, up) => ({
  name, model: name, calls: 0,
  async chat() {
    this.calls++;
    if (!up(this.calls)) throw new Error(`${name}: fetch failed — is http://localhost:11434/v1/chat/completions reachable?`);
    return { text: "ok", toolCalls: [], finishReason: "stop", usage: null };
  },
});
const noWait = { waitsMs: [1, 1, 1], sleep: async () => {} };

test("an error row says whose failure it was", () => {
  const kinds = {
    "local:ornith-1.5:9b: fetch failed — is http://localhost:11434/v1/chat/completions reachable?": ["transport", "endpoint"],
    "HTTP 404 from local:gemma4:31b-mlx: model 'gemma4:31b-mlx' not found": ["transport", "endpoint"],
    'HTTP 500 from local:qwen3.8:27b-mlx: Post "http://127.0.0.1:55887/v1/completions": EOF': ["transport", "endpoint"],
    "HTTP 401 from llamacpp:ornith: Invalid API Key": ["transport", "endpoint"],
    "HTTP 429 from openai:gpt-4o-mini: Rate limit reached": ["transport", "endpoint"],
    "terminated": ["transport", "endpoint"],
    "local:x: terminated — the stream from http://h/v1/chat/completions ended early": ["transport", "endpoint"],
    "fetch failed": ["transport", "server"], // a task's own fetch: the webserver it runs against
    "request timed out": ["timeout", "server"],
    "HTTP 400 from openai:gpt-4o-mini: Unrecognized request argument supplied: reasoning_effort": ["request", "endpoint"],
    "cancelled before completing": ["cancelled", "server"],
    "POST /api/logs → 500": ["bench", "server"],
    'task "reason" has no "toolOnly" spec': ["bench", "server"],
  };
  for (const [message, [kind, source]] of Object.entries(kinds)) {
    assert.equal(errorKindOf(message), kind, message);
    assert.equal(errorSourceOf(message, message.split(": ")[0]), source, message);
  }
  assert.equal(errorKindOf(""), null);
  assert.equal(errorKindOf("This operation was aborted", { cancelled: true }), "cancelled");
  assert.equal(describeErrors([{ error: "fetch failed", errorKind: "transport" }, { error: "x: fetch failed — is y reachable?" }, { error: "request timed out" }, { error: null }]), "2 transport, 1 timeout");
});

test("a trial that dies in transport records the kind and the source; a scored trial records neither", async () => {
  const dead = makeClient("local:m", () => false);
  const { rows } = await runMatrix({ tasks: [task("t")], modes: ["noHarness"], clients: [dead], count: 1 });
  assert.deepEqual([rows[0].errorKind, rows[0].errorSource, rows[0].correct], ["transport", "endpoint", false]);
  const fine = await runMatrix({ tasks: [task("t")], modes: ["noHarness"], clients: [makeClient("local:m", () => true)], count: 1 });
  assert.deepEqual([fine.rows[0].error, fine.rows[0].errorKind, fine.rows[0].errorSource], [null, null, null]);
  // The webserver being down reaches a row through a task's setup.
  const serverTask = task("s", { server: true, setup: async () => { throw new TypeError("fetch failed"); } });
  const s = await runMatrix({ tasks: [serverTask], modes: ["noHarness"], clients: [makeClient("local:m", () => true)], count: 1 });
  assert.deepEqual([s.rows[0].errorKind, s.rows[0].errorSource], ["transport", "server"]);
});

test("an endpoint that stays down costs three error rows, not the matrix: the rest is skipped and the run is partial", async () => {
  const dead = makeClient("local:gone", () => false);
  const events = [];
  let checks = 0;
  const r = await runMatrix({
    tasks: [task("a"), task("b")], modes: ["noHarness"], clients: [dead], count: 4,
    checkClient: async () => { checks++; return { ok: false, note: 'the route does not list "gone"' }; },
    breaker: noWait, onEvent: (e) => events.push(e),
  });
  assert.equal(r.rows.length, 3, "three transport errors tripped it");
  assert.ok(r.rows.every((x) => x.errorKind === "transport"));
  assert.equal(checks, 4, "checked at once and after each of the three waits");
  assert.equal(r.partial, true);
  assert.deepEqual(r.down, [{ key: "local:gone", note: 'the route does not list "gone"' }]);
  const skippedDown = r.skipped.filter((s) => s.why === "endpoint down");
  assert.equal(skippedDown.reduce((n, s) => n + s.trials, 0), 5, "the other five trials were never started");
  assert.deepEqual(events.filter((e) => e.type === "endpoint").map((e) => e.state), ["checking", "down"]);
  assert.equal(events.at(-1).partial, true);
  assert.match(describeSkipped(skippedDown)[0], /for local:gone: \d trials? not run — its endpoint stopped answering/);
  assert.equal(dead.calls, 3, "nothing was sent to an endpoint that was given up on");
});

test("an endpoint that comes back is waited for, and the matrix goes on", async () => {
  // Down for calls 3 to 5, then up: the check says no once, yes the second time.
  const flaky = makeClient("local:flaky", (n) => n < 3 || n > 5);
  let checks = 0;
  const waited = [];
  const r = await runMatrix({
    tasks: [task("a")], modes: ["noHarness"], clients: [flaky], count: 10,
    checkClient: async () => ({ ok: ++checks >= 2, note: checks >= 2 ? "answered in 0.1 s" : "fetch failed" }),
    breaker: { waitsMs: [7, 8, 9], sleep: async (ms) => { waited.push(ms); } },
  });
  assert.equal(r.partial, false);
  assert.equal(r.rows.length, 10, "every trial ran");
  assert.equal(r.rows.filter((x) => x.errorKind === "transport").length, 3, "the three that met the outage stay as its record");
  assert.equal(r.rows.filter((x) => x.correct).length, 7);
  assert.deepEqual(waited, [7], "one wait, then it was back");
  assert.deepEqual(r.down, []);
});

test("errors that are not transport never trip the stop, an answer in between resets the count, and no check means no stop", async () => {
  const timeouts = { name: "local:slow", model: "slow", async chat() { throw new Error("request timed out"); } };
  let checks = 0;
  const check = async () => { checks++; return { ok: false, note: "down" }; };
  const slow = await runMatrix({ tasks: [task("a")], modes: ["noHarness"], clients: [timeouts], count: 6, checkClient: check, breaker: noWait });
  assert.equal(slow.rows.length, 6, "a model that thinks too long is not an outage");
  assert.equal(checks, 0);
  // Two failures, an answer, two failures, an answer …: never three in a row.
  const blips = makeClient("local:blips", (n) => n % 3 === 0);
  const b = await runMatrix({ tasks: [task("a")], modes: ["noHarness"], clients: [blips], count: 9, checkClient: check, breaker: noWait });
  assert.equal(b.rows.length, 9);
  assert.equal(checks, 0);
  // Without a check handed in (the browser, a test) the matrix behaves as it always did.
  const plain = await runMatrix({ tasks: [task("a")], modes: ["noHarness"], clients: [makeClient("local:gone", () => false)], count: 5 });
  assert.equal(plain.rows.length, 5);
  assert.equal(plain.partial, false);
});

test("the webserver going down skips the tasks that run against it and leaves the others alone", async () => {
  let serverUp = true;
  const client = makeClient("local:m", () => true);
  const backed = task("backed", { server: true, setup: async () => { if (!serverUp) throw new TypeError("fetch failed"); return {}; } });
  const pure = task("pure");
  const r = await runMatrix({
    tasks: [backed, pure], modes: ["noHarness"], clients: [client], count: 6,
    checkServer: async () => ({ ok: false, note: "nothing answers at http://localhost:3000" }),
    breaker: noWait,
    onEvent: (e) => { if (e.type === "trial" && e.completed === 2) serverUp = false; }, // after trial 1 of both
  });
  const by = (name) => r.rows.filter((x) => x.task === name);
  assert.equal(by("pure").length, 6, "a task that needs no server runs to the end");
  assert.ok(by("pure").every((x) => x.correct));
  assert.equal(by("backed").filter((x) => x.errorKind === "transport").length, 3);
  assert.equal(by("backed").length, 4, "one good trial, three that met the outage, two never started");
  assert.deepEqual(r.down.map((d) => d.key), ["the webserver"]);
  assert.match(describeSkipped(r.skipped.filter((s) => s.why === "endpoint down"))[0], /backed\/noHarness for local:m: 2 trials not run — the webserver stopped answering/);
});

test("a check tripped by the last trials is let go: the run ends without waiting and is not partial", async () => {
  const dead = makeClient("local:gone", () => false);
  const t0 = performance.now();
  const r = await runMatrix({ tasks: [task("a")], modes: ["noHarness"], clients: [dead], count: 3, checkClient: async () => ({ ok: false, note: "down" }), breaker: { waitsMs: [60_000] } });
  assert.ok(performance.now() - t0 < 2000, "no minute-long wait with nothing left to run");
  assert.equal(r.rows.length, 3);
  assert.equal(r.partial, false, "nothing was skipped");
  assert.deepEqual(ENDPOINT_WAITS_MS, [30_000, 120_000, 300_000]);
});

test("pingClient: not listed is a no without a request; listed or unlistable is judged by the answer; a hung server is a no", async () => {
  let asked = 0;
  const client = { name: "local:m", model: "m", async chat(_m, _t, { signal } = {}) { asked++; if (this.hang) await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); return { text: "OK" }; } };
  const missing = await pingClient(client, { listModels: async () => ["other", "another"] });
  assert.equal(missing.ok, false);
  assert.match(missing.note, /does not list "m" \(it lists other, another\)/);
  assert.equal(asked, 0);
  assert.equal((await pingClient(client, { listModels: async () => ["m"] })).ok, true);
  assert.equal((await pingClient(client, { listModels: async () => null })).ok, true, "a route that lists nothing is judged by whether it answers");
  assert.match((await pingClient(client, {})).note, /answered in/);
  const dead = { name: "local:m", model: "m", async chat() { throw new Error("local:m: fetch failed — is http://x reachable?"); } };
  assert.deepEqual(await pingClient(dead, { listModels: async () => null }), { ok: false, note: "local:m: fetch failed — is http://x reachable?" });
  client.hang = true;
  const hung = await pingClient(client, { timeoutMs: 30 });
  assert.equal(hung.ok, false);
  assert.match(hung.note, /no answer within/);
  const thinking = { name: "local:t", model: "t", async chat() { return { text: "", reasoningChars: 412 } } };
  assert.equal((await pingClient(thinking, {})).ok, true, "a thinking model that spent its answer on reasoning still answered");
});

test("preflight asks each endpoint once and the webserver only when a selected task needs it", async () => {
  const asked = [];
  const checkClient = async (c) => { asked.push(c.baseName ?? c.name); return { ok: !/gone/.test(c.name), note: /gone/.test(c.name) ? "the route does not list it" : "answered in 0.2 s" }; };
  let serverAsked = 0;
  const server = async () => { serverAsked++; return { ok: false, note: "nothing answers at http://localhost:3000" }; };
  const clients = [{ name: "local:m" }, { name: "local:m@abstain", baseName: "local:m" }, { name: "claude-code:haiku", structuredOnly: true }];
  const pure = await preflight({ clients, tasks: [task("pure")] }, { checkClient, server });
  assert.equal(pure.ok, true);
  assert.deepEqual(asked, ["local:m"], "a variant is its base client's endpoint, and an arm is not an endpoint");
  assert.equal(serverAsked, 0, "no selected task runs against the webserver");
  const backed = await preflight({ clients: [{ name: "local:gone" }], tasks: [task("restock3", { server: true }), task("pure")] }, { checkClient, server });
  assert.equal(backed.ok, false);
  assert.deepEqual(backed.problems, ["local:gone: the route does not list it", "the webserver: nothing answers at http://localhost:3000 — needed by restock3"]);
  // The webserver check itself, against nothing and against a stub.
  assert.equal((await checkServer({ base: "http://127.0.0.1:9", timeoutMs: 500 })).ok, false);
  assert.equal((await checkServer({ fetchImpl: async () => ({ ok: true }) })).ok, true);
  assert.match((await checkServer({ fetchImpl: async () => ({ ok: false, status: 503 }) })).note, /HTTP 503/);
  // checkClientWith pings the base client plainly, never the treatment's wrapper; an arm is not pinged.
  const pinged = [];
  const check = checkClientWith({ ping: async (c) => { pinged.push(c.name); return { ok: true, note: "" }; }, resolve: (name) => [{ name, model: name.split(":")[1] }] });
  await check({ name: "local:m@perturb:typos", baseName: "local:m" });
  assert.deepEqual(pinged, ["local:m"]);
  // A local endpoint may have to load the model before it answers: it gets three minutes, a hosted route one.
  const given = [];
  const timed = checkClientWith({ ping: async (c, o) => { given.push([c.name, o.timeoutMs]); return { ok: true, note: "" }; }, resolve: (name) => [{ name }] });
  await timed({ name: "local:qwen3.8:27b-mlx" });
  await timed({ name: "openai:gpt-4o-mini" });
  assert.deepEqual(given, [["local:qwen3.8:27b-mlx", 180_000], ["openai:gpt-4o-mini", 60_000]]);
  assert.match((await check({ name: "codex:x", structuredOnly: true })).note, /not pinged/);
});

test("every task whose module talks to the webserver says so, and no other does", () => {
  // `server: true` is what the preflight and the dead-server stop read; a module that imports the
  // webserver's address or the scenario helpers runs against it.
  const dir = new URL("../src/tasks/", import.meta.url);
  const backedModules = readdirSync(dir).filter((f) => f.endsWith(".js") && !["util.js", "scenario.js", "registry.js", "gen.js"].includes(f))
    .filter((f) => /from "\.\/scenario\.js"|import \{[^}]*\bBASE\b[^}]*\} from "\.\/util\.js"/.test(readFileSync(new URL(f, dir), "utf8")))
    .map((f) => f.replace(/\.js$/, ""));
  const moduleOf = (t) => (t.source === "public" ? "public" : t.family === "needlehop" ? "needle" : t.family ?? t.name);
  for (const t of tasks) assert.equal(!!t.server, backedModules.includes(moduleOf(t)), `${t.name} (module ${moduleOf(t)}.js)`);
  assert.ok(tasks.filter((t) => t.server).length >= 30);
});
