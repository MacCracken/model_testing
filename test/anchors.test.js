// Public anchors: the IFEval checkers, the BFCL AST check and call parser, the GSM8K reader, the
// fetch cache and the fixed permutation, and the four tasks over fixture sets in a temporary cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hb-anchors-"));
process.env.ANCHORS_DIR = dir;
const { checkInstruction, checkPrompt, looseVariants, detectLanguage, countWords, countSentences, INSTRUCTION_IDS, APPROXIMATE } = await import("../src/ifeval.js");
const { toSchema, toolsFrom, toolName, standardize, valueMatches, checkCall, scoreCalls, parseCalls } = await import("../src/bfcl.js");
const { SOURCES, fetchAnchor, loadAnchor, anchorOrder, anchorItem, anchorProvenance, describeAnchor, CAVEAT } = await import("../src/anchors.js");
const { publicTasks, gsm8k, ifeval, bfclsimple, bfclmultiple, gsm8kRead, gsm8kAnswer } = await import("../src/tasks/public.js");
const { listTasks } = await import("../src/tasks/registry.js");
const { runTrial } = await import("../src/runner.js");

test("IFEval checkers: each instruction type passes and fails where the original does", () => {
  const c = checkInstruction;
  assert.equal(c("keywords:existence", { keywords: ["mom", "mother"] }, "My Mom is my mother."), true);
  assert.equal(c("keywords:existence", { keywords: ["mom", "mother"] }, "My mother."), false);
  assert.equal(c("keywords:frequency", { keyword: "war", frequency: 2, relation: "at least" }, "War and war."), true);
  assert.equal(c("keywords:frequency", { keyword: "war", frequency: 2, relation: "less than" }, "War and war."), false);
  assert.equal(c("keywords:forbidden_words", { forbidden_words: ["rock"] }, "Rocket science"), true, "a word boundary, not a substring");
  assert.equal(c("keywords:forbidden_words", { forbidden_words: ["rock"] }, "I like Rock."), false);
  assert.equal(c("keywords:letter_frequency", { letter: "!", let_frequency: 2, let_relation: "at least" }, "Hi! There!"), true);
  assert.equal(c("keywords:letter_frequency", { letter: "e", let_frequency: 3, let_relation: "less than" }, "Eee"), false);
  assert.equal(c("length_constraints:number_sentences", { num_sentences: 3, relation: "less than" }, "One. Two."), true);
  assert.equal(c("length_constraints:number_sentences", { num_sentences: 3, relation: "less than" }, "One. Two! Three?"), false);
  assert.equal(c("length_constraints:number_paragraphs", { num_paragraphs: 3 }, "a\n***\nb\n***\nc"), true);
  assert.equal(c("length_constraints:number_paragraphs", { num_paragraphs: 3 }, "a\n***\n\n***\nc"), false, "an empty paragraph in the middle fails");
  assert.equal(c("length_constraints:number_paragraphs", { num_paragraphs: 2 }, "a *** b ***"), true, "a trailing separator is allowed");
  assert.equal(c("length_constraints:number_words", { num_words: 3, relation: "at least" }, "one two three"), true);
  assert.equal(c("length_constraints:number_words", { num_words: 3, relation: "at least" }, "one two"), false);
  assert.equal(c("length_constraints:nth_paragraph_first_word", { num_paragraphs: 2, nth_paragraph: 2, first_word: "weekend" }, "First para.\n\nWeekend, at last!"), true);
  assert.equal(c("length_constraints:nth_paragraph_first_word", { num_paragraphs: 2, nth_paragraph: 2, first_word: "weekend" }, "First para.\n\nThe weekend."), false);
  assert.equal(c("length_constraints:nth_paragraph_first_word", { num_paragraphs: 3, nth_paragraph: 2, first_word: "weekend" }, "First.\n\nWeekend."), false, "the paragraph count must match");
  assert.equal(c("detectable_content:number_placeholders", { num_placeholders: 2 }, "Dear [name], from [address]."), true);
  assert.equal(c("detectable_content:number_placeholders", { num_placeholders: 2 }, "Dear [name]."), false);
  assert.equal(c("detectable_content:postscript", { postscript_marker: "P.S." }, "Body.\n\nP.S. Call me."), true);
  assert.equal(c("detectable_content:postscript", { postscript_marker: "P.P.S" }, "Body.\nP.S. one"), false);
  assert.equal(c("detectable_content:postscript", { postscript_marker: "P.P.S" }, "Body.\nP.P.S. two"), true);
  assert.equal(c("detectable_format:number_bullet_lists", { num_bullets: 2 }, "* one\n- two"), true);
  assert.equal(c("detectable_format:number_bullet_lists", { num_bullets: 2 }, "* one\n* two\n* three"), false, "exactly that many");
  assert.equal(c("detectable_format:number_bullet_lists", { num_bullets: 1 }, "**bold** is not a bullet\n* one"), true);
  assert.equal(c("detectable_format:constrained_response", {}, "My answer is maybe."), true);
  assert.equal(c("detectable_format:constrained_response", {}, "Maybe."), false);
  assert.equal(c("detectable_format:number_highlighted_sections", { num_highlights: 2 }, "*one* and **two**"), true);
  assert.equal(c("detectable_format:number_highlighted_sections", { num_highlights: 2 }, "*one* and ** **"), false, "an empty highlight does not count");
  assert.equal(c("detectable_format:multiple_sections", { section_spliter: "Section", num_sections: 2 }, "Section 1\nfoo\nSection 2\nbar"), true);
  assert.equal(c("detectable_format:multiple_sections", { section_spliter: "SECTION", num_sections: 3 }, "SECTION 1\nfoo\nSECTION 2\nbar"), false);
  assert.equal(c("detectable_format:json_format", {}, '```json\n{"a": 1}\n```'), true);
  assert.equal(c("detectable_format:json_format", {}, 'Here: {"a": 1}'), false);
  assert.equal(c("detectable_format:title", {}, "<<My Title>>\ntext"), true);
  assert.equal(c("detectable_format:title", {}, "<< >>\ntext"), false);
  assert.equal(c("combination:two_responses", {}, "one\n******\ntwo"), true);
  assert.equal(c("combination:two_responses", {}, "one\n******\none"), false, "the two must differ");
  assert.equal(c("combination:two_responses", {}, "one\n******\n\n******\ntwo"), false, "an empty middle response fails");
  assert.equal(c("combination:repeat_prompt", { prompt_to_repeat: "Write a poem" }, "write a poem\n\nRoses…"), true);
  assert.equal(c("combination:repeat_prompt", { prompt_to_repeat: "Write a poem" }, "Sure! Write a poem"), false);
  assert.equal(c("startend:end_checker", { end_phrase: "Is there anything else?" }, '"So long. Is there anything else?"'), true);
  assert.equal(c("startend:end_checker", { end_phrase: "Is there anything else?" }, "Is there anything else? Bye."), false);
  assert.equal(c("change_case:capital_word_frequency", { capital_frequency: 2, capital_relation: "at least" }, "This is BIG and LOUD."), true);
  assert.equal(c("change_case:capital_word_frequency", { capital_frequency: 1, capital_relation: "less than" }, "This is BIG."), false);
  assert.equal(c("change_case:english_capital", {}, "ALL CAPS 123!"), true);
  assert.equal(c("change_case:english_capital", {}, "ALL Caps"), false);
  assert.equal(c("change_case:english_lowercase", {}, "all lower 123"), true);
  assert.equal(c("change_case:english_lowercase", {}, "All lower"), false);
  assert.equal(c("punctuation:no_comma", {}, "No commas here."), true);
  assert.equal(c("punctuation:no_comma", {}, "One, two."), false);
  assert.equal(c("startend:quotation", {}, '"quoted"'), true);
  assert.equal(c("startend:quotation", {}, '"half'), false);
  assert.equal(c("language:response_language", { language: "hi" }, "यह एक परीक्षण वाक्य है"), true);
  assert.equal(c("language:response_language", { language: "mr" }, "यह एक परीक्षण वाक्य है"), true, "one script, several languages: cannot be told apart, so it passes");
  assert.equal(c("language:response_language", { language: "de" }, "Das ist ein Test und die Katze ist nicht da."), true);
  assert.equal(c("language:response_language", { language: "de" }, "This is a test and the cat is not there."), false);
  assert.equal(c("language:response_language", { language: "sw" }, "Hii ni jaribio la maandishi na ya lugha."), true);
  assert.equal(c("language:response_language", { language: "ko" }, "이것은 테스트 문장입니다"), true);
  assert.throws(() => c("no:such", {}, "x"), /unknown IFEval instruction/);
  assert.equal(INSTRUCTION_IDS.length, 25);
  assert.ok(APPROXIMATE.has("language:response_language") && APPROXIMATE.has("length_constraints:number_words"));
  assert.equal(detectLanguage(""), null);
  assert.equal(countWords("Hello, world! It's 3 o'clock."), 7);
  assert.equal(countSentences("One. Two! Three? Four"), 4);
});

