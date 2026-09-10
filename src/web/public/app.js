// app.js — launch benchmark runs and review the results.
//
// Summaries come from the runner itself (served as /lib/runner.js), so a run in flight, a run
// loaded from history, and the CLI all report the same numbers through the same code.

import { summarize, deltaFor, describeSignificance, isStructuredMode, twoByTwo, DEFAULT_MODES, describeStability, describePaired, describePower, compareRows } from "/lib/runner.js";
import { radarSvg, sparklineSvg, lineageLayout, lineageSvg } from "/lib/charts.js";

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
  compare: { a: null, b: null, runId: "", rows: null, mode: "", seedRuns: null }, // the paired-comparison block
  inFlight: new Set(), // trial keys started but not finished (task|mode|client|index), for the live view
  meta: null,
  tasks: new Set(),
  modes: new Set(DEFAULT_MODES),
  clients: new Set(),
  run: null,
  stream: null,
  filter: "all",     // all | failures | harness
  detail: -1,        // index into filteredRows(), -1 = closed
  filterText: "",    // the setup panel's filter box
  openGroups: new Map(), // provider group open/closed states the user has toggled
  pooled: {},        // client → its index-pooled scorecard (the dashed outline behind a radar)
  trends: {},        // client → its capabilities per run (the sparklines)
  lineage: undefined, // the registry with per-checkpoint stats, fetched once
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
  for (const t of state.meta.tasks) state.tasks.add(t.name);
  renderStatus();
  renderTasks();
  renderModes();
  renderClients();
  await refreshHistory();
  wire();
  setSetupCollapsed(readSetupCollapsed());
  updatePlan();
  setInterval(pollStatus, 20_000);
}

function wire() {
  $("#parallel").addEventListener("input", updatePlan);
  $("#skill").addEventListener("change", updatePlan);
  $("#agents").addEventListener("change", updatePlan);
  $("#stress").addEventListener("change", updatePlan);
  $("#constraints").addEventListener("change", updatePlan);
  for (const id of ["compare-a", "compare-b", "compare-mode"]) $(`#${id}`).addEventListener("change", (e) => { state.compare[{ "compare-a": "a", "compare-b": "b", "compare-mode": "mode" }[id]] = e.target.value; renderReport(); });
  $("#curves-mode").addEventListener("change", () => renderReport());
  $("#compare-run").addEventListener("change", async (e) => {
    state.compare.runId = e.target.value;
    state.compare.b = null;
    state.compare.rows = state.compare.runId ? await getJSON(`/api/runs/${state.compare.runId}`).then((d) => d.run ?? d).catch(() => null) : null;
    renderReport();
  });
  $("#run").addEventListener("click", launch);
  $("#cancel").addEventListener("click", cancel);
  $("#count").addEventListener("input", updatePlan);
  $("#judge").addEventListener("change", updatePlan);
  $("#history").addEventListener("change", (e) => { if (e.target.value) openRun(e.target.value); });
  $("#history-filter").addEventListener("input", () => { clearTimeout(historyTimer); historyTimer = setTimeout(() => refreshHistory().catch(() => {}), 200); });
  $("#delete-run").addEventListener("click", removeRun);
  $("#replay-run").addEventListener("click", replayRun);
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
  for (const btn of document.querySelectorAll("[data-all]")) btn.addEventListener("click", () => setAll(btn.dataset.all, true));
  for (const btn of document.querySelectorAll("[data-none]")) btn.addEventListener("click", () => setAll(btn.dataset.none, false));
  for (const btn of document.querySelectorAll("[data-modes]")) {
    btn.addEventListener("click", () => setModes(btn.dataset.modes === "pair" ? ["noHarness", "harness"] : MODE_ORDER.filter(modeSupported)));
  }
  $("#setup-filter").addEventListener("input", (e) => { state.filterText = e.target.value; renderTasks(); renderClients(); });
  $("#setup-toggle").addEventListener("click", () => setSetupCollapsed(!document.body.classList.contains("setup-collapsed")));
  $("#setup-rail").addEventListener("click", () => setSetupCollapsed(false));
  $("#setup-rail").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSetupCollapsed(false); } });
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

// ---- new run (the setup panel) ---------------------------------------------------------------

const SETUP_KEY = "hb-setup-collapsed";
const CATEGORY_LABEL = {
  "api-call": "API calls",
  "pure-reasoning": "Reasoning · control",
  "tool-reasoning": "Tool reasoning",
  "multi-step": "Multi-step",
  "extract-transform": "Extract & transform",
  "public-anchor": "Public anchors · not the headline",
  "open-ended": "Open-ended · judged",
 "reasoning": "Reasoning · generated" , "long-context": "Long context · generated" };

// The panel folds to a rail; the choice is remembered per browser.
function setSetupCollapsed(collapsed) {
  document.body.classList.toggle("setup-collapsed", collapsed);
  $("#setup").setAttribute("aria-expanded", String(!collapsed));
  $("#setup-toggle").title = collapsed ? "Expand the run setup" : "Collapse the run setup";
  try { localStorage.setItem(SETUP_KEY, collapsed ? "1" : "0"); } catch { /* per-viewer convenience only */ }
}

function readSetupCollapsed() {
  try { return localStorage.getItem(SETUP_KEY) === "1"; } catch { return false; }
}

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

function matchesFilter(text) {
  const q = state.filterText.trim().toLowerCase();
  return !q || String(text).toLowerCase().includes(q);
}

// A link-styled button that never bubbles (it lives inside clickable group headers).
function linkButton(label, onClick, title) {
  const b = el("button", { type: "button", className: "link", title: title ?? "" }, label);
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
  return b;
}

function groupTools({ selected, total, onAll, onNone }) {
  const tools = el("span", { className: "group-tools" }, el("span", { className: "group-count" }, `${selected}/${total}`));
  if (onAll) tools.append(linkButton("all", onAll));
  if (onNone) tools.append(linkButton("none", onNone));
  return tools;
}

// Tasks, grouped by category. The list is re-rendered on every change so the counts stay right.
function renderTasks() {
  const box = $("#tasks");
  box.replaceChildren();
  const byCategory = new Map();
  for (const t of state.meta.tasks) {
    if (!byCategory.has(t.category)) byCategory.set(t.category, []);
    byCategory.get(t.category).push(t);
  }
  for (const [category, list] of byCategory) {
    const visible = list.filter((t) => matchesFilter(`${t.name} ${t.description} ${category}`));
    if (!visible.length) continue;
    const selected = list.filter((t) => state.tasks.has(t.name)).length;
    const group = el("div", { className: "group" },
      el("div", { className: "group-head" },
        el("span", { className: "group-name" }, CATEGORY_LABEL[category] ?? category),
        groupTools({
          selected, total: list.length,
          onAll: () => { for (const t of list) state.tasks.add(t.name); afterTaskChange(); },
          onNone: () => { for (const t of list) state.tasks.delete(t.name); afterTaskChange(); },
        })));
    const chips = el("div", { className: "chips" });
    for (const t of visible) {
      chips.append(chip({
        label: t.needsJudge ? `${t.name} ⚖` : t.name,
        on: state.tasks.has(t.name),
        title: `${t.description}\nmodes: ${t.modes.map((m) => MODE_LABEL[m] ?? m).join(", ")}${t.tools.length ? `\ntools: ${t.tools.join(", ")}` : ""}${t.needsJudge ? "\nneeds a judge model (pick one under Settings)" : ""}`,
        onToggle: (on) => { on ? state.tasks.add(t.name) : state.tasks.delete(t.name); afterTaskChange(); },
      }));
    }
    group.append(chips);
    box.append(group);
  }
  if (!box.children.length) box.append(el("div", { className: "hint" }, "no tasks match the filter"));
}

function afterTaskChange() { renderTasks(); renderModes(); updatePlan(); }

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

function setModes(names) {
  state.modes = new Set(names);
  renderModes();
  updatePlan();
}

function renderJudgeOptions() {
  const sel = $("#judge");
  const current = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "none"));
  for (const p of state.meta.providers) {
    if (p.kind === "harness" || !p.hasKey || p.live === false) continue;
    for (const m of p.models) sel.append(el("option", { value: m.client }, m.client));
  }
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function providerTag(p) {
  if (p.kind === "harness") return p.hasKey ? "arm" : "arm · no key";
  if (!p.needsKey) return p.live ? `live · ${p.models.length}` : "offline";
  return p.hasKey ? "key set" : `${p.name.toUpperCase()}_API_KEY missing`;
}

