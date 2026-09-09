import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFormatSuffix, withFormat, applyFormat, complied, FORMAT_MODES, NOTES, WORK_FIELD } from "../src/format.js";
import { runTrial, summarize, buildSystemPrompt, scoreRecord } from "../src/runner.js";
import { resolveClients } from "../src/providers/index.js";
import { rescoreRun } from "../src/rescore.js";

test("parseFormatSuffix reads the @format variant off a client spec; the resolver builds it", () => {
  assert.deepEqual(FORMAT_MODES, ["nowork", "work"]);
  assert.deepEqual(parseFormatSuffix("openai:gpt-4o-mini"), { base: "openai:gpt-4o-mini", how: null });
  assert.deepEqual(parseFormatSuffix("openai:gpt-4o-mini@format"), { base: "openai:gpt-4o-mini", how: "nowork" });
  assert.deepEqual(parseFormatSuffix("local:ornith-1.5:9b@format:work"), { base: "local:ornith-1.5:9b", how: "work" });
  assert.throws(() => parseFormatSuffix("x@format:prose"), /unknown format variant/);
  const [c] = resolveClients("local:ornith-1.5:9b@format:nowork");
  assert.equal(c.name, "local:ornith-1.5:9b@format:nowork");
  assert.equal(c.baseName, "local:ornith-1.5:9b");
  assert.equal(c.format, "nowork");
  assert.throws(() => resolveClients("local:x@skill:preload@format:work"), /one variant per client/);
});

test("withFormat only names the variant; the client's behaviour is untouched", async () => {
  const client = { name: "c", model: "m", async chat() { return { text: "c" }; }, async runWithTools(p) { return { text: `ran ${p}`, toolCalls: [], toolResults: [] }; } };
  const w = withFormat(client, "work");
  assert.equal(w.name, "c@format:work"); assert.equal(w.baseName, "c"); assert.equal(w.format, "work");
  assert.equal((await w.runWithTools("p")).text, "ran p");
  assert.equal((await w.chat([])).text, "c");
  assert.throws(() => withFormat(client, "nope"), /unknown format variant/);
});

const withWork = { prompt: "Solve it. Answer with { \"work\": [...], \"answer\": <n> }.", schema: { type: "object", properties: { work: WORK_FIELD, answer: { type: "integer" } }, required: ["answer"] } };
const without = { prompt: "Report the status.", schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] } };

test("applyFormat strips or adds the work field, says so on the prompt, and leaves a spec alone when there is nothing to apply", () => {
  const stripped = applyFormat(withWork, "nowork");
  assert.equal(stripped.applied, true);
  assert.deepEqual(Object.keys(stripped.spec.schema.properties), ["answer"]);
  assert.deepEqual(stripped.spec.schema.required, ["answer"]);
  assert.ok(stripped.spec.prompt.endsWith(NOTES.nowork));
  assert.deepEqual(withWork.schema.properties.work, WORK_FIELD, "the task's own spec is untouched");
  const added = applyFormat(without, "work");
  assert.equal(added.applied, true);
  assert.deepEqual(Object.keys(added.spec.schema.properties), ["work", "status"], "the work field comes first");
  assert.ok(added.spec.prompt.endsWith(NOTES.work));
  assert.match(buildSystemPrompt(added.spec, "harness"), /"work"/);
  assert.doesNotMatch(buildSystemPrompt(stripped.spec, "harness"), /"work"/);
  assert.deepEqual(applyFormat(withWork, "work"), { spec: withWork, applied: false }, "a schema that has the field gains nothing");
  assert.deepEqual(applyFormat(without, "nowork"), { spec: without, applied: false }, "a schema without the field loses nothing");
  assert.deepEqual(applyFormat({ prompt: "free" }, "nowork", { structured: false }), { spec: { prompt: "free" }, applied: false }, "free-form modes have no schema");
  const list = { prompt: "list them", schema: { type: "array", items: { type: "object", properties: { string: { type: "string" }, matched: { type: "boolean" } } } } };
  assert.deepEqual(applyFormat(list, "work"), { spec: list, applied: false }, "an array answer has no room for a work field");
  assert.equal(complied("nowork", { answer: 1 }), true);
  assert.equal(complied("nowork", { work: [], answer: 1 }), false, "an empty work key is still a work key");
  assert.equal(complied("work", { work: ["step"], status: "ok" }), true);
  assert.equal(complied("work", { work: [], status: "ok" }), false);
  assert.equal(complied("work", null), null);
});

// A task with a work field, whose fake model answers as asked (with or without working).
function probe({ writesWork }) {
  const seen = {};
  const task = {
    name: "fmt",
    capabilities: ["arithmetic"],
    noHarness: { prompt: "free: answer 4" },
    schemaOnly: { ...withWork, tools: [] },
    harness: { ...withWork, tools: [{ name: "calc", parameters: { type: "object", properties: {} }, impl: async () => "4" }] },
    eval: { ground: 4, scoreHarness: (out, g) => ({ correct: out?.answer === g, reason: out?.answer === g ? "right" : "wrong" }), scoreNoHarness: (out, g) => ({ correct: Number(out) === g, reason: "" }) },
  };
  const client = {
    name: "c", model: "m",
    async chat() { return { text: "4", toolCalls: [], finishReason: "stop", usage: null }; },
    async runWithTools(prompt, tools, system) { seen.prompt = prompt; seen.system = system; const s = writesWork ? { work: ["2+2"], answer: 4 } : { answer: 4 }; return { text: JSON.stringify(s), structured: s, toolCalls: [], toolResults: [], rounds: 1, finishReason: "stop", usage: null }; },
  };
  return { task, client, seen };
}

