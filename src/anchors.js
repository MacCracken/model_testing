// anchors.js — public benchmark sets run here as anchors. The items are fetched from their public
// repositories into a local cache (`anchors/`, gitignored: the sets are public, the copy is not
// ours to vendor), with the source, licence, byte count and hash recorded beside them so a run can
// say exactly which file it read. Runs of these tasks are tagged `source: public` and carry the
// contamination caveat: the sets are on the open web and may be in any model's training data, so
// they anchor our generators' difficulty to known scales and are never the headline.
//
// The subset a run sees is the first N items of one fixed permutation of the set (seed 2026), the
// same for every model and every run, so anchor numbers compare across runs the way generated
// tasks do across seeds.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dice } from "./tasks/gen.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const anchorsDir = () => process.env.ANCHORS_DIR ?? join(ROOT, "anchors");
export const CAVEAT = "public set: on the open web, may be in the model's training data; an anchor, not a headline";
export const PERMUTATION_SEED = 2026;

const GORILLA = "https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/data";
export const SOURCES = {
  gsm8k: {
    files: { items: "https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl" },
    format: "jsonl", license: "MIT", cite: "Cobbe et al. 2021, GSM8K test split (1319 problems)", capability: "arithmetic",
  },
  ifeval: {
    files: { items: "https://raw.githubusercontent.com/google-research/google-research/master/instruction_following_eval/data/input_data.jsonl" },
    format: "jsonl", license: "Apache-2.0", cite: "Zhou et al. 2023, IFEval (541 prompts, 25 instruction types)", capability: "instruction-following",
  },
  bfclsimple: {
    files: { items: `${GORILLA}/BFCL_v4_simple_python.json`, answers: `${GORILLA}/possible_answer/BFCL_v4_simple_python.json` },
    format: "jsonl", license: "Apache-2.0", cite: "Berkeley Function Calling Leaderboard v4, simple (python) — one function, one call", capability: "tool-use",
  },
  bfclmultiple: {
    files: { items: `${GORILLA}/BFCL_v4_multiple.json`, answers: `${GORILLA}/possible_answer/BFCL_v4_multiple.json` },
    format: "jsonl", license: "Apache-2.0", cite: "Berkeley Function Calling Leaderboard v4, multiple — several functions, the right one called once", capability: "tool-selection",
  },
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parse = (text) => text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

export function cachePath(name, file = "items") {
  return join(anchorsDir(), `${name}.${file}.jsonl`);
}
export function metaPath(name) {
  return join(anchorsDir(), `${name}.meta.json`);
}

// Fetch a set into the cache (or read the cache): { name, meta, items, answers? }.
export async function fetchAnchor(name, { force = false, fetchImpl = globalThis.fetch } = {}) {
  const src = SOURCES[name];
  if (!src) throw new Error(`unknown anchor ${name} (${Object.keys(SOURCES).join(", ")})`);
  mkdirSync(anchorsDir(), { recursive: true });
  const meta = existsSync(metaPath(name)) && !force ? JSON.parse(readFileSync(metaPath(name), "utf8")) : { name, files: {} };
  for (const [file, url] of Object.entries(src.files)) {
    const path = cachePath(name, file);
    if (existsSync(path) && !force && meta.files[file]) continue;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`fetching ${url} → HTTP ${res.status}`);
    const text = await res.text();
    const items = parse(text);
    writeFileSync(path, items.map((x) => JSON.stringify(x)).join("\n") + "\n");
    meta.files[file] = { url, bytes: text.length, sha256: sha256(text), count: items.length, fetchedAt: new Date().toISOString() };
  }
  Object.assign(meta, { license: src.license, cite: src.cite, capability: src.capability, caveat: CAVEAT });
  writeFileSync(metaPath(name), JSON.stringify(meta, null, 2) + "\n");
  return loadAnchor(name);
}

// The cached set, or null when it has not been fetched.
export function loadAnchor(name) {
  if (!SOURCES[name]) throw new Error(`unknown anchor ${name}`);
  if (!existsSync(metaPath(name)) || !existsSync(cachePath(name, "items"))) return null;
  const meta = JSON.parse(readFileSync(metaPath(name), "utf8"));
  const items = parse(readFileSync(cachePath(name, "items"), "utf8"));
  const out = { name, meta, items };
  if (SOURCES[name].files.answers && existsSync(cachePath(name, "answers"))) out.answers = Object.fromEntries(parse(readFileSync(cachePath(name, "answers"), "utf8")).map((a) => [a.id, a]));
  return out;
}

// The fixed permutation: item k of a run is `order(n)[k mod n]`.
export function anchorOrder(n, seed = PERMUTATION_SEED) {
  return dice(seed).shuffle(Array.from({ length: n }, (_, i) => i));
}
export function anchorItem(set, index) {
  const order = anchorOrder(set.items.length);
  const k = ((index - 1) % order.length + order.length) % order.length;
  const item = set.items[order[k]];
  return { item, position: k, answer: set.answers?.[item.id] ?? null };
}

// What a row records about the file it read: enough to say which copy of the set produced a number.
export function anchorProvenance(set) {
  const f = set.meta.files?.items ?? {};
  return { set: set.name, sha256: f.sha256 ? f.sha256.slice(0, 12) : null, count: f.count ?? set.items.length, fetchedAt: f.fetchedAt ?? null, license: set.meta.license, caveat: CAVEAT };
}

export function describeAnchor(name) {
  const set = loadAnchor(name);
  const src = SOURCES[name];
  if (!set) return `${name}: not fetched (node src/cli.js anchors fetch ${name}) — ${src.cite}, ${src.license}`;
  const f = set.meta.files.items;
  return `${name}: ${f.count} items, sha256 ${f.sha256.slice(0, 12)}, fetched ${String(f.fetchedAt).slice(0, 10)} — ${src.cite}, ${src.license}`;
}