test("IFEval prompt-level scoring: strict wants every instruction; loose forgives a first line, a last line and asterisks", () => {
  const item = { instruction_id_list: ["punctuation:no_comma", "detectable_format:number_highlighted_sections", "length_constraints:number_words"], kwargs: [{}, { num_highlights: 1 }, { relation: "at least", num_words: 4 }] };
  const good = checkPrompt(item, "Here is *one* highlighted part of a longer answer.");
  assert.deepEqual([good.strict, good.loose, good.approximate], [true, true, true]);
  const commas = checkPrompt(item, "Here is *one* highlighted part, of a longer answer.");
  assert.equal(commas.strict, false);
  assert.deepEqual(commas.instructions.map((x) => x.strict), [false, true, true]);
  // The comma sits on a first line the loose scorer drops.
  const preface = checkPrompt(item, "Sure, here you go:\nHere is *one* highlighted part of a longer answer.");
  assert.deepEqual([preface.strict, preface.loose], [false, true]);
  assert.equal(checkPrompt({ instruction_id_list: ["punctuation:no_comma"], kwargs: [{}] }, "Rain, rain, go away.").loose, false, "a one-line answer minus its line is empty and proves nothing");
  assert.equal(looseVariants("a\nb\nc").length, 8);
  assert.deepEqual(looseVariants("a\nb\nc").slice(0, 4), ["a\nb\nc", "b\nc", "a\nb", "b"]);
});

