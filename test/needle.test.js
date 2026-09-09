import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, needleTasks, needlehopTasks, linesFor, remint, KINDS } from "../src/tasks/needle.js";
import { runTrial } from "../src/runner.js";

test("the log is deterministic, sized to the token target, and its truth is recomputable from the lines", () => {
  assert.equal(linesFor(8000), 190);
  for (let seed = 1; seed <= 12; seed++) {
    const g = generate(seed, 8000);
    assert.deepEqual(g, generate(seed, 8000));
    assert.equal(g.lines, 190);
    assert.ok(Math.abs(g.approxTokens - 8000) < 100, `≈8k tokens (got ${g.approxTokens})`);
    const lines = g.text.split("\n");
    assert.equal(lines.length, g.lines);
    assert.equal(g.kind, ["single", "multi", "agg"][seed % 3]);
    if (g.kind === "single") {
      const hits = lines.filter((l) => l.includes(`req=${g.key[0]}`));
      assert.equal(hits.length, 1, "the request id is unique");
      assert.match(hits[0], new RegExp(`latency=${g.answer}ms`));
      assert.ok([0.1, 0.5, 0.9].includes(g.depth));
    } else if (g.kind === "multi") {
      const crit = lines.filter((l) => l.includes("level=CRITICAL"));
      assert.equal(crit.length, 3);
      assert.deepEqual(crit.map((l) => l.match(/host-\d+/)[0]).sort(), g.answer);
    } else {
      const [svc] = g.key;
      assert.equal(lines.filter((l) => l.includes(`svc=${svc}`) && l.includes("level=ERROR")).length, g.answer);
    }
  }
  assert.equal(generate(7, 8000, { kind: 1 }).kind, "multi");
  assert.equal(generate(7, 8000, { kind: 2 }).kind, "agg");
  assert.equal(generate(7, 8000, { kind: 0 }).question.slice(0, 12), "What latency");
  const big = generate(5, 100000);
  assert.ok(big.lines > 2000 && big.approxTokens >= 99000 && big.approxTokens <= 101000);
});

test("scorers and verdicts per question kind", () => {
  const t = needleTasks[0];
  assert.equal(t.name, "needle8k");
  const single = { kind: "single", answer: 897, depth: 0.5 };
  assert.equal(t.eval.scoreHarness({ answer: 897 }, single).correct, true);
  assert.equal(t.eval.scoreNoHarness("The line shows latency=897ms.\nanswer: 897", single).correct, true);
  assert.match(t.eval.scoreNoHarness("answer: 900", single).reason, /answered 900, expected 897/);
  const multi = { kind: "multi", answer: ["host-29", "host-30", "host-8"] };
  assert.equal(t.eval.scoreHarness({ answer: ["Host-8", "host-29", "host-30"] }, multi).correct, true);
  assert.equal(t.eval.scoreNoHarness("answer: host-8, host-29, host-30", multi).correct, true);
  assert.match(t.eval.scoreNoHarness("answer: host-8, host-29", multi).reason, /missing host-30/);
  assert.match(t.eval.scoreHarness({ answer: ["host-8", "host-29", "host-30", "host-1"] }, multi).reason, /extra host-1/);
  const agg = { kind: "agg", answer: 5 };
  assert.equal(t.eval.scoreHarness({ answer: 5 }, agg).correct, true);
  assert.equal(t.eval.scoreNoHarness("I count 5 such lines.\nanswer: 5", agg).correct, true);
  assert.equal(t.eval.scoreHarness({ answer: ["x"] }, agg).correct, false);
  const ctx = { key: ["billing", "ERROR"] };
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "count_log", arguments: { pattern: "svc=billing.*level=ERROR" } }], ctx }).ok, true);
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "grep_log", arguments: { pattern: "svc=billing" } }, { name: "grep_log", arguments: { pattern: "level=error" } }], ctx }).ok, true, "keys may be found across calls");
  assert.match(t.eval.toolUse({ toolCalls: [{ name: "grep_log", arguments: { pattern: "WARN" } }], ctx }).reason, /none for billing and ERROR/);
  assert.match(t.eval.toolUse({ toolCalls: [], ctx }).reason, /never searched/);
  assert.equal(t.eval.canon({ answer: ["host-30", "host-8"] }, { structured: true }), "host-30,host-8");
  assert.equal(t.eval.canon("answer: 42", { structured: false }), "42");
  assert.match(t.noHarness.prompt({ lines: 3, kind: "single", text: "L1\nL2\nL3", question: "Q?" }), /L1\nL2\nL3\n\nQuestion: Q\?$/);
  assert.match(t.harness.prompt({ log: "log-1", lines: 3, kind: "agg", question: "Q?" }), /Log id log-1/);
  assert.doesNotMatch(t.harness.prompt({ log: "log-1", lines: 3, kind: "agg", question: "Q?", text: "L1" }), /L1/, "the tool modes never inline the log");
});

