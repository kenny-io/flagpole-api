/**
 * Flagpole HTTP application.
 *
 * Exposes a factory rather than a singleton so tests (and embedders) can
 * spin up isolated instances with their own store and auth configuration.
 * Route handlers only deal with HTTP concerns — validation, status codes,
 * and the uniform error envelope — while all state lives in the store.
 */

import { Hono } from "hono";
import { isEnabledForUnit } from "./rollout.js";
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

/** Valid rollout percentages are integers 0-100 inclusive. */
const isValidRolloutPercentage = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;

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

    const { key, description, enabled, rolloutPercentage } = (body ?? {}) as Record<string, unknown>;

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
    if (rolloutPercentage !== undefined && !isValidRolloutPercentage(rolloutPercentage)) {
      return c.json(
        errorBody("invalid_rollout_percentage", "`rolloutPercentage` must be an integer between 0 and 100."),
        400,
      );
    }
    if (store.has(key)) {
      return c.json(errorBody("flag_exists", `A flag with key "${key}" already exists.`), 409);
    }

    const flag = store.create({ key, description, enabled, rolloutPercentage });
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

    const { description, enabled, rolloutPercentage } = (body ?? {}) as Record<string, unknown>;

    if (enabled !== undefined && typeof enabled !== "boolean") {
      return c.json(errorBody("invalid_enabled", "`enabled` must be a boolean."), 400);
    }
    if (description !== undefined && typeof description !== "string") {
      return c.json(errorBody("invalid_description", "`description` must be a string."), 400);
    }
    if (rolloutPercentage !== undefined && !isValidRolloutPercentage(rolloutPercentage)) {
      return c.json(
        errorBody("invalid_rollout_percentage", "`rolloutPercentage` must be an integer between 0 and 100."),
        400,
      );
    }
    if (enabled === undefined && description === undefined && rolloutPercentage === undefined) {
      return c.json(
        errorBody("empty_update", "Provide at least one of `enabled`, `description`, or `rolloutPercentage`."),
        400,
      );
    }

    const patch: UpdateFlagInput = {};
    if (enabled !== undefined) patch.enabled = enabled;
    if (description !== undefined) patch.description = description;
    if (rolloutPercentage !== undefined) patch.rolloutPercentage = rolloutPercentage;

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
    // An empty `?unit=` is treated as absent so pollers that always append
    // the param get the plain boolean rather than a surprise bucket.
    const unitParam = c.req.query("unit");
    const unit = unitParam ? unitParam : undefined;
    const enabled = isEnabledForUnit(flag.key, flag.enabled, flag.rolloutPercentage, unit);
    // Minimal payload on purpose: this is the hot path SDKs poll.
    const result: { key: string; enabled: boolean; rolloutPercentage?: number } = {
      key: flag.key,
      enabled,
    };
    if (flag.rolloutPercentage !== undefined) {
      result.rolloutPercentage = flag.rolloutPercentage;
    }
    return c.json(result);
  });

  v1.get("/flags/:key/history", (c) => {
    const key = c.req.param("key");
    // History outlives the flag: a deleted flag still answers with its
    // events (ending in "deleted"); only never-created keys 404.
    const events = store.history(key);
    if (!events) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    return c.json({ key, events });
  });

  app.route("/v1", v1);

  app.notFound((c) => c.json(errorBody("not_found", "Route not found."), 404));

  return app;
}
