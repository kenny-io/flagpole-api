# Flagpole

A lightweight feature-flag service by [Polaris Labs](https://github.com/kenny-io).

Flagpole is a single, small REST API for managing boolean feature flags. No
dashboard, no SDK lock-in, no database required — just an HTTP server your
services can query. Run it in memory for ephemeral environments, or point it
at a JSON file for durable, human-inspectable storage.

## Why Flagpole

- **Tiny surface area.** Seven endpoints. You can read the whole API reference below in a minute.
- **Zero infrastructure.** In-memory by default; optional single-file JSON persistence. No Postgres, no Redis.
- **Boring auth.** One static bearer token via an environment variable. Leave it unset for local development.
- **Honest errors.** Every non-2xx response is the same JSON envelope: `{ "error": { "code", "message" } }`.

## Quickstart

Requires Node.js 20 or later.

```bash
git clone https://github.com/kenny-io/flagpole-api.git
cd flagpole-api
npm install
npm run dev
```

The server starts on port 3333. Create a flag and evaluate it:

```bash
curl -s -X POST http://localhost:3333/v1/flags \
  -H 'content-type: application/json' \
  -d '{"key": "new-checkout", "description": "New checkout flow", "enabled": true}'

curl -s http://localhost:3333/v1/flags/new-checkout/evaluate
# {"key":"new-checkout","enabled":true}
```

For anything beyond local development, set a token and a data file:

```bash
FLAGPOLE_API_TOKEN=$(openssl rand -hex 24) \
FLAGPOLE_DATA_FILE=./data/flags.json \
npm start
```

With a token set, all `/v1` requests must carry it:

```bash
curl -s http://localhost:3333/v1/flags \
  -H "Authorization: Bearer $FLAGPOLE_API_TOKEN"
```

## API reference

All request and response bodies are JSON. `GET /health` is always public;
every `/v1` route requires `Authorization: Bearer <token>` when
`FLAGPOLE_API_TOKEN` is set.

| Method | Path | Description | Body / params | Success |
| ------ | ---- | ----------- | ------------- | ------- |
| `GET` | `/health` | Liveness check. | — | `200` `{ "status": "ok" }` |
| `GET` | `/v1/flags` | List all flags. | — | `200` `{ "flags": [Flag] }` |
| `POST` | `/v1/flags` | Create a flag. | `key` (string, required), `enabled` (boolean, required), `description` (string, optional) | `201` `Flag` |
| `GET` | `/v1/flags/:key` | Fetch one flag. | `:key` path param | `200` `Flag` |
| `PATCH` | `/v1/flags/:key` | Update a flag. | `enabled` (boolean) and/or `description` (string) — at least one | `200` `Flag` |
| `DELETE` | `/v1/flags/:key` | Delete a flag. | `:key` path param | `204` (no body) |
| `GET` | `/v1/flags/:key/evaluate` | Evaluate a flag (hot path for pollers). | `:key` path param | `200` `{ "key", "enabled" }` |

### The Flag object

```json
{
  "key": "new-checkout",
  "description": "New checkout flow",
  "enabled": true,
  "createdAt": "2026-08-13T12:00:00.000Z",
  "updatedAt": "2026-08-13T12:00:00.000Z"
}
```

Keys are 1–64 characters of letters, digits, dots, dashes, or underscores,
and are immutable after creation.

### Errors

Every error uses the same envelope:

```json
{ "error": { "code": "flag_not_found", "message": "No flag with that key." } }
```

| Status | Code | When |
| ------ | ---- | ---- |
| `400` | `invalid_json` | Body is not valid JSON. |
| `400` | `invalid_key` | Missing or malformed `key` on create. |
| `400` | `invalid_enabled` | `enabled` is not a boolean. |
| `400` | `invalid_description` | `description` is not a string. |
| `400` | `empty_update` | PATCH body has neither `enabled` nor `description`. |
| `401` | `unauthorized` | Missing or wrong bearer token. |
| `404` | `flag_not_found` | No flag with that key. |
| `404` | `not_found` | Unknown route. |
| `409` | `flag_exists` | Create with a key that already exists. |

## Configuration

All configuration is via environment variables. Everything is optional.

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `3333` | Port the HTTP server listens on. |
| `FLAGPOLE_API_TOKEN` | _(unset)_ | Bearer token required on all `/v1` routes. **Unset disables auth entirely (dev mode)** — never expose an unauthenticated instance. |
| `FLAGPOLE_DATA_FILE` | _(unset)_ | Path to a JSON file for persistence. Loaded at startup, rewritten atomically on every mutation. Unset keeps flags in memory only. |

## Development

```bash
npm run dev        # start with file watching
npm test           # run the vitest suite
npm run typecheck  # tsc --noEmit
```

Flags live in an in-memory `Map` (`src/store.ts`); the HTTP layer
(`src/app.ts`) is a Hono app exposed as a factory so tests run against
isolated instances without opening sockets.

## License

[MIT](./LICENSE) © Polaris Labs
