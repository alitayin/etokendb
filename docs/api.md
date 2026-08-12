# API Reference

This document is the human-readable reference for the public `etokendb` HTTP API.

For machine-readable tooling, use [../openapi.yaml](../openapi.yaml).

## Base URLs

- Local default: `http://127.0.0.1:8787`
- Production example: `https://etokendb.alitayin.com`

## General behavior

- Public endpoints are `GET` only except the paid invoice routes documented below.
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
- `INVALID_TOKEN_ID`
- `INVALID_SCORE`
- `COMMENT_TOO_LONG`
- `INVALID_TXID`
- `INVOICE_NOT_FOUND`
- `INVOICE_EXPIRED`
- `PAYMENT_AUTHOR_MISMATCH`
- `PAYMENT_TXID_REUSED`
- `PAYMENT_OUTPUT_MISMATCH`
- `PROJECT_INFO_EMPTY`
- `PROJECT_INFO_DESCRIPTION_TOO_LONG`
- `PROJECT_INFO_URL_TOO_LONG`
- `INVALID_PROJECT_INFO_URL`
- `PROJECT_INFO_PAYMENTS_DISABLED`
- `PROJECT_INFO_PAYMENT_CONFIG_INVALID`
- `PROJECT_INFO_AUTH_PUBKEY_REQUIRED`
- `PROJECT_INFO_CREATOR_REQUIRED`
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
| `GET /api/tokens/:tokenId/reviews` | Paginated paid reviews |
| `GET /api/tokens/:tokenId/reviews/summary` | Paid review score summary |
| `POST /api/tokens/:tokenId/reviews/invoices` | Create a paid review invoice |
| `GET /api/tokens/:tokenId/project-info` | Current token project info |
| `POST /api/tokens/:tokenId/project-info/invoices` | Create a paid project info invoice |
| `GET /api/review-invoices/:invoiceId` | Review invoice detail |
| `POST /api/review-invoices/:invoiceId/submit-tx` | Submit payment txid for verification |
| `GET /api/project-info-invoices/:invoiceId` | Project info invoice detail |
| `POST /api/project-info-invoices/:invoiceId/submit-tx` | Submit project info payment txid for verification |
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
- `chainCursorHeight`: latest persisted finalized block processed by catch-up
- `chainLagBlocks`: current tip minus the persisted finalized cursor
- `pendingTokenCount`: queued and running token synchronizations
- `wsReconnectAttempts`: current application-managed reconnect attempt count
- `lastDiscoveryAt`
- `lastTipUpdateAt`
- `lastCatchUpAt`
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
- `reviewAverageScore`: number or `null` when no paid scores exist
- `reviewScorerCount`: number of author addresses in the latest-score aggregate
- `reviewCountTotal`: total published review records
- `reviewCommentCountTotal`: total published review records with non-empty comments
- `lastReviewAt`: Unix milliseconds or `null`

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

## Paid reviews

Paid reviews are append-only public records. A token does not need to be tracked by `etokendb`, but `tokenId` must be a 64-character hex string. Each published review has an integer `score` from `0` to `10`; `comment` is optional and limited to 500 UTF-8 bytes.

Score aggregation uses only the latest published score per `(tokenId, authorAddress)`. Historical paid reviews remain visible in the review list.

### `GET /api/tokens/:tokenId/reviews/summary`

Returns the score and review totals for one token.

Response `data`:

- `averageScore`: number or `null` when no scores exist
- `scorerCount`: number of author addresses in the latest-score aggregate
- `reviewCountTotal`: total published review records
- `commentCountTotal`: total published review records with non-empty comments
- `lastReviewAt`: Unix milliseconds or `null`

Example:

```bash
curl "http://127.0.0.1:8787/api/tokens/<tokenId>/reviews/summary"
```

### `GET /api/tokens/:tokenId/reviews`

Returns the latest published review stream for one token.

Query parameters:

- `page`: integer, default `1`
- `pageSize`: integer, default `50`, max `200`

Each item contains:

- `reviewId`
- `tokenId`
- `authorMasked`
- `score`
- `comment`
- `createdAt`

Example:

```bash
curl "http://127.0.0.1:8787/api/tokens/<tokenId>/reviews?page=1&pageSize=20"
```

### `POST /api/tokens/:tokenId/reviews/invoices`

Creates a pending invoice for one paid review. The invoice is denominated in XEC/sats. By default it is paid with XEC, but callers may request a one-time SS or SC token payment instead.

Request body:

- `authorAddress`: connected eCash address
- `score`: integer from `0` to `10`
- `comment`: optional string, max 500 UTF-8 bytes
- `paymentKind`: optional, `xec` or `token`, default `xec`
- `paymentTokenSymbol`: required when `paymentKind` is `token`; currently `SS` or `SC`