test("the run record keeps a capped prompt while the model receives the whole log", async () => {
  const task = { name: "cap", noHarness: { prompt: "x".repeat(50_000) }, eval: { ground: () => 1, scoreNoHarness: () => ({ correct: true, reason: "" }) } };
  let sent = 0;
  const client = { name: "c", model: "m", async chat(messages) { sent = messages.at(-1).content.length; return { text: "ok", toolCalls: [], finishReason: "stop", usage: null }; } };
  const r = await runTrial({ task, mode: "noHarness", client });
  assert.equal(sent, 50_000);
  assert.ok(r.prompt.length < 20_200);
  assert.match(r.prompt, /truncated in the record: 50000 characters/);
});

// needle's setup posts the log to the webserver; a stand-in takes the post and hands back an id.
async function withLogServer(fn) {
  const real = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, init) => {
    posted.push({ url: String(url), body: init?.body ?? null });
    return { ok: true, json: async () => ({ id: `log-${posted.length}` }) };
  };
  try { return await fn(posted); } finally { globalThis.fetch = real; }
}

const say = (answer) => (Array.isArray(answer) ? answer.join(", ") : String(answer));

test("the row records the needle context without the log; scoring, the tool-mode prompt and the log itself come back from it", async () => {
  const task = needleTasks[0];
  await withLogServer(async (posted) => {
    for (const index of [1, 2, 3]) {
      // Free-form: the model is sent the whole log; the row keeps a capped prompt and a small ctx.
      let sent = null, live = null;
      const reader = { name: "c", model: "m", async chat(messages, _tools, { ctx }) { sent = messages.at(-1).content; live = ctx; return { text: `I looked.\nanswer: ${say(ctx.answer)}`, toolCalls: [], finishReason: "stop", usage: null }; } };
      const f = await runTrial({ task, mode: "noHarness", client: reader, index, seed: 11 });
      assert.equal(f.error, null);
      assert.equal(f.correct, true, `${live.kind}: ${f.reason}`);
      assert.equal(live.kind, ["single", "multi", "agg"][index - 1], "the kind rotates with the index");
      assert.ok(live.text.length > 15_000 && sent.includes(live.text), "the model received the whole log");
      assert.equal(posted.at(-1).body, live.text, "the same log went to the webserver");
      assert.equal(f.ctx.text, undefined, "the record has no log text");
      assert.ok(!JSON.stringify(f.ctx).includes(live.text.slice(0, 120)), "nor a copy of it under another key");
      assert.deepEqual(Object.keys(f.ctx).sort(), ["answer", "approxTokens", "depth", "hops", "key", "kind", "lines", "log", "question", "seed", "tokens"]);
      assert.ok(JSON.stringify(f.ctx).length < 600, `the recorded ctx is small (${JSON.stringify(f.ctx).length} chars)`);
      assert.deepEqual(f.ground, { kind: live.kind, answer: live.answer, depth: live.depth });
      assert.ok(f.prompt.length <= 20_200, "the prompt is capped in the record");

      // Tool mode: the tools and the judge see the live ctx (log id included); the row keeps the recorded one.
      let toolCtx = null;
      const searcher = { name: "c", model: "m", async runWithTools(prompt, tools, system, { ctx }) { toolCtx = ctx; return { text: "{}", structured: { work: ["searched"], answer: ctx.answer }, toolCalls: [{ name: "grep_log", arguments: { log: ctx.log, pattern: ctx.key.join(".*") } }], toolResults: [], rounds: 1, finishReason: "stop", usage: null }; } };
      const h = await runTrial({ task, mode: "harness", client: searcher, index, seed: 11 });
      assert.equal(h.correct, true, `${live.kind}: ${h.reason}`);
      assert.equal(h.toolUseOk, true, h.toolUseReason);
      assert.equal(toolCtx.text, live.text, "the same instance in every mode");
      assert.equal(h.ctx.log, toolCtx.log);
      assert.equal(h.ctx.text, undefined);

      // A replay or a re-score works from the row alone: ground, the verdicts and the tool-mode prompt
      // re-render from the recorded ctx, and the seed re-mints the log for the free-form one.
      assert.deepEqual(task.eval.ground({ ctx: h.ctx }), h.ground);
      assert.equal(task.eval.toolUse({ toolCalls: h.toolCalls, ctx: h.ctx }).ok, true);
      assert.equal(task.eval.scoreHarness(h.structured, task.eval.ground({ ctx: h.ctx })).correct, true);
      assert.equal(task.eval.scoreNoHarness(f.answerText, task.eval.ground({ ctx: f.ctx })).correct, true);
      assert.equal(task.harness.prompt(h.ctx), h.prompt);
      const again = remint(f.ctx);
      assert.equal(again.text, live.text);
      assert.deepEqual({ ...again, log: f.ctx.log }, live);
      assert.equal(task.noHarness.prompt(again), sent, "the free-form prompt re-renders from the re-minted instance");
    }
  });
  assert.throws(() => remint({ seed: 1, tokens: 8000, kind: "other" }), /unknown question kind/);
});

