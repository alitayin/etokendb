import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import {
  createApiRequestHandler,
  type ApiDataService,
} from "./apiServer.js";
import type {
  TokenCandle,
  TokenCandlesResult,
  TokenCandleQuery,
  PaginatedResult,
  ServiceStatus,
  TokenDetail,
  TokenListQuery,
  TokenSummary,
  TradeHistoryItem,
  TradeListQuery,
} from "./contracts.js";

interface MockResponseResult {
  statusCode: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: unknown;
}

async function invoke(
  service: ApiDataService,
  method: string,
  url: string,
): Promise<MockResponseResult> {
  const handler = createApiRequestHandler(service);
  const request = { method, url } as IncomingMessage;

  let bodyText = "";
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 200,
    setHeader(name: string, value: number | string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) {
        bodyText += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }
    },
  } as unknown as ServerResponse;

  await handler(request, response);

  let bodyJson: unknown = null;
  if (bodyText.length > 0) {
    bodyJson = JSON.parse(bodyText);
  }

  return {
    statusCode: (response as { statusCode: number }).statusCode,
    headers,
    bodyText,
    bodyJson,
  };
}

function sampleStatus(): ServiceStatus {
  return {
    ready: false,
    phase: "initializing",
    wsConnected: true,
    chronikUrl: "https://chronik-native1.fabien.cash",
    dbPath: "./data/etokendb.sqlite",
    dbSizeBytes: 123456,
    startedAt: "2026-04-15T00:00:00.000Z",
    statusDate: "2026-04-15",
    statusTimezone: "Asia/Shanghai",
    tipHeight: 123,
    totalTrackedTokenCount: 99,
    activeTokenCount: 42,
    readyTokenCount: 21,
    tradedTokenCount: 18,
    discoveredTodayCount: 6,
    activeDiscoveredTodayCount: 5,
    bootstrapTokenCount: 10,
    bootstrapReadyCount: 5,
    discoveryPageCount: 70,
    lastDiscoveryAt: "2026-04-15T00:10:00.000Z",
    lastTipUpdateAt: "2026-04-15T00:10:05.000Z",
    lastError: null,
  };
}

function sampleTokenSummary(tokenId = "token-1"): TokenSummary {
  return {
    tokenId,
    isActive: true,
    isReady: true,
    bootstrapCohort: true,
    totalTradeCount: 12,
    totalVolumeSats: "4000",
    latestPriceNanosatsPerAtom: "123456",
    recent144TradeCount: 4,
    recent144VolumeSats: "1000",
    recent144PriceChangeBps: "250",
    recent144PriceChangePct: "2.50",
    recent1008TradeCount: 8,
    recent1008VolumeSats: "2000",
    recent4320TradeCount: 18,
    recent4320VolumeSats: "6000",
    lastTradeBlockHeight: 111,
    lastTradeBlockTimestamp: 222,
    lastSyncedAt: 333,
    lastWsEventAt: 444,
  };
}

function sampleTokenDetail(tokenId = "token-1"): TokenDetail {
  return {
    summary: sampleTokenSummary(tokenId),
    firstDiscoveredAt: 100,
    lastDiscoveredAt: 200,
    initStatus: "ready",
  };
}

function sampleTrade(tokenId = "token-1", idx = 0): TradeHistoryItem {
  return {
    tokenId,
    offerTxid: `offer-${idx}`,
    offerOutIdx: idx,
    spendTxid: `spend-${idx}`,
    paidSats: "100",
    soldAtoms: "10",
    priceNanosatsPerAtom: "10000000",
    takerScriptHex: null,
    blockHeight: 100 + idx,
    blockTimestamp: 1000 + idx,
  };
}

function sampleCandle(idx = 0): TokenCandle {
  return {
    bucketStart: 1_000 + idx * 3_600,
    bucketEnd: 4_599 + idx * 3_600,
    openPriceNanosatsPerAtom: "100",
    highPriceNanosatsPerAtom: "120",
    lowPriceNanosatsPerAtom: "90",
    closePriceNanosatsPerAtom: "110",
    tradeCount: 3,
    volumeSats: "500",
    soldAtoms: "50",
  };
}

function makeBaseService(): ApiDataService {
  return {
    isHealthy: () => true,
    isReady: () => false,
    getStatus: () => sampleStatus(),
    listTokens: () => ({ items: [], page: 1, pageSize: 50, total: 0 }),
    getToken: () => null,
    listTokenTrades: (_tokenId, query) => ({
      items: [],
      page: query.page,
      pageSize: query.pageSize,
      total: 0,
    }),
    listTokenCandles: (tokenId, query) => ({
      tokenId,
      interval: query.interval,
      timezone: "Asia/Shanghai",
      items: [],
    }),
  };
}

test("healthz, readyz and status expose service state", async () => {
  const service = makeBaseService();

  const health = await invoke(service, "GET", "/healthz");
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.bodyJson, { ok: true, data: { healthy: true } });

  const ready = await invoke(service, "GET", "/readyz");
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.bodyJson, { ok: true, data: { ready: false } });

  const status = await invoke(service, "GET", "/api/status");
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.bodyJson, {
    ok: true,
    data: {
      healthy: true,
      ...sampleStatus(),
    },
  });
});

