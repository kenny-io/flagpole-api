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