test("the run record caps every string in a trial context like the prompt, while the live context is whole", async () => {
  const seen = {};
  const task = {
    name: "ctxcap",
    setup: async () => ({ blob: "x".repeat(50_000), n: 1, nested: { s: "y".repeat(30_000), list: ["z".repeat(25_000), "short"] } }),
    noHarness: { prompt: (ctx) => `len ${ctx.blob.length}` },
    eval: {
      ground: ({ ctx }) => { seen.ground = ctx; return ctx.blob.length; },
      scoreNoHarness: (out, ground, { ctx }) => { seen.score = ctx; return { correct: ctx.blob.length === ground && out === "ok", reason: "" }; },
    },
  };
  const client = { name: "c", model: "m", async chat(_messages, _tools, { ctx }) { seen.chat = ctx; return { text: "ok", toolCalls: [], finishReason: "stop", usage: null }; } };
  const r = await runTrial({ task, mode: "noHarness", client });
  assert.equal(r.error, null);
  assert.equal(r.correct, true);
  assert.equal(r.ground, 50_000);
  for (const which of ["chat", "ground", "score"]) assert.equal(seen[which].blob.length, 50_000, `${which} saw the whole context`);
  assert.ok(r.ctx.blob.length < 20_200);
  assert.match(r.ctx.blob, /context truncated in the record: 50000 characters/);
  assert.match(r.ctx.nested.s, /truncated in the record: 30000 characters/);
  assert.match(r.ctx.nested.list[0], /truncated in the record: 25000 characters/);
  assert.equal(r.ctx.nested.list[1], "short");
  assert.equal(r.ctx.n, 1);
  assert.ok(JSON.stringify(r.ctx).length < 61_000);
  // No setup, no context: the record says so as before.
  const bare = await runTrial({ task: { ...task, setup: undefined, recordCtx: () => { throw new Error("never called without a context"); }, noHarness: { prompt: "p" }, eval: { ground: () => 1, scoreNoHarness: () => ({ correct: true, reason: "" }) } }, mode: "noHarness", client });
  assert.equal(bare.ctx, null);
  assert.equal(bare.correct, true);
});