test("BFCL: types map to JSON Schema, tool names lose their dots, values compare the leaderboard's way", () => {
  const fn = { name: "math.hypot", description: "d", parameters: { type: "dict", properties: { x: { type: "integer" }, pts: { type: "array", items: { type: "float" } }, opts: { type: "dict", properties: { k: { type: "tuple" } } } }, required: ["x"] } };
  const [tool] = toolsFrom([fn]);
  assert.equal(tool.name, "math_hypot");
  assert.equal(tool.original, "math.hypot");
  assert.deepEqual(tool.parameters, { type: "object", properties: { x: { type: "integer" }, pts: { type: "array", items: { type: "number" } }, opts: { type: "object", properties: { k: { type: "array" } } } }, required: ["x"] });
  assert.equal(typeof tool.impl, "function");
  assert.equal(toolName("a.b.c"), "a_b_c");
  assert.equal(standardize("San Francisco, CA"), "sanfranciscoca");
  assert.equal(valueMatches("san francisco", ["San Francisco"]), true);
  assert.equal(valueMatches(5, [5]), true);
  assert.equal(valueMatches("5", [5]), true, "a numeric string counts as the number");
  assert.equal(valueMatches(5.5, [5], "integer"), false);
  assert.equal(valueMatches(5.0, [5], "integer"), true);
  assert.equal(valueMatches(true, [true]), true);
  assert.equal(valueMatches("true", [true]), true);
  assert.equal(valueMatches([1, 3], [[1, 3]]), true);
  assert.equal(valueMatches([3, 1], [[1, 3]]), false, "order matters in a list");
  assert.equal(valueMatches(["C", "G"], [["G", "C"], ["C", "G"]]), true);
  assert.equal(valueMatches({ a: 1 }, [{ a: 1 }]), true);
  assert.equal(valueMatches({ a: 1, b: 2 }, [{ a: 1 }]), false);
  // A dict answer lists the values each key accepts, the leaderboard's way.
  assert.equal(valueMatches({ width: 20, height: 12 }, [{ width: [20], height: [12] }]), true);
  assert.equal(valueMatches({ width: 21, height: 12 }, [{ width: [20], height: [12] }]), false);
  assert.equal(valueMatches({ department: "science", school: "Bluebird HS" }, [{ department: ["Science"], school: ["Bluebird High School", "Bluebird HS"] }]), true);
  assert.equal(valueMatches({ department: "Science" }, [{ department: ["Science"], school: ["Bluebird HS", ""] }]), true, "a nested key that accepts \"\" may be omitted");
  assert.equal(valueMatches({ department: "Science" }, [{ department: ["Science"], school: ["Bluebird HS"] }]), false, "a nested key without \"\" is required");
  assert.equal(valueMatches([{ type: "window", area: 15 }], [[{ type: ["window"], area: [15] }]]), true, "a list of dicts, element-wise");
  assert.equal(valueMatches("", [""]), false, '"" means optional, never a value');
});

