// server.js — the benchmark control plane: launch runs and review results from a browser.
//
// This is NOT the system under test. `webserver/` is the target the tasks probe; this server
// drives the benchmark against it and stays on a different port so the two never collide.
//
//   node src/cli.js serve --port 4000
//
// Dependency-free (node:http), consistent with the rest of the project.

import "../env.js";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listTasks, getTask } from "../tasks/registry.js";
import { describeProviders, resolveClients } from "../providers/index.js";
import { runMatrix, MODE_NAMES, DEFAULT_MODES } from "../runner.js";
import { describeSkipped } from "../bench.js";
import { newRunId, saveRun, loadRun, listRuns, deleteRun, runHeader } from "../results.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const SRC_DIR = resolve(PUBLIC_DIR, "..", "..");
const SUT_PORT = process.env.SUT_PORT ?? process.env.PORT ?? 3000;
const SUT_BASE = `http://localhost:${SUT_PORT}`;

// Source modules the browser may import, so the UI summarizes runs with the runner's own code
// (see runner.js). Served under /lib/ and nowhere else.
const BROWSER_LIB = new Set(["runner.js", "schema.js"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// ---- live run state ------------------------------------------------------------------------
// Runs live in memory while executing and are flushed to results/runs/ as they progress, so a
// reload mid-run still shows where things got to.

const active = new Map();   // id -> { run, controller, subscribers:Set<res> }

function broadcast(id, event) {
  const entry = active.get(id);
  if (!entry) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of entry.subscribers) {
    try { res.write(payload); } catch { entry.subscribers.delete(res); }
  }
}

function startRun({ tasks, modes, clients, count }) {
  const taskObjs = tasks.map(getTask);
  const clientObjs = resolveClients(clients);
  if (!clientObjs.length) throw new Error("no usable clients — check the model names and that the provider's API key is set in .env");

  const missing = clients.filter((c) => !clientObjs.some((r) => r.name === c));
  const controller = new AbortController();

  const run = {
    id: newRunId(),
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    source: "web",
    config: { tasks, modes, clients: clientObjs.map((c) => c.name), count },
    warnings: missing.length ? [`skipped (no API key or unknown provider): ${missing.join(", ")}`] : [],
    // The real total arrives with the runner's "start" event, once undeclared (task, mode) pairs
    // are dropped from the plan.
    progress: { completed: 0, total: taskObjs.length * modes.length * clientObjs.length * count },
    summary: null,
    rows: [],
  };

  active.set(run.id, { run, controller, subscribers: new Set() });
  saveRun(run);

  (async () => {
    try {
      await runMatrix({
        tasks: taskObjs,
        modes,
        clients: clientObjs,
        count,
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === "start") {
            run.progress = { completed: 0, total: ev.total };
            run.warnings.push(...describeSkipped(ev.skipped));
            saveRun(run);
          } else if (ev.type === "trial") {
            run.rows.push(ev.result);
            run.progress = { completed: ev.completed, total: ev.total };
            saveRun(run);
            broadcast(run.id, { type: "trial", completed: ev.completed, total: ev.total, result: ev.result });
          } else if (ev.type === "done") {
            run.summary = ev.summary;
            run.status = ev.cancelled ? "cancelled" : "done";
          }
        },
      });
    } catch (err) {
      run.status = "error";
      run.error = err?.message ?? String(err);
    } finally {
      run.finishedAt = new Date().toISOString();
      if (run.status === "running") run.status = "done";
      saveRun(run);
      broadcast(run.id, { type: "done", run: runHeader(run) });
      const entry = active.get(run.id);
      for (const res of entry?.subscribers ?? []) { try { res.end(); } catch { /* gone */ } }
      active.delete(run.id);
    }
  })();

  return run;
}

// ---- http ----------------------------------------------------------------------------------

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function sendFile(res, file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!resolve(file).startsWith(resolve(PUBLIC_DIR))) return sendJSON(res, 403, { error: "forbidden" });
  return sendFile(res, file);
}