test("list tokens parses pagination and sorting query", async () => {
  let capturedQuery: TokenListQuery | null = null;
  const pageResult: PaginatedResult<TokenSummary> = {
    items: [sampleTokenSummary()],
    page: 2,
    pageSize: 25,
    total: 99,
  };

  const service: ApiDataService = {
    ...makeBaseService(),
    listTokens: (query) => {
      capturedQuery = query;
      return pageResult;
    },
  };

  const response = await invoke(
    service,
    "GET",
    "/api/tokens?page=2&pageSize=25&sort=recent4320VolumeSats&order=asc&readyOnly=true",
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(capturedQuery, {
    page: 2,
    pageSize: 25,
    sort: "recent4320VolumeSats",
    order: "asc",
    readyOnly: true,
  });
  assert.deepEqual(response.bodyJson, { ok: true, data: pageResult });
});

test("token detail and token trades endpoints return data and 404", async () => {
  let capturedTradeQuery: TradeListQuery | null = null;
  const tokenDetail = sampleTokenDetail("token-a");

  const service: ApiDataService = {
    ...makeBaseService(),
    getToken: (tokenId) => (tokenId === "token-a" ? tokenDetail : null),
    listTokenTrades: (tokenId, query) => {
      capturedTradeQuery = query;
      if (tokenId !== "token-a") {
        return {
          items: [],
          page: query.page,
          pageSize: query.pageSize,
          total: 0,
        };
      }
      return {
        items: [sampleTrade("token-a", 1), sampleTrade("token-a", 2)],
        page: query.page,
        pageSize: query.pageSize,
        total: 2,
      };
    },
  };

  const detail = await invoke(service, "GET", "/api/tokens/token-a");
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.bodyJson, { ok: true, data: tokenDetail });

  const missingToken = await invoke(service, "GET", "/api/tokens/token-missing");
  assert.equal(missingToken.statusCode, 404);

  const trades = await invoke(
    service,
    "GET",
    "/api/tokens/token-a/trades?page=3&pageSize=10",
  );
  assert.equal(trades.statusCode, 200);
  assert.deepEqual(capturedTradeQuery, { page: 3, pageSize: 10 });

  const missingTrades = await invoke(
    service,
    "GET",
    "/api/tokens/token-missing/trades",
  );
  assert.equal(missingTrades.statusCode, 404);
});

test("token candles endpoint parses query and returns chart data", async () => {
  let capturedCandleQuery: TokenCandleQuery | null = null;
  const tokenDetail = sampleTokenDetail("token-a");
  const candleResult: TokenCandlesResult = {
    tokenId: "token-a",
    interval: "week",
    timezone: "Asia/Shanghai",
    items: [sampleCandle(0), sampleCandle(1)],
  };

  const service: ApiDataService = {
    ...makeBaseService(),
    getToken: (tokenId) => (tokenId === "token-a" ? tokenDetail : null),
    listTokenCandles: (tokenId, query) => {
      capturedCandleQuery = query;
      assert.equal(tokenId, "token-a");
      return candleResult;
    },
  };

  const response = await invoke(
    service,
    "GET",
    "/api/tokens/token-a/candles?interval=week&limit=20",
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(capturedCandleQuery, {
    interval: "week",
    limit: 20,
  });
  assert.deepEqual(response.bodyJson, {
    ok: true,
    data: candleResult,
  });

  const missing = await invoke(service, "GET", "/api/tokens/token-missing/candles");
  assert.equal(missing.statusCode, 404);
});

test("global trades endpoint is optional", async () => {
  const disabled = await invoke(makeBaseService(), "GET", "/api/trades");
  assert.equal(disabled.statusCode, 404);

  const service: ApiDataService = {
    ...makeBaseService(),
    listTrades: (query) => ({
      items: [sampleTrade("token-g", 9)],
      page: query.page,
      pageSize: query.pageSize,
      total: 1,
    }),
  };

  const enabled = await invoke(service, "GET", "/api/trades?page=2&pageSize=5");
  assert.equal(enabled.statusCode, 200);
  assert.deepEqual(enabled.bodyJson, {
    ok: true,
    data: {
      items: [sampleTrade("token-g", 9)],
      page: 2,
      pageSize: 5,
      total: 1,
    },
  });
});

test("invalid query and method return proper errors", async () => {
  const service = makeBaseService();

  const invalidPage = await invoke(service, "GET", "/api/tokens?page=0");
  assert.equal(invalidPage.statusCode, 400);

  const invalidSort = await invoke(service, "GET", "/api/tokens?sort=unknown");
  assert.equal(invalidSort.statusCode, 400);

  const invalidReadyOnly = await invoke(service, "GET", "/api/tokens?readyOnly=1");
  assert.equal(invalidReadyOnly.statusCode, 400);

  const invalidInterval = await invoke(
    service,
    "GET",
    "/api/tokens/token-a/candles?interval=month",
  );
  assert.equal(invalidInterval.statusCode, 400);

  const method = await invoke(service, "POST", "/healthz");
  assert.equal(method.statusCode, 405);

  const missing = await invoke(service, "GET", "/api/unknown");
  assert.equal(missing.statusCode, 404);
});
