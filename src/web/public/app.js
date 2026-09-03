// app.js — launch benchmark runs and review the results.
//
// Summaries come from the runner itself (served as /lib/runner.js), so a run in flight, a run
// loaded from history, and the CLI all report the same numbers through the same code.

import { summarize, deltaFor, describeSignificance, isStructuredMode, DEFAULT_MODES } from "/lib/runner.js";

// ---- tiny DOM + format helpers -------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "style" && value && typeof value === "object") {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith("--")) node.style.setProperty(prop, v);
        else node.style[prop] = v;
      }
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid?.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const fmtPct = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtInt = (n) => Number(n || 0).toLocaleString();
const signedPp = (pp, digits) => `${pp > 0 ? "+" : ""}${digits === 0 ? Math.round(pp) : Number.isInteger(pp) ? pp : pp.toFixed(digits)}pp`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const MODE_ORDER = ["noHarness", "harness", "schemaOnly", "toolOnly"];
const MODE_LABEL = {
  noHarness: "no harness",
  harness: "harness",
  schemaOnly: "schema only",
  toolOnly: "tools only",
};
const MODE_DESC = {
  noHarness: "free-form prompt — no tools, no schema (the baseline)",
  harness: "tools + output schema + structured prompt (the full bundle)",
  schemaOnly: "output schema only, no tools — isolates the 'ask for JSON' axis",
  toolOnly: "tools only, free-form answer — isolates the 'give it tools' axis",
};
// Modes whose spec carries tools, i.e. where a tool-call count means something.
const TOOL_MODES = new Set(["harness", "toolOnly"]);

const state = {
  meta: null,
  tasks: new Set(),
  modes: new Set(DEFAULT_MODES),
  clients: new Set(),
  run: null,
  stream: null,
  filter: "all",     // all | failures | harness
  detail: -1,        // index into filteredRows(), -1 = closed
};

// ---- theme -----------------------------------------------------------------------------------
// Three states: light / dark pin a choice via data-theme on <html>; system removes it so the
// prefers-color-scheme media query decides. Stored per browser; index.html applies the stored
// choice before first paint so nothing flashes.

const THEME_KEY = "hb-theme";

function readTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = "";
  }
  for (const b of document.querySelectorAll("[data-theme-choice]")) {
    b.setAttribute("aria-pressed", String(b.dataset.themeChoice === theme));
  }
}

function setTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* per-viewer convenience only */ }
  applyTheme(theme);
}

// ---- boot ------------------------------------------------------------------------------------

init().catch((err) => showLaunchError(err.message));

async function init() {
  for (const b of document.querySelectorAll("[data-theme-choice]")) {
    b.addEventListener("click", () => setTheme(b.dataset.themeChoice));
  }
  applyTheme(readTheme());

  state.meta = await getJSON("/api/meta");
  renderStatus();
  renderTasks();
  renderModes();
  renderClients();
  await refreshHistory();
  wire();
  updatePlan();
  setInterval(pollStatus, 20_000);
}

function wire() {
  $("#run").addEventListener("click", launch);
  $("#cancel").addEventListener("click", cancel);
  $("#count").addEventListener("input", updatePlan);
  $("#history").addEventListener("change", (e) => { if (e.target.value) openRun(e.target.value); });
  $("#delete-run").addEventListener("click", removeRun);
  $("#detail-close").addEventListener("click", closeDetail);
  $("#detail-prev").addEventListener("click", () => stepDetail(-1));
  $("#detail-next").addEventListener("click", () => stepDetail(1));
  $("#scrim").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => {
    if ($("#detail").hidden) return;
    if (e.key === "Escape") closeDetail();
    else if (e.key === "ArrowLeft") stepDetail(-1);
    else if (e.key === "ArrowRight") stepDetail(1);
  });
  for (const btn of document.querySelectorAll("[data-all]")) {
    btn.addEventListener("click", () => selectAll(btn.dataset.all));
  }
}

// ---- header status ---------------------------------------------------------------------------

