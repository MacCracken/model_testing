// Simple test for ornith provider
import { Client } from './src/providers/client.js';

const client = new Client({
  name: "local:ornith-1.5:9b",
  model: "ornith-1.5:9b",
  apiKey: "local-token-placeholder",
  url: "http://localhost:11434/v1/chat/completions",
  provider: "local"
});

async function test() {
  const tools = [{
    name: "hello",
    description: "Get a greeting for a person's name. Can handle one or multiple names. Returns { messages (array of {name, message}), id }.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name(s) to greet. Can be a single string or comma-separated names.",
        },
      },
      required: ["name"],
    }
  }];

  console.log("Sending initial request...\n");
  const resp = await client.runWithTools(
    "Call the hello tool for these names: alice, bob, and carol. Return one greeting object per name as an array.",
    tools,
    "You are a precise API client. Use the provided tools and return exactly the requested structured data."
  );

  console.log("\n=== RESPONSE ===");
  console.log("text:", resp.text);
  console.log("toolCalls:", JSON.stringify(resp.toolCalls, null, 2));
  console.log("structured:", JSON.stringify(resp.structured, null, 2));
  console.log("finishReason:", resp.finishReason);
}

test().catch(console.error);
