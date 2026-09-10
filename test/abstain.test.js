// Abstention ([28]): the unanswerable variants of wordmath, tally and datecalc, the seeded half,
// the generic verdict (abstained / fabricated / refused / answered), the view, the suffix, and the
// treatment through the runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAbstain, abstained, abstentionVerdict, abstentionView, describeAbstention, withAbstain, parseAbstainSuffix, unanswerableFor, NOTES } from "../src/abstain.js";
import { generate as wordmathGen, unanswerable as wordmathUnanswerable, wordmathTasks } from "../src/tasks/wordmath.js";
import { generate as tallyGen, unanswerable as tallyUnanswerable, tallyTasks } from "../src/tasks/tally.js";
import { generate as datecalcGen, unanswerable as datecalcUnanswerable, datecalcTasks } from "../src/tasks/datecalc.js";
import { summarize, runTrial } from "../src/runner.js";
import { printSummary } from "../src/report.js";
import { parseClientSpec, resolveClients } from "../src/providers/index.js";

test("wordmath: the unanswerable variant drops one step's quantity, deterministically, and the answer becomes null", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const ctx = wordmathGen(seed, 4);
    const u = wordmathUnanswerable(ctx);
    assert.equal(u.unanswerable, true);
    assert.equal(u.answer, null);
    assert.ok(u.missing, "names what is missing");
    assert.notEqual(u.story, ctx.story, "the story changed");
    assert.match(u.story, /some/, "a quantity became 'some'");
    assert.equal(u.story.match(/\b\d+\b/g).length, ctx.story.match(/\b\d+\b/g).length - 1, "exactly one number is gone");
    assert.deepEqual(wordmathUnanswerable(ctx), u, "deterministic");
    assert.equal(u.question, ctx.question);
  }
  assert.ok(wordmathGen(1, 2).lines.length >= 3, "the generator now keeps its lines");
});

test("tally: the unanswerable variant asks about a column the table lacks; datecalc: the date is left out", () => {
  const t = tallyGen(7, 20);
  const u = tallyUnanswerable(t);
  assert.equal(u.unanswerable, true);
  assert.equal(u.answer, null);
  assert.equal(u.query, null);
  assert.notEqual(u.question, t.question);
  assert.match(u.missing, /column/);
  assert.deepEqual(u.rows, t.rows, "the table is the same");
  assert.deepEqual(tallyUnanswerable(t), u);
  const d1 = datecalcGen(3, 1), u1 = datecalcUnanswerable(d1);
  assert.match(d1.text, /is issued on .* and expires \d+ days later/);
  assert.match(u1.text, /is issued and expires \d+ days later/);
  assert.doesNotMatch(u1.text, /20\d\d/, "no year left in the text");
  assert.deepEqual([u1.date, u1.weekday, u1.unanswerable, u1.missing], [null, null, true, "the starting date"]);
  const d3 = datecalcGen(3, 3), u3 = datecalcUnanswerable(d3);
  assert.match(u3.text, /is posted at \d{1,2}:\d{2} on a date that was not recorded\. Processing takes/);
  assert.doesNotMatch(u3.text, /20\d\d/);
  assert.equal(typeof wordmathTasks[0].unanswerable, "function");
  assert.equal(typeof tallyTasks[0].unanswerable, "function");
  assert.equal(typeof datecalcTasks[1].unanswerable, "function");
});

test("the seeded half is the same for every mode and client, and close to half", () => {
  const flags = Array.from({ length: 400 }, (_, i) => unanswerableFor(i * 7919 + 13));
  const share = flags.filter(Boolean).length / flags.length;
  assert.ok(share > 0.4 && share < 0.6, `about half: ${share}`);
  assert.equal(unanswerableFor(42), unanswerableFor(42));
});

test("the instruction and the schema: both kinds of instance get the note; an object schema gains answerable and a nullable answer", () => {
  const obj = applyAbstain({ prompt: "p", schema: { type: "object", properties: { work: { type: "array" }, answer: { type: "integer" } }, required: ["answer"] } }, { structured: true });
  assert.equal(obj.applied, true);
  assert.deepEqual(obj.spec.schema.properties.answer.type, ["integer", "null"]);
  assert.equal(obj.spec.schema.properties.answerable.type, "boolean");
  assert.deepEqual(obj.spec.schema.required, ["answer"]);
  assert.match(obj.spec.prompt, /set "answerable" to false/);
  const arr = applyAbstain({ prompt: "p", schema: { type: "array" } }, { structured: true });
  assert.equal(arr.spec.prompt, `p\n\n${NOTES.free}`);
  const free = applyAbstain({ prompt: "p" }, { structured: false });
  assert.match(free.spec.prompt, /answer: cannot be determined/);
});

