// app.js — launch benchmark runs and review the results.
//
// Summaries are computed here from the raw trial rows so that a run in flight and a run loaded
// from history render through exactly the same code path.

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), attrs);
  for (const kid of kids.flat()) node.append(kid?.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
};
const pct = (n) => `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;

const MODE_LABEL = { noHarness: "no harness", harness: "harness" };

const state = {
  meta: null,
  tasks: new Set(),
  modes: new Set(["noHarness", "harness"]),
  clients: new Set(),
  run: null,
  stream: null,
  onlyFailed: false,
};

// ---- boot ----------------------------------------------------------------------------------

init().catch((err) => showLaunchError(err.message));

async function init() {
  state.meta = await getJSON("/api/meta");
  renderSUT(state.meta.sut);
  renderTasks();
  renderModes();
  renderClients();
  await refreshHistory();
  wire();
  updatePlan();
  setInterval(pollSUT, 20_000);
}

function wire() {
  $("#run").addEventListener("click", launch);
  $("#cancel").addEventListener("click", cancel);
  $("#count").addEventListener("input", updatePlan);
  $("#only-failed").addEventListener("change", (e) => { state.onlyFailed = e.target.checked; renderTrials(); });
  $("#history").addEventListener("change", (e) => { if (e.target.value) openRun(e.target.value); });
  $("#delete-run").addEventListener("click", removeRun);
  $("#detail-close").addEventListener("click", closeDetail);
  $("#scrim").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

  for (const btn of document.querySelectorAll("[data-all]")) {
    btn.addEventListener("click", () => selectAll(btn.dataset.all));
  }
}

// ---- launch panel --------------------------------------------------------------------------

function renderSUT(sut) {
  const node = $("#sut");
  node.className = `sut ${sut.up ? "up" : "down"}`;
  node.querySelector(".sut-text").textContent = sut.up
    ? `webserver up · ${sut.url}`
    : `webserver down · start it: cd webserver && npm start`;
  node.title = sut.up ? "Harness tools call this server" : (sut.error ?? "unreachable");
}

async function pollSUT() {
  try { renderSUT(await getJSON("/api/sut")); } catch { /* transient */ }
}

function renderTasks() {
  const box = $("#tasks");
  box.replaceChildren();
  for (const t of state.meta.tasks) {
    state.tasks.add(t.name);
    box.append(checkbox({
      checked: true,
      label: t.name,
      sub: t.description,
      onChange: (on) => { on ? state.tasks.add(t.name) : state.tasks.delete(t.name); updatePlan(); },
    }));
  }
}

function renderModes() {
  const box = $("#modes");
  box.replaceChildren();
  for (const m of state.meta.modes) {
    box.append(checkbox({
      checked: true,
      label: MODE_LABEL[m] ?? m,
      sub: m === "harness" ? "tools + output schema + structured prompt" : "free-form prompt, no tools",
      onChange: (on) => { on ? state.modes.add(m) : state.modes.delete(m); updatePlan(); },
    }));
  }
}

function renderClients() {
  const box = $("#clients");
  box.replaceChildren();
  for (const p of state.meta.providers) {
    const group = el("div", { className: "provider-group" });
    const tag = p.hasKey
      ? el("span", { className: "tag ok" }, p.name === "local" && p.live ? "live" : "key set")
      : el("span", { className: "tag no" }, `${p.name.toUpperCase()}_API_KEY missing`);
    group.append(el("div", { className: "provider-head" }, el("span", {}, p.name), tag));

    for (const m of p.models) {
      group.append(checkbox({
        checked: false,
        disabled: !p.hasKey,
        label: m.label,
        code: m.id,
        onChange: (on) => { on ? state.clients.add(m.client) : state.clients.delete(m.client); updatePlan(); },
      }));
    }
    box.append(group);
  }
}

function checkbox({ checked, disabled, label, sub, code, onChange }) {
  const input = el("input", { type: "checkbox", checked: !!checked, disabled: !!disabled });
  input.addEventListener("change", () => onChange(input.checked));
  const text = el("span", {}, el("span", {}, label));
  if (code) text.append(" ", el("code", {}, code));
  if (sub) text.append(el("div", { className: "sub" }, sub));
  return el("label", { className: `check${disabled ? " disabled" : ""}` }, input, text);
}

function selectAll(kind) {
  const boxes = $(kind === "tasks" ? "#tasks" : "#clients").querySelectorAll("input:not(:disabled)");
  const turnOn = [...boxes].some((b) => !b.checked);
  for (const b of boxes) {
    if (b.checked !== turnOn) { b.checked = turnOn; b.dispatchEvent(new Event("change")); }
  }
}

function updatePlan() {
  const count = Math.max(1, Number($("#count").value) || 1);
  const cells = state.tasks.size * state.modes.size * state.clients.size;
  const total = cells * count;
  const busy = state.run?.status === "running";

  $("#plan").textContent = total
    ? `${total} trial${total === 1 ? "" : "s"} — ${state.tasks.size} task(s) × ${state.modes.size} mode(s) × ${state.clients.size} model(s) × ${count}`
    : "Select at least one task, mode and model.";
  $("#run").disabled = !total || busy;
}

function showLaunchError(msg) {
  const node = $("#launch-error");
  node.textContent = msg;
  node.hidden = !msg;
}

// ---- run lifecycle -------------------------------------------------------------------------

async function launch() {
  showLaunchError("");
  const body = {
    tasks: [...state.tasks],
    modes: [...state.modes],
    clients: [...state.clients],
    count: Math.max(1, Number($("#count").value) || 1),
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
  $("#run").disabled = busy || !(state.tasks.size && state.modes.size && state.clients.size);
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
  $("#report").hidden = true;
  $("#empty").hidden = false;
  $("#delete-run").hidden = true;
  await refreshHistory();
}

async function refreshHistory() {
  const { runs } = await getJSON("/api/runs");
  const sel = $("#history");
  const current = state.run?.id ?? sel.value;
  sel.replaceChildren(el("option", { value: "" }, runs.length ? "Past runs…" : "No past runs"));
  for (const r of runs) {
    const when = new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const label = `${when} · ${r.config.tasks.join("+")} · ${r.config.clients.length} model(s) · ${r.rowCount} trials${r.status === "done" ? "" : ` · ${r.status}`}`;
    sel.append(el("option", { value: r.id }, label));
  }
  if (current) sel.value = current;
}

// ---- report --------------------------------------------------------------------------------

function summarize(rows) {
  const by = (f) => [...new Set(rows.map(f))];
  const stats = (rs) => ({
    runs: rs.length,
    correct: rs.filter((r) => r.correct).length,
    correctPct: rs.length ? (rs.filter((r) => r.correct).length / rs.length) * 100 : 0,
    toolUsePct: rs.length ? (rs.filter((r) => r.toolCalls?.length).length / rs.length) * 100 : 0,
    schemaValidPct: rs.length ? (rs.filter((r) => r.schemaValid === true).length / rs.length) * 100 : 0,
    errors: rs.filter((r) => r.error).length,
    avgLatencyMs: rs.length ? Math.round(rs.reduce((a, r) => a + r.latencyMs, 0) / rs.length) : 0,
    tokens: rs.reduce((a, r) => a + (r.usage?.total_tokens ?? 0), 0),
  });

  const modes = by((r) => r.mode);
  const noH = rows.filter((r) => r.mode === "noHarness");
  const withH = rows.filter((r) => r.mode === "harness");
  const delta = noH.length && withH.length
    ? { a: stats(noH).correctPct, b: stats(withH).correctPct }
    : null;

  return {
    total: rows.length,
    tasks: by((r) => r.task),
    clients: by((r) => r.client),
    modes,
    byMode: Object.fromEntries(modes.map((m) => [m, stats(rows.filter((r) => r.mode === m))])),
    cell: (task, client, mode) => stats(rows.filter((r) => r.task === task && r.client === client && r.mode === mode)),
    delta,
  };
}

function renderReport() {
  const run = state.run;
  if (!run) return;
  $("#empty").hidden = true;
  $("#report").hidden = false;
  $("#delete-run").hidden = run.status === "running";

  const warn = $("#warnings");
  warn.hidden = !run.warnings?.length;
  if (run.warnings?.length) warn.textContent = run.warnings.join(" · ");

  const prog = $("#progress");
  const running = run.status === "running";
  prog.hidden = !running;
  if (running) {
    const { completed = 0, total = 0 } = run.progress ?? {};
    prog.querySelector(".bar-fill").style.width = total ? `${(completed / total) * 100}%` : "0%";
    prog.querySelector(".progress-text").textContent = `${completed} / ${total} trials`;
  }

  renderCards();
  renderMatrix();
  renderTrials();
}

function renderCards() {
  const s = summarize(state.run.rows);
  const box = $("#cards");
  box.replaceChildren();

  if (s.delta) {
    const pp = s.delta.b - s.delta.a;
    box.append(el("div", { className: "card headline" },
      el("div", { className: "k" }, "Harness delta"),
      el("div", { className: `v ${pp > 0 ? "up" : pp < 0 ? "down" : ""}` }, `${pp >= 0 ? "+" : ""}${pp.toFixed(1)}pp`),
      el("div", { className: "s" }, `${pct(s.delta.a)} → ${pct(s.delta.b)} correct`),
    ));
  }

  for (const mode of ["noHarness", "harness"]) {
    const m = s.byMode[mode];
    if (!m) continue;
    box.append(el("div", { className: "card" },
      el("div", { className: "k" }, MODE_LABEL[mode]),
      el("div", { className: "v" }, pct(m.correctPct)),
      el("div", { className: "s" }, `${m.correct}/${m.runs} correct · ${m.avgLatencyMs}ms avg`),
    ));
  }

  const h = s.byMode.harness;
  if (h) {
    box.append(el("div", { className: "card" },
      el("div", { className: "k" }, "Tool use"),
      el("div", { className: "v" }, pct(h.toolUsePct)),
      el("div", { className: "s" }, `schema valid ${pct(h.schemaValidPct)}`),
    ));
  }

  const tokens = s.byMode.harness?.tokens ?? 0;
  const noHTokens = s.byMode.noHarness?.tokens ?? 0;
  if (tokens || noHTokens) {
    box.append(el("div", { className: "card" },
      el("div", { className: "k" }, "Tokens"),
      el("div", { className: "v" }, (tokens + noHTokens).toLocaleString()),
      el("div", { className: "s" }, `harness ${tokens.toLocaleString()} · free-form ${noHTokens.toLocaleString()}`),
    ));
  }
}

function renderMatrix() {
  const rows = state.run.rows;
  const s = summarize(rows);
  const table = $("#matrix");
  table.replaceChildren();

  const modes = ["noHarness", "harness"].filter((m) => s.modes.includes(m));
  table.append(el("thead", {}, el("tr", {},
    el("th", {}, "Task"), el("th", {}, "Model"),
    ...modes.map((m) => el("th", {}, MODE_LABEL[m])),
    ...(modes.length === 2 ? [el("th", {}, "delta")] : []),
  )));

  const body = el("tbody");
  for (const task of s.tasks) {
    for (const client of s.clients) {
      const cells = modes.map((m) => s.cell(task, client, m));
      if (!cells.some((c) => c.runs)) continue;
      const tr = el("tr", {}, el("td", {}, task), el("td", {}, el("code", {}, client)));
      for (const c of cells) tr.append(el("td", { className: "num" }, rateCell(c)));
      if (modes.length === 2) {
        const [a, b] = cells;
        const pp = a.runs && b.runs ? b.correctPct - a.correctPct : null;
        tr.append(el("td", { className: "num" }, pp === null ? "—" : `${pp >= 0 ? "+" : ""}${pp.toFixed(0)}pp`));
      }
      body.append(tr);
    }
  }
  table.append(body);
}

function rateCell(c) {
  if (!c.runs) return document.createTextNode("—");
  const wrap = el("div", { className: `rate${c.correct ? "" : " zero"}` });
  const meter = el("span", { className: "meter" });
  meter.append(el("i", { style: `width:${c.correctPct}%` }));
  wrap.append(meter, el("span", {}, `${c.correct}/${c.runs}`));
  return wrap;
}

function renderTrials() {
  const all = state.run?.rows ?? [];
  const rows = state.onlyFailed ? all.filter((r) => !r.correct) : all;
  const table = $("#trials");
  table.replaceChildren();

  table.append(el("thead", {}, el("tr", {},
    el("th", {}, ""), el("th", {}, "Task"), el("th", {}, "Mode"), el("th", {}, "Model"),
    el("th", {}, "#"), el("th", {}, "Tools"), el("th", {}, "Schema"), el("th", {}, "Latency"), el("th", {}, "Why"),
  )));

  const body = el("tbody");
  for (const r of rows) {
    const tr = el("tr", { className: "clickable" },
      el("td", {}, el("span", { className: `pill ${r.correct ? "pass" : "fail"}` }, r.correct ? "pass" : "fail")),
      el("td", {}, r.task),
      el("td", {}, el("span", { className: "pill mode" }, MODE_LABEL[r.mode] ?? r.mode)),
      el("td", {}, el("code", {}, r.model)),
      el("td", { className: "num" }, `#${r.index}`),
      el("td", { className: "num" }, r.mode === "harness" ? String(r.toolCalls?.length ?? 0) : "—"),
      el("td", {}, r.schemaValid === null ? "—" : el("span", { className: `pill ${r.schemaValid ? "pass" : "fail"}` }, r.schemaValid ? "valid" : "invalid")),
      el("td", { className: "num" }, `${r.latencyMs}ms`),
      el("td", { className: "reason" }, r.error ? el("span", { className: "pill err" }, "error") : "", r.error ? ` ${r.error}` : r.reason),
    );
    tr.addEventListener("click", () => openDetail(r));
    body.append(tr);
  }
  if (!rows.length) {
    body.append(el("tr", {}, el("td", { colSpan: 9, className: "reason" }, state.onlyFailed ? "No failures." : "No trials yet.")));
  }
  table.append(body);
}

