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

/**
 * Upper bound for the history `limit` query param. Generous enough for any
 * realistic audit view while capping the response size a client can request.
 */
const MAX_HISTORY_LIMIT = 500;

/** Valid rollout percentages are integers 0-100 inclusive. */
const isValidRolloutPercentage = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;

/** A flag carries at most this many tags. */
const MAX_TAGS_PER_FLAG = 10;

/** Individual tags: 1-50 chars of lowercase kebab-case. */
const MAX_TAG_LENGTH = 50;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate a `tags` value from a request body. Returns a human-readable
 * problem description, or `undefined` when the value is acceptable. All
 * failures map to the single `invalid_tags` error code; the message is
 * what tells the caller which rule they broke.
 */
const findTagsProblem = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return "`tags` must be an array of strings.";
  }
  if (value.length > MAX_TAGS_PER_FLAG) {
    return `A flag may have at most ${MAX_TAGS_PER_FLAG} tags.`;
  }
  const seen = new Set<string>();
  for (const tag of value) {
    if (
      typeof tag !== "string" ||
      tag.length < 1 ||
      tag.length > MAX_TAG_LENGTH ||
      !TAG_PATTERN.test(tag)
    ) {
      return `Each tag must be 1-${MAX_TAG_LENGTH} characters of lowercase kebab-case (letters, digits, single dashes).`;
    }
    if (seen.has(tag)) {
      return `Duplicate tag "${tag}".`;
    }
    seen.add(tag);
  }
  return undefined;
};

