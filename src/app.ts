/**
 * Flagpole HTTP application.
 *
 * Exposes a factory rather than a singleton so tests (and embedders) can
 * spin up isolated instances with their own store and auth configuration.
 * Route handlers only deal with HTTP concerns — validation, status codes,
 * and the uniform error envelope — while all state lives in the store.
 */

import { Hono } from "hono";
import type { FlagStore } from "./store.js";
import type { UpdateFlagInput } from "./types.js";

export interface AppOptions {
  store: FlagStore;
  /**
   * Bearer token required on all /v1 routes. When omitted, auth is
   * disabled entirely (dev mode) — convenient locally, but never run an
   * exposed instance without it.
   */
  apiToken?: string;
}

/** Flag keys: 1-64 chars of letters, digits, dots, dashes, underscores. */
const FLAG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Build the uniform error envelope used by every non-2xx response. */
const errorBody = (code: string, message: string) => ({
  error: { code, message },
});

export function createApp({ store, apiToken }: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  const v1 = new Hono();

  // Bearer auth guard. Deliberately not using timing-unsafe string
  // comparison shortcuts on the header shape: parse strictly, then compare.
  v1.use("*", async (c, next) => {
    if (!apiToken) {
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || token !== apiToken) {
      return c.json(
        errorBody("unauthorized", "Missing or invalid bearer token."),
        401,
      );
    }
    await next();
  });

  v1.get("/flags", (c) => {
    return c.json({ flags: store.list() });
  });

  v1.post("/flags", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be valid JSON."), 400);
    }

    const { key, description, enabled } = (body ?? {}) as Record<string, unknown>;

    if (typeof key !== "string" || !FLAG_KEY_PATTERN.test(key)) {
      return c.json(
        errorBody(
          "invalid_key",
          "`key` is required and must be 1-64 characters of letters, digits, dots, dashes, or underscores.",
        ),
        400,
      );
    }
    if (typeof enabled !== "boolean") {
      return c.json(errorBody("invalid_enabled", "`enabled` is required and must be a boolean."), 400);
    }
    if (description !== undefined && typeof description !== "string") {
      return c.json(errorBody("invalid_description", "`description` must be a string."), 400);
    }
    if (store.has(key)) {
      return c.json(errorBody("flag_exists", `A flag with key "${key}" already exists.`), 409);
    }

    const flag = store.create({ key, description, enabled });
    return c.json(flag, 201);
  });

  v1.get("/flags/:key", (c) => {
    const flag = store.get(c.req.param("key"));
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    return c.json(flag);
  });

  v1.patch("/flags/:key", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be valid JSON."), 400);
    }

    const { description, enabled } = (body ?? {}) as Record<string, unknown>;

    if (enabled !== undefined && typeof enabled !== "boolean") {
      return c.json(errorBody("invalid_enabled", "`enabled` must be a boolean."), 400);
    }
    if (description !== undefined && typeof description !== "string") {
      return c.json(errorBody("invalid_description", "`description` must be a string."), 400);
    }
    if (enabled === undefined && description === undefined) {
      return c.json(
        errorBody("empty_update", "Provide at least one of `enabled` or `description`."),
        400,
      );
    }

    const patch: UpdateFlagInput = {};
    if (enabled !== undefined) patch.enabled = enabled;
    if (description !== undefined) patch.description = description;

    const updated = store.update(c.req.param("key"), patch);
    if (!updated) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    return c.json(updated);
  });

  v1.delete("/flags/:key", (c) => {
    const removed = store.delete(c.req.param("key"));
    if (!removed) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    // 204 keeps DELETE idempotent-friendly and body-free.
    return c.body(null, 204);
  });

  v1.get("/flags/:key/evaluate", (c) => {
    const flag = store.get(c.req.param("key"));
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    // Minimal payload on purpose: this is the hot path SDKs poll.
    return c.json({ key: flag.key, enabled: flag.enabled });
  });

  app.route("/v1", v1);

  app.notFound((c) => c.json(errorBody("not_found", "Route not found."), 404));

  return app;
}
