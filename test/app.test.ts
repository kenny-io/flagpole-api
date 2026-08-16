/**
 * Endpoint tests for the Flagpole API.
 *
 * Uses Hono's fetch-compatible `app.request()` so no real socket is opened;
 * each test builds a fresh app + store for isolation.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createStore } from "../src/store.js";

const makeApp = (apiToken?: string) => createApp({ store: createStore(), apiToken });

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("GET /health", () => {
  it("returns ok without auth even when a token is configured", async () => {
    const app = makeApp("secret");
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /version", () => {
  it("reports the public API release without requiring auth", async () => {
    const app = makeApp("secret");
    const res = await app.request("/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "1.0.0" });
  });
});

describe("POST /v1/flags", () => {
  it("creates a flag and returns 201 with timestamps", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/flags",
      json({ key: "new-checkout", description: "New checkout flow", enabled: true }),
    );
    expect(res.status).toBe(201);
    const flag = await res.json();
    expect(flag).toMatchObject({
      key: "new-checkout",
      description: "New checkout flow",
      enabled: true,
    });
    expect(flag.createdAt).toBeTruthy();
    expect(flag.updatedAt).toBe(flag.createdAt);
  });

  it("defaults description to an empty string", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags", json({ key: "bare", enabled: false }));
    expect(res.status).toBe(201);
    expect((await res.json()).description).toBe("");
  });

  it("rejects a missing or malformed key with 400", async () => {
    const app = makeApp();
    for (const body of [{ enabled: true }, { key: "has spaces", enabled: true }, { key: "", enabled: true }]) {
      const res = await app.request("/v1/flags", json(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_key");
    }
  });

  it("rejects a non-boolean enabled with 400", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags", json({ key: "x", enabled: "yes" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_enabled");
  });

  it("rejects invalid JSON with 400", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_json");
  });

  it("accepts a valid rolloutPercentage", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags", json({ key: "gradual", enabled: true, rolloutPercentage: 25 }));
    expect(res.status).toBe(201);
    expect((await res.json()).rolloutPercentage).toBe(25);
  });

  it("rejects an invalid rolloutPercentage with 400", async () => {
    const app = makeApp();
    for (const rolloutPercentage of [-1, 101, 12.5, "50", null, true]) {
      const res = await app.request("/v1/flags", json({ key: "bad", enabled: true, rolloutPercentage }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_rollout_percentage");
    }
  });

  it("omits rolloutPercentage from the flag when not provided", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags", json({ key: "plain", enabled: true }));
    expect(await res.json()).not.toHaveProperty("rolloutPercentage");
  });

  it("rejects a duplicate key with 409", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "dupe", enabled: true }));
    const res = await app.request("/v1/flags", json({ key: "dupe", enabled: false }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("flag_exists");
  });
});

describe("GET /v1/flags", () => {
  it("lists all flags", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    await app.request("/v1/flags", json({ key: "b", enabled: false }));
    const res = await app.request("/v1/flags");
    expect(res.status).toBe(200);
    const { flags } = await res.json();
    expect(flags.map((f: { key: string }) => f.key)).toEqual(["a", "b"]);
  });
});

describe("GET /v1/flags/:key", () => {
  it("returns the flag", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a");
    expect(res.status).toBe(200);
    expect((await res.json()).key).toBe("a");
  });

  it("404s on an unknown key", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags/ghost");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("flag_not_found");
  });
});

describe("GET /v1/flags/:key/status", () => {
  it("returns only the master switch and 404s unknown keys", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "checkout", enabled: false }));
    expect(await (await app.request("/v1/flags/checkout/status")).json()).toEqual({
      key: "checkout",
      enabled: false,
    });
    expect((await app.request("/v1/flags/missing/status")).status).toBe(404);
  });
});

describe("GET /v1/flags/:key/rollout", () => {
  it("returns the rollout percentage without the full flag", async () => {
    const app = makeApp();
    await app.request(
      "/v1/flags",
      json({ key: "checkout", enabled: true, rolloutPercentage: 35 }),
    );
    await app.request("/v1/flags", json({ key: "search", enabled: true }));
    expect(
      await (await app.request("/v1/flags/checkout/rollout")).json(),
    ).toEqual({ key: "checkout", rolloutPercentage: 35 });
    expect(
      await (await app.request("/v1/flags/search/rollout")).json(),
    ).toEqual({ key: "search", rolloutPercentage: null });
    expect((await app.request("/v1/flags/missing/rollout")).status).toBe(404);
  });
});

describe("PATCH /v1/flags/:key", () => {
  it("updates enabled and bumps updatedAt", async () => {
    const app = makeApp();
    const created = await (await app.request("/v1/flags", json({ key: "a", enabled: false }))).json();
    const res = await app.request("/v1/flags/a", { ...json({ enabled: true }), method: "PATCH" });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.enabled).toBe(true);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.createdAt));
  });

  it("updates description independently of enabled", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a", { ...json({ description: "hi" }), method: "PATCH" });
    const updated = await res.json();
    expect(updated.description).toBe("hi");
    expect(updated.enabled).toBe(true);
  });

  it("400s on an empty patch body", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a", { ...json({}), method: "PATCH" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("empty_update");
  });

  it("updates rolloutPercentage on its own", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a", { ...json({ rolloutPercentage: 40 }), method: "PATCH" });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.rolloutPercentage).toBe(40);
    expect(updated.enabled).toBe(true);
  });

  it("rejects an invalid rolloutPercentage with 400", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a", { ...json({ rolloutPercentage: 200 }), method: "PATCH" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_rollout_percentage");
  });

  it("404s on an unknown key", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags/ghost", { ...json({ enabled: true }), method: "PATCH" });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/flags/:key/tags", () => {
  it("lists a flag's tags and 404s for unknown flags", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "search", enabled: true, tags: ["beta"] }));
    const res = await app.request("/v1/flags/search/tags");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "search", tags: ["beta"] });
    await app.request("/v1/flags", json({ key: "plain", enabled: false }));
    expect(await (await app.request("/v1/flags/plain/tags")).json()).toEqual({ key: "plain", tags: [] });
    expect((await app.request("/v1/flags/nope/tags")).status).toBe(404);
  });
});

describe("PUT /v1/flags/:key/tags/:tag", () => {
  it("attaches a tag idempotently and validates it", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "search", enabled: true, tags: ["beta"] }));
    const res = await app.request("/v1/flags/search/tags/web", { method: "PUT" });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual(["beta", "web"]);
    const again = await app.request("/v1/flags/search/tags/web", { method: "PUT" });
    expect((await again.json()).tags).toEqual(["beta", "web"]);
    const bad = await app.request("/v1/flags/search/tags/Not_Valid", { method: "PUT" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_tags");
    const missing = await app.request("/v1/flags/nope/tags/web", { method: "PUT" });
    expect(missing.status).toBe(404);
  });
});

describe("DELETE /v1/flags/:key/tags/:tag", () => {
  it("detaches a tag idempotently", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "search", enabled: true, tags: ["beta", "web"] }));
    const res = await app.request("/v1/flags/search/tags/beta", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual(["web"]);
    const again = await app.request("/v1/flags/search/tags/beta", { method: "DELETE" });
    expect(again.status).toBe(200);
    expect((await again.json()).tags).toEqual(["web"]);
    const missing = await app.request("/v1/flags/nope/tags/web", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});

describe("POST /v1/webhooks", () => {
  it("registers a subscription and returns 201", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/webhooks",
      json({ url: "https://hooks.example.com/flagpole", events: ["flag.created"] }),
    );
    expect(res.status).toBe(201);
    const webhook = await res.json();
    expect(webhook.url).toBe("https://hooks.example.com/flagpole");
    expect(webhook.events).toEqual(["flag.created"]);
    expect(typeof webhook.id).toBe("string");
  });

  it("rejects a non-https url, unknown events, and a short secret", async () => {
    const app = makeApp();
    const insecure = await app.request(
      "/v1/webhooks",
      json({ url: "http://hooks.example.com", events: ["flag.created"] }),
    );
    expect(insecure.status).toBe(400);
    expect((await insecure.json()).error.code).toBe("invalid_webhook_url");
    const unknown = await app.request(
      "/v1/webhooks",
      json({ url: "https://hooks.example.com", events: ["flag.exploded"] }),
    );
    expect((await unknown.json()).error.code).toBe("invalid_webhook_events");
    const shortSecret = await app.request(
      "/v1/webhooks",
      json({ url: "https://hooks.example.com", events: ["flag.created"], secret: "tiny" }),
    );
    expect((await shortSecret.json()).error.code).toBe("invalid_webhook_secret");
  });
});

describe("webhook lifecycle", () => {
  it("lists, fetches, tests, and deletes a subscription", async () => {
    const app = makeApp();
    const created = await (
      await app.request(
        "/v1/webhooks",
        json({ url: "https://hooks.example.com/a", events: ["flag.updated"] }),
      )
    ).json();

    const list = await (await app.request("/v1/webhooks")).json();
    expect(list.webhooks.map((w: { id: string }) => w.id)).toContain(created.id);

    const fetched = await app.request(`/v1/webhooks/${created.id}`);
    expect(fetched.status).toBe(200);

    const tested = await app.request(`/v1/webhooks/${created.id}/test`, { method: "POST" });
    expect(tested.status).toBe(202);
    expect((await tested.json()).delivery.event).toBe("flag.updated");

    const deliveries = await (
      await app.request(`/v1/webhooks/${created.id}/deliveries`)
    ).json();
    expect(deliveries.deliveries).toHaveLength(1);

    const filtered = await (
      await app.request(`/v1/webhooks/${created.id}/deliveries?status=delivered`)
    ).json();
    expect(filtered.deliveries).toHaveLength(0);

    const removed = await app.request(`/v1/webhooks/${created.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect((await app.request(`/v1/webhooks/${created.id}`)).status).toBe(404);
  });

  it("records a delivery when a flag is deleted", async () => {
    const app = makeApp();
    const hook = await (
      await app.request(
        "/v1/webhooks",
        json({ url: "https://hooks.example.com/b", events: ["flag.deleted"] }),
      )
    ).json();
    await app.request("/v1/flags", json({ key: "doomed", enabled: true }));
    await app.request("/v1/flags/doomed", { method: "DELETE" });
    const deliveries = await (
      await app.request(`/v1/webhooks/${hook.id}/deliveries`)
    ).json();
    expect(deliveries.deliveries[0].event).toBe("flag.deleted");
  });
});

describe("environments", () => {
  it("seeds the three conventional environments and adds more", async () => {
    const app = makeApp();
    const seeded = await (await app.request("/v1/environments")).json();
    expect(seeded.environments.map((e: { key: string }) => e.key)).toEqual([
      "development",
      "staging",
      "production",
    ]);
    const created = await app.request(
      "/v1/environments",
      json({ key: "canary", displayName: "Canary" }),
    );
    expect(created.status).toBe(201);
    const duplicate = await app.request("/v1/environments", json({ key: "canary" }));
    expect(duplicate.status).toBe(409);
    const invalid = await app.request("/v1/environments", json({ key: "Not Valid" }));
    expect((await invalid.json()).error.code).toBe("invalid_environment_key");
  });

  it("overrides a flag per environment and evaluates through it", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "checkout", enabled: false }));

    const override = await app.request(
      "/v1/flags/checkout/environments/staging",
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) },
    );
    expect(override.status).toBe(200);
    expect((await override.json()).enabled).toBe(true);

    const staging = await (
      await app.request("/v1/flags/checkout/evaluate?environment=staging")
    ).json();
    expect(staging.enabled).toBe(true);
    expect(staging.environment).toBe("staging");

    const production = await (
      await app.request("/v1/flags/checkout/evaluate?environment=production")
    ).json();
    expect(production.enabled).toBe(false);

    const listed = await (
      await app.request("/v1/flags/checkout/environments")
    ).json();
    expect(listed.overrides).toHaveLength(1);

    const cleared = await app.request("/v1/flags/checkout/environments/staging", {
      method: "DELETE",
    });
    expect(cleared.status).toBe(204);
    const afterClear = await (
      await app.request("/v1/flags/checkout/evaluate?environment=staging")
    ).json();
    expect(afterClear.enabled).toBe(false);
  });

  it("404s an unknown environment on both write and evaluate", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "x", enabled: true }));
    const write = await app.request("/v1/flags/x/environments/nowhere", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await write.json()).error.code).toBe("environment_not_found");
    const read = await app.request("/v1/flags/x/evaluate?environment=nowhere");
    expect(read.status).toBe(404);
  });
});

describe("GET /v1/flags pagination", () => {
  it("returns every flag by default and a page when asked", async () => {
    const app = makeApp();
    for (const key of ["a", "b", "c"]) {
      await app.request("/v1/flags", json({ key, enabled: true }));
    }
    const all = await (await app.request("/v1/flags")).json();
    expect(all.flags).toHaveLength(3);
    expect(all.total).toBe(3);

    const page2 = await (await app.request("/v1/flags?page=2&perPage=2")).json();
    expect(page2.flags).toHaveLength(1);
    expect(page2.total).toBe(3);
    expect(page2.page).toBe(2);

    const bad = await app.request("/v1/flags?page=0&perPage=2");
    expect((await bad.json()).error.code).toBe("invalid_pagination");
  });
});

describe("GET /v1/flags/count", () => {
  it("counts flags by enabled state and never treats count as a key", async () => {
    const app = makeApp();
    expect(await (await app.request("/v1/flags/count")).json()).toEqual({ total: 0, enabled: 0, disabled: 0 });
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    await app.request("/v1/flags", json({ key: "b", enabled: false }));
    const res = await app.request("/v1/flags/count");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 2, enabled: 1, disabled: 1 });
  });
});

describe("GET /v1/flags/keys", () => {
  it("returns only the live flag keys", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "checkout", enabled: true }));
    await app.request("/v1/flags", json({ key: "search", enabled: false }));
    expect(await (await app.request("/v1/flags/keys")).json()).toEqual({
      keys: ["checkout", "search"],
    });
  });
});

describe("GET /v1/tags/:tag/flags", () => {
  it("lists flags carrying a tag and 404s for unknown tags", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["web"] }));
    await app.request("/v1/flags", json({ key: "b", enabled: true, tags: ["api"] }));
    const res = await app.request("/v1/tags/web/flags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tag).toBe("web");
    expect(body.flags.map((flag: { key: string }) => flag.key)).toEqual(["a"]);
    const missing = await app.request("/v1/tags/nope/flags");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("tag_not_found");
  });
});

describe("POST /v1/flags/:key/toggle", () => {
  it("flips enabled and returns the updated flag", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "dark-mode", enabled: false }));
    const res = await app.request("/v1/flags/dark-mode/toggle", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
    const again = await app.request("/v1/flags/dark-mode/toggle", { method: "POST" });
    expect((await again.json()).enabled).toBe(false);
  });

  it("returns 404 for an unknown flag", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags/nope/toggle", { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("flag_not_found");
  });
});

describe("DELETE /v1/flags/:key", () => {
  it("deletes and returns 204, then the flag is gone", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await app.request("/v1/flags/a")).status).toBe(404);
  });

  it("404s on an unknown key", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/flags/:key/evaluate", () => {
  it("returns only key and enabled", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", description: "d", enabled: true }));
    const res = await app.request("/v1/flags/a/evaluate");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "a", enabled: true });
  });

  it("404s on an unknown key", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags/ghost/evaluate");
    expect(res.status).toBe(404);
  });

  it("includes rolloutPercentage when the flag has one", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, rolloutPercentage: 50 }));
    const res = await app.request("/v1/flags/a/evaluate");
    expect(await res.json()).toEqual({ key: "a", enabled: true, rolloutPercentage: 50 });
  });

  it("is deterministic for the same unit", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, rolloutPercentage: 50 }));
    const first = await (await app.request("/v1/flags/a/evaluate?unit=user-42")).json();
    for (let i = 0; i < 5; i++) {
      const again = await (await app.request("/v1/flags/a/evaluate?unit=user-42")).json();
      expect(again.enabled).toBe(first.enabled);
    }
  });

  it("enables every unit at 100 and none at 0", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "all", enabled: true, rolloutPercentage: 100 }));
    await app.request("/v1/flags", json({ key: "none", enabled: true, rolloutPercentage: 0 }));
    for (const unit of ["u1", "u2", "u3"]) {
      expect((await (await app.request(`/v1/flags/all/evaluate?unit=${unit}`)).json()).enabled).toBe(true);
      expect((await (await app.request(`/v1/flags/none/evaluate?unit=${unit}`)).json()).enabled).toBe(false);
    }
  });

  it("splits units at a partial percentage", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "half", enabled: true, rolloutPercentage: 50 }));
    const results = new Set<boolean>();
    for (let i = 0; i < 50; i++) {
      const { enabled } = await (await app.request(`/v1/flags/half/evaluate?unit=user-${i}`)).json();
      results.add(enabled);
    }
    // With 50 distinct units at 50%, both outcomes must occur.
    expect(results).toEqual(new Set([true, false]));
  });

  it("keeps a disabled flag off for every unit regardless of percentage", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: false, rolloutPercentage: 100 }));
    const res = await app.request("/v1/flags/a/evaluate?unit=user-1");
    expect((await res.json()).enabled).toBe(false);
  });

  it("falls back to the plain boolean when no unit is given", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, rolloutPercentage: 0 }));
    const res = await app.request("/v1/flags/a/evaluate");
    expect((await res.json()).enabled).toBe(true);
  });

  it("ignores a unit on a flag without a rolloutPercentage", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a/evaluate?unit=user-1");
    expect(await res.json()).toEqual({ key: "a", enabled: true });
  });
});

describe("GET /v1/flags/:key/history", () => {
  it("records created, updated, and deleted events in order", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", description: "d", enabled: false }));
    await app.request("/v1/flags/a", { ...json({ enabled: true, rolloutPercentage: 10 }), method: "PATCH" });
    await app.request("/v1/flags/a", { method: "DELETE" });

    const res = await app.request("/v1/flags/a/history");
    expect(res.status).toBe(200);
    const { key, events } = await res.json();
    expect(key).toBe("a");
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "created",
      changes: { description: "d", enabled: false },
    });
    expect(events[1]).toMatchObject({
      type: "updated",
      changes: { enabled: true, rolloutPercentage: 10 },
    });
    expect(events[2]).toMatchObject({ type: "deleted", changes: {} });
    for (const event of events) expect(Date.parse(event.at)).not.toBeNaN();
  });

  it("records only the patched fields on update", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    await app.request("/v1/flags/a", { ...json({ description: "note" }), method: "PATCH" });
    const { events } = await (await app.request("/v1/flags/a/history")).json();
    expect(events[1].changes).toEqual({ description: "note" });
  });

  it("404s on a key that never existed", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags/ghost/history");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("flag_not_found");
  });

  it("returns only the most recent events when ?limit is set, oldest-first", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: false }));
    await app.request("/v1/flags/a", { ...json({ enabled: true }), method: "PATCH" });
    await app.request("/v1/flags/a", { ...json({ description: "note" }), method: "PATCH" });

    const res = await app.request("/v1/flags/a/history?limit=2");
    expect(res.status).toBe(200);
    const { events } = await res.json();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "updated", changes: { enabled: true } });
    expect(events[1]).toMatchObject({ type: "updated", changes: { description: "note" } });
  });

  it("returns the full history when limit exceeds the event count", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a/history?limit=500");
    expect(res.status).toBe(200);
    expect((await res.json()).events).toHaveLength(1);
  });

  it("treats an empty ?limit= as absent", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    await app.request("/v1/flags/a", { ...json({ enabled: false }), method: "PATCH" });
    const res = await app.request("/v1/flags/a/history?limit=");
    expect(res.status).toBe(200);
    expect((await res.json()).events).toHaveLength(2);
  });

  it("rejects a non-integer, zero, negative, or oversized limit with 400", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    for (const limit of ["abc", "1.5", "0", "-3", "501", "1e2"]) {
      const res = await app.request(`/v1/flags/a/history?limit=${limit}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_limit");
    }
  });

  it("validates limit before checking flag existence", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags/ghost/history?limit=0");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });
});

describe("flag tags", () => {
  it("creates a flag with tags and returns them", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/flags",
      json({ key: "a", enabled: true, tags: ["checkout", "beta"] }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).tags).toEqual(["checkout", "beta"]);
  });

  it("omits tags from the flag when not provided", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags", json({ key: "a", enabled: true }));
    expect(await res.json()).not.toHaveProperty("tags");
  });

  it("treats an empty tags array on create as no tags", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags", json({ key: "a", enabled: true, tags: [] }));
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("tags");
  });

  it("accepts up to 10 tags and single-character or 50-character tags", async () => {
    const app = makeApp();
    const tags = [...Array.from({ length: 8 }, (_, i) => `tag-${i}`), "x", "a".repeat(50)];
    expect(tags).toHaveLength(10);
    const res = await app.request("/v1/flags", json({ key: "a", enabled: true, tags }));
    expect(res.status).toBe(201);
    expect((await res.json()).tags).toEqual(tags);
  });

  it("rejects more than 10 tags with 400 invalid_tags", async () => {
    const app = makeApp();
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    const res = await app.request("/v1/flags", json({ key: "a", enabled: true, tags }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_tags");
  });

  it("rejects malformed tags with 400 invalid_tags", async () => {
    const app = makeApp();
    const badTagSets = [
      "not-an-array",
      ["Checkout"],
      ["has space"],
      ["-leading"],
      ["trailing-"],
      ["double--dash"],
      [""],
      ["a".repeat(51)],
      [42],
      [null],
      ["under_score"],
    ];
    for (const tags of badTagSets) {
      const res = await app.request("/v1/flags", json({ key: "a", enabled: true, tags }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_tags");
    }
  });

  it("rejects duplicate tags with 400 invalid_tags", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/flags",
      json({ key: "a", enabled: true, tags: ["beta", "beta"] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_tags");
  });

  it("replaces the whole tag set on PATCH", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["old", "stale"] }));
    const res = await app.request("/v1/flags/a", { ...json({ tags: ["fresh"] }), method: "PATCH" });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual(["fresh"]);
  });

  it("clears all tags when PATCHed with an empty array", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["beta"] }));
    const res = await app.request("/v1/flags/a", { ...json({ tags: [] }), method: "PATCH" });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("tags");
  });

  it("accepts a PATCH containing only tags", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a", { ...json({ tags: ["solo"] }), method: "PATCH" });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.tags).toEqual(["solo"]);
    expect(updated.enabled).toBe(true);
  });

  it("rejects invalid tags on PATCH with 400 invalid_tags", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/flags/a", { ...json({ tags: ["BAD"] }), method: "PATCH" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_tags");
  });

  it("records tags in history on create, update, and clear", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["beta"] }));
    await app.request("/v1/flags/a", { ...json({ tags: ["ga"] }), method: "PATCH" });
    await app.request("/v1/flags/a", { ...json({ tags: [] }), method: "PATCH" });
    const { events } = await (await app.request("/v1/flags/a/history")).json();
    expect(events[0].changes.tags).toEqual(["beta"]);
    expect(events[1].changes).toEqual({ tags: ["ga"] });
    expect(events[2].changes).toEqual({ tags: [] });
  });
});

describe("GET /v1/flags?tag=", () => {
  it("filters the list to flags carrying the tag", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["checkout", "beta"] }));
    await app.request("/v1/flags", json({ key: "b", enabled: false, tags: ["search"] }));
    await app.request("/v1/flags", json({ key: "c", enabled: true }));
    const res = await app.request("/v1/flags?tag=checkout");
    expect(res.status).toBe(200);
    const { flags } = await res.json();
    expect(flags.map((f: { key: string }) => f.key)).toEqual(["a"]);
  });

  it("returns an empty list for a tag no flag carries", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["beta"] }));
    const res = await app.request("/v1/flags?tag=ghost");
    expect(res.status).toBe(200);
    expect((await res.json()).flags).toEqual([]);
  });

  it("treats an empty ?tag= as absent and lists everything", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["beta"] }));
    await app.request("/v1/flags", json({ key: "b", enabled: true }));
    const res = await app.request("/v1/flags?tag=");
    expect(res.status).toBe(200);
    expect((await res.json()).flags).toHaveLength(2);
  });
});

describe("GET /v1/tags", () => {
  it("lists distinct tags with counts, sorted by tag name", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["checkout", "beta"] }));
    await app.request("/v1/flags", json({ key: "b", enabled: false, tags: ["beta"] }));
    await app.request("/v1/flags", json({ key: "c", enabled: true, tags: ["search"] }));
    const res = await app.request("/v1/tags");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tags: [
        { tag: "beta", count: 2 },
        { tag: "checkout", count: 1 },
        { tag: "search", count: 1 },
      ],
    });
  });

  it("returns an empty list when no flag has tags", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true }));
    const res = await app.request("/v1/tags");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tags: [] });
  });

  it("drops a deleted flag's tags from the counts", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["beta"] }));
    await app.request("/v1/flags", json({ key: "b", enabled: true, tags: ["beta"] }));
    await app.request("/v1/flags/a", { method: "DELETE" });
    const { tags } = await (await app.request("/v1/tags")).json();
    expect(tags).toEqual([{ tag: "beta", count: 1 }]);
  });

  it("requires the bearer token like every other /v1 route", async () => {
    const app = makeApp("s3cret");
    expect((await app.request("/v1/tags")).status).toBe(401);
    const res = await app.request("/v1/tags", {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
  });
});

describe("bearer-token auth", () => {
  it("rejects /v1 requests without a token when one is configured", async () => {
    const app = makeApp("s3cret");
    const res = await app.request("/v1/flags");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("rejects a wrong token", async () => {
    const app = makeApp("s3cret");
    const res = await app.request("/v1/flags", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const app = makeApp("s3cret");
    const res = await app.request("/v1/flags", {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
  });

  it("allows everything when no token is configured (dev mode)", async () => {
    const app = makeApp();
    const res = await app.request("/v1/flags");
    expect(res.status).toBe(200);
  });
});

describe("unknown routes", () => {
  it("returns the JSON error envelope, not HTML", async () => {
    const app = makeApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});

describe("file persistence", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("persists flags to disk and reloads them in a new store", async () => {
    dir = mkdtempSync(join(tmpdir(), "flagpole-test-"));
    const dataFile = join(dir, "flags.json");

    const first = createApp({ store: createStore(dataFile) });
    await first.request("/v1/flags", json({ key: "persisted", enabled: true }));

    // File contents are readable, pretty-printed JSON.
    const onDisk = JSON.parse(readFileSync(dataFile, "utf8"));
    expect(onDisk.flags).toHaveLength(1);
    expect(onDisk.flags[0].key).toBe("persisted");

    // A brand-new store (fresh process, conceptually) sees the same flag.
    const second = createApp({ store: createStore(dataFile) });
    const res = await second.request("/v1/flags/persisted");
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
  });

  it("removes deleted flags from the data file", async () => {
    dir = mkdtempSync(join(tmpdir(), "flagpole-test-"));
    const dataFile = join(dir, "flags.json");

    const app = createApp({ store: createStore(dataFile) });
    await app.request("/v1/flags", json({ key: "gone", enabled: true }));
    await app.request("/v1/flags/gone", { method: "DELETE" });

    expect(JSON.parse(readFileSync(dataFile, "utf8")).flags).toEqual([]);
  });

  it("persists history across store reloads, including for deleted flags", async () => {
    dir = mkdtempSync(join(tmpdir(), "flagpole-test-"));
    const dataFile = join(dir, "flags.json");

    const first = createApp({ store: createStore(dataFile) });
    await first.request("/v1/flags", json({ key: "audited", enabled: true }));
    await first.request("/v1/flags/audited", { ...json({ enabled: false }), method: "PATCH" });
    await first.request("/v1/flags/audited", { method: "DELETE" });

    const second = createApp({ store: createStore(dataFile) });
    const res = await second.request("/v1/flags/audited/history");
    expect(res.status).toBe(200);
    const { events } = await res.json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(["created", "updated", "deleted"]);
  });

  it("persists tags to disk and reloads them in a new store", async () => {
    dir = mkdtempSync(join(tmpdir(), "flagpole-test-"));
    const dataFile = join(dir, "flags.json");

    const first = createApp({ store: createStore(dataFile) });
    await first.request("/v1/flags", json({ key: "tagged", enabled: true, tags: ["beta", "checkout"] }));

    const second = createApp({ store: createStore(dataFile) });
    const res = await second.request("/v1/flags/tagged");
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual(["beta", "checkout"]);

    const listed = await (await second.request("/v1/tags")).json();
    expect(listed.tags).toEqual([
      { tag: "beta", count: 1 },
      { tag: "checkout", count: 1 },
    ]);
  });

  it("loads a legacy bare-array data file and serves an empty history", async () => {
    dir = mkdtempSync(join(tmpdir(), "flagpole-test-"));
    const dataFile = join(dir, "flags.json");
    const legacyFlag = {
      key: "old",
      description: "",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(dataFile, JSON.stringify([legacyFlag]));

    const app = createApp({ store: createStore(dataFile) });
    expect((await app.request("/v1/flags/old")).status).toBe(200);
    const res = await app.request("/v1/flags/old/history");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "old", events: [] });
  });
});

describe("DELETE /v1/tags/:tag", () => {
  it("removes the tag from every flag carrying it and reports the count", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["beta", "ops"] }));
    await app.request("/v1/flags", json({ key: "b", enabled: false, tags: ["beta"] }));
    await app.request("/v1/flags", json({ key: "c", enabled: true, tags: ["ops"] }));

    const res = await app.request("/v1/tags/beta", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tag: "beta", removedFrom: 2 });

    const a = await (await app.request("/v1/flags/a")).json();
    expect(a.tags).toEqual(["ops"]);
    const b = await (await app.request("/v1/flags/b")).json();
    expect(b.tags).toBeUndefined();
    const listed = await (await app.request("/v1/tags")).json();
    expect(listed.tags).toEqual([{ tag: "ops", count: 2 }]);
  });

  it("404s with tag_not_found when no live flag carries the tag", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["beta"] }));
    const res = await app.request("/v1/tags/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("tag_not_found");
  });

  it("records an updated history event on each affected flag", async () => {
    const app = makeApp();
    await app.request("/v1/flags", json({ key: "a", enabled: true, tags: ["beta"] }));
    await app.request("/v1/tags/beta", { method: "DELETE" });
    const history = await (await app.request("/v1/flags/a/history")).json();
    expect(history.events.map((e: { type: string }) => e.type)).toEqual([
      "created",
      "updated",
    ]);
  });

  it("requires auth when a token is configured", async () => {
    const app = makeApp("secret");
    const res = await app.request("/v1/tags/beta", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