test("a trial under @format:nowork sees a schema without the field and a prompt that says so; the row records applied and complied; free-form modes are left alone", async () => {
  const { task, client, seen } = probe({ writesWork: false });
  const r = await runTrial({ task, mode: "harness", client: withFormat(client, "nowork") });
  assert.equal(r.error, null);
  assert.equal(r.correct, true);
  assert.deepEqual(r.format, { how: "nowork", applied: true, complied: true });
  assert.equal(r.baseClient, "c");
  assert.doesNotMatch(seen.system, /"work"/, "the schema hint has no work field");
  assert.ok(seen.prompt.endsWith(NOTES.nowork));
  assert.ok(r.prompt.endsWith(NOTES.nowork), "the record keeps the treated prompt");
  assert.equal(r.schemaValid, true);
  const disobeyed = await runTrial({ task, mode: "harness", client: withFormat(probe({ writesWork: true }).client, "nowork") });
  assert.deepEqual(disobeyed.format, { how: "nowork", applied: true, complied: false });
  assert.equal(disobeyed.correct, true, "compliance is recorded, not scored");
  const free = await runTrial({ task, mode: "noHarness", client: withFormat(client, "nowork") });
  assert.deepEqual(free.format, { how: "nowork", applied: false, complied: null });
  assert.equal(free.correct, true);
  const plain = await runTrial({ task, mode: "harness", client });
  assert.equal(plain.format, null);
});

test("@format:work adds the field to a schema that lacks it, and validity is judged against the treated schema — in the trial and in a re-score", async () => {
  const seen = {};
  const task = {
    name: "fmt2",
    capabilities: ["tool-use"],
    harness: { ...without, tools: [], schema: { ...without.schema, additionalProperties: false } },
    eval: { ground: "ok", scoreHarness: (out, g) => ({ correct: out?.status === g, reason: "" }), scoreNoHarness: () => ({ correct: false, reason: "" }) },
  };
  const client = { name: "c", model: "m", async runWithTools(prompt, tools, system) { seen.system = system; const s = { work: ["checked"], status: "ok" }; return { text: JSON.stringify(s), structured: s, toolCalls: [], toolResults: [], rounds: 1, finishReason: "stop", usage: null }; } };
  const r = await runTrial({ task, mode: "harness", client: withFormat(client, "work") });
  assert.equal(r.error, null);
  assert.deepEqual(r.format, { how: "work", applied: true, complied: true });
  assert.match(seen.system, /"work"/);
  assert.equal(r.schemaValid, true, "the extra work key is what the treated schema asked for");
  const untreated = await runTrial({ task, mode: "harness", client });
  assert.equal(untreated.schemaValid, false, "against the task's own strict schema the same answer is invalid");
  // A re-score re-applies the treatment the row records before judging validity.
  const again = structuredClone(r);
  again.schemaValid = null; again.schemaErrors = [];
  await scoreRecord(task, again);
  assert.equal(again.schemaValid, true);
  const rescored = await rescoreRun({ id: "x", status: "done", config: {}, rows: [r] }, { taskFor: () => task });
  assert.equal(rescored.run.rows[0].schemaValid, true);
  assert.equal(rescored.changed, 0);
});

test("summarize pairs a format variant with its base: per cell and pooled, with applied and complied counts", () => {
  const row = (client, correct, i, format = null) => ({ task: "wordmath4", mode: "harness", client, baseClient: format ? "openai:m" : null, model: "m", index: i, correct, error: null, toolCalls: [], latencyMs: 1, format, seed: i });
  const rows = [
    ...[true, true, true, true].map((c, i) => row("openai:m", c, i + 1)),
    ...[true, false, false, true].map((c, i) => row("openai:m@format:nowork", c, i + 1, { how: "nowork", applied: true, complied: i !== 3 })),
  ];
  const s = summarize(rows);
  const cell = s.delta.byFormat["wordmath4|harness|openai:m@format:nowork"];
  assert.equal(cell.how, "nowork");
  assert.equal(cell.baseClient, "openai:m");
  assert.equal(cell.deltaPp, -50);
  assert.equal(cell.applied, 4);
  assert.equal(cell.complied, 3);
  assert.equal(s.delta.format.nowork.deltaPp, -50);
  assert.equal(s.delta.format.nowork.complied, 3);
  assert.equal(s.delta.format.nowork.paired.n, 4, "the same instances pair");
  assert.equal(summarize(rows.slice(0, 4)).delta.format, null);
  // Pooled over two models, the pairs still find their base rows.
  const two = [...rows, ...rows.map((r) => ({ ...r, client: r.client.replace("openai:m", "anthropic:h"), baseClient: r.baseClient ? "anthropic:h" : null }))];
  const pooled = summarize(two).delta.format.nowork;
  assert.equal(pooled.treatRuns, 8);
  assert.equal(pooled.paired.n, 8, "pooled across models, every treated row pairs with its own base");
  assert.equal(pooled.paired.onlyBase, 4);
});
