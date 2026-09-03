// env.js — load the project-root `.env` into process.env, never overriding real environment
// variables.
//
// Imported first by every entry point and by providers/index.js (which everything else imports),
// so `PORT`, `RESULTS_DIR`, `OLLAMA_BASE_URL` and the *_API_KEY values in `.env` are visible to any
// module that reads process.env at load time.

import { loadEnvFile } from "./util.js";

for (const [key, value] of Object.entries(loadEnvFile())) {
  if (process.env[key] === undefined) process.env[key] = value;
}
