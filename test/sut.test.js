// The system under test's scenario endpoints, run in-process on a random port. Nothing here needs a
// model; it pins the contract the restock tasks are scored against.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.PORT = "0";
const { server } = await import("../webserver/server.js");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const j = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

test("scenarios: seeded creation is reproducible; low count and size hold", async () => {
  const a = await j("POST", "/api/scenarios", { low: 3, seed: 42 });
  const b = await j("POST", "/api/scenarios", { low: 3, seed: 42 });
  assert.equal(a.status, 201);
  assert.deepEqual(a.data.items, b.data.items);
  assert.notEqual(a.data.id, b.data.id);
  assert.equal(a.data.items.length, 8);
  assert.equal(a.data.items.filter((i) => i.qty < i.min).length, 3);
  assert.ok(a.data.items.every((i) => i.target > i.min && i.status === "ok" && /^sku-\d{4}$/.test(i.id)));
  const big = await j("POST", "/api/scenarios", { low: 12 });
  assert.equal(big.data.items.length, 26);
  assert.equal(big.data.items.filter((i) => i.qty < i.min).length, 12);
});

test("update hands out one ticket per item; confirm needs exactly the outstanding set; the state records it all", async () => {
  const { data: s } = await j("POST", "/api/scenarios", { low: 2, seed: 7 });
  const low = s.items.filter((i) => i.qty < i.min);
  const other = s.items.find((i) => i.qty >= i.min);
  assert.equal((await j("GET", `/api/scenarios/${s.id}/items`)).data.items.length, s.items.length);
  const u1 = await j("PATCH", `/api/scenarios/${s.id}/items/${low[0].id}`, { qty: low[0].target, status: "reordered" });
  assert.equal(u1.status, 200);
  assert.equal(u1.data.item.qty, low[0].target);
  assert.match(u1.data.ticket, /^tkt-/);
  const again = await j("PATCH", `/api/scenarios/${s.id}/items/${low[0].id}`, { status: "reordered" });
  assert.equal(again.data.ticket, u1.data.ticket, "same item, same ticket");
  // Confirming while an item is still low is refused, whatever the tickets say.
  const early = await j("POST", `/api/scenarios/${s.id}/confirm`, { tickets: [u1.data.ticket] });
  assert.equal(early.status, 409);
  assert.equal(early.data.stillLow, 1);
  assert.match(early.data.error, /still below their minimum/);
  const summary = (await j("GET", `/api/scenarios/${s.id}/summary`)).data;
  assert.equal(summary.low, 1);
  assert.equal(summary.items, s.items.length);
  assert.equal(summary.totalQty, s.items.reduce((a, i) => a + (i.id === low[0].id ? low[0].target : i.qty), 0));
  const u2 = await j("PATCH", `/api/scenarios/${s.id}/items/${low[1].id}`, { qty: low[1].target, status: "reordered" });
  const bad = await j("POST", `/api/scenarios/${s.id}/confirm`, { tickets: [u1.data.ticket, "tkt-nope"] });
  assert.equal(bad.status, 409);
  assert.deepEqual({ outstanding: bad.data.outstanding, missing: bad.data.missing, unknown: bad.data.unknown }, { outstanding: 2, missing: 1, unknown: 1 });
  const empty = await j("POST", `/api/scenarios/${s.id}/confirm`, { tickets: [] });
  assert.equal(empty.status, 409);
  assert.equal(empty.data.missing, 2);
  const ok = await j("POST", `/api/scenarios/${s.id}/confirm`, { tickets: [u2.data.ticket, u1.data.ticket] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { confirmed: true, count: 2 });
  const state = (await j("GET", `/api/scenarios/${s.id}`)).data;
  assert.equal(state.confirmed, true);
  assert.equal(state.items.find((i) => i.id === other.id).qty, other.qty, "an untouched item is unchanged");
  assert.deepEqual(state.ops.map((o) => o.op), ["list", "update", "update", "confirm", "summary", "update", "confirm", "confirm", "confirm"]);
  assert.equal((await j("GET", `/api/scenarios/${s.id}/summary`)).data.confirmed, true);
  assert.equal((await j("PATCH", `/api/scenarios/${s.id}/items/${low[0].id}`, { qty: -1 })).status, 400);
  assert.equal((await j("PATCH", `/api/scenarios/${s.id}/items/${low[0].id}`, {})).status, 400);
  assert.equal((await j("PATCH", `/api/scenarios/${s.id}/items/sku-0000`, { qty: 1 })).status, 404);
  assert.equal((await j("GET", "/api/scenarios/scn-nope")).status, 404);
  assert.equal((await j("POST", `/api/scenarios/${s.id}/confirm`, {})).status, 400);
});
