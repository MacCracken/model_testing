import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillSuffix, withSkill, skillFor, listSkills } from "../src/skills.js";
import { summarize } from "../src/runner.js";
import { goalPrompt } from "../src/harness/util.js";
import { resolveClients } from "../src/providers/index.js";
import { restockTasks } from "../src/tasks/restock.js";

test("parseSkillSuffix reads the @skill variant off a client spec", () => {
  assert.deepEqual(parseSkillSuffix("openai:gpt-4o-mini"), { base: "openai:gpt-4o-mini", how: null });
  assert.deepEqual(parseSkillSuffix("openai:gpt-4o-mini@skill"), { base: "openai:gpt-4o-mini", how: "preload" });
  assert.deepEqual(parseSkillSuffix("pi:openai/gpt-4o-mini@skill:ondemand"), { base: "pi:openai/gpt-4o-mini", how: "ondemand" });
  assert.throws(() => parseSkillSuffix("x@skill:magic"), /unknown skill mode/);
});

test("every tool task has a playbook; reason and explain have none", () => {
  const names = listSkills();
  assert.deepEqual(names, ["chain", "health", "hello", "lookup", "regex", "restock", "transform"], "every tool task has a playbook; reason and explain do not");
  for (const t of restockTasks) assert.equal(skillFor(t).name, "restock");
  assert.match(skillFor(restockTasks[0]).text, /qty == min/);
  assert.equal(skillFor({ name: "reason" }), null);
});

function fake(extra = {}) {
  const calls = [];
  const client = {
    name: "local:m", model: "m", provider: "local", ...extra,
    async chat(messages, tools, opts) { calls.push({ kind: "chat", messages, opts }); return { text: "ok", toolCalls: [], finishReason: "stop", usage: null }; },
    async runWithTools(prompt, tools, system, opts) {
      calls.push({ kind: "tools", prompt, tools, system, opts });
      const ls = tools.find((t) => t.name === "load_skill");
      return { text: "{}", structured: {}, toolCalls: [], toolResults: [], rounds: 1, finishReason: "stop", usage: null, loadedText: ls ? await ls.impl({}) : null };
    },
  };
  return { calls, client };
}

