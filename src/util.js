// Small shared helpers. Kept dependency-free.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Read the .env file from the project root (cwd) if present. Keys here are used as defaults;
// real environment variables (process.env) take precedence. Ignores comments and blanks.
export function loadEnvFile() {
  let raw = "";
  try {
    raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return {};
  }
  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    parsed[key] = decodeURIComponent(val);
  }
  return parsed;
}

// Parse a single KEY=VALUE line from .env (or the raw string). Ignores comments and blanks.
export function parseEnv(input) {
  // When called with a single KEY, look it up in the .env file (and process.env).
  if (input && !/\s/.test(input) && input.toUpperCase() === input && !input.includes("=")) {
    const env = loadEnvFile();
    if (env[input]) return env[input];
    return process.env[input] ?? "";
  }

  // Otherwise parse the input as KEY=VALUE lines (raw string or multi-line string).
  const lines = String(input).split(/\r?\n/);
  for (const line of lines) {
    const lineTrim = line.trim();
    if (!lineTrim || lineTrim.startsWith("#")) continue;
    const eq = lineTrim.indexOf("=");
    if (eq === -1) continue;
    const key = lineTrim.slice(0, eq).trim();
    let val = lineTrim.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    return decodeURIComponent(val);
  }
  return "";
}

export function readFile(name) {
  return String(readFileSync(name, "utf8"));
}

// Basic statistics helpers for aggregation.
export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function pct(xs, cond) {
  if (!xs.length) return 0;
  return (xs.filter((x) => cond(x)).length / xs.length) * 100;
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