const tri = { name: "calculate_triangle_area", description: "d", parameters: { type: "dict", properties: { base: { type: "integer" }, height: { type: "integer" }, unit: { type: "string" } }, required: ["base", "height"] } };
const triAnswer = [{ calculate_triangle_area: { base: [10], height: [5], unit: ["units", ""] } }];

test("BFCL: the call check wants the function, every required parameter, and allowed values; nothing extra", () => {
  assert.equal(scoreCalls([{ name: "calculate_triangle_area", arguments: { base: 10, height: 5 } }], triAnswer, [tri]).ok, true, "an optional parameter may be omitted");
  assert.equal(scoreCalls([{ name: "calculate_triangle_area", arguments: { base: 10, height: 5, unit: "units" } }], triAnswer, [tri]).ok, true);
  assert.match(scoreCalls([{ name: "calculate_triangle_area", arguments: { base: 10, height: 5, unit: "cm" } }], triAnswer, [tri]).reason, /unit = "cm", wanted one of \["units"\]/);
  assert.match(scoreCalls([{ name: "calculate_triangle_area", arguments: { base: 10 } }], triAnswer, [tri]).reason, /missing parameter height/);
  assert.match(scoreCalls([{ name: "calculate_triangle_area", arguments: { base: 10, height: 5, color: "red" } }], triAnswer, [tri]).reason, /unexpected parameter color/);
  assert.match(scoreCalls([{ name: "area", arguments: {} }], triAnswer, [tri]).reason, /called area, wanted calculate_triangle_area/);
  assert.match(scoreCalls([], triAnswer, [tri]).reason, /no function call/);
  assert.match(scoreCalls([{ name: "calculate_triangle_area", arguments: { base: 10, height: 5 } }, { name: "calculate_triangle_area", arguments: { base: 1, height: 1 } }], triAnswer, [tri]).reason, /2 calls for one expected/);
  assert.equal(checkCall({ name: "math_hypot", arguments: { x: 4, y: 5 } }, { "math.hypot": { x: [4], y: [5], z: ["", 0] } }).ok, true, "the underscored tool name counts as the dotted function");
  assert.equal(checkCall({ name: "math.hypot", arguments: { x: 4, y: 5, z: 0 } }, { "math.hypot": { x: [4], y: [5], z: ["", 0] } }).ok, true);
});

test("BFCL: the prompting-mode parser reads Python-style calls with their literals", () => {
  assert.deepEqual(parseCalls('[calculate_triangle_area(base=10, height=5, unit="units")]'), [{ name: "calculate_triangle_area", arguments: { base: 10, height: 5, unit: "units" } }]);
  assert.deepEqual(parseCalls("Sure: math.hypot(x=4, y=5)"), [{ name: "math.hypot", arguments: { x: 4, y: 5 } }]);
  assert.deepEqual(parseCalls("```python\n[f(a=[1, 2.5], b={'k': True, \"j\": None}, c=(1, 2), d='it\\'s')]\n```"), [{ name: "f", arguments: { a: [1, 2.5], b: { k: true, j: null }, c: [1, 2], d: "it's" } }]);
  assert.deepEqual(parseCalls("[f(a=1), g(b=-2e3)]").map((c) => c.name), ["f", "g"]);
  assert.deepEqual(parseCalls("I cannot help with that."), []);
  assert.deepEqual(parseCalls(""), []);
});

