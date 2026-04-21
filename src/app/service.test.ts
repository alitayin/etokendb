import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../lib/db.js";
import type { AppConfig } from "../lib/config.js";
import { AgoraTokenService } from "./service.js";

function makeProcessedTrade(params: {
  tokenId: string;
  offerTxid: string;
  outIdx: number;
  spendTxid: string;
  paidSats: string;
  blockHeight: number;
  blockTimestamp: number;
}) {
  return {
    tokenId: params.tokenId,
    offerTxid: params.offerTxid,
    offerOutIdx: params.outIdx,
    spendTxid: params.spendTxid,
    variantType: "PARTIAL" as const,
    paidSats: params.paidSats,
    soldAtoms: "1",
    priceNanosatsPerAtom: params.paidSats,
    takerScriptHex: null,
    blockHeight: params.blockHeight,
    blockHash: `block-${params.blockHeight}`,
    blockTimestamp: params.blockTimestamp,
    rawTradeJson: "{}",
  };
}

function requireResolver(value: (() => void) | null): () => void {
  if (value === null) {
    throw new Error("resolver was not assigned");
  }
  return value;
}

const BASE_CONFIG: AppConfig = {
  chronikUrl: "https://example.invalid",
  sqlitePath: ":memory:",
  serverPort: 8787,
  activeGroupPageSize: 50,
  historyPageSize: 50,
  tailPageCount: 2,
  pollIntervalMs: 60_000,
  discoveryIntervalMs: 60_000,
  tipRefreshIntervalMs: 60_000,
  bootstrapConcurrency: 1,
  apiPageSizeDefault: 50,
  apiPageSizeMax: 200,
  analyticsHourlyRetentionHours: 90 * 24,
  requestTimeoutMs: 5_000,
  requestRetryCount: 2,
  wsConnectTimeoutMs: 5_000,
};

test("service performs tail catch-up before marking bootstrap token ready", async () => {
  const db = openDatabase(":memory:");
  const modes: string[] = [];
  let releaseFullSync: (() => void) | null = null;
  let fullSyncStarted: (() => void) | null = null;

  const fullSyncStartedPromise = new Promise<void>((resolve) => {
    fullSyncStarted = resolve;
  });
  const releaseFullSyncPromise = new Promise<void>((resolve) => {
    releaseFullSync = resolve;
  });

  const ws = {
    subscribeToBlocks: () => {},
    waitForOpen: async () => {},
    close: () => {},
  };

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () =>
          ({
            txid: "spend-1",
            inputs: [
              {
                prevOut: { txid: "offer-1", outIdx: 0 },
                plugins: {
                  agora: {
                    groups: ["54token-a", "46token-a"],
                  },
                },
              },
            ],
            outputs: [],
          }) as never,
        ws: () => ws as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-a",
            groupHex: "46token-a",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          assert.equal(tokenId, "token-a");
          modes.push(mode);
          if (mode === "full") {
            fullSyncStarted?.();
            await releaseFullSyncPromise;
          }

          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    const startPromise = service.start();
    await fullSyncStartedPromise;

    await (service as unknown as { handleWsMessage: (msg: unknown) => Promise<void> })
      .handleWsMessage({
        type: "Tx",
        txid: "spend-1",
      });

    requireResolver(releaseFullSync)();
    await startPromise;

    assert.deepEqual(modes, ["full", "tail"]);
    assert.equal(service.isReady(), true);
    assert.equal(service.getStatus().bootstrapReadyCount, 1);
    assert.equal(service.getStatus().phase, "ready");
  } finally {
    service.stop();
    db.close();
  }
});

test("service rejects startup when a bootstrap token fails initialization", async () => {
  const db = openDatabase(":memory:");
  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_001,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-fail",
            groupHex: "46token-fail",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async () => {
          throw new Error("boom");
        },
      },
    },
  );

  try {
    await assert.rejects(service.start(), /Bootstrap failed for token-fail: boom/);
    assert.equal(service.isReady(), false);
    assert.equal(service.getStatus().phase, "error");
  } finally {
    service.stop();
    db.close();
  }
});

