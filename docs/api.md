# API Reference

This document is the human-readable reference for the public `etokendb` HTTP API.

For machine-readable tooling, use [../openapi.yaml](../openapi.yaml).

## Base URLs

- Local default: `http://127.0.0.1:8787`
- Production example: `https://etokendb.alitayin.com`

## General behavior

- All public endpoints are `GET` only.
- Unsupported methods return `405 METHOD_NOT_ALLOWED`.
- Success responses use this envelope:

```json
{
  "ok": true,
  "data": {}
}
```

- Error responses use this envelope:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_QUERY",
    "message": "page must be an integer in [1, 200]"
  }
}
```

## Common conventions

### Time fields

- ISO timestamps are UTC strings, for example `2026-04-21T12:20:58.940Z`
- Most analytics and token activity timestamps are Unix milliseconds
- Trade block timestamps and candle bucket timestamps are Unix seconds

### Numeric fields

- Counts use JSON numbers
- Large satoshi and price values use strings so precision is preserved

### Pagination defaults

- `page` default: `1`
- `pageSize` default: `50`
- `pageSize` max: `200`

### Common error codes

- `INVALID_QUERY`
- `BAD_PATH`
- `TOKEN_NOT_FOUND`
- `ROUTE_NOT_FOUND`
- `ENDPOINT_DISABLED`
- `METHOD_NOT_ALLOWED`
- `NOT_FOUND`
- `INTERNAL_ERROR`

## Endpoint index

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Basic health check |
| `GET /readyz` | Readiness check |
| `GET /api/status` | Runtime and sync status |
| `GET /api/tokens` | Paginated token summary list |
| `GET /api/tokens/:tokenId` | Single token detail |
| `GET /api/tokens/:tokenId/trades` | Token trade history |
| `GET /api/tokens/:tokenId/candles` | Token OHLCV candles |
| `GET /api/trades` | Global trade history |
| `GET /api/analytics/summary` | Site-wide access summary |
| `GET /api/analytics/endpoints` | Access summary by endpoint |
| `GET /api/analytics/endpoints/:routeKey` | Hourly trend for one endpoint |
| `GET /api/analytics/tokens` | Token visit leaderboard |
| `GET /api/analytics/tokens/:tokenId` | Hourly visit trend for one token |

## Health and status

### `GET /healthz`

Returns `200` when the service is healthy and `503` when it is not.

Response `data`:

- `healthy`: boolean

Example:

```bash
curl http://127.0.0.1:8787/healthz
```

### `GET /readyz`

Returns `200` when the service is ready to serve and `503` when it is still bootstrapping or degraded enough to report not-ready.

Response `data`:

- `ready`: boolean

Example:

```bash
curl http://127.0.0.1:8787/readyz
```

### `GET /api/status`

Returns a runtime snapshot of sync state and service metadata.

Response `data` fields:

- `healthy`
- `ready`
- `phase`
- `wsConnected`
- `chronikUrl`
- `dbPath`
- `dbSizeBytes`
- `startedAt`
- `statusDate`
- `statusTimezone`
- `tipHeight`
- `totalTrackedTokenCount`
- `activeTokenCount`
- `readyTokenCount`
- `tradedTokenCount`
- `discoveredTodayCount`
- `activeDiscoveredTodayCount`
- `bootstrapTokenCount`
- `bootstrapReadyCount`
- `discoveryPageCount`
- `lastDiscoveryAt`
- `lastTipUpdateAt`
- `lastError`

`phase` is one of:

- `starting`
- `discovering`
- `subscribing`
- `initializing`
- `ready`
- `degraded`
- `error`

Example:

```bash
curl http://127.0.0.1:8787/api/status
```

## Tokens

### `GET /api/tokens`

Returns paginated token summaries.

Query parameters:

- `page`: integer, default `1`
- `pageSize`: integer, default `50`, max `200`
- `sort`: one of:
  - `totalTradeCount`
  - `totalVolumeSats`
  - `latestPriceNanosatsPerAtom`
  - `recent144TradeCount`
  - `recent144VolumeSats`
  - `recent1008TradeCount`
  - `recent1008VolumeSats`
  - `recent4320TradeCount`
  - `recent4320VolumeSats`
  - `lastTradeBlockHeight`
  - `lastTradeBlockTimestamp`
- `order`: `asc` or `desc`, default `desc`
- `readyOnly`: `true` or `false`

If `readyOnly` is omitted, the current service behavior is to default to ready tokens only.

Response `data` fields:

- `page`
- `pageSize`
- `total`
- `items`: array of token summaries

Each token summary contains:

- `tokenId`
- `isActive`
- `isReady`
- `bootstrapCohort`
- `totalTradeCount`
- `totalVolumeSats`
- `latestPriceNanosatsPerAtom`
- `recent144TradeCount`
- `recent144VolumeSats`
- `recent144PriceChangeBps`
- `recent144PriceChangePct`
- `recent1008TradeCount`
- `recent1008VolumeSats`
- `recent4320TradeCount`
- `recent4320VolumeSats`
- `lastTradeBlockHeight`
- `lastTradeBlockTimestamp`
- `lastSyncedAt`
- `lastWsEventAt`
- `visitCountTotal`
- `visitCount24h`
- `lastVisitedAt`

Examples:

```bash
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20"
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20&sort=recent144VolumeSats&order=desc"
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20&sort=totalVolumeSats&order=desc&readyOnly=true"
```

### `GET /api/tokens/:tokenId`

Returns a single token record.

Path parameters:

- `tokenId`: token identifier

Response `data`:

- `summary`: token summary object from `GET /api/tokens`
- `firstDiscoveredAt`
- `lastDiscoveredAt`
- `initStatus`

`initStatus` is currently one of:

- `PENDING`
- `INITIALIZING`
- `READY`
- `ERROR`

Errors:

- `404 TOKEN_NOT_FOUND`

Example:

```bash
curl "http://127.0.0.1:8787/api/tokens/<tokenId>"
```

### `GET /api/tokens/:tokenId/trades`

Returns paginated trade history for one token.

Query parameters:

- `page`: integer, default `1`
- `pageSize`: integer, default `50`, max `200`

Response `data`:

- `page`
- `pageSize`
- `total`
- `items`

Each trade item contains:

- `tokenId`
- `offerTxid`
- `offerOutIdx`
- `spendTxid`
- `paidSats`
- `soldAtoms`
- `priceNanosatsPerAtom`
- `takerScriptHex`
- `blockHeight`
- `blockTimestamp`

Errors:

- `404 TOKEN_NOT_FOUND`

Example:

```bash
curl "http://127.0.0.1:8787/api/tokens/<tokenId>/trades?page=1&pageSize=20"
```

### `GET /api/tokens/:tokenId/candles`

Returns OHLCV candle data for one token.

Query parameters:

- `interval`: `hour`, `day`, or `week`, default `day`
- `limit`: integer, default `200`, max `200`

Response `data`:

- `tokenId`
- `interval`
- `timezone`
- `items`

Each candle item contains:

- `bucketStart`
- `bucketEnd`
- `openPriceNanosatsPerAtom`
- `highPriceNanosatsPerAtom`
- `lowPriceNanosatsPerAtom`
- `closePriceNanosatsPerAtom`
- `tradeCount`
- `volumeSats`
- `soldAtoms`

The current candle timezone is `Asia/Shanghai`.

Errors:

- `400 INVALID_QUERY`
- `404 TOKEN_NOT_FOUND`

Example:

```bash
curl "http://127.0.0.1:8787/api/tokens/<tokenId>/candles?interval=day&limit=30"
```

## Trades

### `GET /api/trades`

Returns paginated global trade history across all tokens.

Query parameters:

- `page`: integer, default `1`
- `pageSize`: integer, default `50`, max `200`

Response shape matches `GET /api/tokens/:tokenId/trades`.

Possible errors:

- `404 ENDPOINT_DISABLED` if a host application disables this route

Example:

```bash
curl "http://127.0.0.1:8787/api/trades?page=1&pageSize=20"
```

## Access analytics

These endpoints expose server-side access aggregates. They do not require front-end tracking calls.

Analytics rules:

- Health probes are excluded: `/healthz` and `/readyz`
- Analytics reads are excluded: `/api/analytics/*`
- Endpoint analytics count matched business routes even on `4xx` and `5xx`
- Token visits are counted only when `GET /api/tokens/:tokenId` returns `200`

Supported analytics `routeKey` values:

- `status`
- `tokens.list`
- `tokens.detail`
- `tokens.trades`
- `tokens.candles`
- `trades.list`

The default analytics query window is `168` hours. The default retention window is `2160` hours, or 90 days. The maximum query window is capped by the deployment's `ANALYTICS_HOURLY_RETENTION_HOURS`.

### `GET /api/analytics/summary`

Returns site-wide API traffic totals and site-wide token visit totals.

Query parameters:

- `hours`: integer, default `168`

Response `data`:

- `hours`
- `windowStart`
- `windowEnd`
- `apiAccessCountTotal`
- `apiAccessCountWindow`
- `apiAccessBuckets`
- `tokenVisitCountTotal`
- `tokenVisitCountWindow`
- `tokenVisitBuckets`

Each API access bucket contains:

- `bucketStart`
- `bucketEnd`
- `accessCount`
- `successCount`
- `clientErrorCount`
- `serverErrorCount`

Each token visit bucket contains:

- `bucketStart`
- `bucketEnd`
- `visitCount`

Example:

```bash
curl "http://127.0.0.1:8787/api/analytics/summary?hours=24"
```

### `GET /api/analytics/endpoints`

Returns a summary row for every supported `routeKey`.

Query parameters:

- `hours`: integer, default `168`

Each item contains:

- `routeKey`
- `accessCountTotal`
- `accessCountWindow`
- `successCountTotal`
- `successCountWindow`
- `clientErrorCountTotal`
- `clientErrorCountWindow`
- `serverErrorCountTotal`
- `serverErrorCountWindow`
- `lastAccessedAt`

Example:

```bash
curl "http://127.0.0.1:8787/api/analytics/endpoints?hours=168"
```

### `GET /api/analytics/endpoints/:routeKey`

Returns one endpoint summary and its hourly trend buckets.

Path parameters:

- `routeKey`: one of the fixed analytics route keys listed above

Query parameters:

- `hours`: integer, default `168`

Response `data`:

- All fields from `GET /api/analytics/endpoints`
- `hours`
- `windowStart`
- `windowEnd`
- `buckets`

Errors:

- `404 ROUTE_NOT_FOUND`

Example:

```bash
curl "http://127.0.0.1:8787/api/analytics/endpoints/tokens.detail?hours=24"
```

### `GET /api/analytics/tokens`

Returns a paginated token visit leaderboard.

Query parameters:

- `page`: integer, default `1`
- `pageSize`: integer, default `50`, max `200`
- `sort`: `visitsTotal`, `visits24h`, or `lastVisitedAt`
- `order`: `asc` or `desc`, default `desc`

Response `data`:

- `page`
- `pageSize`
- `total`
- `items`

Each item contains:

- `tokenId`
- `visitCountTotal`
- `visitCount24h`
- `lastVisitedAt`

Example:

```bash
curl "http://127.0.0.1:8787/api/analytics/tokens?page=1&pageSize=20&sort=visitsTotal&order=desc"
```

### `GET /api/analytics/tokens/:tokenId`

Returns one token's access analytics and hourly visit buckets.

Path parameters:

- `tokenId`: token identifier

Query parameters:

- `hours`: integer, default `168`

Response `data`:

- `tokenId`
- `visitCountTotal`
- `visitCount24h`
- `lastVisitedAt`
- `hours`
- `windowStart`
- `windowEnd`
- `visitCountWindow`
- `buckets`

Errors:

- `404 TOKEN_NOT_FOUND`

Example:

```bash
curl "http://127.0.0.1:8787/api/analytics/tokens/<tokenId>?hours=168"
```

## Notes for dashboards and clients

- Use `GET /api/tokens` if you only need visit counters in a token table
- Use `GET /api/analytics/summary` for top-line cards
- Use `GET /api/analytics/endpoints` for per-endpoint summary tables
- Use `GET /api/analytics/endpoints/:routeKey` for single-endpoint charts
- Use `GET /api/analytics/tokens` for token visit leaderboards
- Use `GET /api/analytics/tokens/:tokenId` for token-level visit charts