test("the hop question plants a line that retries an earlier request; the answer is the earlier request's latency", () => {
  assert.deepEqual(KINDS, ["single", "multi", "agg", "hop"]);
  for (let seed = 1; seed <= 12; seed++) {
    const g = generate(seed, 8000, { kind: 3 });
    assert.equal(g.kind, "hop");
    assert.deepEqual(g, generate(seed, 8000, { kind: 3 }));
    const [a, x] = g.key;
    assert.notEqual(a, x);
    const lines = g.text.split("\n");
    const aLine = lines.filter((l) => l.includes(`req=${a}`));
    const xLine = lines.filter((l) => l.includes(`req=${x}`));
    assert.equal(aLine.length, 1); assert.equal(xLine.length, 1);
    assert.match(aLine[0], new RegExp(`msg="retry of req ${x}"`), "the first line names the second");
    assert.match(xLine[0], new RegExp(`latency=${g.answer}ms`), "the answer is the second line's latency");
    assert.match(g.question, new RegExp(`Request ${a} was a retry`));
    assert.doesNotMatch(g.question, new RegExp(x), "the second key is not in the question");
    assert.equal(g.depth, null);
    assert.equal(g.hops.length, 2);
    assert.equal(generate(seed, 8000).kind, ["single", "multi", "agg"][seed % 3], "the plain rotation is unchanged");
  }
  assert.equal(remint({ seed: 4, tokens: 8000, kind: "hop" }).text, generate(4, 8000, { kind: 3 }).text);
  assert.deepEqual(needlehopTasks.map((t) => [t.name, t.family, t.level, t.capabilities.includes("multi-hop")]), [["needlehop8k", "needlehop", 8000, true], ["needlehop32k", "needlehop", 32000, true], ["needlehop100k", "needlehop", 100000, true]]);
  const t = needlehopTasks[0];
  const g = generate(9, 8000, { kind: 3 });
  const ground = { kind: "hop", answer: g.answer, depth: null };
  assert.equal(t.eval.scoreHarness({ work: [], answer: g.answer }, ground).correct, true);
  assert.equal(t.eval.scoreNoHarness(`answer: ${g.answer + 1}`, ground).correct, false);
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "grep_log", arguments: { pattern: `req=${g.key[0]}` } }], ctx: g }).ok, false, "one hop is not enough");
  assert.equal(t.eval.toolUse({ toolCalls: [{ name: "grep_log", arguments: { pattern: `req=${g.key[0]}` } }, { name: "grep_log", arguments: { pattern: g.key[1] } }], ctx: g }).ok, true);
});

test("a needlehop trial through the runner in harness mode: the second key comes from the first line's text", async () => {
  const task = needlehopTasks[0];
  await withLogServer(async () => {
    const hopper = { name: "c", model: "m", async runWithTools(_p, _t, _s, { ctx }) {
      const first = ctx.text.split("\n").find((l) => l.includes(`req=${ctx.key[0]}`));
      const next = first.match(/retry of req (\w+)/)[1];
      const second = ctx.text.split("\n").find((l) => l.includes(`req=${next}`));
      const latency = Number(second.match(/latency=(\d+)ms/)[1]);
      return { text: "{}", structured: { work: ["two hops"], answer: latency }, toolCalls: [{ name: "grep_log", arguments: { log: ctx.log, pattern: `req=${ctx.key[0]}` } }, { name: "grep_log", arguments: { log: ctx.log, pattern: `req=${next}` } }], toolResults: [], rounds: 2, finishReason: "stop", usage: null };
    } };
    const r = await runTrial({ task, mode: "harness", client: hopper, index: 3, seed: 5 });
    assert.equal(r.error, null, r.error);
    assert.equal(r.correct, true, r.reason);
    assert.equal(r.toolUseOk, true, r.toolUseReason);
    assert.equal(r.ctx.kind, "hop");
    assert.equal(r.ctx.text, undefined, "the record keeps no log text");
    assert.equal(remint(r.ctx).answer, r.ground.answer);
  });
});
