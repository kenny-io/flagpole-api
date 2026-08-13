/**
 * Flagpole server entrypoint.
 *
 * Configuration is environment-only (twelve-factor style):
 *   PORT                — listen port (default 3333)
 *   FLAGPOLE_API_TOKEN  — bearer token for /v1 routes; unset disables auth
 *   FLAGPOLE_DATA_FILE  — JSON file for persistence; unset keeps flags in memory
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createStore } from "./store.js";

const port = Number(process.env.PORT ?? 3333);
const apiToken = process.env.FLAGPOLE_API_TOKEN;
const dataFile = process.env.FLAGPOLE_DATA_FILE;

const store = createStore(dataFile);
const app = createApp({ store, apiToken });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Flagpole listening on http://localhost:${info.port}`);
  console.log(`  auth:        ${apiToken ? "bearer token required" : "disabled (dev mode)"}`);
  console.log(`  persistence: ${dataFile ?? "in-memory only"}`);
});