function renderStatus() {
  renderSUT(state.meta.sut);
  const local = state.meta.providers.find((p) => p.name === "local");
  const node = $("#local");
  const live = !!local?.live;
  node.className = `status ${live ? "up" : "down"}`;
  node.querySelector(".status-text").textContent = live ? `ollama · ${plural(local.models.length, "model")} live` : "ollama · offline";
  node.title = live ? local.baseUrl : "Ollama is not reachable, so local models are disabled";
}

function renderSUT(sut) {
  const node = $("#sut");
  node.className = `status ${sut.up ? "up" : "down"}`;
  let host = sut.url;
  try { host = new URL(sut.url).host; } catch { /* keep raw */ }
  node.querySelector(".status-text").textContent = sut.up ? `webserver · ${host}` : "webserver · down";
  node.title = sut.up ? "Harness tools call this server" : `${sut.error ?? "unreachable"} — start it: cd webserver && npm start`;
}

// Re-probe both the system under test and the local daemon. Rebuild the model list only when the
// set of local models actually changed, so selections survive the poll.
async function pollStatus() {
  try {
    const meta = await getJSON("/api/meta");
    const before = JSON.stringify(state.meta.providers.map((p) => [p.name, p.hasKey, p.live, p.models.map((m) => m.id)]));
    const after = JSON.stringify(meta.providers.map((p) => [p.name, p.hasKey, p.live, p.models.map((m) => m.id)]));
    state.meta.providers = meta.providers;
    state.meta.sut = meta.sut;
    renderStatus();
    if (before !== after) { renderClients(); updatePlan(); }
  } catch { /* transient */ }
}

// ---- recipe ------------------------------------------------------------------------------------

function chip({ label, on, title, disabled, onToggle }) {
  const b = el("button", { type: "button", className: "chip", title: title ?? "", disabled: !!disabled });
  b.setAttribute("aria-pressed", String(!!on));
  b.append(label);
  b.addEventListener("click", () => {
    const next = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(next));
    onToggle(next);
  });
  return b;
}

function taskMeta(name) {
  return state.meta.tasks.find((t) => t.name === name);
}

function renderTasks() {
  const box = $("#tasks");
  box.replaceChildren();
  for (const t of state.meta.tasks) {
    state.tasks.add(t.name);
    box.append(chip({
      label: t.name,
      on: true,
      title: `${t.description}\nmodes: ${t.modes.map((m) => MODE_LABEL[m] ?? m).join(", ")}${t.tools.length ? `\ntools: ${t.tools.join(", ")}` : ""}`,
      onToggle: (on) => { on ? state.tasks.add(t.name) : state.tasks.delete(t.name); renderModes(); updatePlan(); },
    }));
  }
}

// A mode is offered when at least one selected task declares a spec for it.
function modeSupported(mode) {
  return [...state.tasks].some((name) => taskMeta(name)?.modes.includes(mode));
}

function renderModes() {
  const box = $("#modes");
  box.replaceChildren();
  for (const m of state.meta.modes) {
    const supported = modeSupported(m);
    box.append(chip({
      label: MODE_LABEL[m] ?? m,
      on: state.modes.has(m),
      disabled: !supported,
      title: supported ? MODE_DESC[m] : `${MODE_DESC[m]}\n— no selected task declares this mode`,
      onToggle: (on) => { on ? state.modes.add(m) : state.modes.delete(m); updatePlan(); },
    }));
  }
}

function renderClients() {
  const box = $("#clients");
  box.replaceChildren();
  for (const p of state.meta.providers) {
    const usable = p.hasKey && p.live !== false;
    const tag = !p.needsKey
      ? (p.live ? `live · ${p.models.length}` : "offline")
      : (p.hasKey ? "key set" : `${p.name.toUpperCase()}_API_KEY missing`);
    const group = el("div", { className: `provider${usable ? "" : " unusable"}`, dataset: { provider: p.name } },
      el("div", { className: "provider-head" }, el("span", {}, p.name), el("span", { className: `tag ${usable ? "ok" : "no"}` }, tag)));
    for (const m of p.models) {
      const input = el("input", { type: "checkbox", disabled: !usable, value: m.client, checked: state.clients.has(m.client) });
      input.addEventListener("change", () => { input.checked ? state.clients.add(m.client) : state.clients.delete(m.client); updatePlan(); });
      group.append(el("label", { className: "model", title: m.label !== m.id ? m.label : "" }, input, el("i", { className: "box" }), el("span", {}, m.id)));
    }
    box.append(group);
  }
}

