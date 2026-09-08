// The browser imports /lib/runner.js and summarizes runs with it. Every module in runner.js's import
// graph must therefore be served under /lib/ and be free of Node-only imports — this test failed
// (by design) the day runner.js gained an import the server did not serve and the UI went blank.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const served = new Set([...readFileSync(join(SRC, "web/server.js"), "utf8").match(/const BROWSER_LIB = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

function imports(rel) {
  const text = readFileSync(join(SRC, rel), "utf8");
  return [...text.matchAll(/^import [^;]* from "([^"]+)";/gm)].map((m) => m[1]);
}

test("every module the browser needs through /lib/runner.js is served and Node-free", () => {
  const seen = new Set();
  const queue = ["runner.js"];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    assert.ok(served.has(rel), `${rel} is imported by the browser's runner graph but not in BROWSER_LIB`);
    for (const spec of imports(rel)) {
      assert.ok(!spec.startsWith("node:"), `${rel} imports ${spec}, which the browser cannot load`);
      if (spec.startsWith(".")) queue.push(normalize(join(dirname(rel), spec)).replace(/\\/g, "/"));
    }
  }
  assert.ok(seen.has("tasks/gen.js"), "runner.js reaches tasks/gen.js (seedFor)");
});