test("service performs a polling catch-up before ready when websocket bootstrap is unavailable", async () => {
  const db = openDatabase(":memory:");
  const tipHeights = [900_100, 900_101, 900_101];
  const modes: string[] = [];

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {
              throw new Error("ws offline");
            },
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: tipHeights.shift() ?? 900_101,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-tail",
            groupHex: "46token-tail",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          assert.equal(tokenId, "token-tail");
          modes.push(mode);
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    await service.start();
    assert.deepEqual(modes, ["full", "tail"]);
    assert.equal(service.isReady(), true);
    assert.equal(service.getStatus().phase, "degraded");
  } finally {
    service.stop();
    db.close();
  }
});

test("service can defer known zero-trade tokens out of blocking bootstrap", async () => {
  const db = openDatabase(":memory:");
  db.upsertTrackedToken({
    tokenId: "token-zero",
    groupHex: "46token-zero",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-zero", true, 1000);
  db.markTokenSynced("token-zero", 1000);
  db.recomputeTokenAggregateStats("token-zero", 900_000);

  const seen: string[] = [];
  let releaseBlocking: (() => void) | null = null;
  const blockingPromise = new Promise<void>((resolve) => {
    releaseBlocking = resolve;
  });

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      deferKnownTradeCountLte: 0,
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-zero",
            groupHex: "46token-zero",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
          {
            tokenId: "token-live",
            groupHex: "46token-live",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          seen.push(`${tokenId}:${mode}`);
          if (tokenId === "token-live" && mode === "full") {
            await blockingPromise;
          }
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
        extractAgoraTokenIdsFromTx: () => ["token-zero"],
      },
    },
  );

  try {
    const startPromise = service.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["token-live:full"]);

    requireResolver(releaseBlocking)();
    await startPromise;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(service.getStatus().bootstrapTokenCount, 1);
    assert.equal(db.getTrackedToken("token-zero")?.bootstrapCohort, false);

    await (service as unknown as { handleWsMessage: (msg: unknown) => Promise<void> })
      .handleWsMessage({
        type: "Tx",
        txid: "spend-zero",
      });
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(!seen.includes("token-zero:full"));
    assert.ok(seen.includes("token-zero:tail"));
  } finally {
    service.stop();
    db.close();
  }
});

test("service can defer known low-trade tokens by configurable threshold", async () => {
  const db = openDatabase(":memory:");
  db.upsertTrackedToken({
    tokenId: "token-one",
    groupHex: "46token-one",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.insertProcessedTrades([
    {
      tokenId: "token-one",
      offerTxid: "offer-1",
      offerOutIdx: 0,
      spendTxid: "spend-1",
      variantType: "PARTIAL",
      paidSats: "100",
      soldAtoms: "10",
      priceNanosatsPerAtom: "10000000",
      takerScriptHex: null,
      blockHeight: 900_000,
      blockHash: "block-900000",
      blockTimestamp: 1_700_000_000,
      rawTradeJson: "{}",
    },
  ]);
  db.markTokenReady("token-one", true, 1000);
  db.markTokenSynced("token-one", 1000);
  db.recomputeTokenAggregateStats("token-one", 900_000);

  const seen: string[] = [];

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      deferKnownTradeCountLte: 1,
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-one",
            groupHex: "46token-one",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          seen.push(`${tokenId}:${mode}`);
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    await service.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.getStatus().bootstrapTokenCount, 0);
    assert.deepEqual(seen, []);
  } finally {
    service.stop();
    db.close();
  }
});

