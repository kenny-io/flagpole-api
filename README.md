# Flagpole

A lightweight feature-flag service by [Polaris Labs](https://github.com/kenny-io).

Flagpole is a single, small REST API for managing boolean feature flags. No
dashboard, no SDK lock-in, no database required — just an HTTP server your
services can query. Run it in memory for ephemeral environments, or point it
at a JSON file for durable, human-inspectable storage.

## Why Flagpole

- **Tiny surface area.** Nine endpoints. You can read the whole API reference below in a minute.
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
| `GET` | `/v1/flags` | List all flags. | `?tag=<t>` (optional) returns only flags carrying that tag | `200` `{ "flags": [Flag] }` |
| `POST` | `/v1/flags` | Create a flag. | `key` (string, required), `enabled` (boolean, required), `description` (string, optional), `rolloutPercentage` (integer 0–100, optional), `tags` (array of strings, optional) | `201` `Flag` |
| `GET` | `/v1/flags/:key` | Fetch one flag. | `:key` path param | `200` `Flag` |
| `PATCH` | `/v1/flags/:key` | Update a flag. | `enabled` (boolean), `description` (string), `rolloutPercentage` (integer 0–100), and/or `tags` (array of strings) — at least one | `200` `Flag` |
| `DELETE` | `/v1/flags/:key` | Delete a flag. | `:key` path param | `204` (no body) |
| `GET` | `/v1/flags/:key/evaluate` | Evaluate a flag (hot path for pollers). | `:key` path param; `?unit=<string>` (optional) buckets the unit for percentage rollouts | `200` `{ "key", "enabled", "rolloutPercentage"? }` |
| `GET` | `/v1/flags/:key/history` | Change history for a flag. | `:key` path param; `?limit=<n>` (optional) returns only the most recent `n` events (integer 1–500) | `200` `{ "key", "events": [FlagEvent] }` |
| `GET` | `/v1/tags` | List distinct tags across all flags with usage counts. | — | `200` `{ "tags": [{ "tag", "count" }] }` |

### The Flag object

```json
{
  "key": "new-checkout",
  "description": "New checkout flow",
  "enabled": true,
  "rolloutPercentage": 25,
  "tags": ["checkout", "beta"],
  "createdAt": "2026-08-13T12:00:00.000Z",
  "updatedAt": "2026-08-13T12:00:00.000Z"
}
```

Keys are 1–64 characters of letters, digits, dots, dashes, or underscores,
and are immutable after creation. `rolloutPercentage` is only present when
the flag uses a percentage rollout, and `tags` only when the flag has at
least one tag.

### Percentage rollouts

Set `rolloutPercentage` (an integer 0–100) on create or update to roll a
flag out gradually. Evaluation then accepts a `unit` — any stable string
identifying who is being evaluated, such as a user or session id:

```bash
curl -s 'http://localhost:3333/v1/flags/new-checkout/evaluate?unit=user-42'
# {"key":"new-checkout","enabled":true,"rolloutPercentage":25}
```

The unit is hashed together with the flag key into a bucket from 0 to 99;
the flag is enabled for that unit when the bucket is below the percentage.
Bucketing is deterministic — the same unit always gets the same answer —
and raising the percentage only ever adds units to the enabled cohort.
`enabled` remains the master switch: a disabled flag is off for everyone,
and evaluating without a `unit` (or a flag without a `rolloutPercentage`)
returns the plain boolean.

### Tags

Tags group related flags — by team, surface, launch, or anything else —
so you can slice a growing flag list without a naming convention. Attach
them on create or replace them later with a PATCH:

```bash
curl -s -X POST http://localhost:3333/v1/flags \
  -H 'content-type: application/json' \
  -d '{"key": "new-checkout", "enabled": true, "tags": ["checkout", "beta"]}'

curl -s -X PATCH http://localhost:3333/v1/flags/new-checkout \
  -H 'content-type: application/json' \
  -d '{"tags": ["checkout"]}'
```

A flag carries at most 10 tags. Each tag is 1–50 characters of lowercase
kebab-case — letters, digits, and single dashes, e.g. `checkout` or
`q3-launch` — with no duplicates within a flag. Anything else returns
`400` `invalid_tags`. A PATCH replaces the whole tag set (there is no
merge); pass an empty array to remove every tag, after which the `tags`
field disappears from the flag entirely.

Filter the flag list by tag, or ask for the full tag inventory:

```bash
curl -s 'http://localhost:3333/v1/flags?tag=checkout'
# {"flags":[ ...only flags tagged "checkout"... ]}

curl -s http://localhost:3333/v1/tags
# {"tags":[{"tag":"beta","count":1},{"tag":"checkout","count":2}]}
```

`GET /v1/tags` returns every distinct tag on a live flag with the number
of flags carrying it, sorted by tag name. Deleted flags do not contribute.
Filtering by a tag no flag carries returns an empty list, not an error,
and an empty `?tag=` is treated as absent. Tags are persisted with the
flag when `FLAGPOLE_DATA_FILE` is set, and tag changes appear in the
flag's history like any other field.

### Change history

Every create, update, and delete is recorded, and
`GET /v1/flags/:key/history` returns the events oldest-first:

```json
{
  "key": "new-checkout",
  "events": [
    { "type": "created", "at": "2026-08-13T12:00:00.000Z", "changes": { "description": "New checkout flow", "enabled": true } },
    { "type": "updated", "at": "2026-08-13T14:30:00.000Z", "changes": { "rolloutPercentage": 25 } },
    { "type": "deleted", "at": "2026-08-14T09:00:00.000Z", "changes": {} }
  ]
}
```

`changes` holds the initial values for `created`, only the patched fields
for `updated`, and is empty for `deleted`. History survives deletion — a
deleted flag still answers with its full event trail — and only keys that
never existed return `404`. History is persisted alongside flags when
`FLAGPOLE_DATA_FILE` is set; data files written by older versions load
fine and start with an empty history.

Long-lived flags can accumulate a lot of events. Pass `?limit=<n>` (an
integer from 1 to 500) to get only the most recent `n` events; the
response stays oldest-first, so a limited result is always a suffix of
the full trail:

```bash
curl -s 'http://localhost:3333/v1/flags/new-checkout/history?limit=2'
# {"key":"new-checkout","events":[ ...the two most recent events... ]}
```

A `limit` outside that range (or not an integer) returns `400`
`invalid_limit`.

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
| `400` | `invalid_rollout_percentage` | `rolloutPercentage` is not an integer between 0 and 100. |
| `400` | `invalid_tags` | `tags` is not an array of up to 10 unique lowercase kebab-case strings (1–50 chars each). |
| `400` | `empty_update` | PATCH body has none of `enabled`, `description`, `rolloutPercentage`, or `tags`. |
| `400` | `invalid_limit` | History `limit` is not an integer between 1 and 500. |
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
| `FLAGPOLE_DATA_FILE` | _(unset)_ | Path to a JSON file for persistence of flags and their change history. Loaded at startup, rewritten atomically on every mutation. Unset keeps everything in memory only. |

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