async function probeSUT() {
  try {
    const res = await fetch(`${SUT_BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { up: false, url: SUT_BASE, error: `HTTP ${res.status}` };
    return { up: true, url: SUT_BASE, health: await res.json() };
  } catch (err) {
    return { up: false, url: SUT_BASE, error: err?.message ?? "unreachable" };
  }
}

function validateLaunch(body) {
  const tasks = Array.isArray(body.tasks) ? body.tasks.filter(Boolean) : [];
  const modes = Array.isArray(body.modes) ? body.modes.filter((m) => MODE_NAMES.includes(m)) : [];
  const clients = Array.isArray(body.clients) ? body.clients.filter(Boolean) : [];
  const count = Math.max(1, Math.min(20, Number(body.count) || 1));

  if (!tasks.length) throw new Error("select at least one task");
  if (!modes.length) throw new Error("select at least one mode");
  if (!clients.length) throw new Error("select at least one model");
  for (const t of tasks) getTask(t); // throws on unknown task
  if (!tasks.some((t) => modes.some((m) => !!getTask(t)[m]))) {
    throw new Error("none of the selected tasks declares any of the selected modes");
  }
  return { tasks, modes, clients, count };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/meta") {
    const [providers, sut] = await Promise.all([describeProviders(), probeSUT()]);
    return sendJSON(res, 200, { tasks: listTasks(), modes: MODE_NAMES, defaultModes: DEFAULT_MODES, providers, sut });
  }

  if (req.method === "GET" && path === "/api/sut") {
    return sendJSON(res, 200, await probeSUT());
  }

  if (req.method === "GET" && path === "/api/runs") {
    return sendJSON(res, 200, { runs: listRuns({ limit: 100 }) });
  }

  if (req.method === "POST" && path === "/api/runs") {
    try {
      const run = startRun(validateLaunch(await readBody(req)));
      return sendJSON(res, 201, { run: runHeader(run) });
    } catch (err) {
      return sendJSON(res, 400, { error: err?.message ?? String(err) });
    }
  }

  const runMatch = path.match(/^\/api\/runs\/([A-Za-z0-9._-]+)(\/[a-z]+)?$/);
  if (runMatch) {
    const [, id, sub] = runMatch;
    const live = active.get(id);
    const run = live?.run ?? loadRun(id);
    if (!run) return sendJSON(res, 404, { error: `unknown run: ${id}` });

    if (req.method === "GET" && !sub) return sendJSON(res, 200, { run });

    if (req.method === "DELETE" && !sub) {
      if (live) return sendJSON(res, 409, { error: "run is still in progress — cancel it first" });
      return sendJSON(res, 200, { deleted: deleteRun(id) });
    }

    if (req.method === "POST" && sub === "/cancel") {
      if (!live) return sendJSON(res, 409, { error: "run is not in progress" });
      live.controller.abort();
      return sendJSON(res, 200, { cancelled: true });
    }

    // Server-sent events: replay what has happened, then stream the rest.
    if (req.method === "GET" && sub === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ type: "snapshot", run })}\n\n`);

      if (!live) {
        res.write(`data: ${JSON.stringify({ type: "done", run: runHeader(run) })}\n\n`);
        return res.end();
      }

      live.subscribers.add(res);
      const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 15_000);
      req.on("close", () => { clearInterval(keepAlive); live.subscribers.delete(res); });
      return undefined;
    }
  }

  if (req.method === "GET" && path.startsWith("/lib/")) {
    const name = path.slice("/lib/".length);
    if (!BROWSER_LIB.has(name)) return sendJSON(res, 404, { error: "not found" });
    return sendFile(res, join(SRC_DIR, name));
  }

  if (req.method === "GET") return serveStatic(res, path);
  return sendJSON(res, 405, { error: "method not allowed" });
}

export function createBenchServer() {
  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJSON(res, 500, { error: err?.message ?? "internal error" });
      else res.end();
    });
  });
}

export function serve({ port = 4000, host = "127.0.0.1" } = {}) {
  const server = createBenchServer();
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      console.log(`llm-harness-bench UI  ->  ${url}`);
      console.log(`system under test     ->  ${SUT_BASE}  (start it with: cd webserver && npm start)`);
      resolvePromise({ server, url });
    });
  });
}
