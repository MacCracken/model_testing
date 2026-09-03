// version.js — what produced a run: bench version, git commit, node. Recorded in every run so
// results stay comparable as prompts, scorers and models move.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cached = null;

export function benchVersions() {
  if (cached) return cached;
  let bench = null;
  try {
    bench = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version ?? null;
  } catch { /* not in a checkout */ }
  let git = null;
  try {
    git = execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch { /* no git */ }
  cached = { bench, git, node: process.version, harness: "synthetic" };
  return cached;
}
