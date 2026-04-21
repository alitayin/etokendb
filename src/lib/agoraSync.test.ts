import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "./db.js";
import {
  discoverActiveTokens,
  extractAgoraTokenIdsFromTx,
  syncActiveTokens,
  syncTokenHistory,
  type SyncDependencies,
} from "./agoraSync.js";
import type { AppConfig } from "./config.js";

const BASE_CONFIG: AppConfig = {
  chronikUrl: "https://example.invalid",
  sqlitePath: ":memory:",
  serverPort: 8787,
  activeGroupPageSize: 50,
  historyPageSize: 50,
  tailPageCount: 2,
  pollIntervalMs: 1000,
  discoveryIntervalMs: 5000,
  tipRefreshIntervalMs: 1000,
  bootstrapConcurrency: 2,
  apiPageSizeDefault: 50,
  apiPageSizeMax: 200,
  analyticsHourlyRetentionHours: 90 * 24,
  requestTimeoutMs: 5_000,
  requestRetryCount: 2,
  wsConnectTimeoutMs: 5_000,
};

function makeTakenOffer(params: {
  offerTxid: string;
  outIdx?: number;
  tokenId: string;
  offeredAtoms?: bigint;
  paidSats: bigint;
  soldAtoms: bigint;
}): unknown {
  return {
    outpoint: {
      txid: params.offerTxid,
      outIdx: params.outIdx ?? 2,
    },
    status: "TAKEN",
    variant: {
      type: "PARTIAL",
    },
    token: {
      tokenId: params.tokenId,
      atoms: params.offeredAtoms ?? 1000n,
    },
    takenInfo: {
      sats: params.paidSats,
      atoms: params.soldAtoms,
      takerScriptHex: "76a914cafebabecafebabecafebabecafebabecafebabe88ac",
    },
  };
}

function makeRawSpendTx(params: {
  spendTxid: string;
  offerTxid: string;
  outIdx?: number;
  blockHeight?: number;
  blockTimestamp?: number;
}): unknown {
  return {
    txid: params.spendTxid,
    block: {
      height: params.blockHeight ?? 100,
      hash: `block-${params.blockHeight ?? 100}`,
      timestamp: params.blockTimestamp ?? 1000,
    },
    inputs: [
      {
        prevOut: {
          txid: params.offerTxid,
          outIdx: params.outIdx ?? 2,
        },
        plugins: {
          agora: {
            groups: ["54deadbeef"],
          },
        },
      },
    ],
    outputs: [],
  };
}

function makeDeps(
  pages: Array<{ rawTxs: unknown[]; offers: unknown[] }>,
  groupPages: Array<{ startHex?: string; groups: string[]; nextStart?: string }> = [],
): SyncDependencies {
  return {
    chronik: {
      plugin: () =>
        ({
          groups: async (
            _prefixHex: string,
            startHex = "",
            pageSize = 50,
          ) => {
            void pageSize;
            const resolvedPage =
              groupPages.find((entry) => (entry.startHex ?? "") === startHex) ??
              groupPages[0];
            return {
              groups: (resolvedPage?.groups ?? []).map((group) => ({
                group,
              })),
              nextStart: resolvedPage?.nextStart ?? "",
            };
          },
          history: async (_groupHex: string, page = 0) => ({
            txs: (pages[page]?.rawTxs ?? []) as never[],
            numTxs: pages.length,
            numPages: pages.length,
          }),
        }) as never,
      tx: async () => {
        throw new Error("unused in this test");
      },
      ws: () => {
        throw new Error("unused in this test");
      },
    } as never,
    agora: {
      offeredFungibleTokenIds: async () => [],
      historicOffers: async ({ page = 0 }) => ({
        offers: (pages[page]?.offers ?? []) as never[],
        numTxs: pages.length,
        numPages: pages.length,
      }),
      subscribeWs: () => {},
      unsubscribeWs: () => {},
    } as never,
  } as SyncDependencies;
}

test("extractAgoraTokenIdsFromTx deduplicates ids from inputs and outputs", () => {
  const tx = {
    txid: "spend-1",
    inputs: [
      {
        prevOut: { txid: "offer-1", outIdx: 2 },
        plugins: {
          agora: {
            groups: [
              "54aaaabbbb",
              "46aaaabbbb",
              "47ccccdddd",
            ],
          },
        },
      },
    ],
    outputs: [
      {
        sats: 546n,
        outputScript: "76a91400",
        plugins: {
          agora: {
            groups: [
              "54aaaabbbb",
              "46eeeeffff",
            ],
          },
        },
      },
    ],
  } as never;

  assert.deepEqual(extractAgoraTokenIdsFromTx(tx).sort(), [
    "aaaabbbb",
    "ccccdddd",
    "eeeeffff",
  ]);
});

test("discoverActiveTokens returns fungible token seeds from Agora discovery", async () => {
  const deps = makeDeps([], [
    {
      startHex: "46",
      groups: ["46token-a", "46token-b", "47nft-group"],
      nextStart: "",
    },
  ]);

  const seeds = await discoverActiveTokens(deps, BASE_CONFIG);

  assert.deepEqual(seeds, [
    {
      tokenId: "token-a",
      groupHex: "46token-a",
      groupPrefixHex: "46",
      kind: "FUNGIBLE",
    },
    {
      tokenId: "token-b",
      groupHex: "46token-b",
      groupPrefixHex: "46",
      kind: "FUNGIBLE",
    },
  ]);
});

