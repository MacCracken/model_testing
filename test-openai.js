import { Client } from "./src/providers/client.js";

const key = process.env.OPENAI_API_KEY;
const client = new Client({
  name: "openai:gpt-4o-mini",
  model: "gpt-4o-mini",
  apiKey: key,
  url: "https://api.openai.com/v1/chat/completions",
  provider: "openai"
});

const tools = [{
  name: "health",
  description: "Check the webserver health",
  parameters: { type: "object", properties: {}, required: [] }
}];

const system = "You are a precise API client. Use the provided tools and return exactly the requested structured data.";
const prompt = "Report the current health of the webserver using the health tool.";

async function run() {
  const resp = await client.runWithTools(prompt, [tools[0]], system, { maxRounds: 2 });
  console.log("=== RAW RESPONSE ===");
  console.log(JSON.stringify(resp, null, 2));
}

run().catch(console.error);
