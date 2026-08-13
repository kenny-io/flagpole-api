/**
 * Endpoint tests for the Flagpole API.
 *
 * Uses Hono's fetch-compatible `app.request()` so no real socket is opened;
 * each test builds a fresh app + store for isolation.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].key).toBe("persisted");

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

    expect(JSON.parse(readFileSync(dataFile, "utf8"))).toEqual([]);
  });
});
