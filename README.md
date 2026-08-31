# Flagpole

A lightweight feature-flag service by [Polaris Labs](https://github.com/kenny-io).

Flagpole is a single, small REST API for managing boolean feature flags. No
dashboard, no SDK lock-in, no database required — just an HTTP server your
services can query. Run it in memory for ephemeral environments, or point it
at a JSON file for durable, human-inspectable storage.

Version 0.4.0 includes a public `GET /version` endpoint so deploy checks can verify
the running API release without credentials.

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

All request and response bodies are JSON. `GET /health` and `GET /version` are always public;
every `/v1` route requires `Authorization: Bearer <token>` when
`FLAGPOLE_API_TOKEN` is set.

| Method | Path | Description | Body / params | Success |
| ------ | ---- | ----------- | ------------- | ------- |
| `GET` | `/health` | Liveness and release check. | — | `200` `{ "status": "ok", "version": "1.0.0" }` |
| `GET` | `/version` | Running API release. | — | `200` `{ "version": "0.4.0" }` |
| `GET` | `/v1/flags` | List flags. | `?tag=<t>` (optional) filters by tag; `?page=<n>` and `?perPage=<n>` (optional, `perPage` ≤ 200) paginate | `200` `{ "flags": [Flag], "total", "page", "perPage" }` |
| `GET` | `/v1/flags/count` | Count flags, split by enabled state. | — | `200` `{ "total", "enabled", "disabled" }` |
| `GET` | `/v1/flags/keys` | List live flag keys without full objects. | — | `200` `{ "keys": [string] }` |
| `POST` | `/v1/flags` | Create a flag. | `key` (string, required), `enabled` (boolean, required), `description` (string, optional), `rolloutPercentage` (integer 0–100, optional), `tags` (array of strings, optional) | `201` `Flag` |
| `GET` | `/v1/flags/:key` | Fetch one flag. | `:key` path param | `200` `Flag` |
| `GET` | `/v1/flags/:key/status` | Read only a flag's master switch. | `:key` path param | `200` `{ "key", "enabled" }` |
| `GET` | `/v1/flags/:key/rollout` | Read only a flag's percentage rollout policy. | `:key` path param | `200` `{ "key", "rolloutPercentage" }` |
| `PATCH` | `/v1/flags/:key` | Update a flag. | `enabled` (boolean), `description` (string), `rolloutPercentage` (integer 0–100), and/or `tags` (array of strings) — at least one | `200` `Flag` |
| `POST` | `/v1/flags/:key/toggle` | Flip a flag's `enabled` state without a body. | `:key` path param | `200` `Flag` |
| `DELETE` | `/v1/flags/:key` | Delete a flag. | `:key` path param | `204` (no body) |
| `GET` | `/v1/flags/:key/evaluate` | Evaluate a flag (hot path for pollers). | `:key` path param; `?unit=<string>` (optional) buckets the unit for percentage rollouts; `?environment=<key>` (optional) applies that environment's override | `200` `{ "key", "enabled", "rolloutPercentage"?, "environment"? }` |
| `GET` | `/v1/flags/:key/history` | Change history for a flag. | `:key` path param; `?limit=<n>` (optional) returns only the most recent `n` events (integer 1–500) | `200` `{ "key", "events": [FlagEvent] }` |
| `GET` | `/v1/flags/:key/tags` | List a flag's tags. | `:key` path param | `200` `{ "key", "tags": [string] }` |
| `PUT` | `/v1/flags/:key/tags/:tag` | Attach one tag to a flag (idempotent). | `:key` and `:tag` path params; the same tag rules as `tags` apply | `200` `Flag` |
| `DELETE` | `/v1/flags/:key/tags/:tag` | Detach one tag from a flag (idempotent). | `:key` and `:tag` path params | `200` `Flag` |
| `POST` | `/v1/webhooks` | Register a webhook subscription. | `url` (https, required), `events` (array of `flag.created`, `flag.updated`, `flag.deleted`, `tag.retired`, required), `secret` (string ≥16 chars, optional) | `201` `Webhook` |
| `GET` | `/v1/webhooks` | List webhook subscriptions. | — | `200` `{ "webhooks": [Webhook] }` |
| `GET` | `/v1/webhooks/:id` | Fetch one subscription. | `:id` path param | `200` `Webhook` |
| `DELETE` | `/v1/webhooks/:id` | Remove a subscription. | `:id` path param | `204` (no body) |
| `POST` | `/v1/webhooks/:id/test` | Record a test delivery for the subscription's first event. | `:id` path param | `202` `{ "delivery": Delivery }` |
| `GET` | `/v1/webhooks/:id/deliveries` | Delivery history, newest first. | `?status=<pending\|delivered\|failed>`, `?limit=<n>` (both optional) | `200` `{ "deliveries": [Delivery] }` |
| `GET` | `/v1/environments` | List environments. | — | `200` `{ "environments": [Environment] }` |
| `POST` | `/v1/environments` | Create an environment. | `key` (lowercase kebab-case, required), `displayName` (optional) | `201` `Environment` |
| `GET` | `/v1/flags/:key/environments` | Every environment override on a flag. | `:key` path param | `200` `{ "key", "overrides": [Override] }` |
| `PUT` | `/v1/flags/:key/environments/:environment` | Set an override. | `enabled` (boolean) and/or `rolloutPercentage` (integer 0–100) — at least one | `200` `Override` |
| `DELETE` | `/v1/flags/:key/environments/:environment` | Clear an override. | path params | `204` (no body) |
| `GET` | `/v1/tags` | List distinct tags across all flags with usage counts. | — | `200` `{ "tags": [{ "tag", "count" }] }` |
| `GET` | `/v1/tags/:tag/flags` | List the flags carrying one tag. | `:tag` path param | `200` `{ "tag", "flags": [Flag] }` (`404` `tag_not_found` when no live flag carries it) |
| `DELETE` | `/v1/tags/:tag` | Retire a tag: remove it from every flag carrying it. | `:tag` path param | `200` `{ "tag", "removedFrom" }` |

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
them on create, replace them later with a PATCH, or add and remove one
tag at a time with `PUT`/`DELETE /v1/flags/:key/tags/:tag`. To see every
flag behind a tag, call `GET /v1/tags/:tag/flags`:

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

`DELETE /v1/tags/:tag` retires a tag across the whole flag set in one
call: the tag is removed from every flag carrying it and the response
reports how many flags were affected. The flags themselves are otherwise
untouched, each affected flag records an `updated` history event, and the
call returns `404` `tag_not_found` when no live flag carries the tag.

### Change history

Every create, update, and delete is recorded, and
`GET /v1/flags/:key/history` returns the events oldest-first. History
outlives the flag: a deleted flag still answers with its events (ending in
`deleted`); only keys that were never created return `404`. Pass
`?limit=<n>` to keep just the most recent `n` events — the response is
always a suffix of the full list, so ordering never changes:

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

### Webhooks

Register an https endpoint and Flagpole records a delivery every time a flag
changes. Deliveries are recorded, not sent — Flagpole is a reference
implementation, so the transport stays yours — but the history is a faithful
account of what a real sender would have attempted.

```bash
curl -X POST http://localhost:3333/v1/webhooks \
  -H 'content-type: application/json' \
  -d '{"url":"https://hooks.example.com/flagpole","events":["flag.updated","flag.deleted"]}'
```

A subscription names the events it wants. `POST /v1/webhooks/:id/test` records
a delivery immediately so you can verify wiring before a real change happens,
and `GET /v1/webhooks/:id/deliveries` returns the history newest-first,
filterable by `?status=` and trimmable with `?limit=`.

Supply a `secret` of at least 16 characters when you intend to verify
signatures at the receiving end; it is stored with the subscription and never
returned in delivery payloads.

## Environments

A flag's `enabled` and `rolloutPercentage` are its defaults. An environment
override replaces either value for one environment only, so `production` can
lag `staging` without duplicating the flag:

```bash
curl -X PUT http://localhost:3333/v1/flags/new-checkout/environments/staging \
  -H 'content-type: application/json' \
  -d '{"enabled":true}'

curl 'http://localhost:3333/v1/flags/new-checkout/evaluate?environment=staging'
# => { "key": "new-checkout", "enabled": true, "environment": "staging" }
```

`development`, `staging`, and `production` exist from the start; add more with
`POST /v1/environments`. Evaluating without `?environment=` returns the flag's
own defaults, so existing pollers are unaffected. Deleting a flag clears its
overrides.

## Errors

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
| `404` | `tag_not_found` | `DELETE /v1/tags/:tag` named a tag that no live flag carries. |
| `400` | `invalid_tags` | `tags` is not an array of up to 10 unique lowercase kebab-case strings (1–50 chars each). |
| `400` | `empty_update` | PATCH body has none of `enabled`, `description`, `rolloutPercentage`, or `tags`. |
| `400` | `invalid_limit` | History `limit` is not an integer between 1 and 500. |
| `401` | `unauthorized` | Missing or wrong bearer token. |
| `404` | `flag_not_found` | No flag with that key. |
| `400` | `invalid_pagination` | `page` or `perPage` is not a positive integer, or `perPage` exceeds 200. |
| `400` | `invalid_webhook_url` | `url` is missing, too long, or not `https://`. |
| `400` | `invalid_webhook_events` | `events` is empty or names an event Flagpole does not emit. |
| `400` | `invalid_webhook_secret` | `secret` is shorter than 16 characters. |
| `400` | `invalid_delivery_status` | `status` is not `pending`, `delivered`, or `failed`. |
| `400` | `invalid_environment_key` | `key` is not 1–50 characters of lowercase kebab-case. |
| `404` | `webhook_not_found` | No webhook with that id. |
| `404` | `environment_not_found` | No environment with that key. |
| `404` | `override_not_found` | That flag has no override in that environment. |
| `409` | `environment_exists` | An environment with that key already exists. |
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