test("reading an abstention: answerable false or a null answer in JSON, the phrase in text; a value is not one", () => {
  assert.equal(abstained({ work: [], answer: null, answerable: false }, ""), true);
  assert.equal(abstained({ answer: null }, ""), true);
  assert.equal(abstained({ answer: 12, answerable: true }, "cannot be determined"), false, "answerable true wins over the text");
  assert.equal(abstained({ answer: 12 }, ""), false);
  assert.equal(abstained(null, "answer: cannot be determined — the Tuesday delivery has no quantity"), true);
  assert.equal(abstained(null, "There is not enough information to say."), true);
  assert.equal(abstained(null, "answer: 204"), false);
  assert.equal(abstained([], "answer: 204"), false);
});

test("the verdict: abstained is right and fabricated wrong on an unanswerable instance; refused is wrong and the task's score stands on an answerable one", () => {
  assert.deepEqual(abstentionVerdict({ unanswerable: true, abstainedAnswer: true, missing: "the count" }), { correct: true, reason: "abstained — right (the count was missing)", abstention: "abstained" });
  assert.deepEqual(abstentionVerdict({ unanswerable: true, abstainedAnswer: false, missing: "the count" }), { correct: false, reason: "fabricated an answer — the count was missing", abstention: "fabricated" });
  assert.deepEqual(abstentionVerdict({ unanswerable: false, abstainedAnswer: true }), { correct: false, reason: "abstained on a problem that could be answered", abstention: "refused" });
  assert.deepEqual(abstentionVerdict({ unanswerable: false, abstainedAnswer: false, score: { correct: true, reason: "answer 3 is right" } }), { correct: true, reason: "answer 3 is right", abstention: "answered" });
});

// A fake model that either always answers a number, always abstains, or reads the problem for a
// "some" and abstains only then (the right behaviour).
function fake(how) {
  const decide = (text) => (how === "always" ? "answer" : how === "never" ? "abstain" : /some|not recorded|refund|assigned|priority|called before/.test(text) ? "abstain" : "answer");
  const numberFor = (text) => { const m = text.match(/holds (\d+)/); return m ? Number(m[1]) : 1; };
  return {
    name: "fake:m", model: "m",
    async chat(messages) { const t = messages.at(-1).content; return { text: decide(t) === "abstain" ? "answer: cannot be determined — a quantity is missing" : `answer: ${numberFor(t)}`, usage: null }; },
    async runWithTools(prompt) {
      const out = decide(prompt) === "abstain" ? { work: ["a quantity is missing"], answerable: false, answer: null } : { work: [], answerable: true, answer: numberFor(prompt) };
      return { text: JSON.stringify(out), structured: out, toolCalls: [{ name: "calc", arguments: { expression: "1" } }], toolResults: [{ name: "calc", ok: true, content: "{}" }], rounds: 1, usage: null };
    },
  };
}

