# etokendb Runbook

Additional docs:

- API handbook: [api.md](./api.md)
- OpenAPI spec: [../openapi.yaml](../openapi.yaml)
- Project overview: [../README.md](../README.md)

## 1. First deploy on a VPS

### System packages

```bash
sudo apt update
sudo apt install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2
```

### Clone and install

```bash
git clone <your-repo-url> etokendb
cd etokendb
npm install
```

### Minimal `.env`

```env
CHRONIK_URL=https://chronik-native1.fabien.cash
SQLITE_PATH=./data/etokendb.sqlite
SERVER_PORT=8787

BOOTSTRAP_CONCURRENCY=8
ACTIVE_GROUP_PAGE_SIZE=50
HISTORY_PAGE_SIZE=200
TAIL_PAGE_COUNT=2
DISCOVERY_INTERVAL_MS=60000
TIP_REFRESH_INTERVAL_MS=60000
POLL_INTERVAL_MS=60000
REQUEST_TIMEOUT_MS=20000
REQUEST_RETRY_COUNT=3
WS_CONNECT_TIMEOUT_MS=10000
```

If the machine also needs a proxy:

```env
http_proxy=http://127.0.0.1:7890
https_proxy=http://127.0.0.1:7890
all_proxy=socks5://127.0.0.1:7890
```

### First foreground run

```bash
npm run check
npm test
npm start
```

If you want faster startup by deferring previously-synced zero-trade tokens out of blocking bootstrap:

```bash
npm run start:skip-zero
```

If you want a custom threshold, pass it on the CLI:

```bash
npm start -- --defer-known-trade-count-lte=1
```

Convenience script for the common `<= 1 trade` threshold:

```bash
npm run start:skip-lte1
```

### Start under PM2

```bash
pm2 start npm --name etokendb -- start
pm2 save
pm2 startup
```

If you want the `tradeCount <= 1` bootstrap deferral mode under PM2, start it with the script explicitly:

```bash
pm2 start npm --name etokendb -- run start:skip-lte1
pm2 save
```

## 2. Update workflow

### Fast path

```bash
git pull
npm install
pm2 restart etokendb
```

If you deployed with trade-count bootstrap deferral:

```bash
git pull
npm install
pm2 restart etokendb
```

Important:

- `pm2 restart etokendb` keeps the existing start command.
- Restarting does not switch bootstrap modes by itself.
- To switch from normal startup to `start:skip-zero` or `start:skip-lte1`, recreate the PM2 process with the intended command.

Example:

```bash
pm2 delete etokendb
pm2 start npm --name etokendb -- run start:skip-lte1
pm2 save
```

### Safer path

```bash
git pull
npm install
npm run check
npm test
pm2 restart etokendb
```

Notes:

- Keep `.env` and `SQLITE_PATH` stable.
- The SQLite file is the source of truth. Restarting does not wipe synced data.
- A restart still re-scans currently active tokens during bootstrap, but already-processed trades are deduped and not counted twice.

## 3. Runtime behavior

- The service bootstraps first, then opens the API port.
- During bootstrap, each active fungible token gets initialized.
- If a token receives websocket activity while it is still initializing, it is marked dirty and gets a tail catch-up before it becomes ready.
- If websocket is unavailable, the service falls back to polling mode and still completes bootstrap.
- Every 60 seconds the service rediscovers newly active fungible tokens.
- Optional startup mode:
  `--skip-known-zero-trade-bootstrap` is a convenience alias for `--defer-known-trade-count-lte=0`.
- General startup mode:
  `--defer-known-trade-count-lte=N` keeps previously-ready tokens with `tradeCount <= N` out of blocking bootstrap. They remain queryable from existing DB data, and only get tail-synced later when websocket or polling marks them dirty.

## 4. API port and endpoints

Default port:

```text
8787
```

Main endpoints:

- `GET /healthz`
- `GET /readyz`
- `GET /api/status`
- `GET /api/tokens`
- `GET /api/tokens/:tokenId`
- `GET /api/tokens/:tokenId/trades`
- `GET /api/tokens/:tokenId/candles`
- `GET /api/trades`
- `GET /api/analytics/summary`
- `GET /api/analytics/endpoints`
- `GET /api/analytics/endpoints/:routeKey`
- `GET /api/analytics/tokens`
- `GET /api/analytics/tokens/:tokenId`

Useful local checks:

```bash
curl http://127.0.0.1:8787/api/status
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20"
curl "http://127.0.0.1:8787/api/tokens/<tokenId>"
curl "http://127.0.0.1:8787/api/tokens/<tokenId>/trades?page=1&pageSize=20"
curl "http://127.0.0.1:8787/api/tokens/<tokenId>/candles?interval=day&limit=30"
curl "http://127.0.0.1:8787/api/analytics/summary?hours=24"
curl "http://127.0.0.1:8787/api/analytics/endpoints?hours=168"
```

Local DB reports:

```bash
npm run report:status
npm run report:tokens
npm run report:token -- <tokenId>
```