// Models and harness arms: one collapsible group per provider, with a status tag, the selected
// count and all/none. Groups open when usable and small, or when something in them is selected,
// or when a filter is active; a group the user toggled keeps that state.
function renderClients() {
  renderJudgeOptions();
  const models = $("#clients");
  const arms = $("#arms");
  models.replaceChildren();
  arms.replaceChildren();
  const filtering = state.filterText.trim() !== "";
  for (const p of state.meta.providers) {
    const usable = p.hasKey && p.live !== false;
    const target = p.kind === "harness" ? arms : models;
    const visible = p.models.filter((m) => matchesFilter(`${p.name} ${m.client} ${m.label}`));
    if (filtering && !visible.length) continue;
    const selected = p.models.filter((m) => state.clients.has(m.client)).length;
    const open = state.openGroups.has(p.name)
      ? state.openGroups.get(p.name)
      : (usable && (selected > 0 || filtering || p.models.length <= 4));
    const details = el("details", { className: `provider${usable ? "" : " unusable"}`, open });
    details.addEventListener("toggle", () => state.openGroups.set(p.name, details.open));
    details.append(el("summary", {},
      el("span", { className: "group-name" }, p.name),
      el("span", { className: `tag ${usable ? "ok" : "no"}` }, providerTag(p)),
      groupTools({
        selected, total: p.models.length,
        onAll: usable ? () => { for (const m of p.models) state.clients.add(m.client); afterClientChange(); } : null,
        onNone: usable ? () => { for (const m of p.models) state.clients.delete(m.client); afterClientChange(); } : null,
      })));
    const rows = el("div", { className: "rows" });
    for (const m of visible) {
      const input = el("input", { type: "checkbox", disabled: !usable, value: m.client, checked: state.clients.has(m.client) });
      input.addEventListener("change", () => { input.checked ? state.clients.add(m.client) : state.clients.delete(m.client); afterClientChange(); });
      rows.append(el("label", { className: "model", title: m.label !== m.id ? m.label : "" }, input, el("i", { className: "box" }), el("span", {}, m.id)));
    }
    details.append(rows);
    target.append(details);
  }
  if (!models.children.length) models.append(el("div", { className: "hint" }, filtering ? "no models match the filter" : "no model providers configured"));
  if (!arms.children.length) arms.append(el("div", { className: "hint" }, filtering ? "no arms match the filter" : "no harness arms configured"));
}

function afterClientChange() { renderClients(); updatePlan(); }

// all / none for a whole section: tasks, models (non-arm providers) or arms.
function setAll(kind, on) {
  if (kind === "tasks") {
    for (const t of state.meta.tasks) on ? state.tasks.add(t.name) : state.tasks.delete(t.name);
    afterTaskChange();
    return;
  }
  for (const p of state.meta.providers) {
    if ((kind === "arms") !== (p.kind === "harness")) continue;
    if (!(p.hasKey && p.live !== false)) continue;
    for (const m of p.models) on ? state.clients.add(m.client) : state.clients.delete(m.client);
  }
  afterClientChange();
}

function armClientSet() {
  return new Set((state.meta?.providers ?? []).filter((p) => p.kind === "harness").flatMap((p) => p.models.map((m) => m.client)));
}

// What the current setup would actually run: (task, mode) pairs the task declares × runners × count.
// A harness arm runs structured modes only; the server skips its free-form pairs, so the count does too.
// The client names a launch sends for one selected client, given the skill and sub-agent settings.
// An A/B choice keeps the plain client as the baseline; a bare treatment replaces it.
function clientVariants(c) {
  const pick = (value, abDefault) => {
    if (!value) return { how: null, ab: false };
    if (value === "ab") return { how: abDefault, ab: true };
    if (value.startsWith("ab-")) return { how: value.slice(3), ab: true };
    return { how: value, ab: false };
  };
  const skill = pick($("#skill").value, "preload");
  const agents = pick($("#agents").value, "available");
  const stress = pick($("#stress").value, "flaky");
  const constraints = pick($("#constraints").value, "light");
  const out = [];
  if ((!skill.how && !agents.how && !stress.how && !constraints.how) || skill.ab || agents.ab || stress.ab || constraints.ab) out.push(c);
  if (skill.how) out.push(`${c}@skill:${skill.how}`);
  if (agents.how) out.push(`${c}@agents:${agents.how}`);
  if (stress.how) out.push(`${c}@stress:${stress.how}`);
  if (constraints.how) out.push(`${c}@constraints:${constraints.how}`);
  return out;
}

function plan() {
  const count = Math.max(1, Math.min(20, Number($("#count").value) || 1));
  const modes = [...state.modes].filter(modeSupported);
  const arms = armClientSet();
  const clientsFor = (m) => [...state.clients].filter((c) => !(arms.has(c) && !isStructuredMode(m))).length;
  let cells = 0;
  const skipped = [];
  for (const name of state.tasks) {
    const t = taskMeta(name);
    for (const m of modes) {
      if (t?.modes.includes(m)) cells += clientsFor(m);
      else skipped.push(`${name}/${MODE_LABEL[m] ?? m}`);
    }
  }
  const armsN = [...state.clients].filter((c) => arms.has(c)).length;
  // Treatments (skill, sub-agents) run every client once per variant; an A/B choice keeps the plain client too.
  const variants = clientVariants("x").length;
  return { count, modes, total: cells * count * variants, skipped, modelsN: state.clients.size - armsN, armsN, variants };
}

function updatePlan() {
  const p = plan();
  const busy = state.run?.status === "running";
  const node = $("#plan");
  node.replaceChildren();
  if (!p.total) {
    node.append(el("div", {}, "Pick at least one task, a mode it declares, and a model or arm."));
  } else {
    const runners = [p.modelsN ? plural(p.modelsN, "model") : "", p.armsN ? plural(p.armsN, "arm") : ""].filter(Boolean).join(" + ");
    node.append(
      el("div", {}, `${plural(state.tasks.size, "task")} × ${plural(p.modes.length, "mode")} × ${runners} × ${p.count} = `, el("b", {}, plural(p.total, "trial"))),
      el("div", { className: "summary" },
        el("span", {}, [...state.tasks].join(" ")),
        el("span", {}, p.modes.map((m) => MODE_LABEL[m] ?? m).join(" + "))),
    );
    if (p.skipped.length) node.append(el("div", { className: "hint" }, `skips ${p.skipped.join(", ")} — not declared by that task`));
    const par = Math.max(1, Math.min(16, Number($("#parallel").value) || 1));
    if (par > 1) node.append(el("div", { className: "hint" }, `${par} trials in flight at once · arms still run alone · latencies include queueing`));
    const skillMode = $("#skill").value;
    if (skillMode) {
      const have = new Set(state.meta?.skills ?? []);
      const without = [...state.tasks].filter((n) => !have.has(taskMeta(n)?.skill ?? n));
      node.append(el("div", { className: "hint" }, `${skillMode.startsWith("ab") ? "each model also runs with its playbook" : "models run with their playbook"}${without.length ? ` · no playbook for ${without.join(", ")} (unchanged)` : ""}`));
    }
    const agentsMode = $("#agents").value;
    if (agentsMode) node.append(el("div", { className: "hint" }, `${agentsMode.startsWith("ab") ? "each model also runs with a delegate tool" : "models run with a delegate tool"} · arms use their own sub-agents where they have them (Claude Code)`));
    const constraintsMode = $("#constraints").value;
    if (constraintsMode) node.append(el("div", { className: "hint" }, `${constraintsMode.startsWith("ab") ? "each model also runs with formatting requirements" : "models run with formatting requirements"} · adherence is reported next to correctness`));
    const stressMode = $("#stress").value;
    if (stressMode) {
      const noAxis = [...state.tasks].filter((n) => !/^(restock|fanout|follow|norelevant)/.test(n));
      node.append(el("div", { className: "hint" }, `${stressMode.startsWith("ab") ? "each model also runs under stress" : "models run under stress"}${noAxis.length ? ` · no stress axis on ${noAxis.join(", ")} (unchanged)` : ""}`));
    }
  }
  const judged = [...state.tasks].filter((name) => taskMeta(name)?.needsJudge);
  if (p.total && judged.length && !$("#judge").value) node.append(el("div", { className: "hint" }, `${judged.join(", ")} needs a judge — pick one under Settings or its trials will error`));
  $("#run").disabled = !p.total || busy;
  $("#mode-hint").textContent = state.modes.has("noHarness") && state.modes.has("harness")
    ? "no harness + harness → delta"
    : "select no harness and harness to get a delta";
  $("#setup-rail-summary").textContent = p.total ? plural(p.total, "trial") : "nothing selected";
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
    clients: [...state.clients].flatMap(clientVariants),
    count: plan().count,
    parallel: Math.max(1, Math.min(16, Number($("#parallel").value) || 1)),
  };
  if ($("#instance-seed").value !== "") body.instanceSeed = Number($("#instance-seed").value);
  for (const key of ["temperature", "seed"]) {
    const raw = $(`#${key}`).value;
    if (raw !== "") body[key] = Number(raw);
  }
  if ($("#judge").value) body.judge = $("#judge").value;
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
      state.compare = { a: null, b: null, runId: "", rows: null, mode: "", seedRuns: null };
      state.regressions = {};
      state.inFlight = new Set();
      state.filter = "all";
      closeDetail();
      setBusy(msg.run.status === "running");
      renderReport();
    } else if (msg.type === "trial-start") {
      state.inFlight.add(msg.key);
      renderLive();
    } else if (msg.type === "trial") {
      const r = msg.result;
      state.inFlight.delete(`${r.task}|${r.mode}|${r.client}|${r.index}`);
      state.run.rows.push(r);
      state.run.progress = { completed: msg.completed, total: msg.total };
      renderReport();
    } else if (msg.type === "done") {
      state.inFlight = new Set();
      Object.assign(state.run, msg.run);
      setBusy(false);
      renderReport();
      refreshHistory();
      stream.close();
    }
  };
  stream.onerror = () => { stream.close(); setBusy(false); };
}

