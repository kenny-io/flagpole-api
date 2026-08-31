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
import {
  createEnvironmentRegistry,
  ENVIRONMENT_KEY_PATTERN,
  MAX_ENVIRONMENT_KEY_LENGTH,
  type EnvironmentRegistry,
} from "./environments.js";
import {
  createWebhookRegistry,
  MAX_WEBHOOK_URL_LENGTH,
  WEBHOOK_EVENTS,
  type WebhookEvent,
  type WebhookRegistry,
} from "./webhooks.js";

export interface AppOptions {
  store: FlagStore;
  /** Webhook subscriptions. A fresh in-memory registry when omitted. */
  webhooks?: WebhookRegistry;
  /** Environment registry. Seeded with the three defaults when omitted. */
  environments?: EnvironmentRegistry;
  /**
   * Bearer token required on all /v1 routes. When omitted, auth is
   * disabled entirely (dev mode) — convenient locally, but never run an
   * exposed instance without it.
   */
  apiToken?: string;
}

/** Public release identifier returned by unauthenticated service probes. */
const API_VERSION = "1.0.0";

/** Flag keys: 1-64 chars of letters, digits, dots, dashes, underscores. */
const FLAG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Largest page a single `GET /v1/flags` response will return. */
const MAX_PAGE_SIZE = 200;

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

