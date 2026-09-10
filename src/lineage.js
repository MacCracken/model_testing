// lineage.js — the model registry: which checkpoint a client id is, what line it belongs to and what
// it was trained from. `models/lineage.json` (or LINEAGE_FILE) maps client ids to entries; runs
// record the entries of the clients they ran, the index carries family / checkpoint / step / parent
// per trial, and the scorecard and compare commands can follow a line over time.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "models", "lineage.json");
let cache = null;

export function lineageFile() {
  return process.env.LINEAGE_FILE ?? DEFAULT_FILE;
}

export function loadLineage({ force = false } = {}) {
  if (cache && !force) return cache;
  const file = lineageFile();
  let raw = {};
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`lineage file ${file} is not valid JSON: ${err.message}`); }
  }
  const entries = {};
  for (const [id, e] of Object.entries(raw)) {
    if (id.startsWith("_") || !e || typeof e !== "object") continue;
    entries[id] = {
      id,
      family: e.family ?? null,
      checkpoint: e.checkpoint ?? null,
      step: Number.isFinite(Number(e.step)) && e.step !== null ? Number(e.step) : null,
      parent: e.parent ?? null,
      trainedOn: e.trainedOn ?? null,
      date: e.date ?? null,
      notes: e.notes ?? null,
    };
  }
  cache = { file, entries };
  return cache;
}

// The entry for a client id, ignoring any @variant suffix (a skilled or stressed run of a checkpoint
// is still that checkpoint).
export function lineageFor(clientName) {
  const base = String(clientName ?? "").replace(/@(skill|agents|stress|constraints|format|effort|confidence|abstain)(:[a-z]+)?$/, "");
  return loadLineage().entries[base] ?? null;
}

// The entries for a run's clients — what gets recorded on the run.
export function lineageOf(clientNames) {
  const out = {};
  for (const c of clientNames) { const e = lineageFor(c); if (e) out[c] = e; }
  return out;
}

export function familyMembers(family) {
  return Object.values(loadLineage().entries).filter((e) => e.family === family).sort((a, b) => (a.step ?? -1) - (b.step ?? -1) || String(a.date ?? "").localeCompare(String(b.date ?? "")));
}

export function parentOf(clientName) {
  return lineageFor(clientName)?.parent ?? null;
}

export function describeLineage(e) {
  if (!e) return "";
  return [e.family, e.checkpoint, e.step !== null ? `step ${e.step}` : null, e.parent ? `from ${e.parent}` : null, e.trainedOn ? `on ${e.trainedOn}` : null].filter(Boolean).join(" · ");
}