// Replay: the same tasks, modes, models, instances and knobs as the open run, as a new run
// parented to it — the server fills the launch from the parent's config.
async function replayRun() {
  if (!state.run || state.run.status === "running") return;
  showLaunchError("");
  try {
    const { run } = await postJSON("/api/runs", { replayOf: state.run.id });
    setBusy(true);
    openRun(run.id);
  } catch (err) {
    showLaunchError(err.message);
  }
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

let historyTimer = null;

async function refreshHistory() {
  const q = $("#history-filter")?.value.trim() ?? "";
  const { runs } = await getJSON(q ? `/api/runs?q=${encodeURIComponent(q)}` : "/api/runs");
  const sel = $("#history");
  const current = state.run?.id ?? sel.value;
  sel.replaceChildren(el("option", { value: "" }, runs.length ? (q ? `${plural(runs.length, "matching run")}…` : "past runs…") : (q ? "no matching runs" : "no past runs")));
  for (const r of runs) {
    const when = new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const tasks = r.config?.tasks ?? [];
    const clients = r.config?.clients ?? [];
    const label = `${when} · ${tasks.join(" ") || "?"} · ${plural(clients.length, "model")} · ${plural(r.rowCount ?? 0, "trial")}${r.status === "done" ? "" : ` · ${r.status ?? "?"}`}${r.parent ? ` · replay of ${r.parent.id}` : ""}`;
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
  $("#replay-run").hidden = run.status === "running";
  const csv = $("#export-csv");
  csv.hidden = run.status === "running";
  csv.href = `/api/runs/${run.id}/csv`;
  csv.title = "Download every trial as CSV (add ?cells=1 for the task × model × mode cells)";

  const warn = $("#warnings");
  warn.hidden = !run.warnings?.length;
  warn.replaceChildren(...(run.warnings ?? []).map((w) => el("div", {}, w)));

  const s = summarize(run.rows, {
    capabilitiesOf: Object.fromEntries((state.meta?.tasks ?? []).map((t) => [t.name, t.capabilities ?? []])),
    levelsOf: Object.fromEntries((state.meta?.tasks ?? []).filter((t) => t.family).map((t) => [t.name, { family: t.family, level: t.level }])),
  });
  renderHeadline(s);
  renderTwoByTwo(s);
  renderCost(s);
  renderCalibration(s);
  renderAbstention(s);
  renderScorecard(s);
  renderLineage();
  renderCurves(s);
  renderCompare(s);
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
  const knobs = [
    ...Object.entries(run.config?.modelParams ?? {}).map(([k, v]) => `${k} ${v}`),
    (run.config?.parallel ?? 1) > 1 ? `${run.config.parallel} in parallel` : "",
    run.config?.instanceSeed !== undefined && run.config?.instanceSeed !== null ? `instances #${run.config.instanceSeed}` : "",
    run.parent ? `replay of ${run.parent.id}` : "",
    run.rescored?.length ? `re-scored ${String(run.rescored.at(-1).at).slice(0, 10)}` : "",
  ].filter(Boolean).join(" · ");
  const progress = (run.status === "running" ? `${done} of ${total} trials · running` : `${plural(done, "trial")} · ${run.status}`) + (knobs ? ` · ${knobs}` : "");

  const d = s.delta.overall;
  const col = el("div", { className: "hcol" }, el("div", { className: "eyebrow" }, "Harness delta"));
  if (d) {
    col.append(
      el("div", { className: `big ${d.deltaPp > 0 ? "up" : d.deltaPp < 0 ? "down" : "flat"}` },
        `${d.deltaPp > 0 ? "+" : ""}${Number.isInteger(d.deltaPp) ? d.deltaPp : d.deltaPp.toFixed(1)}`, el("small", {}, "pp")),
      el("div", { className: "sub" }, `${fmtPct(d.noHarnessPct)} → ${fmtPct(d.harnessPct)} correct · ${progress}`),
      el("div", { className: `sig${d.significant ? " yes" : ""}` }, describeSignificance(d)),
    );
    if (d.paired) col.append(el("div", { className: `sig${d.paired.significant ? " yes" : ""}`, title: "the same instances in both modes, compared pairwise: McNemar's exact test on the discordant pairs, and a bootstrap band on the delta" }, describePaired(d.paired)));
    if (!d.significant) { const pw = describePower(d); if (pw) col.append(el("div", { className: "sub", title: "unpaired two-proportion power calculation at α = 0.05" }, pw)); }
    if (s.multiple) col.append(el("div", { className: "sub", title: "with many task × model cells some look significant by chance; Bonferroni divides α by the number of comparisons" }, `${s.multiple.comparisons} cells · ${s.multiple.significantRaw} significant · ${s.multiple.significantBonferroni} after Bonferroni`));
  }
  // Gates: the thresholds this run was judged against (cli --gate / --gates), with what missed.
  if (run.gates) {
    const g = run.gates;
    const per = Object.entries(g.byClient ?? {}).map(([c, r]) => `${c} ${r.counts?.pass ?? 0}/${(r.results ?? []).length} pass`).join(" · ");
    col.append(el("div", { className: `sig${g.verdict === "pass" ? " yes" : ""}`, title: `${g.file ? `${g.file} · ` : ""}${(g.specs ?? []).join(", ")}${g.strict ? " · strict" : ""}` }, `gates: ${g.verdict}${g.strict ? " (strict)" : ""} · ${per}`));
    for (const [c, r] of Object.entries(g.byClient ?? {})) {
      for (const x of (r.results ?? []).filter((x) => x.verdict !== "pass").slice(0, 4)) col.append(el("div", { className: "sub" }, `${x.verdict} · ${Object.keys(g.byClient).length > 1 ? `${c} · ` : ""}${x.label} — ${x.reason}`));
    }
  }
  for (const [client, a] of Object.entries(s.delta.byArm ?? {})) {
    if (!a.overall) continue;
    col.append(el("div", { className: "sub", title: `${describeSignificance(a.overall)} · baseline from ${a.baselineClients.join(", ")}` },
      `${client}: ${signedPp(a.overall.deltaPp, 1)} vs ${a.model} free-form`));
  }
  if (!d) {
    col.prepend(
      el("div", { className: "big flat" }, "—"),
      el("div", { className: "sub" }, progress),
      el("div", { className: "sig" }, describeSignificance(null)),
    );
    col.prepend(el("div", { className: "eyebrow" }, "Harness delta"));
    col.querySelectorAll(".eyebrow")[1]?.remove();
  }
  box.append(col);

  // With treated variants in the run (a playbook, a delegate tool), each treatment's delta stands
  // beside the harness delta, one column per delivery.
  const variantCols = [
    ...Object.entries(s.delta?.skill ?? {}).map(([how, d]) => ({ kind: "skill", how, d })),
    ...Object.entries(s.delta?.agents ?? {}).map(([how, d]) => ({ kind: "agents", how, d })),
    ...Object.entries(s.delta?.stress ?? {}).map(([how, d]) => ({ kind: "stress", how, d })),
    ...Object.entries(s.delta?.constraints ?? {}).map(([how, d]) => ({ kind: "constraints", how, d })),
    ...Object.entries(s.delta?.format ?? {}).map(([how, d]) => ({ kind: "format", how, d })),
    ...Object.entries(s.delta?.effort ?? {}).map(([how, d]) => ({ kind: "effort", how, d })),
    ...Object.entries(s.delta?.confidence ?? {}).map(([how, d]) => ({ kind: "confidence", how, d })),
    ...Object.entries(s.delta?.abstain ?? {}).map(([how, d]) => ({ kind: "abstain", how, d })),
    ...Object.entries(s.delta?.perturb ?? {}).map(([how, d]) => ({ kind: "perturb", how, d })),
  ];
  const stressDetail = (how, d) => ({
    flaky: `${plural(d.failed, "failure")} served`,
    budget: `${plural(d.rejected, "request")} refused`,
    haystack: `${plural(d.requests, "request")} in inventories of 60`,
    distractors: `${plural(d.distractorCalls, "distractor call")} · reorder-all ×${d.trap}`,
    injected: `hijacked in ${d.hijackedTrials} of ${d.treatRuns} trials`,
  }[how] ?? `${plural(d.requests, "request")}`);
  for (const { kind, how, d } of variantCols) {
    const label = kind === "skill" ? `Skill delta · ${how === "ondemand" ? "on demand" : how}` : kind === "agents" ? `Sub-agents delta · ${how}` : kind === "stress" ? `Stress delta · ${how}` : kind === "format" ? `Format delta · ${how === "nowork" ? "work field stripped" : "work field added"}` : kind === "effort" ? `Effort delta · ${how}` : kind === "confidence" ? "Confidence delta · asked" : kind === "abstain" ? "Abstain delta · half unanswerable" : kind === "perturb" ? `Perturbation delta · ${how}` : `Constraints delta · ${how}`;
    const detail = kind === "skill"
      ? `without → with playbook${how === "ondemand" ? ` · loaded in ${d.loaded}/${d.treatRuns}` : ""}`
      : kind === "agents"
        ? `without → with delegation · delegated in ${d.used}/${d.treatRuns} · ${plural(d.delegations, "sub-agent")}`
        : kind === "stress"
          ? `plain → under stress · ${stressDetail(how, d)}`
          : kind === "format"
            ? `as written → ${how === "nowork" ? "without" : "with"} the work field · applied in ${d.applied}/${d.treatRuns} · complied ${d.complied}/${d.applied}`
            : kind === "effort"
              ? `as is → effort ${how}${d.reasoningCharsMean !== null && d.reasoningCharsMean !== undefined ? ` · reasoning ${fmtInt(d.reasoningCharsMean)} chars` : ""}`
              : kind === "confidence"
                ? `plain → asked for a confidence · stated in ${d.stated}/${d.treatRuns}${d.calibration ? ` · Brier ${d.calibration.brier.toFixed(3)} · ECE ${d.calibration.ece.toFixed(3)}` : ""}`
                : kind === "abstain"
                  ? `all answerable → half unanswerable · abstained ${d.abstained}/${d.unanswerable}, fabricated ${d.fabricated} · refused ${d.refused} answerable`
                  : kind === "perturb"
                    ? `as minted → ${how === "paraphrase" ? "in other words" : how === "order" ? "parts reordered" : "another surface form"} · applied in ${d.applied}/${d.treatRuns}${d.consistency?.pairs ? ` · consistent in ${d.consistency.same}/${d.consistency.pairs} (${fmtPct(d.consistency.pct)})` : ""}`
                    : `plain → with requirements · adherence ${d.total ? fmtPct((100 * d.met) / d.total) : "—"} (${d.met}/${d.total})`;
    box.append(el("div", { className: "hcol" },
      el("div", { className: "eyebrow" }, label),
      el("div", { className: `big ${d.deltaPp > 0 ? "up" : d.deltaPp < 0 ? "down" : "flat"}` },
        `${d.deltaPp > 0 ? "+" : ""}${Number.isInteger(d.deltaPp) ? d.deltaPp : d.deltaPp.toFixed(1)}`, el("small", {}, "pp")),
      el("div", { className: "sub" }, `${fmtPct(d.basePct)} → ${fmtPct(d.treatPct)} correct · ${detail}`),
      el("div", { className: `sig${d.significant ? " yes" : ""}` }, describeSignificance(d)),
    ));
  }

  const modeCols = MODE_ORDER.filter((m) => s.byMode[m]);
  for (const m of modeCols) {
    const st = s.byMode[m];
    box.append(el("div", { className: "hcol" },
      el("div", { className: "eyebrow" }, MODE_LABEL[m]),
      el("div", { className: "num" }, fmtPct(st.correctPct)),
      el("div", { className: "sub", title: `avg ${fmtMs(st.avgLatencyMs)} · max ${fmtMs(st.latencyMaxMs)}` }, `${st.correct}/${st.runs} · p50 ${fmtMs(st.latencyP50Ms)} · p95 ${fmtMs(st.latencyP95Ms)}`),
      st.ttftP50Ms !== null && st.ttftP50Ms !== undefined ? el("div", { className: "sub", title: "median time to the first token of any kind, and to the first answer token" }, `first token ${fmtMs(st.ttftP50Ms)} · answer ${fmtMs(st.ttfaP50Ms ?? st.ttftP50Ms)}`) : null,
      s.stability?.[m]?.repeated ? el("div", { className: "sub", title: "agreement: share of a cell's repeated trials that gave the same canonical answer (tasks with fixed truth: health, reason, regex) · flaky: repeated cells with both passes and failures" }, describeStability(s.stability[m])) : null,
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
    kv("tool args ok", h?.toolArgsJudged ? fmtPct(h.toolArgsOkPct) : "—"),
    kv("errors", h ? fmtPct(h.errorPct) : "—"),
    kv("tokens", fmtInt(harnessTokens + freeTokens)),
    kv("harness / free", `${fmtInt(harnessTokens)} / ${fmtInt(freeTokens)}`),
  ));

  box.style.gridTemplateColumns = `1.35fr ${"1.2fr ".repeat(variantCols.length)}repeat(${modeCols.length}, 1fr) 1.15fr`;
}

// The tools × schema decomposition, shown once three of the four modes have rows.
function renderTwoByTwo(s) {
  const box = twoByTwo(s);
  const section = $("#grid2x2");
  section.hidden = !box;
  if (!box) return;
  const pp = (v) => (v === null ? "n/a" : signedPp(v, 1));
  $("#grid2x2-effects").replaceChildren(
    el("span", { title: "average lift from adding tools, across both schema settings" }, `tools ${pp(box.toolsEffect)}`),
    el("span", { title: "average lift from adding the schema, across both tool settings" }, `schema ${pp(box.schemaEffect)}`),
    el("span", { title: "how much the two together differ from the sum of their separate effects" }, `interaction ${pp(box.interaction)}`),
  );
  const cell = (mode) => {
    const c = box.grid[mode];
    return el("div", { className: `cell2 ${mode}${c ? "" : " missing"}` },
      el("div", { className: "v" }, c ? fmtPct(c.correctPct) : "—"),
      el("div", { className: "s" }, c ? `${MODE_LABEL[mode]} · ${c.correct}/${c.runs}` : `${MODE_LABEL[mode]} · not run`));
  };
  $("#grid2x2-body").replaceChildren(
    el("div", { className: "corner" }), el("div", { className: "axis" }, "no schema"), el("div", { className: "axis" }, "schema"),
    el("div", { className: "axis row" }, "no tools"), cell("noHarness"), cell("schemaOnly"),
    el("div", { className: "axis row" }, "tools"), cell("toolOnly"), cell("harness"),
  );
}

// One cell per planned trial, in the runner's execution order (task → mode → client → trial), so
// the grid fills in left to right and the first empty cell is the one running now.
function renderLive() {
  const run = state.run;
  const box = $("#live");
  box.replaceChildren();

  const { tasks = [], modes = [], clients = [], count = 1 } = run.config ?? {};
  const declared = (task, mode) => taskMeta(task)?.modes.includes(mode) ?? true;
  const armClients = new Set((state.meta?.providers ?? []).filter((p) => p.kind === "harness").flatMap((p) => p.models.map((m) => m.client)));
  const structuredMode = (mode) => mode === "harness" || mode === "schemaOnly";
  const byKey = new Map(run.rows.map((r) => [`${r.task}|${r.mode}|${r.client}|${r.index}`, r]));

  const order = [];
  for (const task of tasks) {
    for (const mode of modes) {
      if (!declared(task, mode)) continue;
      for (const client of clients) {
        if (armClients.has(client) && !structuredMode(mode)) continue;
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

  // Cells in flight come from the server's trial-start events; before the first one arrives (or
  // for a run reopened mid-flight) the first unfinished cell stands in.
  const firstQueued = run.status === "running" ? order.find((c) => !c.row) : null;
  const isRunning = (c) => run.status === "running" && (state.inFlight.size ? state.inFlight.has(`${c.task}|${c.mode}|${c.client}|${c.index}`) : c === firstQueued);
  $("#live-title").textContent = run.status === "running" ? `Live · ${run.rows.length} / ${order.length}` : `Trials · ${run.rows.length}`;

  for (const mode of MODE_ORDER.filter((m) => order.some((c) => c.mode === m))) {
    const cells = order.filter((c) => c.mode === mode);
    const grid = el("div", { className: "cells", style: { "--n": String(cells.length) } });
    for (const c of cells) {
      const cls = c.row ? (c.row.correct ? "pass" : "fail") : isRunning(c) ? "running" : "queued";
      const status = c.row ? `${c.row.correct ? "pass" : "fail"} · ${c.row.error ?? c.row.reason}` : isRunning(c) ? "running" : "queued";
      const cell = el("span", { className: `cell ${cls}`, title: `${c.task} · ${MODE_LABEL[c.mode] ?? c.mode} · ${c.client} #${c.index} · ${status}` });
      if (c.row) cell.addEventListener("click", () => openDetailFor(c.row));
      grid.append(cell);
    }
    box.append(el("div", { className: "live-row" }, el("div", { className: "live-label" }, MODE_LABEL[mode] ?? mode), grid));
  }
}

// Calibration: for rows that stated a confidence, how the stated probabilities compare with the
// outcomes — accuracy against mean confidence, Brier, ECE and the reliability bins.
function renderCalibration(s) {
  const block = $("#calibration-block");
  const box = $("#calibration");
  box.replaceChildren();
  const rows = s.calibration ?? [];
  block.hidden = !rows.length;
  if (!rows.length) return;
  $("#calibration-legend").replaceChildren(el("span", {}, "Brier: mean squared distance between the stated probability and the outcome (0 is perfect) · ECE: expected calibration error over ten bins · gap: mean confidence minus accuracy, overconfident when positive"));
  box.style.gridTemplateColumns = "minmax(160px, 1.4fr) repeat(6, minmax(70px, 1fr)) minmax(160px, 2fr)";
  box.append(...["model", "mode", "stated", "accuracy", "confidence", "gap", "Brier · ECE", "bins (confidence → accuracy, n)"].map((c) => el("div", { className: "mh" }, c)));
  for (const c of rows) {
    box.append(
      el("div", { className: "ellipsis", title: c.client }, c.client),
      el("div", {}, MODE_LABEL[c.mode] ?? c.mode),
      el("div", { className: "num" }, String(c.n)),
      el("div", { className: "num" }, fmtPct(c.accuracyPct)),
      el("div", { className: "num" }, fmtPct(c.meanConfidencePct)),
      el("div", { className: `num ${c.overconfidencePp > 5 ? "down" : ""}` }, signedPp(c.overconfidencePp, 0)),
      el("div", { className: "num" }, `${c.brier.toFixed(3)} · ${c.ece.toFixed(3)}`),
      el("div", { className: "faint" }, c.bins.map((b) => `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}: ${fmtPct(b.confidencePct)} → ${fmtPct(b.accuracyPct)} (${b.n})`).join(" · ")),
    );
  }
}

// Abstention: for abstain-variant rows, the four cases per client and mode — abstained or
// fabricated on the unanswerable half, refused or answered on the answerable half.
function renderAbstention(s) {
  const block = $("#abstention-block");
  const box = $("#abstention");
  box.replaceChildren();
  const rows = s.abstention ?? [];
  block.hidden = !rows.length;
  if (!rows.length) return;
  $("#abstention-legend").replaceChildren(el("span", {}, "half the instances had a quantity, a column or a date taken away · abstained = said it cannot be determined · fabricated = produced a value anyway · refused = abstained on a problem that could be answered"));
  box.style.gridTemplateColumns = "minmax(160px, 1.4fr) repeat(6, minmax(70px, 1fr))";
  box.append(...["model", "mode", "unanswerable", "abstained", "fabricated", "answerable", "refused · right"].map((c) => el("div", { className: "mh" }, c)));
  for (const v of rows) {
    box.append(
      el("div", { className: "ellipsis", title: v.client }, v.client),
      el("div", {}, MODE_LABEL[v.mode] ?? v.mode),
      el("div", { className: "num" }, String(v.unanswerable)),
      el("div", { className: "num" }, `${v.abstained}${v.abstainRatePct !== null ? ` · ${fmtPct(v.abstainRatePct)}` : ""}`),
      el("div", { className: `num ${v.fabricated ? "down" : ""}` }, String(v.fabricated)),
      el("div", { className: "num" }, String(v.answerable)),
      el("div", { className: "num" }, `${v.refused} · ${v.answeredRight}/${v.answerable}`),
    );
  }
}

// Correctness × cost × latency: per client and mode, what a right answer costs and how long it
// takes. Rows are priced when they run, from models/prices.json; unpriced rows are counted, not
// guessed. Hidden when nothing in the run carries a price.
const fmtUsd = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v >= 1 ? `$${v.toFixed(2)}` : v === 0 ? "$0" : `$${parseFloat(v.toFixed(5))}`);
function renderCost(s) {
  const block = $("#cost-block");
  const box = $("#cost");
  box.replaceChildren();
  const rows = (s.cost ?? []).filter((c) => c.priced || c.reasoningCharsMean > 0);
  block.hidden = !rows.length;
  if (!rows.length) return;
  const withReasoning = rows.some((c) => c.reasoningCharsMean > 0);
  $("#cost-legend").replaceChildren(el("span", {}, `prices from the table on the run's day · $/correct = the run's spend divided by its right answers${withReasoning ? " · reasoning = characters of thinking returned per trial" : ""}`));
  const cols = ["model", "mode", "correct", "total", "per trial", "per correct", "p50 latency", "tokens", ...(withReasoning ? ["reasoning"] : [])];
  box.style.gridTemplateColumns = `minmax(160px, 1.4fr) repeat(${cols.length - 1}, minmax(70px, 1fr))`;
  box.append(...cols.map((c) => el("div", { className: "mh" }, c)));
  for (const c of rows) {
    box.append(
      el("div", { className: "ellipsis", title: c.client }, c.client),
      el("div", {}, MODE_LABEL[c.mode] ?? c.mode),
      el("div", { className: "num" }, `${c.correct}/${c.runs} · ${fmtPct(c.correctPct)}`),
      el("div", { className: "num" }, c.priced ? fmtUsd(c.costUsd) + (c.unpriced ? ` (${c.unpriced} unpriced)` : "") : el("span", { className: "faint" }, "no price")),
      el("div", { className: "num" }, c.priced ? fmtUsd(c.costPerTrialUsd) : "—"),
      el("div", { className: "num" }, c.priced ? fmtUsd(c.costPerCorrectUsd) : "—"),
      el("div", { className: "num" }, fmtMs(c.latencyP50Ms)),
      el("div", { className: "num" }, fmtInt(c.totalTokens)),
      ...(withReasoning ? [el("div", { className: "num" }, c.reasoningCharsMean !== null ? fmtInt(c.reasoningCharsMean) : "—")] : []),
    );
  }
}

// The run's capability scorecard: per tag, each client's harness rate with its Wilson band, the raw
// rate and the delta, pooled over the run's tasks that carry the tag. Above the table, a radar per
// client (this run filled, every saved run of the client dashed behind it); in each cell, a
// sparkline of the capability over the client's saved runs.
const RADAR_COLORS = ["#6d5bd0", "#2f8f5b", "#c0392b", "#6b7280", "#d97706", "#0891b2"];
function fetchOnce(cache, client, url, fallback) {
  if (cache[client] !== undefined) return;
  cache[client] = null;
  getJSON(url).then((r) => { cache[client] = r; renderReport(); }).catch(() => { cache[client] = fallback; });
}
function renderScorecard(s) {
  const block = $("#scorecard-block");
  const box = $("#scorecard");
  const radars = $("#radars");
  box.replaceChildren();
  radars.replaceChildren();
  const caps = Object.entries(s.capabilities ?? {}).sort(([a], [b]) => a.localeCompare(b));
  block.hidden = !caps.length;
  if (!caps.length) return;
  const clients = s.clients;
  const settled = state.run.status !== "running";
  $("#scorecard-legend").replaceChildren(el("span", {}, "harness % with its 95% band · raw % · delta — pooled over the run's tasks carrying the tag; the sparkline is the capability over the client's saved runs, oldest first"));
  if (settled) {
    for (const client of clients) {
      fetchOnce(state.regressions ??= {}, client, `/api/regressions?client=${encodeURIComponent(client)}`, { own: { flags: [] }, vsParent: null });
      fetchOnce(state.pooled, client, `/api/scorecard?client=${encodeURIComponent(client)}`, { capabilities: {} });
      fetchOnce(state.trends, client, `/api/trend?client=${encodeURIComponent(client)}&mode=harness`, { series: [] });
    }
  }
  // Radars: the axes are the run's capabilities, the same for every client so the shapes compare.
  const axes = caps.map(([cap]) => cap);
  clients.forEach((client, ci) => {
    const color = RADAR_COLORS[ci % RADAR_COLORS.length];
    const own = axes.map((cap) => { const st = s.capabilities[cap].byClient[client]; const m = st?.byMode.harness ?? st?.byMode.noHarness ?? Object.values(st?.byMode ?? {})[0]; return m ? m.correctPct : null; });
    const pooled = state.pooled[client]?.capabilities;
    const series = [];
    if (pooled && Object.keys(pooled).length) series.push({ name: "every saved run", values: axes.map((cap) => pooled[cap]?.byMode.harness?.correctPct ?? null), color, dashed: true });
    series.push({ name: "this run", values: own, color, fill: true });
    const card = el("div", { className: "radar-card" });
    card.innerHTML = radarSvg(axes, series, { size: 200, title: `${client} — capability radar` });
    card.append(el("div", { className: "who", title: client }, client), el("div", {}, pooled && Object.keys(pooled).length ? `filled: this run · dashed: ${state.pooled[client].trials} saved trials` : "this run"));
    radars.append(card);
  });
  box.style.gridTemplateColumns = `170px repeat(${clients.length}, minmax(150px, 1fr))`;
  box.append(el("div", { className: "mh" }, "capability"), ...clients.map((c) => el("div", { className: "mh ellipsis", title: c }, c)));
  if (settled) {
    const lines = clients.flatMap((client) => {
      const r = state.regressions?.[client];
      if (!r) return [];
      return [
        ...(r.own?.flags ?? []).map((f) => `↓ ${client}: ${f.capability} ${MODE_LABEL[f.mode] ?? f.mode} ${fmtPct(f.earlier.correctPct)} over ${plural(f.earlierRuns, "earlier run")} → ${fmtPct(f.later.correctPct)} in its latest run (${String(f.latestAt).slice(0, 10)}): ${f.perTask.map((t) => `${t.task} ${t.earlier}→${t.later}/${t.n}`).join(", ")}`),
        ...(r.vsParent?.flags ?? []).map((f) => `↓ ${client}: ${f.capability} ${MODE_LABEL[f.mode] ?? f.mode} ${fmtPct(f.child.correctPct)} against parent ${r.vsParent.parent} at ${fmtPct(f.parent.correctPct)}: ${f.perTask.map((t) => `${t.task} ${t.earlier}→${t.later}/${t.n}`).join(", ")}`),
      ];
    });
    for (const line of lines) box.append(el("div", { className: "regress", title: "the later Wilson band lies entirely under the earlier one" }, line));
  }
  for (const [cap, c] of caps) {
    box.append(el("div", { className: "cap", title: c.tasks.join(", ") }, cap, el("small", {}, ` · ${plural(c.tasks.length, "task")}`)));
    for (const client of clients) {
      const st = c.byClient[client];
      const h = st?.byMode.harness;
      const r = st?.byMode.noHarness;
      const primary = h ?? r ?? Object.values(st?.byMode ?? {})[0];
      if (!primary) { box.append(el("div", { className: "faint" }, "—")); continue; }
      const band = (m) => `${fmtPct(m.correctPct)} [${(m.wilson.low * 100).toFixed(0)}–${(m.wilson.high * 100).toFixed(0)}]`;
      const sub = el("div", { className: "sub" }, [h ? `harness ${band(h)}` : "", r ? `raw ${band(r)}` : "", st.delta ? signedPp(st.delta.deltaPp, 0) : ""].filter(Boolean).join(" · "));
      const series = (state.trends[client]?.series ?? []).filter((p) => p.byCapability[cap]);
      if (series.length >= 2) {
        const values = series.map((p) => p.byCapability[cap].harness?.correctPct ?? null);
        const holder = el("span");
        holder.innerHTML = sparklineSvg(values, { width: 64, height: 14, title: `${cap} · harness over ${series.length} saved runs: ${series.map((p) => `${String(p.createdAt).slice(0, 10)} ${p.byCapability[cap].harness ? `${p.byCapability[cap].harness.correct}/${p.byCapability[cap].harness.runs}` : "—"}`).join(", ")}` });
        sub.append(holder.firstChild);
      }
      box.append(el("div", { className: "sc" }, el("div", { className: "bar" }, el("i", { style: { width: `${primary.correctPct}%` } })), sub));
    }
  }
}

// The lineage graph: every registered checkpoint by family, a child one column right of its
// parent, the run's own clients highlighted, the index-pooled harness rate and any regression flag
// on each node. Hidden while the registry is empty.
function renderLineage() {
  const block = $("#lineage-block");
  const box = $("#lineage");
  if (state.lineage === undefined) {
    state.lineage = null;
    getJSON("/api/lineage").then((r) => { state.lineage = r; renderLineage(); }).catch(() => { state.lineage = { entries: {}, stats: {} }; });
  }
  const data = state.lineage;
  const entries = data?.entries ?? {};
  block.hidden = !Object.keys(entries).length;
  if (block.hidden) return;
  const strip = (c) => c.replace(/@(skill|agents|stress|constraints|format|effort|confidence|abstain|perturb)(:[a-z]+)?$/, "");
  const highlight = [...new Set((state.run?.clients ?? state.run?.config?.clients ?? []).map(strip))];
  const layout = lineageLayout(entries, { stats: data.stats ?? {} });
  box.innerHTML = lineageSvg(layout, { highlight, title: "model lineage" });
  const flagged = Object.entries(data.stats ?? {}).filter(([, st]) => (st.flags?.own ?? 0) + (st.flags?.parent ?? 0)).map(([id, st]) => `${id} ↓${(st.flags.own ?? 0) + (st.flags.parent ?? 0)}`);
  box.append(el("div", { className: "foot" }, `${plural(layout.nodes.length, "checkpoint")} in ${layout.bands.length === 1 ? "1 family" : `${layout.bands.length} families`} from ${data.file ?? "the registry"} · node: checkpoint and its harness rate over every saved run · ${highlight.length ? "filled: this run's models" : ""}${flagged.length ? ` · regression flags: ${flagged.join(", ")}` : ""}`));
  $("#lineage-legend").replaceChildren(el("span", {}, "a child sits one column right of its parent; ↓ = a capability whose latest band lies under its earlier runs or its parent"));
}

// Difficulty curves: per family with a knob, success per level per client, drawn as small SVG
// lines; the breaking point (first level whose Wilson band tops out under 50 %) is a hollow square.
const SERIES = ["var(--accent)", "var(--pass)", "var(--fail)", "var(--ink-3)", "#d97706", "#0891b2"];
function svgEl(tag, attrs = {}, ...children) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const c of children) n.append(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}
const shortLevel = (family, l) => (family === "needle" ? `${Math.round(l / 1000)}k` : String(l));

function renderCurves(s) {
  const block = $("#curves-block");
  const box = $("#curves");
  box.replaceChildren();
  const families = Object.entries(s.curves ?? {}).filter(([, c]) => c.levels.length >= 2);
  const sweep = s.depths ?? null;
  block.hidden = !families.length && !sweep;
  if (!families.length && !sweep) return;
  const modesPresent = [...new Set([...families.flatMap(([, c]) => Object.values(c.byClient).flatMap((bm) => Object.keys(bm))), ...(sweep ? Object.values(sweep.byClient).flatMap((bm) => Object.keys(bm)) : [])])];
  const sel = $("#curves-mode");
  const cur = sel.value && modesPresent.includes(sel.value) ? sel.value : (modesPresent.includes("harness") ? "harness" : modesPresent[0]);
  sel.replaceChildren(...modesPresent.map((m) => el("option", { value: m }, MODE_LABEL[m] ?? m)));
  sel.value = cur;
  const clients = s.clients;
  $("#curves-legend").replaceChildren(...clients.map((c, i) => el("span", { title: c }, el("i", { className: "key", style: { background: SERIES[i % SERIES.length] } }), c.length > 26 ? c.slice(0, 25) + "…" : c)));
  for (const [family, c] of families) {
    const W = 300, H = 120, L = 30, R = 10, T = 8, B = 22;
    const x = (i) => L + (i * (W - L - R)) / Math.max(1, c.levels.length - 1);
    const y = (pct) => T + (1 - pct / 100) * (H - T - B);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${family} difficulty curve` });
    for (const g of [0, 50, 100]) svg.append(svgEl("line", { class: g === 50 ? "grid" : "axis", x1: L, x2: W - R, y1: y(g), y2: y(g) }), svgEl("text", { x: L - 4, y: y(g) + 3, "text-anchor": "end" }, `${g}%`));
    c.levels.forEach((l, i) => svg.append(svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle" }, shortLevel(family, l))));
    const foot = [];
    clients.forEach((client, ci) => {
      const m = c.byClient[client]?.[cur];
      if (!m) return;
      const color = SERIES[ci % SERIES.length];
      const pts = m.points.map((p) => [x(c.levels.indexOf(p.level)), y(p.correctPct), p]);
      if (pts.length > 1) svg.append(svgEl("polyline", { class: "series", stroke: color, points: pts.map(([px, py]) => `${px},${py}`).join(" ") }));
      for (const [px, py, p] of pts) svg.append(svgEl("circle", { class: "pt", cx: px, cy: py, r: 3, fill: color, stroke: "var(--surface)" }, svgEl("title", {}, `${client} · ${family} ${shortLevel(family, p.level)} · ${p.correct}/${p.runs} (${(p.wilson.low * 100).toFixed(0)}–${(p.wilson.high * 100).toFixed(0)}%)`)));
      if (m.breakingPoint !== null) { const bp = pts.find(([, , p]) => p.level === m.breakingPoint); if (bp) svg.append(svgEl("rect", { class: "break", x: bp[0] - 6, y: bp[1] - 6, width: 12, height: 12, stroke: color })); foot.push(`${client.split(":").pop()} breaks at ${shortLevel(family, m.breakingPoint)}`); }
    });
    box.append(el("div", { className: "curve" }, el("h4", {}, `${family} · ${c.levels.map((l) => shortLevel(family, l)).join(" → ")}`), svg, el("div", { className: "foot" }, foot.length ? foot.join(" · ") : "no breaking point at these levels")));
  }
  // The needle depth sweep: one planted line, success by where it sat in the log.
  if (sweep) {
    const lines = [];
    for (const client of clients) {
      const byDepth = sweep.byClient[client]?.[cur] ?? Object.values(sweep.byClient[client] ?? {})[0];
      if (!byDepth) continue;
      lines.push(el("div", { className: "foot" }, `${client} · ${sweep.depths.map((d) => { const p = byDepth[d]; return p ? `${Math.round(d * 100)}%: ${p.correct}/${p.runs}` : null; }).filter(Boolean).join(" · ")}`));
    }
    if (lines.length) box.append(el("div", { className: "curve" }, el("h4", {}, "needle · one planted line, by depth"), ...lines));
  }
}

// Two clients on the same instances — from this run, or B from another run on the same instance
// seed (a later checkpoint, another day) — paired per task with McNemar and a bootstrap band.
function lineageLabel(client) {
  const e = state.meta?.lineage?.[client.replace(/@(skill|agents|stress|constraints|format|effort|confidence|abstain|perturb)(:[a-z]+)?$/, "")];
  return e ? `${client} · ${[e.family, e.checkpoint, e.step !== null && e.step !== undefined ? `step ${e.step}` : null].filter(Boolean).join(" ")}` : client;
}

async function renderCompare(s) {
  const run = state.run;
  const block = $("#compare-block");
  const box = $("#compare");
  const c = state.compare;
  const clients = s.clients;
  if (clients.length < 2 && !c.runId) { block.hidden = true; return; }
  block.hidden = false;
  const fill = (sel, options, value) => {
    const cur = value ?? sel.value;
    sel.replaceChildren(...options.map(([v, label]) => el("option", { value: v }, label)));
    sel.value = options.some(([v]) => v === cur) ? cur : options[0]?.[0] ?? "";
    return sel.value;
  };
  c.a = fill($("#compare-a"), clients.map((x) => [x, lineageLabel(x)]), c.a);
  // Other saved runs on the same seed, fetched once per run.
  if (c.seedRuns === null && run.config?.instanceSeed !== undefined && run.config?.instanceSeed !== null && run.status !== "running") {
    c.seedRuns = [];
    try { c.seedRuns = ((await getJSON(`/api/runs?seed=${run.config.instanceSeed}`)).runs ?? []).filter((r) => r.id !== run.id); } catch { c.seedRuns = []; }
  }
  fill($("#compare-run"), [["", "this run"], ...(c.seedRuns ?? []).map((r) => [r.id, `${r.id} · ${(r.config?.clients ?? []).length} clients`])], c.runId);
  const bRows = c.runId && c.rows?.id === c.runId ? c.rows.rows : run.rows;
  const bClients = [...new Set(bRows.map((r) => r.client))];
  c.b = fill($("#compare-b"), bClients.map((x) => [x, lineageLabel(x)]), c.b ?? bClients.find((x) => x !== c.a) ?? bClients[0]);
  const modes = [...new Set([...run.rows, ...bRows].map((r) => r.mode))];
  c.mode = fill($("#compare-mode"), [["", "all modes"], ...modes.map((m) => [m, MODE_LABEL[m] ?? m])], c.mode);

  box.replaceChildren();
  const rowsA = run.rows.filter((r) => r.client === c.a);
  const rowsB = bRows.filter((r) => r.client === c.b);
  const cmp = compareRows(rowsA, rowsB, { mode: c.mode || null });
  if (!cmp.pairs) { box.append(el("div", { className: "hint" }, "nothing pairs: the two sides did not run the same task and trial indices")); return; }
  for (const h of ["task", "A", "B", "both", "A only", "B only", "neither", "McNemar"]) box.append(el("div", { className: "mh" }, h));
  for (const [task, d] of Object.entries(cmp.byTask)) {
    box.append(el("div", {}, task), el("div", {}, fmtPct(d.aPct)), el("div", {}, fmtPct(d.bPct)), el("div", { className: "faint" }, String(d.both)), el("div", { className: d.onlyBase ? "bad" : "faint" }, String(d.onlyBase)), el("div", { className: d.onlyTreat ? "ok" : "faint" }, String(d.onlyTreat)), el("div", { className: "faint" }, String(d.neither)), el("div", { className: d.significant ? "ok" : "faint" }, `p=${d.pValue.toFixed(3)}${d.significant ? " ·" : ""}`));
  }
  box.append(el("div", { className: "overall" }, `overall: A ${fmtPct(cmp.overall.aPct)} → B ${fmtPct(cmp.overall.bPct)} · ${describePaired(cmp.overall)}${cmp.unpairedA || cmp.unpairedB ? ` · unpaired: ${cmp.unpairedA} A, ${cmp.unpairedB} B` : ""}`));
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
      const arm = s.delta.byArm?.[client];
      const d = deltaFor(state.run.rows.filter((r) => r.task === task && r.client === client)) ?? arm?.byTask?.[task] ?? null;

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
        ? el("div", { className: `mc right ${d.deltaPp > 0 ? "up" : d.deltaPp < 0 ? "down" : "muted"}`, title: `${describeSignificance(d)}${arm ? ` · vs the free-form baseline of ${arm.model} (${arm.baselineClients.join(", ")})` : ""}` }, signedPp(d.deltaPp, 0))
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
      el("span", { className: "faint", title: r.toolUseReason || "" }, tools,
        r.toolUseOk === true ? el("i", { className: "mark ok" }, "✓") : r.toolUseOk === false ? el("i", { className: "mark bad" }, "✗") : null),
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
    fmtMs(r.latencyMs) + (typeof r.ttftMs === "number" ? ` (first token ${fmtMs(r.ttftMs)})` : ""),
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
  const callStep = (c, i) => {
    const res = (c.id !== undefined && c.id !== null ? r.toolResults?.find((t) => t.id === c.id) : undefined) ?? r.toolResults?.[i];
    step(
      `tool call${c.agent ? ` · sub-agent ${c.agent}` : ""} · ${c.name}(${JSON.stringify(c.arguments ?? {})})`,
      res ? (res.ok === false ? "error" : "ok") : "no result recorded",
      res ? pretty(res.content) : "(no result recorded)",
      res?.ok === false ? "bad" : "accent",
    );
  };
  // One user turn's worth of the session: each loop turn's text, then the calls it made; the loop's
  // final text is the turn's answer, shown separately.
  let i = 0;
  const renderLoop = (loopTurns, ownCalls) => {
    if (loopTurns.length) {
      const named = new Set();
      loopTurns.forEach((t, ti) => {
        const own = ownCalls.filter((c) => (t.calls ?? []).includes(c.id));
        own.forEach((c) => named.add(c.id));
        const isFinal = ti === loopTurns.length - 1 && !own.length;
        if (t.text && !isFinal) step(`assistant · round ${t.round ?? ti + 1}`, typeof t.ms === "number" ? `+${fmtMs(t.ms)}` : "", t.text, "");
        own.forEach((c) => callStep(c, i++));
      });
      ownCalls.filter((c) => !named.has(c.id)).forEach((c) => callStep(c, i++));
    } else ownCalls.forEach((c) => callStep(c, i++));
  };
  if (Array.isArray(r.dialogue) && r.dialogue.length) {
    // A scripted dialogue: the user's turns, and what the model did and said after each.
    r.dialogue.forEach((d, di) => {
      const n = d.turn ?? di + 1;
      if (di > 0) step(`user · turn ${n}`, "", d.user || "(empty)", "");
      renderLoop((r.turns ?? []).filter((t) => t.dialogueTurn === n), (r.toolCalls ?? []).filter((c) => c.turn === n));
      if (di < r.dialogue.length - 1) step(`assistant · turn ${n}`, `${plural(d.calls ?? 0, "call")} · ${fmtMs(d.ms ?? 0)}`, d.answer || "(empty)", "");
    });
  } else renderLoop(r.turns ?? [], r.toolCalls ?? []);
  if (TOOL_MODES.has(r.mode) && !(r.toolCalls ?? []).length) step("tool calls", "", "The model never called a tool.", "bad");
  if (r.toolUseOk === true || r.toolUseOk === false) step("tool use", r.toolUseOk ? "correct" : "wrong", r.toolUseReason || "—", r.toolUseOk ? "ok" : "bad");
  if (typeof r.judgeScore === "number") step("judge", `score ${r.judgeScore.toFixed(2)}`, r.judgeReason || "—", r.correct ? "ok" : "bad");
  step("final message", r.finishReason ? `finish: ${r.finishReason}` : "", r.answerText || "(empty)", r.correct ? "ok" : "bad");
  step(
    `scorer · ${isStructuredMode(r.mode) ? "scoreHarness" : "scoreNoHarness"}`,
    r.correct ? "pass" : "fail",
    r.error ? `exception: ${r.error}` : (r.reason || "—"),
    r.correct ? "ok" : "bad",
  );
  body.append(tl);
  // An arm's raw transcript, as its harness printed it (capped in the record), for re-reading.
  if (r.transcript?.text) {
    body.append(el("details", { className: "transcript" },
      el("summary", {}, `raw transcript · ${r.transcript.format} · ${fmtInt(r.transcript.chars ?? r.transcript.text.length)} chars`),
      el("pre", {}, r.transcript.text)));
  }

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

  // Stateful tasks carry the context their trial ran against (restock: the scenario and its items).
  if (r.ctx && typeof r.ctx === "object" && Object.keys(r.ctx).length) {
    const items = Array.isArray(r.ctx.items) ? r.ctx.items : null;
    const low = items ? items.filter((i) => i.qty < i.min).length : null;
    body.append(
      el("div", { className: "eyebrow" }, "Trial context"),
      el("div", { className: "hint" }, items ? `scenario ${r.ctx.scenario} · ${plural(items.length, "item")} · ${plural(low, "low item")}` : JSON.stringify(r.ctx).slice(0, 200)),
    );
  }

  // Delegation: what the parent handed off and what came back.
  if (r.agents?.delegations) {
    body.append(
      el("div", { className: "eyebrow" }, "Sub-agents"),
      el("div", { className: "hint" }, `${plural(r.agents.delegations, "sub-agent")} · ${plural(r.agents.childCalls ?? 0, "child tool call")} · ${fmtInt(r.agents.childTokens ?? 0)} child tokens`),
      ...(r.agents.children ?? []).map((c, i) => el("div", { className: "hint" }, `#${i + 1} · ${plural(c.calls, "call")} · ${fmtMs(c.latencyMs)} · ${c.goal.slice(0, 140)} → ${c.answer.slice(0, 200)}`)),
    );
  } else if (r.agents && r.agents.applied === false) {
    body.append(el("div", { className: "eyebrow" }, "Sub-agents"), el("div", { className: "hint" }, "delegation was requested, but this client has no channel for it"));
  } else if (r.agents) {
    body.append(el("div", { className: "eyebrow" }, "Sub-agents"), el("div", { className: "hint" }, "a delegate tool was available and never used"));
  }

  // Constraints: each formatting requirement and whether the answer met it.
  if (r.constraints) {
    const c = r.constraints;
    body.append(
      el("div", { className: "eyebrow" }, "Constraints"),
      el("div", { className: "hint" }, c.applied ? `${c.how} · ${c.met}/${c.total} met` : `${c.how} requested, none applied`),
      ...(c.list ?? []).map((x) => el("div", { className: `hint ${x.met ? "ok" : "bad"}` }, `${x.met ? "✓" : "✗"} ${x.text}`)),
    );
  }

  // Stress: what the environment did to this trial, from the scenario's op log.
  if (r.stress) {
    const st = r.stress;
    body.append(
      el("div", { className: "eyebrow" }, "Stress"),
      el("div", { className: "hint" }, st.applied
        ? `${st.how} · ${plural(st.requests ?? 0, "request")} · ${plural(st.failed ?? 0, "failure")} served · ${plural(st.rejected ?? 0, "request")} refused · ${plural(st.distractorCalls ?? 0, "distractor call")}${st.hijacked ? ` · HIJACKED (${st.hijacked})` : st.how === "injected" ? " · not hijacked" : ""}${st.budget ? ` · budget ${st.budget}` : ""}`
        : `${st.how} requested, but this task has no stress axis`),
    );
  }

  // The same task × model × mode cell across every saved run, from the index.
  const across = el("div", { className: "hint" }, "across runs: …");
  body.append(el("div", { className: "eyebrow" }, "Across runs"), across);
  const key = `${r.task}|${r.client}|${r.mode}`;
  getJSON(`/api/cells?task=${encodeURIComponent(r.task)}&client=${encodeURIComponent(r.client)}&mode=${encodeURIComponent(r.mode)}`)
    .then((c) => {
      if (!across.isConnected || `${r.task}|${r.client}|${r.mode}` !== key) return;
      across.textContent = c.trials
        ? `${c.correct}/${c.trials} correct across ${plural(c.runs, "run")} (${fmtPct(c.correctPct)}), ${String(c.first).slice(0, 10)} → ${String(c.last).slice(0, 10)}`
        : "no other runs of this cell yet";
    })
    .catch(() => { across.textContent = "index unavailable"; });
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