test("syncTokenHistory inserts trades once and accumulates stats once", async () => {
  const tokenId = "token-1";
  const db = openDatabase(":memory:");

  try {
    const deps = makeDeps([
      {
        rawTxs: [
          makeRawSpendTx({
            spendTxid: "spend-1",
            offerTxid: "offer-1",
            blockHeight: 101,
            blockTimestamp: 1001,
          }),
          makeRawSpendTx({
            spendTxid: "spend-2",
            offerTxid: "offer-2",
            blockHeight: 102,
            blockTimestamp: 1002,
          }),
        ],
        offers: [
          makeTakenOffer({
            offerTxid: "offer-1",
            tokenId,
            paidSats: 100n,
            soldAtoms: 10n,
          }),
          makeTakenOffer({
            offerTxid: "offer-2",
            tokenId,
            paidSats: 200n,
            soldAtoms: 20n,
          }),
        ],
      },
    ]);

    const first = await syncTokenHistory(db, deps, BASE_CONFIG, tokenId, "full");
    assert.equal(first.insertedTradeCount, 2);

    const statsAfterFirst = db.getTokenStats(tokenId);
    assert.deepEqual(statsAfterFirst, {
      tokenId,
      tradeCount: 2,
      cumulativePaidSats: "300",
      lastTradeOfferTxid: "offer-2",
      lastTradeOfferOutIdx: 2,
      lastTradeBlockHeight: 102,
      lastTradeBlockTimestamp: 1002,
      lastTradePriceNanosatsPerAtom: "10000000000",
    });

    const second = await syncTokenHistory(db, deps, BASE_CONFIG, tokenId, "tail");
    assert.equal(second.insertedTradeCount, 0);
    assert.deepEqual(db.getTokenStats(tokenId), statsAfterFirst);

    const countRow = db.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM processed_trades
          WHERE token_id = ?
        `,
      )
      .get(tokenId) as { count: number };
    assert.equal(countRow.count, 2);
  } finally {
    db.close();
  }
});

test("tail sync scans multiple pages so new trades on page 1 are not missed", async () => {
  const tokenId = "token-2";
  const db = openDatabase(":memory:");

  try {
    const deps = makeDeps([
      {
        rawTxs: [
          makeRawSpendTx({
            spendTxid: "spend-1",
            offerTxid: "offer-1",
            blockHeight: 101,
            blockTimestamp: 1001,
          }),
        ],
        offers: [
          makeTakenOffer({
            offerTxid: "offer-1",
            tokenId,
            paidSats: 100n,
            soldAtoms: 10n,
          }),
        ],
      },
      {
        rawTxs: [
          makeRawSpendTx({
            spendTxid: "spend-2",
            offerTxid: "offer-2",
            blockHeight: 102,
            blockTimestamp: 1002,
          }),
        ],
        offers: [
          makeTakenOffer({
            offerTxid: "offer-2",
            tokenId,
            paidSats: 250n,
            soldAtoms: 25n,
          }),
        ],
      },
    ]);

    await syncTokenHistory(db, deps, BASE_CONFIG, tokenId, "full");

    const depsWithDuplicateFirstPage = makeDeps([
      {
        rawTxs: [
          makeRawSpendTx({
            spendTxid: "spend-1",
            offerTxid: "offer-1",
            blockHeight: 101,
            blockTimestamp: 1001,
          }),
        ],
        offers: [
          makeTakenOffer({
            offerTxid: "offer-1",
            tokenId,
            paidSats: 100n,
            soldAtoms: 10n,
          }),
        ],
      },
      {
        rawTxs: [
          makeRawSpendTx({
            spendTxid: "spend-3",
            offerTxid: "offer-3",
            blockHeight: 103,
            blockTimestamp: 1003,
          }),
        ],
        offers: [
          makeTakenOffer({
            offerTxid: "offer-3",
            tokenId,
            paidSats: 400n,
            soldAtoms: 40n,
          }),
        ],
      },
    ]);

    const result = await syncTokenHistory(
      db,
      depsWithDuplicateFirstPage,
      BASE_CONFIG,
      tokenId,
      "tail",
    );
    assert.equal(result.insertedTradeCount, 1);

    assert.deepEqual(db.getTokenStats(tokenId), {
      tokenId,
      tradeCount: 3,
      cumulativePaidSats: "750",
      lastTradeOfferTxid: "offer-3",
      lastTradeOfferOutIdx: 2,
      lastTradeBlockHeight: 103,
      lastTradeBlockTimestamp: 1003,
      lastTradePriceNanosatsPerAtom: "10000000000",
    });
  } finally {
    db.close();
  }
});

test("syncActiveTokens refresh marks tokens missing from discovery as inactive", async () => {
  const db = openDatabase(":memory:");

  try {
    db.upsertTrackedToken({
      tokenId: "stale-token",
      groupHex: "46stale-token",
      groupPrefixHex: "46",
      kind: "FUNGIBLE",
    });

    const deps = makeDeps([], [
      {
        groups: ["46fresh-token"],
        nextStart: "",
      },
    ]);

    const result = await syncActiveTokens(db, deps, BASE_CONFIG, "tail");
    assert.equal(result.discovered, 1);

    const activeRows = db.sqlite
      .prepare(
        `
          SELECT token_id, is_active
          FROM tracked_tokens
          ORDER BY token_id ASC
        `,
      )
      .all() as Array<{ token_id: string; is_active: number }>;

    assert.deepEqual(activeRows, [
      { token_id: "fresh-token", is_active: 1 },
      { token_id: "stale-token", is_active: 0 },
    ]);
  } finally {
    db.close();
  }
});