test("through the runner: the seeded half is unanswerable, the four cases land on the rows, the verdict follows the task otherwise", async () => {
  const task = { ...wordmathTasks[0], setup: async ({ seed }) => ({ ...wordmathGen(seed >>> 0, 2), answer: wordmathGen(seed >>> 0, 2).answer }) };
  // Find a seed for each kind of instance.
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
  const unSeed = seeds.find((s) => unanswerableFor(s)), anSeed = seeds.find((s) => !unanswerableFor(s));
  const careful = withAbstain(fake("careful"));
  assert.deepEqual([careful.name, careful.baseName, careful.abstain], ["fake:m@abstain", "fake:m", "half"]);
  const u = await runTrial({ task, mode: "harness", client: careful, index: 1, seed: unSeed });
  assert.equal(u.abstain.applied, true);
  assert.equal(u.abstain.unanswerable, true);
  assert.ok(u.abstain.missing);
  assert.equal(u.correct, true, u.reason);
  assert.equal(u.abstain.abstention, "abstained");
  assert.equal(u.toolUseOk, true, u.toolUseReason);
  assert.match(u.prompt, /set "answerable" to false/);
  assert.match(u.ctx.story, /some/);
  const fab = await runTrial({ task, mode: "harness", client: withAbstain(fake("always")), index: 1, seed: unSeed });
  assert.equal(fab.correct, false);
  assert.equal(fab.abstain.abstention, "fabricated");
  assert.match(fab.reason, /fabricated an answer/);
  const refused = await runTrial({ task, mode: "noHarness", client: withAbstain(fake("never")), index: 1, seed: anSeed });
  assert.equal(refused.abstain.unanswerable, false);
  assert.equal(refused.correct, false);
  assert.equal(refused.abstain.abstention, "refused");
  // An answerable instance answered wrongly keeps the task's own verdict.
  const wrong = await runTrial({ task, mode: "noHarness", client: withAbstain(fake("always")), index: 1, seed: anSeed });
  assert.equal(wrong.abstain.abstention, "answered");
  assert.match(wrong.reason, /answered \d+, expected \d+|answer \d+ is right/);
  assert.match(wrong.prompt, /answer: cannot be determined/, "the note is on the answerable instance too");
  const plain = await runTrial({ task, mode: "harness", client: fake("careful"), index: 1, seed: unSeed });
  assert.equal(plain.abstain, null);
  assert.doesNotMatch(plain.prompt, /answerable/);
  assert.doesNotMatch(plain.ctx.story, /some/, "without the variant the instance is answerable");
});

test("the view and the paired delta count the four cases; the report prints them", () => {
  const row = (client, unanswerable, abstention, correct, over = {}) => ({ task: "wordmath4", mode: "harness", client, model: "m", index: 1, correct, latencyMs: 1, ...(client.includes("@") ? { baseClient: client.split("@")[0], abstain: { how: "half", applied: true, unanswerable, abstention } } : {}), ...over });
  const rows = [
    row("c", false, null, true, { index: 1 }), row("c", false, null, true, { index: 2 }), row("c", false, null, false, { index: 3 }), row("c", false, null, true, { index: 4 }),
    row("c@abstain", true, "abstained", true, { index: 1 }), row("c@abstain", true, "fabricated", false, { index: 2 }), row("c@abstain", false, "answered", true, { index: 3 }), row("c@abstain", false, "refused", false, { index: 4 }),
  ];
  const s = summarize(rows);
  assert.deepEqual(s.abstention, [{ client: "c@abstain", mode: "harness", trials: 4, unanswerable: 2, abstained: 1, fabricated: 1, answerable: 2, refused: 1, answeredRight: 1, abstainRatePct: 50, refusalRatePct: 50 }]);
  const d = s.delta.abstain.half;
  assert.deepEqual([d.unanswerable, d.abstained, d.fabricated, d.refused], [2, 1, 1, 1]);
  assert.equal(describeAbstention(s.abstention[0]), "2 unanswerable: abstained 1, fabricated 1 (50% abstained) · 2 answerable: refused 1, right 1");
  assert.deepEqual(abstentionView([]), []);
  const lines = [];
  printSummary(s, { log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /-- abstention[\s\S]*c@abstain\s+harness\s+2 unanswerable[\s\S]*-- abstain delta[\s\S]*abstained 1\/2 unanswerable, fabricated 1 · refused 1 answerable/);
});

test("the suffix parses alone, resolves to a paired variant, refuses to stack, and unsupported tasks stay answerable", async () => {
  assert.deepEqual(parseAbstainSuffix("local:m@abstain"), { base: "local:m", how: "half" });
  assert.deepEqual(parseAbstainSuffix("local:m"), { base: "local:m", how: null });
  assert.throws(() => parseAbstainSuffix("local:m@abstain:all"), /unknown abstain mode/);
  assert.deepEqual(parseClientSpec("local:m@abstain"), { provider: "local", model: "m", abstain: "half" });
  assert.throws(() => parseClientSpec("local:m@confidence@abstain"), /one variant per client/);
  const [base, v] = resolveClients("local:ornith-1.5:9b,local:ornith-1.5:9b@abstain");
  assert.equal(v.baseName, base.name);
  const { task: reason } = await import("../src/tasks/reason.js");
  const r = await runTrial({ task: reason, mode: "noHarness", client: withAbstain(fake("always")), index: 1 });
  assert.deepEqual(r.abstain, { how: "half", applied: false, unanswerable: false, missing: null, abstention: null }, "a task without an unanswerable variant is untouched");
});