Response `data`:

- `invoiceId`
- `tokenId`
- `authorAddress`
- `score`
- `comment`
- `paymentAddress`
- `expectedPaidSats`
- `expectedPaidXec`
- `paymentKind`: `xec` or `token`
- `paymentTokenId`: token id for token invoices, otherwise `null`
- `paymentTokenSymbol`: `SS` or `SC` for token invoices, otherwise `null`
- `creditSatsPerAtom`: sats of invoice value covered by one token atom, otherwise `null`
- `expectedPaidAtoms`: minimum token atoms required for token invoices, otherwise `null`
- `status`
- `expiresAt`
- `paymentTxid`
- `publishedReviewId`

Payment rules:

- XEC invoices require an output paying exactly `expectedPaidSats` to `paymentAddress`.
- Token invoices require the transaction to spend the selected token from `authorAddress` and pay at least `expectedPaidAtoms` of that token to `paymentAddress`.
- Token overpayment is accepted, but excess atoms are not saved as credit and are not applied to future invoices.

Example:

```bash
curl -X POST "http://127.0.0.1:8787/api/tokens/<tokenId>/reviews/invoices" \
  -H "content-type: application/json" \
  -d '{"authorAddress":"ecash:...","score":8,"comment":"optional"}'

curl -X POST "http://127.0.0.1:8787/api/tokens/<tokenId>/reviews/invoices" \
  -H "content-type: application/json" \
  -d '{"authorAddress":"ecash:...","score":8,"paymentKind":"token","paymentTokenSymbol":"SS"}'
```

## Project info

Each token can publish one current project info record with `description`, `websiteUrl`, `xUrl`, and `telegramUrl`. Only the token creator address may create a paid invoice to change it. The creator is resolved from the token genesis `authPubkey` when present, or from the first decodable input address of the token genesis tx when `authPubkey` is absent.

Fee schedule:

- initial publish: `1,000,000 XEC`
- later updates: `100,000 XEC`

### `GET /api/tokens/:tokenId/project-info`

Returns the current published project info, or `null` if none exists yet.

### `POST /api/tokens/:tokenId/project-info/invoices`

Creates a pending invoice for publishing or updating project info. The `editorAddress` must match the token creator address resolved by the server from Chronik.

Request body:

- `editorAddress`: eCash address
- `description`: optional string, trimmed and capped at 1000 UTF-8 bytes
- `websiteUrl`: optional HTTP(S) URL
- `xUrl`: optional `https://x.com/...` or `https://twitter.com/...` URL
- `telegramUrl`: optional `https://t.me/...` or `https://telegram.me/...` URL

Response `data`:

- `invoiceId`
- `tokenId`
- `editorAddress`
- `description`
- `websiteUrl`
- `xUrl`
- `telegramUrl`
- `paymentAddress`
- `expectedPaidSats`
- `expectedPaidXec`
- `feeTier`
- `status`
- `expiresAt`
- `paymentTxid`

### `GET /api/project-info-invoices/:invoiceId`

Returns one project info invoice.

### `POST /api/project-info-invoices/:invoiceId/submit-tx`

Submits a payment transaction id for verification. The transaction must spend at least one input from `editorAddress` and pay exactly `expectedPaidSats` to `paymentAddress`. If Chronik has not indexed the tx yet, the invoice remains `tx_submitted` and the background retry loop can publish it later.

### `GET /api/review-invoices/:invoiceId`

Returns one invoice using the same response shape as invoice creation.

Example:

```bash
curl "http://127.0.0.1:8787/api/review-invoices/<invoiceId>"
```

### `POST /api/review-invoices/:invoiceId/submit-tx`

Submits a payment transaction id for verification. For XEC invoices, the transaction must spend at least one input from `authorAddress` and pay exactly `expectedPaidSats` to `paymentAddress`. For token invoices, it must spend the selected token from `authorAddress` and pay at least `expectedPaidAtoms` of that token to `paymentAddress`; mint baton outputs do not count. Token overpayment is accepted but not saved as reusable credit. Mempool transactions are accepted. If Chronik has not indexed the tx yet, the invoice remains `tx_submitted` and the background retry loop can publish it later.

Request body:

- `txid`: 64-character transaction id hex

Example:

```bash
curl -X POST "http://127.0.0.1:8787/api/review-invoices/<invoiceId>/submit-tx" \
  -H "content-type: application/json" \
  -d '{"txid":"<txid>"}'
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
- `tokens.reviews.list`
- `tokens.reviews.summary`
- `tokens.review-invoices.create`
- `tokens.project-info.detail`
- `tokens.project-info-invoices.create`
- `review-invoices.detail`
- `review-invoices.submit-tx`
- `project-info-invoices.detail`
- `project-info-invoices.submit-tx`
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
