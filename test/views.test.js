// The scorecard and trend views ([49]): a family across its checkpoints, the regressions report
// and its delivery to a file or a webhook, the per-checkpoint stats behind the lineage graph, and
// a @format variant resolving to its checkpoint.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "hb-views-"));
process.env.LINEAGE_FILE = join(dir, "lineage.json");
const { writeFileSync } = await import("node:fs");
writeFileSync(process.env.LINEAGE_FILE, JSON.stringify({ "v:p": { family: "mine", checkpoint: "p", step: 100 }, "v:c": { family: "mine", checkpoint: "c", step: 200, parent: "v:p" } }));
const { lineageFor, familyMembers, loadLineage } = await import("../src/lineage.js");
const { familyScorecard, regressionsReport, lineageStats, seriesFor } = await import("../src/trends.js");
const { formatRegressions, writeReport, postReport, describeFlag } = await import("../src/notify.js");
const { sparklineText } = await import("../src/charts.js");

const caps = { health: ["tool-use"], reason: ["deduction"], chain: ["tool-use", "multi-step"] };
// rows(client, runId, createdAt, task, mode, correct-pattern)
const rows = (client, runId, at, task, mode, pattern) => [...pattern].map((ch, i) => ({ runId, createdAt: at, task, mode, client, index: i + 1, correct: ch === "1" }));

test("a family scorecard lines the checkpoints up per capability, in registry order, and pools the whole family", () => {
  const byClient = {
    "v:p": [...rows("v:p", "r1", "2026-09-01", "health", "harness", "1111"), ...rows("v:p", "r1", "2026-09-01", "reason", "harness", "1100"), ...rows("v:p", "r1", "2026-09-01", "health", "noHarness", "0000")],
    "v:c": [...rows("v:c", "r2", "2026-09-02", "health", "harness", "1100"), ...rows("v:c", "r2", "2026-09-02", "chain", "harness", "1000")],
  };
  const card = familyScorecard(byClient, caps, familyMembers("mine"));
  assert.deepEqual(card.members.map((m) => m.id), ["v:p", "v:c"]);
  assert.deepEqual(card.capabilities, ["deduction", "multi-step", "tool-use"]);
  assert.equal(card.members[0].byCapability["tool-use"].correctPct, 100);
  assert.equal(card.members[1].byCapability["tool-use"].correct, 3, "chain counts as tool-use too");
  assert.equal(card.members[1].byCapability["tool-use"].runs, 8);
  assert.equal(card.members[1].byCapability.deduction, undefined, "the child never ran a deduction task");
  assert.equal(card.members[0].trials, 12, "trials count every mode");
  assert.equal(card.pooled["tool-use"].byMode.harness.correct, 7);
  assert.equal(card.trials, 20);
  assert.equal(sparklineText(card.members.map((m) => m.byCapability["tool-use"]?.correctPct ?? null)), "█▄");
  assert.equal(familyScorecard(byClient, caps, familyMembers("mine"), { mode: "noHarness" }).members[1].byCapability["tool-use"], undefined);
});

// A client whose latest run fell from 8/8 to 0/8, a checkpoint at 0/8 whose parent stands at 8/8,
// and a client with one run only (nothing to compare).
const all = [
  ...rows("x", "r1", "2026-09-01", "health", "harness", "11111111"),
  ...rows("x", "r2", "2026-09-05", "health", "harness", "00000000"),
  ...rows("v:p", "r3", "2026-09-03", "health", "harness", "11111111"),
  ...rows("v:c", "r4", "2026-09-06", "health", "harness", "00000000"),
  ...rows("solo", "r5", "2026-09-06", "health", "harness", "1010"),
];

test("the regressions report lists every flag flat, sorted by the drop, with the kind and the tasks behind it", () => {
  const rep = regressionsReport(all, caps, loadLineage().entries, { now: new Date("2026-09-10T00:00:00Z") });
  assert.equal(rep.count, 2);
  assert.equal(rep.generatedAt, "2026-09-10T00:00:00.000Z");
  assert.deepEqual(rep.flags.map((f) => [f.kind, f.client, f.capability, f.mode, f.dropPp]), [["own", "x", "tool-use", "harness", 100], ["parent", "v:c", "tool-use", "harness", 100]]);
  const own = rep.flags[0];
  assert.deepEqual([own.from.correct, own.from.runs, own.to.correct, own.to.runs, own.earlierRuns, own.latestRuns, own.latestAt], [8, 8, 0, 8, 1, ["r2"], "2026-09-05"]);
  assert.deepEqual(own.perTask, [{ task: "health", n: 8, earlier: 8, later: 0 }]);
  assert.equal(rep.flags[1].parent, "v:p");
  assert.deepEqual(rep.clients.map((c) => [c.client, c.runs, c.own.flags.length, c.vsParent?.flags.length ?? null]), [["solo", 1, 0, null], ["v:c", 1, 0, 1], ["v:p", 1, 0, null], ["x", 2, 1, null]]);
  assert.equal(regressionsReport(all, caps, loadLineage().entries, { client: "x" }).count, 1);
  assert.equal(regressionsReport(all, caps, {}, { client: "v:c" }).count, 0, "without the registry there is no parent to compare");
  assert.match(describeFlag(own), /^x · tool-use · harness: 100% \(8\/8\) over 1 earlier run\(s\) → 0% \(0\/8\) in r2 \(2026-09-05; −100pp, p=0\.000\) — health 8→0\/8$/);
  assert.match(describeFlag(rep.flags[1]), /^v:c · tool-use · harness: 0% \(0\/8\) against parent v:p at 100% \(8\/8\)/);
});

