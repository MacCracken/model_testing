// preflight.js — is everything a run needs answering? Asked before the matrix starts, and handed to
// `runMatrix` as the checks behind its dead-endpoint stop.
//
// An unattended run once wrote 152 error rows in three seconds against a model that had left the
// server, and three whole runs against a daemon that was down for ninety minutes. None of that says
// anything about a model, so a run now asks first — each model's endpoint (listed, and a plain
// request comes back) and the webserver when a selected task runs against it — and refuses to start
// on a no. Mid-run the same checks tell an outage from a model's failures (see `runMatrix`). Node
// only: the runner is served to the browser and takes these as functions.

import { pingClient } from "./probe.js";
import { resolveClients, probeLocalModels, PROVIDERS } from "./providers/index.js";
import { BASE } from "./tasks/util.js";

const listModels = (provider) => probeLocalModels({ provider, timeoutMs: 3000 });

// The check for one of a run's clients. A variant (`<client>@abstain`) is its base client's
// endpoint, and a ping goes out plain: the treatment is not what is being asked about. An arm is a
// program on this machine with its own login, not an endpoint — it is not pinged.
// A hosted route answers a ping in a second or two; a local endpoint may have to load the model
// first (an 18 GB model from cold takes the better part of a minute), so it gets three.
export const PING_TIMEOUT_MS = { hosted: 60_000, local: 180_000 };

export function checkClientWith({ ping = pingClient, resolve = resolveClients, timeoutMs = null, isLocal = (provider) => !!PROVIDERS[provider]?.local } = {}) {
  return async (client) => {
    if (client?.structuredOnly) return { ok: true, note: "a harness arm (not pinged)" };
    const name = client?.baseName ?? client?.name;
    let base = null;
    try { base = resolve(name)[0] ?? null; } catch { base = null; }
    const provider = String(name ?? "").split(":")[0];
    return ping(base ?? client, { listModels, timeoutMs: timeoutMs ?? (isLocal(provider) ? PING_TIMEOUT_MS.local : PING_TIMEOUT_MS.hosted) });
  };
}

export async function checkServer({ base = BASE, timeoutMs = 3000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { ok: true, note: `${base} is up` } : { ok: false, note: `${base}/health answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, note: `nothing answers at ${base} (${err?.message ?? err}) — start it with: node webserver/server.js` };
  }
}

// Every distinct endpoint of the run, and the webserver when a selected task needs it, asked at
// once. → { ok, checked: [{ what, ok, note }], problems: [string] }.
export async function preflight({ clients = [], tasks = [] } = {}, { checkClient = checkClientWith(), server = checkServer } = {}) {
  const seen = new Map();
  for (const c of clients) {
    const key = c?.baseName ?? c?.name;
    if (key && !seen.has(key) && !c.structuredOnly) seen.set(key, c);
  }
  const jobs = [...seen.entries()].map(async ([what, c]) => ({ what, ...(await checkClient(c)) }));
  const needy = tasks.filter((t) => t.server).map((t) => t.name);
  if (needy.length) jobs.push(server().then((v) => ({ what: "the webserver", needs: needy, ...v })));
  const checked = await Promise.all(jobs);
  // A client names itself in its own errors; the problem line says it once.
  const said = (c) => (String(c.note).startsWith(`${c.what}: `) ? String(c.note).slice(c.what.length + 2) : c.note);
  const problems = checked.filter((c) => !c.ok).map((c) => `${c.what}: ${said(c)}${c.needs ? ` — needed by ${c.needs.slice(0, 6).join(", ")}${c.needs.length > 6 ? `, … (${c.needs.length} tasks)` : ""}` : ""}`);
  return { ok: problems.length === 0, checked, problems };
}
