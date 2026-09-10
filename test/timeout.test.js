// The per-request timeout: five minutes for a local endpoint (a thinking model served locally can
// spend minutes on an answer), two for a hosted route, BENCH_TIMEOUT_MS overriding either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClient, hasCredentials } from "../src/providers/index.js";

test("local endpoints default to a five-minute request timeout, hosted routes to two, and the env var overrides both", () => {
  const saved = process.env.BENCH_TIMEOUT_MS;
  try {
    delete process.env.BENCH_TIMEOUT_MS;
    assert.equal(buildClient({ provider: "local", model: "m" }).timeoutMs, 300_000);
    if (hasCredentials("openai")) assert.equal(buildClient({ provider: "openai", model: "gpt-4o-mini" }).timeoutMs, 120_000);
    process.env.BENCH_TIMEOUT_MS = "45000";
    assert.equal(buildClient({ provider: "local", model: "m" }).timeoutMs, 45_000);
    if (hasCredentials("openai")) assert.equal(buildClient({ provider: "openai", model: "gpt-4o-mini" }).timeoutMs, 45_000);
  } finally {
    if (saved === undefined) delete process.env.BENCH_TIMEOUT_MS; else process.env.BENCH_TIMEOUT_MS = saved;
  }
});