function selectAll(kind) {
  if (kind === "tasks") {
    const chips = [...$("#tasks").querySelectorAll(".chip")];
    const turnOn = chips.some((c) => c.getAttribute("aria-pressed") !== "true");
    for (const c of chips) if ((c.getAttribute("aria-pressed") === "true") !== turnOn) c.click();
    return;
  }
  const boxes = [...$("#clients").querySelectorAll("input:not(:disabled)")];
  const turnOn = boxes.some((b) => !b.checked);
  for (const b of boxes) {
    if (b.checked !== turnOn) { b.checked = turnOn; b.dispatchEvent(new Event("change")); }
  }
}

// What the current recipe would actually run: (task, mode) pairs the task declares, × models × count.
function plan() {
  const count = Math.max(1, Math.min(20, Number($("#count").value) || 1));
  const modes = [...state.modes].filter(modeSupported);
  let cells = 0;
  const skipped = [];
  for (const name of state.tasks) {
    const t = taskMeta(name);
    for (const m of modes) {
      if (t?.modes.includes(m)) cells += state.clients.size;
      else skipped.push(`${name}/${MODE_LABEL[m] ?? m}`);
    }
  }
  return { count, modes, total: cells * count, skipped };
}

function updatePlan() {
  const p = plan();
  const busy = state.run?.status === "running";
  const node = $("#plan");
  node.replaceChildren();
  if (!p.total) {
    node.append("Select at least one task, a mode it declares, and one model.");
  } else {
    node.append(
      `${plural(state.tasks.size, "task")} × ${plural(p.modes.length, "mode")} × ${plural(state.clients.size, "model")} × ${p.count} = `,
      el("b", {}, plural(p.total, "trial")),
    );
    if (p.skipped.length) node.append(el("span", { className: "hint" }, `skips ${p.skipped.join(", ")} — not declared by that task`));
  }
  $("#run").disabled = !p.total || busy;
  $("#mode-hint").textContent = state.modes.has("noHarness") && state.modes.has("harness")
    ? "no harness + harness → delta"
    : "select no harness and harness to get a delta";
}

function showLaunchError(msg) {
  const node = $("#launch-error");
  node.textContent = msg;
  node.hidden = !msg;
}

// ---- run lifecycle ---------------------------------------------------------------------------

async function launch() {
  showLaunchError("");
  const body = {
    tasks: [...state.tasks],
    modes: [...state.modes],
    clients: [...state.clients],
    count: plan().count,
  };
  try {
    const { run } = await postJSON("/api/runs", body);
    setBusy(true);
    openRun(run.id);
  } catch (err) {
    showLaunchError(err.message);
  }
}

async function cancel() {
  if (!state.run) return;
  try { await postJSON(`/api/runs/${state.run.id}/cancel`, {}); } catch (err) { showLaunchError(err.message); }
}

function setBusy(busy) {
  $("#cancel").hidden = !busy;
  $("#run").disabled = busy || !plan().total;
}

async function openRun(id) {
  state.stream?.close();
  state.stream = null;
  $("#history").value = id;

  const stream = new EventSource(`/api/runs/${id}/events`);
  state.stream = stream;

  stream.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snapshot") {
      state.run = msg.run;
      state.filter = "all";
      closeDetail();
      setBusy(msg.run.status === "running");
      renderReport();
    } else if (msg.type === "trial") {
      state.run.rows.push(msg.result);
      state.run.progress = { completed: msg.completed, total: msg.total };
      renderReport();
    } else if (msg.type === "done") {
      Object.assign(state.run, msg.run);
      setBusy(false);
      renderReport();
      refreshHistory();
      stream.close();
    }
  };
  stream.onerror = () => { stream.close(); setBusy(false); };
}

async function removeRun() {
  if (!state.run || state.run.status === "running") return;
  if (!confirm(`Delete run ${state.run.id}? This cannot be undone.`)) return;
  await fetch(`/api/runs/${state.run.id}`, { method: "DELETE" });
  state.stream?.close();
  state.run = null;
  closeDetail();
  $("#report").hidden = true;
  $("#empty").hidden = false;
  $("#history").value = "";
  await refreshHistory();
}