// ---- the cache, the permutation and the tasks, over fixture sets --------------------------------
const gsmItems = [
  { question: "Janet has 16 eggs and eats 3. How many are left?", answer: "16 - 3 = <<16-3=13>>13\n#### 13" },
  { question: "A robe takes 2 bolts and half that much white. Total?", answer: "2/2=1\n2+1=3\n#### 3" },
  { question: "Twelve times twelve?", answer: "#### 144" },
];
const ifItems = [
  { key: 1, prompt: "Write about rain without commas.", instruction_id_list: ["punctuation:no_comma"], kwargs: [{}] },
  { key: 2, prompt: "Answer in all capital letters with a title in << >>.", instruction_id_list: ["change_case:english_capital", "detectable_format:title"], kwargs: [{}, {}] },
];
const bfclItems = [
  { id: "simple_python_0", question: [[{ role: "user", content: "Find the area of a triangle with a base of 10 units and height of 5 units." }]], function: [tri] },
  { id: "simple_python_1", question: [[{ role: "user", content: "Factorial of 5." }]], function: [{ name: "math.factorial", description: "d", parameters: { type: "dict", properties: { number: { type: "integer" } }, required: ["number"] } }] },
];
const bfclAnswers = [{ id: "simple_python_0", ground_truth: triAnswer }, { id: "simple_python_1", ground_truth: [{ "math.factorial": { number: [5] } }] }];
const files = {
  [SOURCES.gsm8k.files.items]: gsmItems, [SOURCES.ifeval.files.items]: ifItems,
  [SOURCES.bfclsimple.files.items]: bfclItems, [SOURCES.bfclsimple.files.answers]: bfclAnswers,
  [SOURCES.bfclmultiple.files.items]: bfclItems.map((it) => ({ ...it, id: it.id.replace("simple_python", "multiple"), function: [...it.function, tri] })),
  [SOURCES.bfclmultiple.files.answers]: bfclAnswers.map((a) => ({ ...a, id: a.id.replace("simple_python", "multiple") })),
};
let fetched = 0;
const fetchImpl = async (url) => { fetched++; const items = files[url]; return items ? { ok: true, status: 200, text: async () => items.map((x) => JSON.stringify(x)).join("\n") + "\n" } : { ok: false, status: 404, text: async () => "" }; };

test("the cache: fetched once with provenance, read back, never refetched unless forced; unknown sets refused", async () => {
  assert.equal(loadAnchor("gsm8k"), null, "nothing fetched yet");
  assert.match(describeAnchor("gsm8k"), /not fetched/);
  const set = await fetchAnchor("gsm8k", { fetchImpl });
  assert.equal(set.items.length, 3);
  assert.equal(set.meta.files.items.count, 3);
  assert.equal(set.meta.files.items.sha256.length, 64);
  assert.equal(set.meta.license, "MIT");
  assert.equal(set.meta.caveat, CAVEAT);
  assert.ok(existsSync(join(dir, "gsm8k.items.jsonl")) && existsSync(join(dir, "gsm8k.meta.json")));
  const n = fetched;
  await fetchAnchor("gsm8k", { fetchImpl });
  assert.equal(fetched, n, "cached: no second fetch");
  await fetchAnchor("gsm8k", { fetchImpl, force: true });
  assert.equal(fetched, n + 1);
  const bf = await fetchAnchor("bfclsimple", { fetchImpl });
  assert.equal(Object.keys(bf.answers).length, 2, "the answers file rides along");
  await fetchAnchor("ifeval", { fetchImpl });
  await fetchAnchor("bfclmultiple", { fetchImpl });
  assert.match(describeAnchor("gsm8k"), /gsm8k: 3 items, sha256 [0-9a-f]{12}, fetched \d{4}-\d{2}-\d{2} — Cobbe/);
  await assert.rejects(fetchAnchor("nope", { fetchImpl }), /unknown anchor nope/);
  await assert.rejects(fetchAnchor("gsm8k", { fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }), force: true }), /HTTP 500/);
  await fetchAnchor("gsm8k", { fetchImpl, force: true }); // restore after the failed forced fetch
  const prov = anchorProvenance(loadAnchor("gsm8k"));
  assert.deepEqual(Object.keys(prov), ["set", "sha256", "count", "fetchedAt", "license", "caveat"]);
  assert.equal(prov.sha256.length, 12);
});

test("the permutation is fixed: the same subset for every model and run, wrapping past the end", () => {
  assert.deepEqual(anchorOrder(5), anchorOrder(5));
  assert.deepEqual([...anchorOrder(5)].sort(), [0, 1, 2, 3, 4]);
  assert.notDeepEqual(anchorOrder(50), Array.from({ length: 50 }, (_, i) => i), "shuffled, not in file order");
  const set = loadAnchor("gsm8k");
  const first = anchorItem(set, 1), again = anchorItem(set, 1), wrapped = anchorItem(set, 4);
  assert.equal(first.item, again.item);
  assert.equal(wrapped.item, first.item, "index 4 of a 3-item set wraps to index 1");
  assert.equal(new Set([1, 2, 3].map((i) => anchorItem(set, i).item.question)).size, 3, "three trials, three different items");
});

