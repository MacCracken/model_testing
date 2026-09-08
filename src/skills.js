// skills.js — a skill is a packaged procedure for a task: a markdown playbook under skills/<name>.md
// (a task may point at a shared one with `task.skill`; the restock family shares "restock").
//
// The treatment is the same task with and without its skill. `withSkill(client, how)` wraps any
// client — synthetic or real-harness arm — so the skill reaches the model one of two ways:
//   preload  — appended to the system prompt (synthetic) or the goal prompt (arms) before the run;
//   ondemand — offered as a `load_skill` tool the model may call; the row records whether it did.
//              Where no tool loop runs (free-form modes, arms) it falls back to preload.
//   native   — through the harness's own mechanism: Claude Code and Pi take it as an appended
//              system prompt, Codex reads it as the AGENTS.md of its working directory; Thoth and
//              the synthetic client have no separate channel and get preload. The response's
//              `skill.applied` says which path was actually taken.
// A wrapped client keeps the inner client's model and flags (an arm stays `structuredOnly`), and is
// named `<client>@skill:<how>` so every table keeps the two variants apart; `baseName` points back
// so `summarize` can pair them.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = process.env.SKILLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
export const SKILL_MODES = ["preload", "ondemand", "native"];

export function skillFor(task) {
  const name = task?.skill ?? task?.name;
  if (!name) return null;
  const path = join(SKILLS_DIR, `${name}.md`);
  if (!existsSync(path)) return null;
  return { name, text: readFileSync(path, "utf8").trim(), path };
}

export function listSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
}

// "<provider>:<model>@skill" or "@skill:<how>" → { base, how }; anything else → { base: spec, how: null }.
export function parseSkillSuffix(spec) {
  const m = String(spec).match(/^(.*)@skill(?::([a-z]+))?$/);
  if (!m) return { base: spec, how: null };
  const how = m[2] ?? "preload";
  if (!SKILL_MODES.includes(how)) throw new Error(`unknown skill mode "${how}" in "${spec}" — use @skill:preload, @skill:ondemand or @skill:native`);
  return { base: m[1], how };
}

function preloadText(system, skill) {
  return `${system ? `${system}\n\n` : ""}# Skill: ${skill.name}\nA playbook for this job. Follow it.\n\n${skill.text}`;
}

export function withSkill(client, how = "preload") {
  if (!SKILL_MODES.includes(how)) throw new Error(`unknown skill mode "${how}" (preload | ondemand | native)`);
  const name = `${client.name}@skill:${how}`;
  return {
    ...client,
    name,
    baseName: client.name,
    skill: how,

    // Free-form path: no tool loop, so the skill can only be preloaded into the system message.
    async chat(messages, tools, opts = {}) {
      const skill = skillFor(opts.task);
      if (!skill) return tag(await client.chat(messages, tools, opts), how, null, false);
      const msgs = [...messages];
      const i = msgs.findIndex((m) => m.role === "system");
      if (i >= 0) msgs[i] = { ...msgs[i], content: preloadText(msgs[i].content, skill) };
      else msgs.unshift({ role: "system", content: preloadText("", skill) });
      return tag(await client.chat(msgs, tools, opts), how, skill, "preload");
    },

    async runWithTools(prompt, tools, system, opts = {}) {
      const skill = skillFor(opts.task);
      if (!skill) return tag(await client.runWithTools(prompt, tools, system, opts), how, null, false);
      // Arms build their own prompt from the goal; the skill rides along in opts for goalPrompt.
      const passed = { ...opts, skill: { ...skill, how } };
      if (how === "ondemand" && !client.structuredOnly) {
        let loaded = 0;
        const loadSkill = {
          name: "load_skill",
          description: `Load the playbook for this job (${skill.name}): the step-by-step procedure and its pitfalls. Read it before you act.`,
          parameters: { type: "object", properties: {} },
          impl: async () => { loaded += 1; return skill.text; },
        };
        const sys = `${system ? `${system}\n\n` : ""}A load_skill tool holds a playbook for this job. Read it before you act.`;
        const resp = await client.runWithTools(prompt, [...(tools ?? []), loadSkill], sys, passed);
        return { ...tag(resp, how, skill, "ondemand", loaded), effectiveSystem: sys };
      }
      if (how === "native" && client.structuredOnly) {
        // The arm decides whether it has a native channel; it reports the path it took.
        const resp = await client.runWithTools(prompt, tools, system, passed);
        return tag(resp, how, skill, resp.skillApplied ?? "preload");
      }
      const sys = preloadText(system, skill);
      return { ...tag(await client.runWithTools(prompt, tools, sys, passed), how, skill, "preload"), effectiveSystem: sys };
    },
  };
}

// What the row records about the skill: how it was offered, whether one existed for the task, and
// (on demand) how many times the model loaded it.
function tag(resp, how, skill, applied, loaded = null) {
  return { ...resp, skill: { how, name: skill?.name ?? null, applied: applied || false, loaded } };
}