test("the report is delivered as text, JSON or Markdown, to a file, or to a webhook", async () => {
  const rep = regressionsReport(all, caps, loadLineage().entries, { now: new Date("2026-09-10T00:00:00Z") });
  assert.match(formatRegressions(rep, "text"), /^2 regression flag\(s\) over 4 client\(s\) — 2026-09-10T00:00:00.000Z\nx · tool-use/);
  const md = formatRegressions(rep, "md");
  assert.match(md, /^## Regressions\n/);
  assert.match(md, /\| x \| tool-use \| harness \| 100% \(8\/8\) \| 0% \(0\/8\) \| −100pp \| 0\.000 \| health 8→0\/8 \|/);
  assert.match(md, /\| v:c \| tool-use \| harness \| 100% \(8\/8\) \(parent v:p\) \|/);
  assert.equal(JSON.parse(formatRegressions(rep, "json")).count, 2);
  const none = regressionsReport(all.filter((r) => r.client === "solo"), caps, {});
  assert.match(formatRegressions(none, "text"), /no regressions/);
  assert.match(formatRegressions(none, "md"), /No capability's latest band/);
  const out = join(dir, "nested", "regressions.json");
  writeReport(out, rep);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).flags.length, 2, "JSON by default, directories created");
  const mdFile = join(dir, "summary.md");
  writeReport(mdFile, rep, { format: "md" });
  assert.match(readFileSync(mdFile, "utf8"), /^## Regressions/);
  assert.ok(existsSync(mdFile));

  // A webhook: the JSON lands as the body.
  let received = null;
  const server = createServer((req, res) => { let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => { received = { headers: req.headers, body: JSON.parse(body) }; res.writeHead(202); res.end(); }); });
  await new Promise((r) => server.listen(0, r));
  after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const r = await postReport(url, rep, { headers: { "x-token": "t" } });
  assert.deepEqual(r, { ok: true, status: 202 });
  assert.equal(received.body.count, 2);
  assert.equal(received.headers["content-type"], "application/json");
  assert.equal(received.headers["x-token"], "t");
  const bad = await postReport("http://127.0.0.1:1/nowhere", rep, { fetchImpl: async () => { throw new Error("refused"); } });
  assert.deepEqual(bad, { ok: false, status: 0, error: "refused" });
  const http500 = await postReport(url, rep, { fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(http500, { ok: false, status: 500 });
});

test("lineage stats: per registered checkpoint, trials, runs, the pooled harness rate and the flag counts; nothing for a checkpoint without runs", () => {
  const stats = lineageStats(all, caps, loadLineage().entries);
  assert.deepEqual(Object.keys(stats).sort(), ["v:c", "v:p"]);
  assert.deepEqual(stats["v:c"], { trials: 8, runs: 1, last: "2026-09-06", harnessN: 8, harnessCorrect: 0, harnessPct: 0, flags: { own: 0, parent: 1 } });
  assert.equal(stats["v:p"].harnessPct, 100);
  assert.deepEqual(stats["v:p"].flags, { own: 0, parent: 0 });
});

test("the series behind a sparkline: one point per run in date order, and a @format variant is still its checkpoint", () => {
  const s = seriesFor(all.filter((r) => r.client === "x"), caps, { mode: "harness" });
  assert.deepEqual(s.map((p) => [p.runId, p.byCapability["tool-use"].harness.correctPct]), [["r1", 100], ["r2", 0]]);
  assert.equal(sparklineText(s.map((p) => p.byCapability["tool-use"]?.harness?.correctPct ?? null)), "█▁");
  assert.equal(lineageFor("v:c@format:work").checkpoint, "c");
  assert.equal(lineageFor("v:c@stress:flaky").checkpoint, "c");
});
