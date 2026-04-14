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

test("service exposes 30 day rolling stats in token list and detail views", () => {
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
      offerTxid: "offer-new",
      outIdx: 0,
      spendTxid: "spend-new",
      paidSats: "50",
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
    assert.equal(page.items[0]?.recent4320TradeCount, 3);
    assert.equal(page.items[0]?.recent4320VolumeSats, "750");

    const detail = service.getToken("token-30d");
    assert.equal(detail?.summary.recent4320TradeCount, 3);
    assert.equal(detail?.summary.recent4320VolumeSats, "750");
  } finally {
    service.stop();
    db.close();
  }
});