async function refreshHistory() {
  const { runs } = await getJSON("/api/runs");
  const sel = $("#history");
  const current = state.run?.id ?? sel.value;
  sel.replaceChildren(el("option", { value: "" }, runs.length ? "past runs…" : "no past runs"));
  for (const r of runs) {
    const when = new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const tasks = r.config?.tasks ?? [];
    const clients = r.config?.clients ?? [];
    const label = `${when} · ${tasks.join(" ") || "?"} · ${plural(clients.length, "model")} · ${plural(r.rowCount ?? 0, "trial")}${r.status === "done" ? "" : ` · ${r.status ?? "?"}`}`;
    sel.append(el("option", { value: r.id }, label));
  }
  if (current) sel.value = current;
}

// ---- report ------------------------------------------------------------------------------------

function renderReport() {
  const run = state.run;
  if (!run) return;
  $("#empty").hidden = true;
  $("#report").hidden = false;
  $("#delete-run").hidden = run.status === "running";

  const warn = $("#warnings");
  warn.hidden = !run.warnings?.length;
  warn.replaceChildren(...(run.warnings ?? []).map((w) => el("div", {}, w)));

  const s = summarize(run.rows);
  renderHeadline(s);
  renderLive();
  renderMatrix(s);
  renderTrials();
}

function renderHeadline(s) {
  const run = state.run;
  const box = $("#headline");
  box.replaceChildren();

  const done = run.rows.length;
  const total = run.progress?.total ?? done;
  const progress = run.status === "running" ? `${done} of ${total} trials · running` : `${plural(done, "trial")} · ${run.status}`;

  const d = s.delta.overall;
  const col = el("div", { className: "hcol" }, el("div", { className: "eyebrow" }, "Harness delta"));
  if (d) {
    col.append(
      el("div", { className: `big ${d.deltaPp > 0 ? "up" : d.deltaPp < 0 ? "down" : "flat"}` },
        `${d.deltaPp > 0 ? "+" : ""}${Number.isInteger(d.deltaPp) ? d.deltaPp : d.deltaPp.toFixed(1)}`, el("small", {}, "pp")),
      el("div", { className: "sub" }, `${fmtPct(d.noHarnessPct)} → ${fmtPct(d.harnessPct)} correct · ${progress}`),
      el("div", { className: `sig${d.significant ? " yes" : ""}` }, describeSignificance(d)),
    );
  } else {
    col.append(
      el("div", { className: "big flat" }, "—"),
      el("div", { className: "sub" }, progress),
      el("div", { className: "sig" }, describeSignificance(null)),
    );
  }
  box.append(col);

  const modeCols = MODE_ORDER.filter((m) => s.byMode[m]);
  for (const m of modeCols) {
    const st = s.byMode[m];
    box.append(el("div", { className: "hcol" },
      el("div", { className: "eyebrow" }, MODE_LABEL[m]),
      el("div", { className: "num" }, fmtPct(st.correctPct)),
      el("div", { className: "sub" }, `${st.correct}/${st.runs} · ${fmtMs(st.avgLatencyMs)} avg`),
      el("div", { className: "bar" }, el("i", { className: m === "noHarness" ? "grey" : "", style: { width: `${st.correctPct}%` } })),
    ));
  }

  // Hygiene tracks the full bundle; fall back to whichever tool/schema mode ran.
  const h = s.byMode.harness ?? s.byMode.toolOnly ?? s.byMode.schemaOnly;
  const harnessTokens = ["harness", "schemaOnly", "toolOnly"].reduce((a, m) => a + (s.byMode[m]?.totalTokens ?? 0), 0);
  const freeTokens = s.byMode.noHarness?.totalTokens ?? 0;
  const kv = (k, v) => el("div", { className: "kv" }, el("span", {}, k), el("span", {}, v));
  box.append(el("div", { className: "hcol hygiene" },
    el("div", { className: "eyebrow" }, "Harness hygiene"),
    kv("tool use", h ? fmtPct(h.toolUsePct) : "—"),
    kv("schema valid", h ? fmtPct(h.schemaValidPct) : "—"),
    kv("errors", h ? fmtPct(h.errorPct) : "—"),
    kv("tokens", fmtInt(harnessTokens + freeTokens)),
    kv("harness / free", `${fmtInt(harnessTokens)} / ${fmtInt(freeTokens)}`),
  ));

  box.style.gridTemplateColumns = `1.35fr repeat(${modeCols.length}, 1fr) 1.15fr`;
}