export function createApp({ store, apiToken }: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/version", (c) => c.json({ version: "0.3.0" }));

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
    // An empty `?tag=` is treated as absent, matching how `/evaluate`
    // handles an empty `unit`: clients that always append the param get
    // the unfiltered list. Filtering is an exact match, so a value that
    // could never be a valid tag simply yields an empty list rather than
    // an error.
    const tagParam = c.req.query("tag");
    const flags = tagParam
      ? store.list().filter((flag) => flag.tags?.includes(tagParam))
      : store.list();
    return c.json({ flags });
  });

  // Distinct tags across all flags with usage counts, sorted by tag name so
  // the response is stable regardless of flag creation order. Deleted flags
  // no longer contribute — this reflects the live flag set only.
  v1.get("/flags/count", (c) => {
    // Cheap cardinality for dashboards that only need a number, split by
    // enabled state so a poller can watch kill-switch churn without paying
    // for the full list. Registered before /flags/:key so "count" is never
    // read as a flag key.
    const flags = store.list();
    const enabled = flags.filter((flag) => flag.enabled).length;
    return c.json({ total: flags.length, enabled, disabled: flags.length - enabled });
  });

  // Compact discovery endpoint for clients that only need stable flag keys.
  v1.get("/flags/keys", (c) =>
    c.json({ keys: store.list().map((flag) => flag.key) }),
  );

  v1.get("/tags", (c) => {
    const counts = new Map<string, number>();
    for (const flag of store.list()) {
      for (const tag of flag.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const tags = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => ({ tag, count }));
    return c.json({ tags });
  });

  // Retire a tag everywhere in one call. Removes the tag from every flag
  // carrying it (the flags themselves are untouched otherwise) and reports
  // how many flags were affected, so bulk cleanups don't require a
  // per-flag PATCH loop. 404s when no live flag carries the tag.
  v1.get("/flags/:key/tags", (c) => {
    // Tag-only read for labelers that poll many flags: cheaper than fetching
    // whole Flag objects, and it never marks a flag as read anywhere.
    const flag = store.get(c.req.param("key"));
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    return c.json({ key: flag.key, tags: flag.tags ?? [] });
  });

  v1.put("/flags/:key/tags/:tag", (c) => {
    // Idempotent single-tag attach for automation that labels flags one at
    // a time; PATCH replaces the whole tag list, which races concurrent
    // labelers. Validation reuses the tag rules so the two paths never drift.
    const key = c.req.param("key");
    const tag = c.req.param("tag");
    const flag = store.get(key);
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    const current = flag.tags ?? [];
    if (current.includes(tag)) {
      return c.json(flag);
    }
    const problem = findTagsProblem([...current, tag]);
    if (problem) {
      return c.json(errorBody("invalid_tags", problem), 400);
    }
    const updated = store.update(key, { tags: [...current, tag] });
    return c.json(updated);
  });

  v1.delete("/flags/:key/tags/:tag", (c) => {
    // Counterpart of the single-tag attach. Removing a tag the flag does not
    // carry is a no-op success so labelers can converge without a read.
    const key = c.req.param("key");
    const tag = c.req.param("tag");
    const flag = store.get(key);
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    const current = flag.tags ?? [];
    if (!current.includes(tag)) {
      return c.json(flag);
    }
    const updated = store.update(key, {
      tags: current.filter((existing) => existing !== tag),
    });
    return c.json(updated);
  });

  v1.delete("/tags/:tag", (c) => {
    const tag = c.req.param("tag");
    const affected = store.list().filter((flag) => flag.tags?.includes(tag));
    if (affected.length === 0) {
      return c.json(
        errorBody("tag_not_found", `No flag carries the tag "${tag}".`),
        404,
      );
    }
    for (const flag of affected) {
      store.update(flag.key, {
        tags: (flag.tags ?? []).filter((existing) => existing !== tag),
      });
    }
    return c.json({ tag, removedFrom: affected.length });
  });

  v1.post("/flags", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be valid JSON."), 400);
    }

    const { key, description, enabled, rolloutPercentage, tags } = (body ?? {}) as Record<string, unknown>;

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
    if (tags !== undefined) {
      const problem = findTagsProblem(tags);
      if (problem) {
        return c.json(errorBody("invalid_tags", problem), 400);
      }
    }
    if (store.has(key)) {
      return c.json(errorBody("flag_exists", `A flag with key "${key}" already exists.`), 409);
    }

    const flag = store.create({
      key,
      description,
      enabled,
      rolloutPercentage,
      tags: tags as string[] | undefined,
    });
    return c.json(flag, 201);
  });

  v1.get("/flags/:key/status", (c) => {
    // Lightweight control-plane read for dashboards that need the master
    // switch without descriptions, tags, rollout metadata, or history.
    const flag = store.get(c.req.param("key"));
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    return c.json({ key: flag.key, enabled: flag.enabled });
  });

  v1.get("/flags/:key/rollout", (c) => {
    // Lightweight rollout read for clients that already cache the master
    // switch and only need the current percentage policy.
    const flag = store.get(c.req.param("key"));
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    return c.json({
      key: flag.key,
      rolloutPercentage: flag.rolloutPercentage ?? null,
    });
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

    const { description, enabled, rolloutPercentage, tags } = (body ?? {}) as Record<string, unknown>;

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
    if (tags !== undefined) {
      const problem = findTagsProblem(tags);
      if (problem) {
        return c.json(errorBody("invalid_tags", problem), 400);
      }
    }
    if (
      enabled === undefined &&
      description === undefined &&
      rolloutPercentage === undefined &&
      tags === undefined
    ) {
      return c.json(
        errorBody(
          "empty_update",
          "Provide at least one of `enabled`, `description`, `rolloutPercentage`, or `tags`.",
        ),
        400,
      );
    }

    const patch: UpdateFlagInput = {};
    if (enabled !== undefined) patch.enabled = enabled;
    if (description !== undefined) patch.description = description;
    if (rolloutPercentage !== undefined) patch.rolloutPercentage = rolloutPercentage;
    if (tags !== undefined) patch.tags = tags as string[];

    const updated = store.update(c.req.param("key"), patch);
    if (!updated) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    return c.json(updated);
  });

  v1.post("/flags/:key/toggle", (c) => {
    // A body-free flip for kill-switch scripts and chat-ops: it avoids the
    // read-then-PATCH round trip that can race a concurrent update, and it
    // records the same "updated" history event PATCH would.
    const key = c.req.param("key");
    const flag = store.get(key);
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    const updated = store.update(key, { enabled: !flag.enabled });
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
    // An empty `?limit=` is treated as absent, mirroring how `/evaluate`
    // handles an empty `unit`, so callers that always append the param
    // get the full history rather than an error.
    const limitParam = c.req.query("limit");
    let limit: number | undefined;
    if (limitParam) {
      // Strict digit parse: `Number()` alone would accept "1e2" and
      // "0x10", which we don't want to silently honor in an API contract.
      limit = /^\d+$/.test(limitParam) ? Number(limitParam) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        return c.json(
          errorBody(
            "invalid_limit",
            `\`limit\` must be a positive integer no greater than ${MAX_HISTORY_LIMIT}.`,
          ),
          400,
        );
      }
    }
    // History outlives the flag: a deleted flag still answers with its
    // events (ending in "deleted"); only never-created keys 404.
    const events = store.history(key);
    if (!events) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    // `limit` keeps the most recent events but preserves oldest-first
    // ordering, so a limited response is always a suffix of the full one.
    const limited = limit !== undefined ? events.slice(-limit) : events;
    return c.json({ key, events: limited });
  });

  app.route("/v1", v1);

  app.notFound((c) => c.json(errorBody("not_found", "Route not found."), 404));

  return app;
}