Useful startup commands:

```bash
npm start
npm run start:skip-zero
npm run start:skip-lte1
npm start -- --defer-known-trade-count-lte=1
```

## 4.1 Nginx reverse proxy

Example config for `etokendb.alitayin.com` is included at:

`deploy/nginx/etokendb.alitayin.com.conf`

Typical Ubuntu setup:

```bash
sudo apt install -y nginx
sudo cp deploy/nginx/etokendb.alitayin.com.conf /etc/nginx/sites-available/etokendb.alitayin.com
sudo ln -s /etc/nginx/sites-available/etokendb.alitayin.com /etc/nginx/sites-enabled/etokendb.alitayin.com
sudo nginx -t
sudo systemctl reload nginx
```

After nginx is working on port `80`, enable HTTPS:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d etokendb.alitayin.com
```

After you proxy through nginx, you usually do not need public access to `8787` anymore.
You can keep the app bound to `127.0.0.1:8787` behind nginx and close public firewall/security-group access to `8787`.

## 5. Token ranking and descending order

Yes. Token lists support both sorting and descending order.

Supported `sort` values:

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

Supported `order` values:

- `asc`
- `desc`

Examples:

Top tokens by last 144 blocks volume:

```bash
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20&sort=recent144VolumeSats&order=desc"
```

Top tokens by last 1008 blocks volume:

```bash
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20&sort=recent1008VolumeSats&order=desc"
```

Top tokens by last 4320 blocks volume:

```bash
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20&sort=recent4320VolumeSats&order=desc"
```

Top tokens by total traded volume:

```bash
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20&sort=totalVolumeSats&order=desc"
```

Top tokens by latest trade price:

```bash
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20&sort=latestPriceNanosatsPerAtom&order=desc"
```

Only ready tokens:

```bash
curl "http://127.0.0.1:8787/api/tokens?page=1&pageSize=20&sort=recent1008VolumeSats&order=desc&readyOnly=true"
```

`1008` blocks is the current "7 day" window in this product.
`4320` blocks is the current "30 day" window in this product.

Additional token summary fields:

- `latestPriceNanosatsPerAtom`
- `recent144PriceChangeBps`
- `recent144PriceChangePct`

`recent144PriceChangePct` compares the earliest confirmed trade price and latest confirmed trade price inside the last 144 blocks.
If there are fewer than 2 confirmed trades in that 144-block window, it returns `0.00`.

## 6. Current improvement points and risks

These are review notes only. They do not change current business behavior.

### A. Restart bootstrap still re-walks all currently active tokens

- This is safe because dedupe is handled by persisted `processed_trades`.
- But startup cost still scales with the current active token set.
- If the active set keeps growing, restart time will also keep growing.
- Improvement direction:
  store a stronger per-token checkpoint for bootstrap resumption, so already-fully-initialized active tokens can start in tail mode instead of always doing a fresh full walk.

### B. Discovery is still limited to currently active fungible Agora groups

- The current design finds fungible tokens that are active in Agora now.
- Historical-only tokens that once traded but no longer have active groups are still outside the discovery scope.
- Improvement direction:
  add a secondary discovery source or an offline historical sweep path if "all tokens that ever traded on Agora" becomes a strict requirement.

### C. Polling fallback uses a fixed tail depth

- In degraded mode the service relies on tail polling and `TAIL_PAGE_COUNT`.
- For a very high-volume token, more than `TAIL_PAGE_COUNT` new pages could appear between sweeps.
- Improvement direction:
  dynamically widen tail depth when recent token velocity is high, or drive catch-up by last seen block/tx anchors instead of a fixed page count.

### D. Reorg repair is not implemented

- Current storage is good for dedupe and window stats.
- But a deep reorg repair flow is still not part of the product.
- Improvement direction:
  add explicit reorg detection and rollback/rebuild rules if the service is expected to be fully reorg-resilient.

### E. Public API has no auth or rate limiting

- Fine for internal use or behind a reverse proxy.
- Risky if exposed directly to the internet.
- Improvement direction:
  put it behind nginx/Caddy and add rate limiting or IP controls.

### F. Websocket tx handling does not yet distinguish mempool from confirmed updates

- Chronik websocket tx messages include mempool and confirmed lifecycle events.
- The current service marks tokens dirty on any matching tx event.
- Because trade storage only persists confirmed trades, a mempool-triggered tail sync can be a harmless no-op until confirmation arrives.
- Improvement direction:
  treat `TX_CONFIRMED` and block-driven catch-up as the real persistence trigger, while using mempool events only as an early hint.

## 7. Current macro stats

`GET /api/status` and `npm run report:status` include these high-level fields:

- `dbPath`
- `dbSizeBytes`
- `totalTrackedTokenCount`
- `activeTokenCount`
- `readyTokenCount`
- `tradedTokenCount`
- `discoveredTodayCount`
- `activeDiscoveredTodayCount`

`today` is calculated using the local machine timezone.
