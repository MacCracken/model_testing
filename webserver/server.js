import express from "express";
import { randomUUID } from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });
});

// The last few hundred /api/hello replies, newest last. Test infrastructure for the benchmark's
// real-harness arms: a harness may reshape its tool output (jq, scripts), so the bench asks the
// server what it actually served during a trial's window instead of scraping the harness.
const RECENT_MAX = 500;
const recent = [];

app.get("/api/hello", (req, res) => {
  const name = (req.query.name || "world").toString();
  const reply = { message: `Hello, ${name}!`, id: randomUUID() };
  recent.push({ at: new Date().toISOString(), name, ...reply });
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  res.json(reply);
});

// GET /api/recent?since=<ISO>[&until=<ISO>] — the /api/hello replies served in that window.
app.get("/api/recent", (req, res) => {
  const since = req.query.since ? String(req.query.since) : "";
  const until = req.query.until ? String(req.query.until) : "";
  res.json({ responses: recent.filter((r) => (!since || r.at >= since) && (!until || r.at <= until)) });
});

// ---- inventory scenarios ---------------------------------------------------------------------
// An isolated inventory per scenario, so concurrent callers never share state: items with a
// quantity, a minimum and a restock target. Updating an item hands out a ticket (one per item);
// confirming with the complete set of tickets closes the job. Everything is kept in memory and
// reported back by GET /api/scenarios/:sid, which is how a caller (the bench) reads the end state.
const SCENARIO_MAX = 1000;
const scenarios = new Map();
const PART_NAMES = [
  "bolt", "washer", "gasket", "bearing", "spring", "valve", "filter", "pulley", "bracket", "hinge",
  "socket", "flange", "rivet", "grommet", "coupler", "nozzle", "sensor", "relay", "fuse", "diode",
  "gear", "shaft", "piston", "seal", "clamp", "bushing", "spacer", "rotor", "stator", "wick",
];

// mulberry32: a small deterministic generator, so a seeded scenario is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeScenario({ low = 3, size = null, seed = null } = {}) {
  const lowN = Math.max(1, Math.min(30, Math.floor(Number(low)) || 3));
  const sizeN = Math.max(lowN + 1, Math.min(60, Math.floor(Number(size)) || lowN * 2 + 2));
  const s = seed === null || seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(seed) >>> 0;
  const rand = rng(s);
  const pick = (n) => Math.floor(rand() * n);
  const names = [...PART_NAMES];
  const used = new Set();
  const items = [];
  for (let i = 0; i < sizeN; i++) {
    let id;
    do { id = `sku-${1000 + pick(9000)}`; } while (used.has(id));
    used.add(id);
    const name = names.length ? names.splice(pick(names.length), 1)[0] : `part-${i}`;
    const min = 5 + pick(20);
    const qty = i < lowN ? pick(min) : min + pick(30); // the first lowN are below their minimum
    items.push({ id, name, qty, min, target: min * 2 + pick(10), status: "ok" });
  }
  for (let i = items.length - 1; i > 0; i--) { // shuffle, so the low items are not listed first
    const j = pick(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  const scenario = {
    id: `scn-${randomUUID().slice(0, 8)}`,
    seed: s,
    createdAt: new Date().toISOString(),
    items,
    tickets: {},
    confirmed: false,
    confirmedTickets: null,
    ops: [],
  };
  scenarios.set(scenario.id, scenario);
  if (scenarios.size > SCENARIO_MAX) scenarios.delete(scenarios.keys().next().value);
  return scenario;
}

function scenarioFor(req, res) {
  const s = scenarios.get(req.params.sid);
  if (!s) res.status(404).json({ error: "unknown scenario", id: req.params.sid });
  return s;
}
const stamp = () => new Date().toISOString();

// POST /api/scenarios { low?, size?, seed? } → a fresh scenario and its items.
app.post("/api/scenarios", (req, res) => {
  const s = makeScenario(req.body ?? {});
  res.status(201).json({ id: s.id, seed: s.seed, items: s.items });
});

// GET /api/scenarios/:sid → the whole state, including the operation log.
app.get("/api/scenarios/:sid", (req, res) => {
  const s = scenarioFor(req, res);
  if (!s) return;
  res.json({ id: s.id, seed: s.seed, items: s.items, tickets: s.tickets, confirmed: s.confirmed, confirmedTickets: s.confirmedTickets, ops: s.ops });
});

app.get("/api/scenarios/:sid/items", (req, res) => {
  const s = scenarioFor(req, res);
  if (!s) return;
  s.ops.push({ at: stamp(), op: "list" });
  res.json({ items: s.items });
});

// GET /api/scenarios/:sid/summary → counts and the total quantity right now; `low` is how many items
// are still below their minimum.
app.get("/api/scenarios/:sid/summary", (req, res) => {
  const s = scenarioFor(req, res);
  if (!s) return;
  s.ops.push({ at: stamp(), op: "summary" });
  res.json({
    items: s.items.length,
    totalQty: s.items.reduce((a, i) => a + i.qty, 0),
    low: s.items.filter((i) => i.qty < i.min).length,
    confirmed: s.confirmed,
  });
});

app.get("/api/scenarios/:sid/items/:id", (req, res) => {
  const s = scenarioFor(req, res);
  if (!s) return;
  const item = s.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "unknown item", id: req.params.id });
  s.ops.push({ at: stamp(), op: "get", id: item.id });
  res.json(item);
});