// ---- trial detail --------------------------------------------------------------------------

function openDetail(r) {
  $("#detail-title").textContent = `${r.task} · ${MODE_LABEL[r.mode] ?? r.mode}`;
  $("#detail-sub").textContent = `${r.model} · trial #${r.index} · ${r.latencyMs}ms · ${r.correct ? "pass" : "fail"}`;

  const body = $("#detail-body");
  body.replaceChildren();

  const dl = el("dl", { className: "kv" });
  const kv = (k, v) => { dl.append(el("dt", {}, k), el("dd", {}, v)); };
  kv("Verdict", el("span", { className: `pill ${r.correct ? "pass" : "fail"}` }, r.correct ? "pass" : "fail"));
  kv("Scorer said", r.reason || "—");
  if (r.error) kv("Error", r.error);
  kv("Started", new Date(r.startedAt).toLocaleString());
  kv("Finish reason", r.finishReason ?? "—");
  if (r.mode === "harness") kv("Tool rounds", String(r.rounds ?? 0));
  if (r.usage?.total_tokens) kv("Tokens", `${r.usage.total_tokens} (${r.usage.prompt_tokens ?? 0} in / ${r.usage.completion_tokens ?? 0} out)`);
  body.append(dl);

  if (r.system) body.append(block("System prompt", r.system));
  body.append(block("User prompt", r.prompt ?? "—"));

  if (r.mode === "harness") {
    const calls = el("div", { className: "block" }, el("h4", {}, `Tool calls (${r.toolCalls?.length ?? 0})`));
    if (!r.toolCalls?.length) {
      calls.append(el("pre", { className: "bad" }, "The model never called a tool."));
    } else {
      r.toolCalls.forEach((c, i) => {
        const result = r.toolResults?.[i];
        calls.append(el("div", { className: "tool-call" },
          el("div", { className: "name" }, `${c.name}(${JSON.stringify(c.arguments ?? {})})`),
          el("pre", { className: result?.ok === false ? "bad" : "ok" }, result ? pretty(result.content) : "(no result recorded)"),
        ));
      });
    }
    body.append(calls);
  }

  body.append(block("Model's final message", r.answerText || "(empty)"));

  if (r.mode === "harness") {
    body.append(block(
      "Parsed structured answer",
      r.structured === null ? "(final message was not valid JSON)" : pretty(r.structured),
      r.schemaValid === true ? "ok" : "bad",
    ));
    if (r.schemaErrors?.length) body.append(block("Schema errors", r.schemaErrors.join("\n"), "bad"));
  }

  body.append(block("Ground truth (live endpoint)", r.ground === null ? "—" : pretty(r.ground)));

  $("#detail").hidden = false;
  $("#scrim").hidden = false;
}

function block(title, content, cls = "") {
  return el("div", { className: "block" }, el("h4", {}, title), el("pre", { className: cls }, content));
}

function pretty(v) {
  if (typeof v === "string") {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
}

function closeDetail() {
  $("#detail").hidden = true;
  $("#scrim").hidden = true;
}

// ---- fetch helpers -------------------------------------------------------------------------

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
