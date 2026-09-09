// charts.js — the small pictures behind the scorecard and trend views: a radar of a model's
// capabilities, a sparkline of a capability over runs, a lineage graph. Pure functions from numbers
// to SVG strings (and one to text), free of Node and of the DOM, so the CLI writes the same picture
// to a file that the browser draws — the web server serves this file as /lib/charts.js.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const clampPct = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);

// The points of a regular polygon around (cx, cy): axis i at angle −90° + i · 360° / n, radius r.
export function radarPoints(n, r, cx, cy) {
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [num(cx + r * Math.cos(a)), num(cy + r * Math.sin(a))];
  });
}

// A radar: one axis per capability, one polygon per series. values are percentages (0–100) or
// null (drawn at the centre, no marker); `fill` draws the polygon filled, `dashed` outlines it —
// the run's own rates filled, the index-pooled ones dashed behind them.
export function radarSvg(axes, series, { size = 220, rings = [25, 50, 75, 100], labels = true, title = null } = {}) {
  const n = axes.length;
  if (!n) return "";
  const pad = labels ? 34 : 6;
  const cx = size / 2, cy = size / 2, R = size / 2 - pad;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" class="radar"${title ? ` aria-label="${esc(title)}"` : ""}>`];
  if (title) parts.push(`<title>${esc(title)}</title>`);
  for (const ring of rings) {
    const r = (R * ring) / 100;
    parts.push(`<polygon class="ring${ring === 100 ? " outer" : ""}" points="${(n >= 3 ? radarPoints(n, r, cx, cy) : [[cx - r, cy], [cx + r, cy]]).map((p) => p.join(",")).join(" ")}" fill="none" stroke="${ring === 100 ? "#bbb" : "#ddd"}" stroke-width="1"/>`);
  }
  for (const [x, y] of radarPoints(n, R, cx, cy)) parts.push(`<line class="spoke" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e4e4e4" stroke-width="1"/>`);
  for (const s of series) {
    const pts = axes.map((_, i) => {
      const v = clampPct(s.values?.[i]);
      const [x, y] = radarPoints(n, (R * (v ?? 0)) / 100, cx, cy)[i];
      return { x, y, v };
    });
    const style = `stroke="${esc(s.color ?? "currentColor")}"${s.fill ? ` fill="${esc(s.color ?? "currentColor")}" fill-opacity="0.18"` : ' fill="none"'}${s.dashed ? ' stroke-dasharray="4 3"' : ""}`;
    parts.push(`<polygon class="series" data-series="${esc(s.name ?? "")}" points="${pts.map((p) => `${p.x},${p.y}`).join(" ")}" ${style}/>`);
    if (!s.dashed) for (const [i, p] of pts.entries()) if (p.v !== null) parts.push(`<circle class="pt" cx="${p.x}" cy="${p.y}" r="2.5" fill="${esc(s.color ?? "currentColor")}"><title>${esc(`${s.name ? `${s.name} · ` : ""}${axes[i]}: ${Math.round(p.v)}%`)}</title></circle>`);
  }
  if (labels) {
    for (const [i, [x, y]] of radarPoints(n, R + 14, cx, cy).entries()) {
      const anchor = Math.abs(x - cx) < 1 ? "middle" : x < cx ? "end" : "start";
      parts.push(`<text class="label" x="${x}" y="${num(y + 3)}" text-anchor="${anchor}" font-size="10" font-family="sans-serif" fill="#666">${esc(axes[i])}</text>`);
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

// A sparkline: values are percentages (0–100) or null (a gap); the last value gets a dot.
export function sparklineSvg(values, { width = 64, height = 16, color = "currentColor", title = null } = {}) {
  const n = values.length;
  if (!n) return "";
  const x = (i) => num(n === 1 ? width / 2 : 1 + (i * (width - 2)) / (n - 1));
  const y = (v) => num(height - 1 - ((height - 2) * clampPct(v)) / 100);
  const runs = [];
  let cur = [];
  values.forEach((v, i) => { if (clampPct(v) === null) { if (cur.length) runs.push(cur); cur = []; } else cur.push(`${x(i)},${y(v)}`); });
  if (cur.length) runs.push(cur);
  const last = [...values.entries()].reverse().find(([, v]) => clampPct(v) !== null);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="spark" role="img"${title ? ` aria-label="${esc(title)}"` : ""}>`];
  if (title) parts.push(`<title>${esc(title)}</title>`);
  for (const r of runs) parts.push(r.length > 1 ? `<polyline points="${r.join(" ")}" fill="none" stroke="${esc(color)}" stroke-width="1.5"/>` : `<circle cx="${r[0].split(",")[0]}" cy="${r[0].split(",")[1]}" r="1.5" fill="${esc(color)}"/>`);
  if (last) parts.push(`<circle class="last" cx="${x(last[0])}" cy="${y(last[1])}" r="2" fill="${esc(color)}"/>`);
  parts.push("</svg>");
  return parts.join("");
}

// The same series as text, for a terminal: eight bars from 0 % to 100 %, "·" for a gap.
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
export function sparklineText(values) {
  return values.map((v) => { const p = clampPct(v); return p === null ? "·" : BARS[Math.min(7, Math.floor((p / 100) * 8))]; }).join("");
}

// The lineage graph's layout: one band per family (sorted by name), a node per entry. A node with
// a registered parent sits one column right of it; a node without one sits in column 0. Nodes that
// share a family and a column stack in step order. `stats` (per client id, optional) rides along on
// the node so the picture can show the latest rate.
export function lineageLayout(entries, { stats = {}, dx = 150, dy = 46, left = 16, top = 24 } = {}) {
  const list = Object.values(entries ?? {}).filter((e) => e && e.id);
  const byId = Object.fromEntries(list.map((e) => [e.id, e]));
  const depth = new Map();
  const depthOf = (e, seen = new Set()) => {
    if (depth.has(e.id)) return depth.get(e.id);
    if (seen.has(e.id)) return 0; // a cycle in the registry: break it rather than recurse forever
    seen.add(e.id);
    const d = e.parent && byId[e.parent] ? depthOf(byId[e.parent], seen) + 1 : 0;
    depth.set(e.id, d);
    return d;
  };
  for (const e of list) depthOf(e);
  const order = (a, b) => (a.step ?? -1) - (b.step ?? -1) || String(a.date ?? "").localeCompare(String(b.date ?? "")) || a.id.localeCompare(b.id);
  const families = [...new Set(list.map((e) => e.family ?? "(no family)"))].sort();
  const nodes = [];
  let row = 0;
  const bands = [];
  for (const family of families) {
    const members = list.filter((e) => (e.family ?? "(no family)") === family).sort(order);
    const columns = new Map();
    for (const e of members) { const d = depth.get(e.id); columns.set(d, [...(columns.get(d) ?? []), e]); }
    const height = Math.max(...[...columns.values()].map((c) => c.length));
    const y0 = row;
    for (const [d, col] of columns) col.forEach((e, i) => nodes.push({ id: e.id, family, checkpoint: e.checkpoint ?? e.id.split(":").pop(), step: e.step ?? null, parent: e.parent ?? null, column: d, x: left + d * dx, y: top + (y0 + i) * dy, stats: stats[e.id] ?? null }));
    bands.push({ family, y: top + y0 * dy, rows: height });
    row += height;
  }
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = nodes.filter((n) => n.parent && at[n.parent]).map((n) => ({ from: n.parent, to: n.id, x1: at[n.parent].x, y1: at[n.parent].y, x2: n.x, y2: n.y }));
  const width = left + (Math.max(0, ...nodes.map((n) => n.column)) + 1) * dx + 40;
  const height = top + Math.max(1, row) * dy;
  return { nodes, edges, bands, width, height };
}

// The lineage graph as SVG: bands labelled by family, nodes as a dot, the checkpoint name and the
// latest harness rate when the index has one, edges parent → child. `highlight` marks the run's
// own clients.
export function lineageSvg(layout, { highlight = [], title = "model lineage" } = {}) {
  const { nodes, edges, bands, width, height } = layout;
  if (!nodes.length) return "";
  const hot = new Set(highlight);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="lineage" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>`];
  for (const b of bands) parts.push(`<text class="family" x="4" y="${num(b.y - 12)}" font-size="10" font-family="sans-serif" fill="#888">${esc(b.family)}</text>`);
  for (const e of edges) parts.push(`<line class="edge" x1="${e.x1 + 5}" y1="${e.y1}" x2="${e.x2 - 5}" y2="${e.y2}" stroke="#bbb" stroke-width="1.2"/>`);
  for (const n of nodes) {
    const s = n.stats;
    const rate = s && Number.isFinite(s.harnessPct) ? `${Math.round(s.harnessPct)}%` : null;
    const flags = s ? (s.flags?.own ?? 0) + (s.flags?.parent ?? 0) : 0;
    const tip = [n.id, n.step !== null ? `step ${n.step}` : null, s ? `${s.trials} trial(s) in ${s.runs} run(s)${s.last ? `, last ${String(s.last).slice(0, 10)}` : ""}` : "no runs in the index", rate ? `harness ${rate} (${s.harnessCorrect}/${s.harnessN})` : null, flags ? `${flags} regression flag(s)` : null].filter(Boolean).join(" · ");
    parts.push(`<g class="node${hot.has(n.id) ? " hot" : ""}${flags ? " flagged" : ""}" data-id="${esc(n.id)}" font-family="sans-serif"><title>${esc(tip)}</title><circle cx="${n.x}" cy="${n.y}" r="${hot.has(n.id) ? 6 : 4.5}" fill="${flags ? "#c0392b" : hot.has(n.id) ? "#6d5bd0" : "#999"}"/><text class="name" x="${n.x + 10}" y="${num(n.y - 2)}" font-size="11" fill="#333">${esc(n.checkpoint)}</text><text class="rate" x="${n.x + 10}" y="${num(n.y + 11)}" font-size="10" fill="#777">${esc(rate ? `${rate}${flags ? ` ↓${flags}` : ""}` : "—")}</text></g>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

// The lineage graph as text, for `cli models --graph`: one line per node, indented by column.
export function lineageText(layout) {
  const out = [];
  for (const b of layout.bands) {
    out.push(b.family);
    for (const n of layout.nodes.filter((n) => n.family === b.family).sort((a, b2) => a.column - b2.column || a.y - b2.y)) {
      const s = n.stats;
      const rate = s && Number.isFinite(s.harnessPct) ? `harness ${Math.round(s.harnessPct)}% (${s.harnessCorrect}/${s.harnessN}) over ${s.runs} run(s)` : "no runs";
      out.push(`${"  ".repeat(n.column + 1)}${n.column ? "└ " : ""}${n.id}${n.step !== null ? ` · step ${n.step}` : ""} — ${rate}${s?.flags && (s.flags.own || s.flags.parent) ? ` · ↓ ${(s.flags.own ?? 0) + (s.flags.parent ?? 0)} flag(s)` : ""}`);
    }
  }
  return out.join("\n");
}
