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

app.get("/api/hello", (req, res) => {
  const name = (req.query.name || "world").toString();
  res.json({ message: `Hello, ${name}!`, id: randomUUID() });
});

app.get("/", (req, res) => {
  res.json({
    service: "webserver",
    endpoints: [
      "GET /health",
      "GET /api/hello?name=your-name",
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