// One cell per planned trial, in the runner's execution order (task → mode → client → trial), so
// the grid fills in left to right and the first empty cell is the one running now.
function renderLive() {
  const run = state.run;
  const box = $("#live");
  box.replaceChildren();

  const { tasks = [], modes = [], clients = [], count = 1 } = run.config ?? {};
  const declared = (task, mode) => taskMeta(task)?.modes.includes(mode) ?? true;
  const byKey = new Map(run.rows.map((r) => [`${r.task}|${r.mode}|${r.client}|${r.index}`, r]));

  const order = [];
  for (const task of tasks) {
    for (const mode of modes) {
      if (!declared(task, mode)) continue;
      for (const client of clients) {
        for (let i = 1; i <= count; i++) {
          order.push({ task, mode, client, index: i, row: byKey.get(`${task}|${mode}|${client}|${i}`) });
        }
      }
    }
  }
  // Rows that the plan does not account for (older runs) still deserve a cell.
  for (const r of run.rows) {
    if (!order.some((c) => c.row === r)) order.push({ task: r.task, mode: r.mode, client: r.client, index: r.index, row: r });
  }

  const running = run.status === "running" ? order.find((c) => !c.row) : null;
  $("#live-title").textContent = run.status === "running" ? `Live · ${run.rows.length} / ${order.length}` : `Trials · ${run.rows.length}`;

  for (const mode of MODE_ORDER.filter((m) => order.some((c) => c.mode === m))) {
    const cells = order.filter((c) => c.mode === mode);
    const grid = el("div", { className: "cells", style: { "--n": String(cells.length) } });
    for (const c of cells) {
      const cls = c.row ? (c.row.correct ? "pass" : "fail") : c === running ? "running" : "queued";
      const status = c.row ? `${c.row.correct ? "pass" : "fail"} · ${c.row.error ?? c.row.reason}` : c === running ? "running" : "queued";
      const cell = el("span", { className: `cell ${cls}`, title: `${c.task} · ${MODE_LABEL[c.mode] ?? c.mode} · ${c.client} #${c.index} · ${status}` });
      if (c.row) cell.addEventListener("click", () => openDetailFor(c.row));
      grid.append(cell);
    }
    box.append(el("div", { className: "live-row" }, el("div", { className: "live-label" }, MODE_LABEL[mode] ?? mode), grid));
  }
}

function renderMatrix(s) {
  const box = $("#matrix");
  box.replaceChildren();
  const present = MODE_ORDER.filter((m) => s.modes.includes(m));

  $("#matrix-legend").replaceChildren(...present.map((m) => el("span", {}, el("i", { className: `key ${m}` }), MODE_LABEL[m])));

  const head = (text, extra = "") => el("div", { className: `mh ${extra}` }, text);
  box.append(head("task"), head("model"), el("div", { className: "mh scale" }, el("span", {}, "0%"), el("span", {}, "50%"), el("span", {}, "100%")), head("delta", "right"));

  const cellOf = (task, client, mode) => s.cells.find((c) => c.task === task && c.client === client && c.mode === mode);

  for (const task of s.tasks) {
    for (const client of s.clients) {
      const cells = Object.fromEntries(present.map((m) => [m, cellOf(task, client, m)]));
      if (!present.some((m) => cells[m])) continue;
      const a = cells.noHarness;
      const b = cells.harness;
      const d = deltaFor(state.run.rows.filter((r) => r.task === task && r.client === client));

      const track = el("div", { className: "dumbbell" }, el("i", { className: "track" }));
      if (a && b) {
        track.append(el("i", { className: "span", style: { left: `${Math.min(a.correctPct, b.correctPct)}%`, width: `${Math.abs(b.correctPct - a.correctPct)}%` } }));
      }
      for (const m of present) {
        const c = cells[m];
        if (!c) continue;
        track.append(el("span", { className: `dot ${m}`, style: { left: `${c.correctPct}%` }, title: `${MODE_LABEL[m]} · ${c.correct}/${c.runs} correct · ${fmtMs(c.avgLatencyMs)} avg` }));
      }

      const delta = d
        ? el("div", { className: `mc right ${d.deltaPp > 0 ? "up" : d.deltaPp < 0 ? "down" : "muted"}`, title: describeSignificance(d) }, signedPp(d.deltaPp, 0))
        : el("div", { className: "mc right faint" }, "—");

      box.append(el("div", { className: "mc" }, task), el("div", { className: "mc muted ellipsis", title: client }, client), el("div", { className: "mc" }, track), delta);
    }
  }
}

