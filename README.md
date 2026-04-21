# etokendb

`etokendb` is a read-only HTTP service for Agora token discovery, trade history, rolling token metrics, and server-side access analytics.

It stores synced data in SQLite, exposes public JSON APIs, and can run behind nginx or directly on a VPS.

## Docs

- API handbook: [docs/api.md](./docs/api.md)
- OpenAPI spec: [openapi.yaml](./openapi.yaml)
- Deployment and operations: [docs/runbook.md](./docs/runbook.md)
- Architecture notes: [docs/architecture.md](./docs/architecture.md)

## Public API surface

Current public `GET` endpoints:

- `/healthz`
- `/readyz`
- `/api/status`
- `/api/tokens`
- `/api/tokens/:tokenId`
- `/api/tokens/:tokenId/trades`
- `/api/tokens/:tokenId/candles`
- `/api/trades`
- `/api/analytics/summary`
- `/api/analytics/endpoints`
- `/api/analytics/endpoints/:routeKey`
- `/api/analytics/tokens`
- `/api/analytics/tokens/:tokenId`

The API is envelope-based:

- Success: `{ "ok": true, "data": ... }`
- Error: `{ "ok": false, "error": { "code": "...", "message": "..." } }`

## Quick start

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm run check
npm test
npm start
```

Optional startup modes:

```bash
npm run start:skip-zero
npm run start:skip-lte1
npm start -- --defer-known-trade-count-lte=5
```

## Useful scripts

- `npm start`
- `npm run start:skip-zero`
- `npm run start:skip-lte1`
- `npm run check`
- `npm test`
- `npm run report:status`
- `npm run report:tokens`
- `npm run report:token -- <tokenId>`

## Example requests

```bash
curl http://127.0.0.1:8787/api/status
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20"
curl "http://127.0.0.1:8787/api/tokens/<tokenId>"
curl "http://127.0.0.1:8787/api/tokens/<tokenId>/candles?interval=day&limit=30"
curl "http://127.0.0.1:8787/api/analytics/summary?hours=24"
curl "http://127.0.0.1:8787/api/analytics/endpoints?hours=168"
curl "http://127.0.0.1:8787/api/analytics/tokens?page=1&pageSize=20&sort=visitsTotal&order=desc"
```

For the complete field-level contract, use [docs/api.md](./docs/api.md) or [openapi.yaml](./openapi.yaml).
