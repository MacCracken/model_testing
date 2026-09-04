// judge.js — LLM-as-judge for open-ended tasks.
//
// A judge is an async function ({ rubric, answer, ground, task }) => { score, reason }, built from a
// synthetic Client. It is asked for strict JSON and its verdict is recorded on the row. Automated
// ground truth still comes first: the judge is handed the facts the task computed, so it grades
// the answer against them rather than against its own beliefs.

import { parseJSONLoose } from "./json.js";

const SYSTEM =
  "You are a strict grader. Score the answer against the rubric and the ground truth. " +
  "Reply with JSON only, no prose: {\"score\": <number from 0 to 1>, \"reason\": \"<one sentence>\"}.";

export function makeJudge(client) {
  const judge = async ({ rubric, answer, ground, task }) => {
    const user = [
      task ? `Task: ${task}` : "",
      `Rubric:\n${rubric}`,
      `Ground truth (facts the answer must agree with):\n${typeof ground === "string" ? ground : JSON.stringify(ground)}`,
      `Answer to grade:\n${typeof answer === "string" ? answer : JSON.stringify(answer)}`,
    ].filter(Boolean).join("\n\n");
    const resp = await client.chat([{ role: "system", content: SYSTEM }, { role: "user", content: user }]);
    const parsed = parseJSONLoose(resp.text);
    const score = Number(parsed?.score);
    if (!Number.isFinite(score)) throw new Error(`judge ${client.name} returned no score: ${String(resp.text).slice(0, 120)}`);
    return { score: Math.max(0, Math.min(1, score)), reason: String(parsed?.reason ?? ""), usage: resp.usage ?? null, judge: client.name };
  };
  Object.defineProperty(judge, "name", { value: client.name });
  return judge;
}