test("gsm8k: the answer is read strictly after #### or as the last number; the tasks are registered with their source", () => {
  assert.equal(gsm8kAnswer("x\n#### 1,234"), 1234);
  assert.deepEqual(gsm8kRead("So 16 − 3 = 13.\n#### 13"), { value: 13, how: "strict" });
  assert.deepEqual(gsm8kRead("The answer is $1,234."), { value: 1234, how: "last number" });
  assert.deepEqual(gsm8kRead("no digits"), { value: NaN, how: "no number" });
  assert.equal(gsm8k.eval.scoreNoHarness("#### 13", { answer: 13 }).correct, true);
  assert.match(gsm8k.eval.scoreNoHarness("It is 12.", { answer: 13 }).reason, /answered 12 \(last number\), expected 13/);
  assert.equal(gsm8k.eval.scoreHarness({ work: [], answer: 13 }, { answer: 13 }).correct, true);
  assert.equal(gsm8k.eval.scoreHarness({ answer: "13" }, { answer: 13 }).correct, true);
  assert.equal(gsm8k.eval.canon("#### 13", { structured: false }), "13");
  const listed = listTasks().filter((t) => t.source === "public");
  assert.deepEqual(listed.map((t) => t.name), ["gsm8k", "ifeval", "bfclsimple", "bfclmultiple"]);
  assert.deepEqual(listed.map((t) => t.capabilities[0]), ["public:arithmetic", "public:instruction-following", "public:tool-use", "public:tool-selection"]);
  assert.ok(listed.every((t) => t.category === "public-anchor" && t.caveat === CAVEAT));
  assert.deepEqual(listTasks().find((t) => t.name === "ifeval").modes, ["noHarness"]);
  assert.equal(publicTasks.length, 4);
});

// A fake model: gsm8k answers from the solution the fixture carries, ifeval follows or breaks the
// instruction, bfcl writes the call as text or makes it as a tool call.
function fake(how) {
  return {
    name: "fake", model: "fake",
    async chat(messages) {
      const prompt = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      if (/eggs/.test(prompt)) return { text: how === "wrong" ? "#### 12" : "16 − 3 = 13\n#### 13", usage: null };
      if (/rain/.test(prompt)) return { text: how === "wrong" ? "Rain, rain, go away." : "Rain falls softly on the roof.", usage: null };
      if (/capital letters/.test(prompt)) return { text: how === "wrong" ? "<<Title>>\nnot capital" : "<<RAIN>>\nIT RAINS.", usage: null };
      if (/triangle/.test(prompt)) return { text: how === "wrong" ? "[calculate_triangle_area(base=10)]" : '[calculate_triangle_area(base=10, height=5, unit="units")]', usage: null };
      return { text: "#### 3", usage: null };
    },
    async runWithTools(prompt, tools) {
      if (/triangle/.test(prompt)) {
        const t = tools.find((x) => x.name === "calculate_triangle_area");
        const args = how === "wrong" ? { base: 10, height: 6 } : { base: 10, height: 5 };
        await t.impl(args);
        const text = /JSON/.test(prompt) ? JSON.stringify({ work: ["called"], called: "calculate_triangle_area" }) : "done";
        return { text, structured: /JSON/.test(prompt) ? JSON.parse(text) : null, toolCalls: [{ name: "calculate_triangle_area", arguments: args }], toolResults: [{ name: "calculate_triangle_area", ok: true, content: "{}" }], rounds: 1, usage: null };
      }
      const calc = tools.find((x) => x.name === "calc");
      const out = await calc.impl({ expression: "16 - 3" });
      const text = JSON.stringify({ work: ["16 - 3"], answer: 13 });
      return { text, structured: JSON.parse(text), toolCalls: [{ name: "calc", arguments: { expression: "16 - 3" } }], toolResults: [{ name: "calc", ok: true, content: JSON.stringify(out) }], rounds: 1, usage: null };
    },
  };
}

