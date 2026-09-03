// Small shared helpers. Kept dependency-free.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Parse KEY=VALUE lines. Comments and blanks are ignored; surrounding quotes are stripped. Values
// are taken literally — an API key containing "%" must not be URL-decoded.
export function parseEnvText(raw) {
  const parsed = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    parsed[key] = val;
  }
  return parsed;
}

let cachedEnvFile = null;

// Read the project-root `.env` (cwd) once. A missing file is simply {}.
export function loadEnvFile() {
  if (cachedEnvFile) return cachedEnvFile;
  try {
    cachedEnvFile = parseEnvText(readFileSync(resolve(process.cwd(), ".env"), "utf8"));
  } catch {
    cachedEnvFile = {};
  }
  return cachedEnvFile;
}

// Look up one setting: a real environment variable wins, then `.env`, then the fallback.
export function envValue(key, fallback = "") {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  return loadEnvFile()[key] || fallback;
}