export function createApp({
  store,
  apiToken,
  webhooks = createWebhookRegistry(),
  environments = createEnvironmentRegistry(),
}: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", version: API_VERSION }));
  app.get("/version", (c) => c.json({ version: API_VERSION }));

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
    const matching = tagParam
      ? store.list().filter((flag) => flag.tags?.includes(tagParam))
      : store.list();
    // 1.0 paginates this endpoint. `page`/`perPage` are optional and default
    // to the whole list, so a caller that ignores them still receives every
    // flag; `total` is always the unpaginated count.
    const pageParam = c.req.query("page");
    const perPageParam = c.req.query("perPage");
    if (
      (pageParam !== undefined && !/^\d+$/.test(pageParam)) ||
      (perPageParam !== undefined && !/^\d+$/.test(perPageParam))
    ) {
      return c.json(
        errorBody("invalid_pagination", "`page` and `perPage` must be positive integers."),
        400,
      );
    }
    const perPage = perPageParam ? Number(perPageParam) : matching.length;
    const page = pageParam ? Number(pageParam) : 1;
    if (page < 1 || (perPageParam !== undefined && (perPage < 1 || perPage > MAX_PAGE_SIZE))) {
      return c.json(
        errorBody(
          "invalid_pagination",
          `\`page\` must be at least 1 and \`perPage\` at most ${MAX_PAGE_SIZE}.`,
        ),
        400,
      );
    }
    const start = (page - 1) * perPage;
    return c.json({
      flags: matching.slice(start, start + perPage),
      total: matching.length,
      page,
      perPage,
    });
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

  // ---------------------------------------------------------------- webhooks
  v1.post("/webhooks", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be valid JSON."), 400);
    }
    const { url, events, secret } = (body ?? {}) as Record<string, unknown>;
    if (typeof url !== "string" || url.length === 0 || url.length > MAX_WEBHOOK_URL_LENGTH) {
      return c.json(
        errorBody("invalid_webhook_url", `\`url\` must be 1-${MAX_WEBHOOK_URL_LENGTH} characters.`),
        400,
      );
    }
    if (!/^https:\/\//.test(url)) {
      return c.json(
        errorBody("invalid_webhook_url", "`url` must be an https:// endpoint."),
        400,
      );
    }
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.some((event) => !WEBHOOK_EVENTS.includes(event as WebhookEvent))
    ) {
      return c.json(
        errorBody(
          "invalid_webhook_events",
          `\`events\` must name at least one of: ${WEBHOOK_EVENTS.join(", ")}.`,
        ),
        400,
      );
    }
    if (secret !== undefined && (typeof secret !== "string" || secret.length < 16)) {
      return c.json(
        errorBody("invalid_webhook_secret", "`secret` must be at least 16 characters."),
        400,
      );
    }
    const webhook = webhooks.create({
      url,
      events: events as WebhookEvent[],
      ...(secret !== undefined ? { secret: secret as string } : {}),
    });
    return c.json(webhook, 201);
  });

  v1.get("/webhooks", (c) => c.json({ webhooks: webhooks.list() }));

  v1.get("/webhooks/:id", (c) => {
    const webhook = webhooks.get(c.req.param("id"));
    if (!webhook) {
      return c.json(errorBody("webhook_not_found", "No webhook with that id."), 404);
    }
    return c.json(webhook);
  });

  v1.delete("/webhooks/:id", (c) => {
    if (!webhooks.delete(c.req.param("id"))) {
      return c.json(errorBody("webhook_not_found", "No webhook with that id."), 404);
    }
    return c.body(null, 204);
  });

  v1.post("/webhooks/:id/test", (c) => {
    const webhook = webhooks.get(c.req.param("id"));
    if (!webhook) {
      return c.json(errorBody("webhook_not_found", "No webhook with that id."), 404);
    }
    // A test delivery is recorded against the subscription's first event so
    // integrators can verify wiring without waiting for a real flag change.
    const [delivery] = webhooks.dispatch(webhook.events[0]!);
    return c.json({ delivery }, 202);
  });

  v1.get("/webhooks/:id/deliveries", (c) => {
    const statusParam = c.req.query("status");
    if (statusParam !== undefined && !["pending", "delivered", "failed"].includes(statusParam)) {
      return c.json(
        errorBody("invalid_delivery_status", "`status` must be pending, delivered, or failed."),
        400,
      );
    }
    const limitParam = c.req.query("limit");
    if (limitParam !== undefined && !/^\d+$/.test(limitParam)) {
      return c.json(errorBody("invalid_limit", "`limit` must be a positive integer."), 400);
    }
    const deliveries = webhooks.deliveries(c.req.param("id"), {
      ...(statusParam ? { status: statusParam as "pending" | "delivered" | "failed" } : {}),
      ...(limitParam ? { limit: Number(limitParam) } : {}),
    });
    if (!deliveries) {
      return c.json(errorBody("webhook_not_found", "No webhook with that id."), 404);
    }
    return c.json({ deliveries });
  });

  // ------------------------------------------------------------ environments
  v1.get("/environments", (c) => c.json({ environments: environments.list() }));

  v1.post("/environments", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be valid JSON."), 400);
    }
    const { key, displayName } = (body ?? {}) as Record<string, unknown>;
    if (
      typeof key !== "string" ||
      key.length > MAX_ENVIRONMENT_KEY_LENGTH ||
      !ENVIRONMENT_KEY_PATTERN.test(key)
    ) {
      return c.json(
        errorBody(
          "invalid_environment_key",
          `\`key\` must be 1-${MAX_ENVIRONMENT_KEY_LENGTH} characters of lowercase kebab-case.`,
        ),
        400,
      );
    }
    if (displayName !== undefined && typeof displayName !== "string") {
      return c.json(errorBody("invalid_display_name", "`displayName` must be a string."), 400);
    }
    const environment = environments.create(key, displayName as string | undefined);
    if (!environment) {
      return c.json(errorBody("environment_exists", "That environment already exists."), 409);
    }
    return c.json(environment, 201);
  });

  v1.get("/flags/:key/environments", (c) => {
    const key = c.req.param("key");
    if (!store.get(key)) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    return c.json({ key, overrides: environments.overrides(key) });
  });

  v1.put("/flags/:key/environments/:environment", async (c) => {
    const key = c.req.param("key");
    const environment = c.req.param("environment");
    const flag = store.get(key);
    if (!flag) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    if (!environments.has(environment)) {
      return c.json(errorBody("environment_not_found", "No environment with that key."), 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be valid JSON."), 400);
    }
    const { enabled, rolloutPercentage } = (body ?? {}) as Record<string, unknown>;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return c.json(errorBody("invalid_enabled", "`enabled` must be a boolean."), 400);
    }
    if (rolloutPercentage !== undefined && !isValidRolloutPercentage(rolloutPercentage)) {
      return c.json(
        errorBody(
          "invalid_rollout_percentage",
          "`rolloutPercentage` must be an integer between 0 and 100.",
        ),
        400,
      );
    }
    if (enabled === undefined && rolloutPercentage === undefined) {
      return c.json(
        errorBody("empty_update", "Provide `enabled` and/or `rolloutPercentage`."),
        400,
      );
    }
    const override = environments.setOverride(key, environment, {
      ...(enabled !== undefined ? { enabled: enabled as boolean } : {}),
      ...(rolloutPercentage !== undefined
        ? { rolloutPercentage: rolloutPercentage as number }
        : {}),
    });
    return c.json(override);
  });

  v1.delete("/flags/:key/environments/:environment", (c) => {
    if (!store.get(c.req.param("key"))) {
      return c.json(errorBody("flag_not_found", "No flag with that key."), 404);
    }
    if (!environments.clearOverride(c.req.param("key"), c.req.param("environment"))) {
      return c.json(errorBody("override_not_found", "No override for that environment."), 404);
    }
    return c.body(null, 204);
  });

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

  v1.get("/tags/:tag/flags", (c) => {
    // Path-based counterpart of `GET /v1/flags?tag=`: 404 for a tag no live
    // flag carries, so dashboards can distinguish "unknown tag" from "empty".
    const tag = c.req.param("tag");
    const flags = store.list().filter((flag) => flag.tags?.includes(tag));
    if (flags.length === 0) {
      return c.json(
        errorBody("tag_not_found", `No flag carries the tag "${tag}".`),
        404,
      );
    }
    return c.json({ tag, flags });
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
    if (removed) {
      environments.clearFlag(c.req.param("key"));
      webhooks.dispatch("flag.deleted");
    }
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
    // `?environment=` evaluates the flag as that environment sees it: the
    // override's values win, and anything it does not set falls back to the
    // flag's own defaults.
    const environmentParam = c.req.query("environment");
    if (environmentParam && !environments.has(environmentParam)) {
      return c.json(errorBody("environment_not_found", "No environment with that key."), 404);
    }
    const override = environmentParam
      ? environments.override(flag.key, environmentParam)
      : undefined;
    const effectiveEnabled = override?.enabled ?? flag.enabled;
    const effectiveRollout = override?.rolloutPercentage ?? flag.rolloutPercentage;
    const enabled = isEnabledForUnit(flag.key, effectiveEnabled, effectiveRollout, unit);
    // Minimal payload on purpose: this is the hot path SDKs poll.
    const result: {
      key: string;
      enabled: boolean;
      rolloutPercentage?: number;
      environment?: string;
    } = {
      key: flag.key,
      enabled,
    };
    if (effectiveRollout !== undefined) {
      result.rolloutPercentage = effectiveRollout;
    }
    if (environmentParam) result.environment = environmentParam;
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
