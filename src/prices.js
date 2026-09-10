// prices.js — cost in currency. A price table (`models/prices.json`, or PRICES_FILE) gives per-token
// prices by model id; a row is priced when it runs from its usage, and the run keeps that number
// with the table's date, so a run costs what it cost on its day. The bench cannot verify a price:
// the table says where each came from and when, and a model without an entry runs unpriced —
// the cost view says how many rows had no price rather than pretending.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "models", "prices.json");
let cache = null;

export function pricesFile() {
  return process.env.PRICES_FILE ?? DEFAULT_FILE;
}

export function loadPrices({ force = false } = {}) {
  if (cache && !force) return cache;
  const file = pricesFile();
  let raw = {};
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`price table ${file} is not valid JSON: ${err.message}`); }
  }
  const entries = {};
  for (const [id, e] of Object.entries(raw)) {
    if (id.startsWith("_") || !e || typeof e !== "object") continue;
    entries[id] = {
      id,
      input: Number(e.input ?? 0),
      output: Number(e.output ?? 0),
      cachedInput: e.cachedInput === undefined || e.cachedInput === null ? null : Number(e.cachedInput),
      per: Number(e.per ?? 1_000_000),
      currency: e.currency ?? "USD",
      asOf: e.asOf ?? null,
      source: e.source ?? null,
      note: e.note ?? null,
    };
  }
  cache = { file, entries };
  return cache;
}

const stripVariant = (s) => String(s ?? "").replace(/@(skill|agents|stress|constraints|format|effort|confidence|abstain|perturb)(:[a-z]+)?$/, "");
const globMatch = (pattern, s) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(s);

// The entry for a client: its id exactly, then its model id (any `provider/` prefix dropped), then
// a wildcard entry over either. Null when nothing matches.
export function priceFor(clientName, { model = null, entries = loadPrices().entries } = {}) {
  const client = stripVariant(clientName);
  const m = model ?? client.slice(client.indexOf(":") + 1);
  const bare = String(m).includes("/") ? String(m).slice(String(m).lastIndexOf("/") + 1) : String(m);
  for (const key of [client, m, bare]) if (entries[key]) return entries[key];
  for (const [key, e] of Object.entries(entries)) if (key.includes("*") && (globMatch(key, client) || globMatch(key, m) || globMatch(key, bare))) return e;
  return null;
}

// The cost of one row's usage at a price: cached prompt tokens at the cached rate when the table
// has one, the rest at the input rate, completions at the output rate.
export function costOf(usage, price) {
  if (!usage || !price) return null;
  const prompt = usage.prompt_tokens ?? 0;
  const cached = Math.min(prompt, usage.prompt_tokens_details?.cached_tokens ?? 0);
  const completion = usage.completion_tokens ?? 0;
  const per = price.per || 1_000_000;
  const cachedRate = price.cachedInput ?? price.input;
  const input = ((prompt - cached) * price.input + cached * cachedRate) / per;
  const output = (completion * price.output) / per;
  return { usd: input + output, input, output, cachedTokens: cached, currency: price.currency, asOf: price.asOf, price: price.id };
}

// What the runner takes: (client, usage) → the row's cost record, or null when unpriced.
export function pricingFor({ entries = loadPrices().entries } = {}) {
  return (client, usage, { model = null } = {}) => {
    const price = priceFor(client?.name ?? client, { model: model ?? client?.model ?? null, entries });
    if (!price) return null;
    const c = costOf(usage, price);
    return c ? { usd: c.usd, input: c.input, output: c.output, cachedTokens: c.cachedTokens, currency: c.currency, asOf: c.asOf, price: c.price } : { usd: 0, input: 0, output: 0, cachedTokens: 0, currency: price.currency, asOf: price.asOf, price: price.id, unpriced: "no usage" };
  };
}

// Dollars: cents above a dollar, otherwise up to five decimals with the trailing zeros dropped.
export const fmtUsd = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v >= 1 ? `$${v.toFixed(2)}` : v === 0 ? "$0" : `$${parseFloat(v.toFixed(5))}`);

export function describePrice(e) {
  if (!e) return "no price";
  return `${e.id}: $${e.input}/M in${e.cachedInput !== null ? ` ($${e.cachedInput} cached)` : ""}, $${e.output}/M out${e.asOf ? `, as of ${e.asOf}` : ""}${e.note ? ` — ${e.note}` : ""}`;
}