test("the tasks through the runner: rows carry source and provenance; gsm8k, ifeval and bfcl score right and wrong answers", async () => {
  // The fixed permutation decides which item a trial index lands on; find the ones the fake answers.
  const indexOf = (name, pick) => [1, 2, 3].find((i) => pick(anchorItem(loadAnchor(name), i).item));
  const eggs = indexOf("gsm8k", (it) => /eggs/.test(it.question));
  const rain = indexOf("ifeval", (it) => it.key === 1), caps = indexOf("ifeval", (it) => it.key === 2);
  const g = await runTrial({ task: gsm8k, mode: "noHarness", client: fake("right"), index: eggs, maxRounds: 4 });
  assert.equal(g.correct, true, g.reason);
  assert.equal(g.source, "public");
  assert.equal(g.ctx.provenance.set, "gsm8k");
  assert.equal(g.ctx.provenance.caveat, CAVEAT);
  assert.equal(g.ctx.answer, 13);
  const gh = await runTrial({ task: gsm8k, mode: "harness", client: fake("right"), index: eggs, maxRounds: 4 });
  assert.equal(gh.correct, true, gh.reason);
  assert.equal(gh.toolUseOk, true);
  assert.equal((await runTrial({ task: gsm8k, mode: "noHarness", client: fake("wrong"), index: eggs, maxRounds: 4 })).correct, false);

  const i1 = await runTrial({ task: ifeval, mode: "noHarness", client: fake("right"), index: rain, maxRounds: 4 });
  assert.equal(i1.correct, true, i1.reason);
  const i1w = await runTrial({ task: ifeval, mode: "noHarness", client: fake("wrong"), index: rain, maxRounds: 4 });
  assert.equal(i1w.correct, false);
  assert.match(i1w.reason, /0\/1 instruction\(s\) followed strictly, 0\/1 loosely \(failed: punctuation:no_comma\)/);
  const i2 = await runTrial({ task: ifeval, mode: "noHarness", client: fake("right"), index: caps, maxRounds: 4 });
  assert.equal(i2.correct, true, i2.reason);
  assert.match((await runTrial({ task: ifeval, mode: "noHarness", client: fake("wrong"), index: caps, maxRounds: 4 })).reason, /1\/2 instruction\(s\) followed strictly.*failed: change_case:english_capital/);

  // The fixture set's fixed permutation: find the trial index that lands on the triangle item.
  const set = loadAnchor("bfclsimple");
  const triIndex = [1, 2].find((i) => anchorItem(set, i).item.id === "simple_python_0");
  const p = await runTrial({ task: bfclsimple, mode: "noHarness", client: fake("right"), index: triIndex, maxRounds: 4 });
  assert.equal(p.correct, true, p.reason);
  assert.match(p.reason, /calculate_triangle_area\(base, height, unit\) matches/);
  const pw = await runTrial({ task: bfclsimple, mode: "noHarness", client: fake("wrong"), index: triIndex, maxRounds: 4 });
  assert.match(pw.reason, /missing parameter height/);
  const t = await runTrial({ task: bfclsimple, mode: "toolOnly", client: fake("right"), index: triIndex, maxRounds: 4 });
  assert.equal(t.correct, true, t.reason);
  assert.equal(t.toolUseOk, true);
  assert.deepEqual(t.ground.calls, [{ name: "calculate_triangle_area", arguments: { base: 10, height: 5 } }]);
  const h = await runTrial({ task: bfclsimple, mode: "harness", client: fake("right"), index: triIndex, maxRounds: 4 });
  assert.equal(h.correct, true, h.reason);
  assert.equal(h.schemaValid, true);
  const hw = await runTrial({ task: bfclsimple, mode: "harness", client: fake("wrong"), index: triIndex, maxRounds: 4 });
  assert.equal(hw.correct, false);
  assert.match(hw.reason, /height = 6, wanted one of \[5\]/);
  assert.equal(hw.toolUseOk, false);
  const m = await runTrial({ task: bfclmultiple, mode: "toolOnly", client: fake("right"), index: [1, 2].find((i) => anchorItem(loadAnchor("bfclmultiple"), i).item.id === "multiple_0"), maxRounds: 4 });
  assert.equal(m.correct, true, m.reason);
  assert.equal(m.ctx.functions.length, 2, "multiple offers several functions");
});

test("an unfetched set fails the trial with the fetch command, not a crash elsewhere", async () => {
  const saved = process.env.ANCHORS_DIR;
  process.env.ANCHORS_DIR = join(dir, "empty");
  try {
    await assert.rejects(gsm8k.setup({ index: 1 }), /anchor gsm8k is not fetched — run: node src\/cli\.js anchors fetch gsm8k/);
  } finally { process.env.ANCHORS_DIR = saved; }
  assert.ok(readFileSync(join(dir, "gsm8k.meta.json"), "utf8").includes('"caveat"'));
});