test("service exposes latest price and rolling stats in token list and detail views", () => {
  const db = openDatabase(":memory:");

  db.upsertTrackedToken({
    tokenId: "token-30d",
    groupHex: "46token-30d",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.upsertTrackedToken({
    tokenId: "token-small",
    groupHex: "46token-small",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-30d", true, 1000);
  db.markTokenReady("token-small", true, 1000);
  db.insertProcessedTrades([
    makeProcessedTrade({
      tokenId: "token-30d",
      offerTxid: "offer-30d",
      outIdx: 0,
      spendTxid: "spend-30d",
      paidSats: "300",
      blockHeight: 2000,
      blockTimestamp: 20_000,
    }),
    makeProcessedTrade({
      tokenId: "token-30d",
      offerTxid: "offer-week",
      outIdx: 0,
      spendTxid: "spend-week",
      paidSats: "400",
      blockHeight: 4500,
      blockTimestamp: 45_000,
    }),
    makeProcessedTrade({
      tokenId: "token-30d",
      offerTxid: "offer-24h-early",
      outIdx: 0,
      spendTxid: "spend-24h-early",
      paidSats: "100",
      blockHeight: 4900,
      blockTimestamp: 49_000,
    }),
    makeProcessedTrade({
      tokenId: "token-30d",
      offerTxid: "offer-new",
      outIdx: 0,
      spendTxid: "spend-new",
      paidSats: "150",
      blockHeight: 5000,
      blockTimestamp: 50_000,
    }),
    makeProcessedTrade({
      tokenId: "token-small",
      offerTxid: "offer-small",
      outIdx: 0,
      spendTxid: "spend-small",
      paidSats: "100",
      blockHeight: 5000,
      blockTimestamp: 50_100,
    }),
  ]);
  db.recomputeAllTokenAggregateStats(5000);

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 5000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  try {
    const page = service.listTokens({
      page: 1,
      pageSize: 10,
      sort: "recent4320VolumeSats",
      order: "desc",
      readyOnly: true,
    });
    assert.equal(page.items[0]?.tokenId, "token-30d");
    assert.equal(page.items[0]?.recent4320TradeCount, 4);
    assert.equal(page.items[0]?.recent4320VolumeSats, "950");
    assert.equal(page.items[0]?.latestPriceNanosatsPerAtom, "150");
    assert.equal(page.items[0]?.recent144PriceChangeBps, "5000");
    assert.equal(page.items[0]?.recent144PriceChangePct, "50.00");

    const detail = service.getToken("token-30d");
    assert.equal(detail?.summary.recent4320TradeCount, 4);
    assert.equal(detail?.summary.recent4320VolumeSats, "950");
    assert.equal(detail?.summary.latestPriceNanosatsPerAtom, "150");
    assert.equal(detail?.summary.recent144PriceChangeBps, "5000");
    assert.equal(detail?.summary.recent144PriceChangePct, "50.00");

    const singleTradeToken = service.getToken("token-small");
    assert.equal(singleTradeToken?.summary.latestPriceNanosatsPerAtom, "100");
    assert.equal(singleTradeToken?.summary.recent144PriceChangeBps, "0");
    assert.equal(singleTradeToken?.summary.recent144PriceChangePct, "0.00");
  } finally {
    service.stop();
    db.close();
  }
});

test("service exposes token visit stats and analytics queries", () => {
  const db = openDatabase(":memory:");
  const nowMs = Date.now();
  const oneHourMs = 60 * 60 * 1000;

  db.upsertTrackedToken({
    tokenId: "token-a",
    groupHex: "46token-a",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.upsertTrackedToken({
    tokenId: "token-b",
    groupHex: "46token-b",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-a", true, nowMs);
  db.markTokenReady("token-b", true, nowMs);
  db.recordApiAccess({
    routeKey: "tokens.detail",
    statusCode: 200,
    tokenId: "token-a",
    countTokenVisit: true,
    occurredAtMs: nowMs,
  });
  db.recordApiAccess({
    routeKey: "tokens.detail",
    statusCode: 200,
    tokenId: "token-a",
    countTokenVisit: true,
    occurredAtMs: nowMs - 30 * oneHourMs,
  });
  db.recordApiAccess({
    routeKey: "tokens.detail",
    statusCode: 200,
    tokenId: "token-b",
    countTokenVisit: true,
    occurredAtMs: nowMs - oneHourMs,
  });
  db.recordApiAccess({
    routeKey: "tokens.list",
    statusCode: 400,
    occurredAtMs: nowMs - oneHourMs,
  });

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 5000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  try {
    const tokens = service.listTokens({
      page: 1,
      pageSize: 10,
      readyOnly: true,
    });
    assert.deepEqual(tokens.items.slice(0, 2).map((item) => ({
      tokenId: item.tokenId,
      visitCountTotal: item.visitCountTotal,
      visitCount24h: item.visitCount24h,
    })), [
      {
        tokenId: "token-a",
        visitCountTotal: 2,
        visitCount24h: 1,
      },
      {
        tokenId: "token-b",
        visitCountTotal: 1,
        visitCount24h: 1,
      },
    ]);

    const tokenA = service.getToken("token-a");
    assert.equal(tokenA?.summary.visitCountTotal, 2);
    assert.equal(tokenA?.summary.visitCount24h, 1);
    assert.equal(tokenA?.summary.lastVisitedAt, nowMs);

    const summary = service.getAnalyticsSummary(48);
    assert.equal(summary.apiAccessCountTotal, 4);
    assert.equal(summary.tokenVisitCountTotal, 3);
    assert.equal(summary.apiAccessBuckets.length, 48);

    const endpoint = service.getEndpointAnalytics("tokens.detail", 48);
    assert.equal(endpoint.accessCountTotal, 3);
    assert.equal(endpoint.successCountTotal, 3);
    assert.equal(endpoint.buckets.length, 48);

    const visits = service.listTokenVisits({
      page: 1,
      pageSize: 10,
      sort: "visitsTotal",
      order: "desc",
    });
    assert.deepEqual(visits.items.slice(0, 2), [
      {
        tokenId: "token-a",
        visitCountTotal: 2,
        visitCount24h: 1,
        lastVisitedAt: nowMs,
      },
      {
        tokenId: "token-b",
        visitCountTotal: 1,
        visitCount24h: 1,
        lastVisitedAt: nowMs - oneHourMs,
      },
    ]);

    const tokenAnalytics = service.getTokenVisitAnalytics("token-a", 48);
    assert.equal(tokenAnalytics?.visitCountTotal, 2);
    assert.equal(tokenAnalytics?.visitCount24h, 1);
    assert.equal(tokenAnalytics?.visitCountWindow, 2);
    assert.equal(tokenAnalytics?.buckets.length, 48);

    assert.equal(service.getTokenVisitAnalytics("token-missing", 48), null);
  } finally {
    service.stop();
    db.close();
  }
});

test("service returns concrete trade history fields from stored trades", () => {
  const db = openDatabase(":memory:");

  db.upsertTrackedToken({
    tokenId: "token-trades",
    groupHex: "46token-trades",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-trades", true, 1000);
  db.insertProcessedTrades([
    makeProcessedTrade({
      tokenId: "token-trades",
      offerTxid: "offer-trades",
      outIdx: 3,
      spendTxid: "spend-trades",
      paidSats: "250",
      blockHeight: 5000,
      blockTimestamp: 50_000,
    }),
  ]);
  db.recomputeAllTokenAggregateStats(5000);

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 5000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  try {
    const trades = service.listTokenTrades("token-trades", {
      page: 1,
      pageSize: 10,
    });
    assert.equal(trades.total, 1);
    assert.deepEqual(trades.items[0], {
      tokenId: "token-trades",
      offerTxid: "offer-trades",
      offerOutIdx: 3,
      spendTxid: "spend-trades",
      paidSats: "250",
      soldAtoms: "1",
      priceNanosatsPerAtom: "250",
      takerScriptHex: null,
      blockHeight: 5000,
      blockTimestamp: 50000,
    });
  } finally {
    service.stop();
    db.close();
  }
});

test("service returns aggregated token candles for charting", () => {
  const db = openDatabase(":memory:");

  db.upsertTrackedToken({
    tokenId: "token-candles",
    groupHex: "46token-candles",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-candles", true, 1000);
  db.insertProcessedTrades([
    makeProcessedTrade({
      tokenId: "token-candles",
      offerTxid: "offer-open",
      outIdx: 0,
      spendTxid: "spend-open",
      paidSats: "300",
      blockHeight: 7000,
      blockTimestamp: Math.floor(Date.parse("2026-04-13T10:05:00+08:00") / 1000),
    }),
    makeProcessedTrade({
      tokenId: "token-candles",
      offerTxid: "offer-close",
      outIdx: 0,
      spendTxid: "spend-close",
      paidSats: "150",
      blockHeight: 7001,
      blockTimestamp: Math.floor(Date.parse("2026-04-13T10:45:00+08:00") / 1000),
    }),
  ]);

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 7001,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  try {
    const candles = service.listTokenCandles("token-candles", {
      interval: "hour",
      limit: 5,
    });
    assert.deepEqual(candles, {
      tokenId: "token-candles",
      interval: "hour",
      timezone: "Asia/Shanghai",
      items: [
        {
          bucketStart: Math.floor(Date.parse("2026-04-13T10:00:00+08:00") / 1000),
          bucketEnd: Math.floor(Date.parse("2026-04-13T10:59:59+08:00") / 1000),
          openPriceNanosatsPerAtom: "300",
          highPriceNanosatsPerAtom: "300",
          lowPriceNanosatsPerAtom: "150",
          closePriceNanosatsPerAtom: "150",
          tradeCount: 2,
          volumeSats: "450",
          soldAtoms: "2",
        },
      ],
    });
  } finally {
    service.stop();
    db.close();
  }
});