test("preload puts the playbook into the system prompt and tags the response", async () => {
  const { calls, client } = fake();
  const w = withSkill(client, "preload");
  assert.equal(w.name, "local:m@skill:preload");
  assert.equal(w.baseName, "local:m");
  assert.equal(w.skill, "preload");
  assert.equal(w.model, "m");
  const r = await w.runWithTools("do it", [], "sys", { task: restockTasks[0], mode: "harness" });
  assert.match(calls[0].system, /^sys\n\n# Skill: restock/);
  assert.match(calls[0].system, /Restock playbook/);
  assert.equal(calls[0].tools.length, 0);
  assert.equal(calls[0].opts.skill.name, "restock");
  assert.deepEqual(r.skill, { how: "preload", name: "restock", applied: "preload", loaded: null });
  const c = await w.chat([{ role: "user", content: "hi" }], undefined, { task: restockTasks[0], mode: "noHarness" });
  assert.equal(calls[1].messages[0].role, "system");
  assert.match(calls[1].messages[0].content, /# Skill: restock/);
  assert.equal(calls[1].messages[1].content, "hi");
  assert.equal(c.skill.applied, "preload");
  const none = await w.runWithTools("do it", [], "sys", { task: { name: "reason" }, mode: "harness" });
  assert.equal(calls[2].system, "sys", "no playbook → the prompt is untouched");
  assert.deepEqual(none.skill, { how: "preload", name: null, applied: false, loaded: null });
});

test("ondemand offers a load_skill tool and counts loads; arms fall back to preload", async () => {
  const { calls, client } = fake();
  const w = withSkill(client, "ondemand");
  const r = await w.runWithTools("do it", [{ name: "x", impl: async () => "" }], "sys", { task: restockTasks[1], mode: "harness" });
  assert.deepEqual(calls[0].tools.map((t) => t.name), ["x", "load_skill"]);
  assert.match(calls[0].system, /load_skill tool holds a playbook/);
  assert.doesNotMatch(calls[0].system, /Restock playbook/);
  assert.match(r.loadedText, /Restock playbook/);
  assert.deepEqual(r.skill, { how: "ondemand", name: "restock", applied: "ondemand", loaded: 1 });
  const arm = withSkill(fake({ name: "arm:x", structuredOnly: true }).client, "ondemand");
  assert.equal(arm.structuredOnly, true, "the wrapper keeps the arm's flags");
  assert.equal(arm.name, "arm:x@skill:ondemand");
  const a = await arm.runWithTools("do it", [], "sys", { task: restockTasks[1], mode: "harness" });
  assert.equal(a.skill.applied, "preload");
});

test("native: synthetic clients get preload; an arm reports the channel it took", async () => {
  const { calls, client } = fake();
  const w = withSkill(client, "native");
  const r = await w.runWithTools("do it", [], "sys", { task: restockTasks[0], mode: "harness" });
  assert.match(calls[0].system, /Restock playbook/);
  assert.deepEqual(r.skill, { how: "native", name: "restock", applied: "preload", loaded: null });
  const armCalls = [];
  const arm = withSkill({ name: "arm:x", model: "m", structuredOnly: true,
    async runWithTools(prompt, tools, system, opts) { armCalls.push({ system, opts }); return { text: "{}", structured: {}, toolCalls: [], toolResults: [], rounds: 1, skillApplied: "native" }; } }, "native");
  const a = await arm.runWithTools("do it", [], "sys", { task: restockTasks[0], mode: "harness" });
  assert.equal(armCalls[0].system, "sys", "the arm's system text is untouched — it owns the channel");
  assert.equal(armCalls[0].opts.skill.how, "native");
  assert.equal(a.skill.applied, "native");
  assert.equal(parseSkillSuffix("codex:gpt-5.4-mini@skill:native").how, "native");
});

test("goalPrompt appends the playbook before the schema instruction", () => {
  const g = goalPrompt(restockTasks[0], "harness", "fb", { scenario: "scn-1" }, { name: "restock", text: "STEPS" });
  assert.ok(g.indexOf("# Skill: restock") < g.indexOf("JSON Schema"));
  assert.match(g, /STEPS/);
  assert.doesNotMatch(goalPrompt(restockTasks[0], "harness", "fb", { scenario: "scn-1" }), /# Skill/);
});

test("resolveClients wraps a @skill spec and de-duplicates the default form", () => {
  const [plain, skilled] = resolveClients("local:m,local:m@skill:ondemand");
  assert.equal(plain.name, "local:m");
  assert.equal(skilled.name, "local:m@skill:ondemand");
  assert.equal(skilled.baseName, "local:m");
  assert.equal(skilled.model, "m");
  assert.equal(resolveClients("local:m@skill,local:m@skill:preload").length, 1);
});

test("summarize pairs skilled variants with their base client and pools the skill delta", () => {
  const row = (client, correct, i, over = {}) => ({ task: "restock3", mode: "harness", client, model: "m", index: i, correct, toolCalls: [], latencyMs: 1, ...over });
  const sk = (loaded) => ({ baseClient: "local:m", skill: { how: "ondemand", name: "restock", applied: "ondemand", loaded } });
  const rows = [
    row("local:m", false, 1), row("local:m", false, 2), row("local:m", true, 3), row("local:m", false, 4),
    row("local:m@skill:ondemand", true, 1, sk(1)), row("local:m@skill:ondemand", true, 2, sk(0)), row("local:m@skill:ondemand", true, 3, sk(2)), row("local:m@skill:ondemand", true, 4, sk(1)),
  ];
  const s = summarize(rows);
  const d = s.delta.bySkill["restock3|harness|local:m@skill:ondemand"];
  assert.equal(d.basePct, 25);
  assert.equal(d.treatPct, 100);
  assert.equal(d.deltaPp, 75);
  assert.equal(d.how, "ondemand");
  assert.equal(d.loaded, 3);
  assert.equal(d.applied, 4);
  assert.equal(d.baseClient, "local:m");
  assert.deepEqual(Object.keys(s.delta.skill), ["ondemand"], "pooled per delivery");
  assert.equal(s.delta.skill.ondemand.deltaPp, 75);
  assert.equal(s.delta.skill.ondemand.treatRuns, 4);
  assert.equal(s.delta.skill.ondemand.baseRuns, 4);
  assert.equal(s.delta.skill.ondemand.loaded, 3);
  assert.equal(summarize(rows.slice(0, 4)).delta.skill, null);
  assert.deepEqual(summarize(rows.slice(4)).delta.bySkill, {}, "a skilled variant without its base has no delta");
});
