import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type { ApiAccessRecord } from "../lib/analytics.js";
import {
  createApiRequestHandler,
  type ApiDataService,
  type ApiServerOptions,
} from "./apiServer.js";
import type {
  AnalyticsSummary,
  EndpointAnalyticsDetail,
  EndpointAnalyticsSummary,
  TokenCandle,
  TokenCandlesResult,
  TokenCandleQuery,
  PaginatedResult,
  ServiceStatus,
  TokenDetail,
  TokenListQuery,
  TokenSummary,
  TokenVisitListQuery,
  TokenVisitAnalytics,
  TokenVisitSummary,
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
  options: ApiServerOptions = {},
): Promise<MockResponseResult> {
  const handler = createApiRequestHandler(service, options);
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
    visitCountTotal: 7,
    visitCount24h: 3,
    lastVisitedAt: 555,
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

function sampleAnalyticsSummary(hours = 168): AnalyticsSummary {
  return {
    hours,
    windowStart: 1_000,
    windowEnd: 2_000,
    apiAccessCountTotal: 20,
    apiAccessCountWindow: 12,
    apiAccessBuckets: [
      {
        bucketStart: 1_000,
        bucketEnd: 4_599,
        accessCount: 5,
        successCount: 4,
        clientErrorCount: 1,
        serverErrorCount: 0,
      },
    ],
    tokenVisitCountTotal: 9,
    tokenVisitCountWindow: 4,
    tokenVisitBuckets: [
      {
        bucketStart: 1_000,
        bucketEnd: 4_599,
        visitCount: 2,
      },
    ],
  };
}

function sampleEndpointAnalyticsSummary(): EndpointAnalyticsSummary {
  return {
    routeKey: "tokens.detail",
    accessCountTotal: 10,
    accessCountWindow: 6,
    successCountTotal: 8,
    successCountWindow: 5,
    clientErrorCountTotal: 2,
    clientErrorCountWindow: 1,
    serverErrorCountTotal: 0,
    serverErrorCountWindow: 0,
    lastAccessedAt: 9_999,
  };
}

function sampleEndpointAnalyticsDetail(hours = 168): EndpointAnalyticsDetail {
  return {
    ...sampleEndpointAnalyticsSummary(),
    hours,
    windowStart: 1_000,
    windowEnd: 2_000,
    buckets: [
      {
        bucketStart: 1_000,
        bucketEnd: 4_599,
        accessCount: 3,
        successCount: 2,
        clientErrorCount: 1,
        serverErrorCount: 0,
      },
    ],
  };
}

function sampleTokenVisitSummary(tokenId = "token-1"): TokenVisitSummary {
  return {
    tokenId,
    visitCountTotal: 8,
    visitCount24h: 3,
    lastVisitedAt: 6_789,
  };
}

function sampleTokenVisitAnalytics(
  tokenId = "token-1",
  hours = 168,
): TokenVisitAnalytics {
  return {
    ...sampleTokenVisitSummary(tokenId),
    hours,
    windowStart: 1_000,
    windowEnd: 2_000,
    visitCountWindow: 4,
    buckets: [
      {
        bucketStart: 1_000,
        bucketEnd: 4_599,
        visitCount: 2,
      },
    ],
  };
}

function makeBaseService(): ApiDataService {
  return {
    isHealthy: () => true,
    isReady: () => false,
    getStatus: () => sampleStatus(),
    listTokens: () => ({ items: [], page: 1, pageSize: 50, total: 0 }),
    getToken: () => null,
    getAnalyticsSummary: (hours) => ({
      hours,
      windowStart: 0,
      windowEnd: 0,
      apiAccessCountTotal: 0,
      apiAccessCountWindow: 0,
      apiAccessBuckets: [],
      tokenVisitCountTotal: 0,
      tokenVisitCountWindow: 0,
      tokenVisitBuckets: [],
    }),
    listEndpointAnalytics: () => [],
    getEndpointAnalytics: (_routeKey, hours) => ({
      routeKey: "status",
      hours,
      windowStart: 0,
      windowEnd: 0,
      accessCountTotal: 0,
      accessCountWindow: 0,
      successCountTotal: 0,
      successCountWindow: 0,
      clientErrorCountTotal: 0,
      clientErrorCountWindow: 0,
      serverErrorCountTotal: 0,
      serverErrorCountWindow: 0,
      lastAccessedAt: null,
      buckets: [],
    }),
    listTokenVisits: (query) => ({
      items: [],
      page: query.page,
      pageSize: query.pageSize,
      total: 0,
    }),
    getTokenVisitAnalytics: (_tokenId, hours) => ({
      tokenId: "token-1",
      hours,
      windowStart: 0,
      windowEnd: 0,
      visitCountTotal: 0,
      visitCount24h: 0,
      visitCountWindow: 0,
      lastVisitedAt: null,
      buckets: [],
    }),
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

test("analytics endpoints parse queries and return data", async () => {
  let capturedSummaryHours = 0;
  let capturedEndpointsHours = 0;
  let capturedEndpointDetail: { routeKey: string; hours: number } | null = null;
  let capturedTokenVisitsQuery: TokenVisitListQuery | null = null;
  let capturedTokenVisitDetail: { tokenId: string; hours: number } | null = null;

  const summary = sampleAnalyticsSummary(24);
  const endpointSummary = sampleEndpointAnalyticsSummary();
  const endpointDetail = sampleEndpointAnalyticsDetail(72);
  const tokenVisitAnalytics = sampleTokenVisitAnalytics("token-a", 96);

  const service: ApiDataService = {
    ...makeBaseService(),
    getAnalyticsSummary: (hours) => {
      capturedSummaryHours = hours;
      return summary;
    },
    listEndpointAnalytics: (hours) => {
      capturedEndpointsHours = hours;
      return [endpointSummary];
    },
    getEndpointAnalytics: (routeKey, hours) => {
      capturedEndpointDetail = { routeKey, hours };
      return endpointDetail;
    },
    listTokenVisits: (query) => {
      capturedTokenVisitsQuery = query;
      return {
        page: query.page,
        pageSize: query.pageSize,
        total: 1,
        items: [sampleTokenVisitSummary("token-a")],
      };
    },
    getTokenVisitAnalytics: (tokenId, hours) => {
      capturedTokenVisitDetail = { tokenId, hours };
      return tokenId === "token-a" ? tokenVisitAnalytics : null;
    },
  };

  const summaryResponse = await invoke(
    service,
    "GET",
    "/api/analytics/summary?hours=24",
  );
  assert.equal(summaryResponse.statusCode, 200);
  assert.equal(capturedSummaryHours, 24);
  assert.deepEqual(summaryResponse.bodyJson, { ok: true, data: summary });

  const endpointsResponse = await invoke(
    service,
    "GET",
    "/api/analytics/endpoints?hours=48",
  );
  assert.equal(endpointsResponse.statusCode, 200);
  assert.equal(capturedEndpointsHours, 48);
  assert.deepEqual(endpointsResponse.bodyJson, {
    ok: true,
    data: [endpointSummary],
  });

  const endpointDetailResponse = await invoke(
    service,
    "GET",
    "/api/analytics/endpoints/tokens.detail?hours=72",
  );
  assert.equal(endpointDetailResponse.statusCode, 200);
  assert.deepEqual(capturedEndpointDetail, {
    routeKey: "tokens.detail",
    hours: 72,
  });
  assert.deepEqual(endpointDetailResponse.bodyJson, {
    ok: true,
    data: endpointDetail,
  });

  const tokenVisitsResponse = await invoke(
    service,
    "GET",
    "/api/analytics/tokens?page=2&pageSize=25&sort=lastVisitedAt&order=asc",
  );
  assert.equal(tokenVisitsResponse.statusCode, 200);
  assert.deepEqual(capturedTokenVisitsQuery, {
    page: 2,
    pageSize: 25,
    sort: "lastVisitedAt",
    order: "asc",
  });
  assert.deepEqual(tokenVisitsResponse.bodyJson, {
    ok: true,
    data: {
      page: 2,
      pageSize: 25,
      total: 1,
      items: [sampleTokenVisitSummary("token-a")],
    },
  });

  const tokenVisitDetailResponse = await invoke(
    service,
    "GET",
    "/api/analytics/tokens/token-a?hours=96",
  );
  assert.equal(tokenVisitDetailResponse.statusCode, 200);
  assert.deepEqual(capturedTokenVisitDetail, {
    tokenId: "token-a",
    hours: 96,
  });
  assert.deepEqual(tokenVisitDetailResponse.bodyJson, {
    ok: true,
    data: tokenVisitAnalytics,
  });

  const missingToken = await invoke(
    service,
    "GET",
    "/api/analytics/tokens/token-missing?hours=24",
  );
  assert.equal(missingToken.statusCode, 404);

  const invalidRoute = await invoke(
    service,
    "GET",
    "/api/analytics/endpoints/not-a-route",
  );
  assert.equal(invalidRoute.statusCode, 404);
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

test("analytics recorder tracks matched business routes only after final status is known", async () => {
  const recorded: ApiAccessRecord[] = [];
  const service: ApiDataService = {
    ...makeBaseService(),
    getToken: (tokenId) => (tokenId === "token-a" ? sampleTokenDetail(tokenId) : null),
  };
  const options: ApiServerOptions = {
    analyticsRecorder: {
      recordApiAccess: (entry) => {
        recorded.push(entry);
      },
    },
    logger: {
      warn: () => {},
    },
  };

  await invoke(service, "GET", "/healthz", options);
  await invoke(service, "GET", "/api/status", options);
  await invoke(service, "POST", "/api/tokens", options);
  await invoke(service, "GET", "/api/tokens/token-a", options);
  await invoke(service, "GET", "/api/tokens/token-missing", options);
  await invoke(service, "GET", "/api/unknown", options);
  await invoke(service, "GET", "/api/analytics/summary", options);

  assert.deepEqual(recorded, [
    {
      routeKey: "status",
      statusCode: 200,
      tokenId: undefined,
      countTokenVisit: false,
    },
    {
      routeKey: "tokens.list",
      statusCode: 405,
      tokenId: undefined,
      countTokenVisit: false,
    },
    {
      routeKey: "tokens.detail",
      statusCode: 200,
      tokenId: "token-a",
      countTokenVisit: true,
    },
    {
      routeKey: "tokens.detail",
      statusCode: 404,
      tokenId: "token-missing",
      countTokenVisit: false,
    },
  ]);
});