// ---- trial log -----------------------------------------------------------------------------

function filteredRows() {
  const all = state.run?.rows ?? [];
  if (state.filter === "failures") return all.filter((r) => !r.correct);
  if (state.filter === "harness") return all.filter((r) => r.mode === "harness");
  return all;
}

function renderTrials() {
  const all = state.run?.rows ?? [];
  const rows = filteredRows();

  const filters = $("#filters");
  filters.replaceChildren();
  const counts = [
    ["all", "all", all.length],
    ["failures", "failures", all.filter((r) => !r.correct).length],
    ["harness", "harness only", all.filter((r) => r.mode === "harness").length],
  ];
  for (const [key, label, n] of counts) {
    const b = el("button", { type: "button", className: `pill${state.filter === key ? " on" : ""}` }, `${label} ${n}`);
    b.addEventListener("click", () => { state.filter = key; state.detail = -1; closeDetail(); });
    filters.append(b);
  }

  const box = $("#trials");
  box.replaceChildren();
  if (!rows.length) {
    box.append(el("div", { className: "empty-row" }, state.filter === "failures" ? "No failures." : "No trials yet."));
    return;
  }
  rows.forEach((r, i) => {
    const calls = r.toolCalls?.length ?? 0;
    const tools = TOOL_MODES.has(r.mode) ? plural(calls, "call") : "—";
    const schema = r.schemaValid === null || r.schemaValid === undefined ? "—" : r.schemaValid ? "valid" : "invalid";
    const row = el("div", { className: `trow${i === state.detail ? " active" : ""}`, role: "button", tabIndex: 0 },
      el("span", { className: `sq ${r.correct ? "pass" : "fail"}` }),
      el("span", {}, r.task),
      el("span", { className: "muted" }, MODE_LABEL[r.mode] ?? r.mode),
      el("span", { className: "muted ellipsis", title: r.client }, r.model),
      el("span", { className: "faint" }, `#${r.index}`),
      el("span", { className: "faint" }, tools),
      el("span", { className: schema === "—" ? "faint" : r.schemaValid ? "ok" : "bad" }, schema),
      el("span", { className: "faint right" }, fmtMs(r.latencyMs)),
      el("span", { className: `reason${r.error ? " bad" : ""}`, title: r.error ?? r.reason }, r.error ? `error · ${r.error}` : r.reason),
    );
    row.addEventListener("click", () => openDetail(i));
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(i); } });
    box.append(row);
  });
}

// ---- trial detail --------------------------------------------------------------------------

function openDetailFor(row) {
  let i = filteredRows().indexOf(row);
  if (i === -1) { state.filter = "all"; i = filteredRows().indexOf(row); }
  openDetail(i);
}

function openDetail(i) {
  state.detail = i;
  renderDetail();
  renderTrials();
}

function stepDetail(delta) {
  const next = state.detail + delta;
  if (next < 0 || next >= filteredRows().length) return;
  openDetail(next);
}

function closeDetail() {
  state.detail = -1;
  $("#detail").hidden = true;
  $("#scrim").hidden = true;
  if (state.run) renderTrials();
}

