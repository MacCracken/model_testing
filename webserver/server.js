import express from "express";
import { randomUUID } from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get("/", (req, res) => {
  res.json({
    service: "webserver",
    endpoints: [
      "GET /health",
      "GET /api/hello?name=your-name",
      "GET /api/recent?since=<ISO timestamp>",
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
