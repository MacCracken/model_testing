import { test } from "node:test";
import assert from "node:assert/strict";
import { radarPoints, radarSvg, sparklineSvg, sparklineText, lineageLayout, lineageSvg, lineageText } from "../src/charts.js";

test("radar: axis 0 points up, the others follow clockwise; a value sits at its share of the radius", () => {
  assert.deepEqual(radarPoints(4, 10, 50, 50), [[50, 40], [60, 50], [50, 60], [40, 50]]);
  const svg = radarSvg(["a", "b", "c", "d"], [{ name: "x", values: [100, 50, 0, null], color: "red", fill: true }], { size: 100, labels: false });
  assert.equal((svg.match(/class="ring/g) ?? []).length, 4, "four rings");
  assert.match(svg, /class="ring outer" points="50,6 94,50 50,94 6,50"/, "the outer ring is the full radius (size − padding)");
  assert.match(svg, /class="series" data-series="x" points="50,6 72,50 50,50 50,50" stroke="red" fill="red"/, "100 % at the top, 50 % half way right, 0 and null at the centre");
  assert.equal((svg.match(/class="pt"/g) ?? []).length, 3, "no marker for a null value");
  assert.match(svg, /<title>x · a: 100%<\/title>/);
  const dashed = radarSvg(["a", "b", "c"], [{ name: "pooled", values: [50, 50, 50], dashed: true }], { size: 120, title: "t" });
  assert.match(dashed, /stroke-dasharray="4 3"/);
  assert.doesNotMatch(dashed, /class="pt"/, "a dashed outline has no markers");
  assert.match(dashed, /<text class="label"[^>]*>a<\/text>/, "labels on by default");
  assert.match(dashed, /aria-label="t"/);
  assert.equal(radarSvg([], []), "");
  assert.match(radarSvg(["x&y"], [{ values: [10] }], { size: 50 }), /x&amp;y/, "labels are escaped");
});

test("sparkline: a polyline per contiguous run, a dot for a lone value, the last value marked; text bars from ▁ to █ with · for a gap", () => {
  const svg = sparklineSvg([0, 50, null, 100], { width: 40, height: 10 });
  assert.match(svg, /<polyline points="1,9 13.67,5"/, "the first run of two points");
  assert.match(svg, /<circle cx="39" cy="1" r="1.5"/, "the lone value after the gap is a dot");
  assert.match(svg, /class="last" cx="39" cy="1"/, "the last value gets the marker");
  assert.match(sparklineSvg([50], { width: 40, height: 10 }), /cx="20"/, "a single value sits in the middle");
  assert.equal(sparklineSvg([]), "");
  assert.equal(sparklineText([0, 10, 50, null, 99, 100]), "▁▁▅·██");
  assert.equal(sparklineText([]), "");
});

const entries = {
  "v:a": { id: "v:a", family: "mine", checkpoint: "a", step: 100, parent: null },
  "v:b": { id: "v:b", family: "mine", checkpoint: "b", step: 200, parent: "v:a" },
  "v:c": { id: "v:c", family: "mine", checkpoint: "c", step: 300, parent: "v:b" },
  "v:d": { id: "v:d", family: "mine", checkpoint: "d", step: 150, parent: null },
  "l:e": { id: "l:e", family: "other", checkpoint: "e", step: null, parent: null },
  "l:z": { id: "l:z", family: "other", checkpoint: "z", step: null, parent: "l:missing" },
};

test("lineage layout: a column per parent hop, parentless nodes stacked in step order, one band per family, edges only to registered parents", () => {
  const stats = { "v:c": { trials: 8, runs: 2, last: "2026-09-09T10:00:00Z", harnessN: 4, harnessCorrect: 3, harnessPct: 75, flags: { own: 1, parent: 0 } } };
  const L = lineageLayout(entries, { stats });
  const at = Object.fromEntries(L.nodes.map((n) => [n.id, n]));
  assert.deepEqual([at["v:a"].column, at["v:b"].column, at["v:c"].column, at["v:d"].column], [0, 1, 2, 0]);
  assert.ok(at["v:a"].x < at["v:b"].x && at["v:b"].x < at["v:c"].x, "a chain runs left to right");
  assert.equal(at["v:a"].y, at["v:b"].y, "a child sits on its parent's row");
  assert.ok(at["v:d"].y > at["v:a"].y, "a second root in the same column stacks below (step 150 after 100)");
  assert.deepEqual(L.bands.map((b) => b.family), ["mine", "other"]);
  assert.ok(at["l:e"].y > at["v:d"].y, "the second family sits below the first band");
  assert.deepEqual(L.edges.map((e) => `${e.from}>${e.to}`).sort(), ["v:a>v:b", "v:b>v:c"], "an edge to a parent that is not registered is not drawn");
  assert.equal(at["l:z"].column, 0, "an unregistered parent leaves the node at column 0");
  assert.equal(at["v:c"].stats.harnessPct, 75);
  assert.ok(L.width > at["v:c"].x && L.height > at["l:z"].y);
  const svg = lineageSvg(L, { highlight: ["v:b"] });
  assert.match(svg, /<g class="node hot" data-id="v:b"/);
  assert.match(svg, /<g class="node flagged" data-id="v:c"[^>]*><title>v:c · step 300 · 8 trial\(s\) in 2 run\(s\), last 2026-09-09 · harness 75% \(3\/4\) · 1 regression flag\(s\)<\/title>/);
  assert.match(svg, /class="rate"[^>]*>75% ↓1</);
  assert.match(svg, /class="rate"[^>]*>—</, "a checkpoint without runs shows a dash");
  assert.equal((svg.match(/class="edge"/g) ?? []).length, 2);
  assert.equal(lineageSvg(lineageLayout({})), "");
  const text = lineageText(L);
  assert.match(text, /^mine\n  v:a · step 100 — no runs\n  v:d · step 150 — no runs\n    └ v:b · step 200 — no runs\n      └ v:c · step 300 — harness 75% \(3\/4\) over 2 run\(s\) · ↓ 1 flag\(s\)\nother\n/);
});

test("lineage layout: a cycle in the registry does not recurse forever", () => {
  const L = lineageLayout({ "x:1": { id: "x:1", family: "f", parent: "x:2" }, "x:2": { id: "x:2", family: "f", parent: "x:1" } });
  assert.equal(L.nodes.length, 2);
});