function renderDetail() {
  const rows = filteredRows();
  const r = rows[state.detail];
  if (!r) { closeDetail(); return; }

  $("#detail").hidden = false;
  $("#scrim").hidden = false;
  $("#detail-prev").disabled = state.detail <= 0;
  $("#detail-next").disabled = state.detail >= rows.length - 1;

  $("#detail-crumbs").replaceChildren(
    el("span", { className: `pill-verdict ${r.correct ? "pass" : "fail"}` }, r.correct ? "pass" : "fail"),
    el("span", { className: "muted" }, `${r.task} · ${MODE_LABEL[r.mode] ?? r.mode} · #${r.index}`),
    el("span", { className: "faint" }, `${state.detail + 1} / ${rows.length}`),
  );
  $("#detail-title").textContent = r.error ? r.error : (r.reason || "—");

  const usage = r.usage?.total_tokens
    ? `${fmtInt(r.usage.total_tokens)} tok (${fmtInt(r.usage.prompt_tokens)} in / ${fmtInt(r.usage.completion_tokens)} out)`
    : "no usage reported";
  $("#detail-sub").textContent = [
    r.client,
    fmtMs(r.latencyMs),
    usage,
    TOOL_MODES.has(r.mode) ? plural(r.rounds ?? 0, "round") : null,
    r.finishReason ? `finish: ${r.finishReason}` : null,
    new Date(r.startedAt).toLocaleTimeString(),
  ].filter(Boolean).join(" · ");

  const body = $("#detail-body");
  body.replaceChildren();

  // The transcript as a timeline: what the model was told, what it did, what it said, how it scored.
  const tl = el("div", { className: "timeline" });
  const step = (label, meta, text, tone = "") => tl.append(el("div", { className: `step ${tone}` },
    el("i", { className: "tdot" }),
    el("div", { className: "step-body" },
      el("div", { className: "step-head" }, el("span", { className: "step-label" }, label), el("span", {}, meta ?? "")),
      el("pre", {}, text)),
  ));

  if (r.system) step("system", `${fmtInt(r.system.length)} chars`, r.system);
  step("user", "", r.prompt ?? "—");
  (r.toolCalls ?? []).forEach((c, i) => {
    const res = r.toolResults?.[i];
    step(
      `tool call · ${c.name}(${JSON.stringify(c.arguments ?? {})})`,
      res ? (res.ok === false ? "error" : "ok") : "no result recorded",
      res ? pretty(res.content) : "(no result recorded)",
      res?.ok === false ? "bad" : "accent",
    );
  });
  if (TOOL_MODES.has(r.mode) && !(r.toolCalls ?? []).length) step("tool calls", "", "The model never called a tool.", "bad");
  step("final message", r.finishReason ? `finish: ${r.finishReason}` : "", r.answerText || "(empty)", r.correct ? "ok" : "bad");
  step(
    `scorer · ${isStructuredMode(r.mode) ? "scoreHarness" : "scoreNoHarness"}`,
    r.correct ? "pass" : "fail",
    r.error ? `exception: ${r.error}` : (r.reason || "—"),
    r.correct ? "ok" : "bad",
  );
  body.append(tl);

  const structured = isStructuredMode(r.mode);
  const answer = structured
    ? (r.structured === null || r.structured === undefined ? "(final message was not valid JSON)" : pretty(r.structured))
    : (r.answerText || "(empty)");
  const schemaNote = r.schemaValid === null || r.schemaValid === undefined ? "" : r.schemaValid ? " · schema valid" : " · schema invalid";
  body.append(
    el("div", { className: "eyebrow" }, "Answer vs ground truth"),
    el("div", { className: "diff" },
      el("div", {}, el("div", { className: "faint" }, structured ? `parsed structured answer${schemaNote}` : "free-form answer"), el("pre", {}, answer)),
      el("div", {}, el("div", { className: "faint" }, "ground truth"), el("pre", {}, r.ground === null || r.ground === undefined ? "—" : pretty(r.ground))),
    ),
  );
  if (r.schemaErrors?.length) {
    body.append(el("div", { className: "eyebrow" }, "Schema errors"), el("pre", { className: "bad-pre" }, r.schemaErrors.join("\n")));
  }
  $("#detail").scrollTop = 0;
}

function pretty(v) {
  if (typeof v === "string") {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
}

// ---- fetch helpers ---------------------------------------------------------------------------

async function getJSON(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function postJSON(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