// PATCH /api/scenarios/:sid/items/:id { qty?, status? } → { item, ticket }. The ticket is per item:
// updating the same item again returns the same ticket.
app.patch("/api/scenarios/:sid/items/:id", (req, res) => {
  const s = scenarioFor(req, res);
  if (!s) return;
  const item = s.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "unknown item", id: req.params.id });
  const body = req.body ?? {};
  const changes = {};
  if (body.qty !== undefined) {
    const q = Number(body.qty);
    if (!Number.isInteger(q) || q < 0) return res.status(400).json({ error: "qty must be a non-negative integer" });
    changes.qty = q;
  }
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !body.status.trim()) return res.status(400).json({ error: "status must be a non-empty string" });
    changes.status = body.status.trim();
  }
  if (!Object.keys(changes).length) return res.status(400).json({ error: "nothing to update: send qty and/or status" });
  Object.assign(item, changes);
  const ticket = s.tickets[item.id] ?? (s.tickets[item.id] = `tkt-${randomUUID().slice(0, 6)}`);
  s.ops.push({ at: stamp(), op: "update", id: item.id, changes });
  res.json({ item, ticket });
});

// POST /api/scenarios/:sid/confirm { tickets: [...] } → { confirmed: true, count }. 409 while any item
// is still below its minimum (the job is not done), or when the set is not exactly the outstanding
// tickets. Counts only — no ids are leaked; the caller has to go and look.
app.post("/api/scenarios/:sid/confirm", (req, res) => {
  const s = scenarioFor(req, res);
  if (!s) return;
  const given = Array.isArray(req.body?.tickets) ? req.body.tickets.map(String) : null;
  if (!given) return res.status(400).json({ error: "send { tickets: [...] }" });
  const open = Object.values(s.tickets);
  const set = new Set(given);
  const missing = open.filter((t) => !set.has(t)).length;
  const unknown = given.filter((t) => !open.includes(t)).length;
  const stillLow = s.items.filter((i) => i.qty < i.min).length;
  const ok = open.length > 0 && !missing && !unknown && !stillLow;
  s.ops.push({ at: stamp(), op: "confirm", tickets: given, ok });
  if (stillLow) return res.status(409).json({ error: `${stillLow} item(s) are still below their minimum — restock them before confirming`, stillLow, outstanding: open.length });
  if (!ok) return res.status(409).json({ error: "the ticket set does not match the outstanding tickets", outstanding: open.length, missing, unknown });
  s.confirmed = true;
  s.confirmedTickets = [...open];
  res.json({ confirmed: true, count: open.length });
});

app.get("/", (req, res) => {
  res.json({
    service: "webserver",
    endpoints: [
      "GET /health",
      "GET /api/hello?name=your-name",
      "GET /api/recent?since=<ISO timestamp>",
      "POST /api/scenarios { low?, size?, seed? }",
      "GET /api/scenarios/:sid",
      "GET /api/scenarios/:sid/items",
      "GET /api/scenarios/:sid/items/:id",
      "GET /api/scenarios/:sid/summary",
      "PATCH /api/scenarios/:sid/items/:id { qty?, status? }",
      "POST /api/scenarios/:sid/confirm { tickets: [] }",
    ],
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "not found", path: req.path });
});

const server = app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});

export { server };
