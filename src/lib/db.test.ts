import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "./db.js";
import type { ProcessedTradeRecord } from "./types.js";

function makeTrade(params: {
  tokenId: string;
  offerTxid: string;
  outIdx: number;
  spendTxid: string;
  paidSats: string;
  soldAtoms?: string;
  blockHeight: number;
  blockTimestamp: number;
}): ProcessedTradeRecord {
  return {
    tokenId: params.tokenId,
    offerTxid: params.offerTxid,
    offerOutIdx: params.outIdx,
    spendTxid: params.spendTxid,
    variantType: "PARTIAL",
    paidSats: params.paidSats,
    soldAtoms: params.soldAtoms ?? "1",
    priceNanosatsPerAtom: params.paidSats,
    takerScriptHex: null,
    blockHeight: params.blockHeight,
    blockHash: `block-${params.blockHeight}`,
    blockTimestamp: params.blockTimestamp,
    rawTradeJson: "{}",
  };
}

test("tracked token lifecycle fields support bootstrap/init/ready progress", () => {
  const db = openDatabase(":memory:");

  try {
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

    db.setBootstrapCohort(["token-a"]);
    assert.equal(db.countBootstrapTokens(), 1);
    assert.equal(db.countReadyBootstrapTokens(), 0);

    db.markTokenInitStarted("token-a", 1000);
    let tokenA = db.getTrackedToken("token-a");
    assert.equal(tokenA?.initStatus, "INITIALIZING");
    assert.equal(tokenA?.isReady, false);
    assert.equal(tokenA?.initStartedAt, 1000);

    db.markTokenInitCompleted("token-a", 2000);
    tokenA = db.getTrackedToken("token-a");
    assert.equal(tokenA?.initStatus, "READY");
    assert.equal(tokenA?.isReady, true);
    assert.equal(tokenA?.initCompletedAt, 2000);
    assert.equal(db.countReadyBootstrapTokens(), 1);

    db.markTokenInitFailed("token-b", 3000, "network timeout");
    const tokenB = db.getTrackedToken("token-b");
    assert.equal(tokenB?.initStatus, "ERROR");
    assert.equal(tokenB?.isReady, false);
    assert.equal(tokenB?.lastInitError, "network timeout");
  } finally {
    db.close();
  }
});

test("insertProcessedTrades dedupes and updates token_block_stats incrementally", () => {
  const db = openDatabase(":memory:");

  try {
    const tokenId = "token-x";
    const initialInsert = db.insertProcessedTrades([
      makeTrade({
        tokenId,
        offerTxid: "offer-1",
        outIdx: 0,
        spendTxid: "spend-1",
        paidSats: "100",
        blockHeight: 100,
        blockTimestamp: 1000,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-1",
        outIdx: 0,
        spendTxid: "spend-1-dup",
        paidSats: "100",
        blockHeight: 100,
        blockTimestamp: 1000,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-2",
        outIdx: 0,
        spendTxid: "spend-2",
        paidSats: "50",
        blockHeight: 100,
        blockTimestamp: 1010,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-3",
        outIdx: 0,
        spendTxid: "spend-3",
        paidSats: "70",
        blockHeight: 101,
        blockTimestamp: 1020,
      }),
    ]);
    assert.equal(initialInsert.length, 3);

    const initialBuckets = db.getTokenBlockStats(tokenId);
    assert.equal(initialBuckets.length, 2);
    assert.equal(initialBuckets[0]?.tokenId, tokenId);
    assert.equal(initialBuckets[0]?.blockHeight, 100);
    assert.equal(initialBuckets[0]?.tradeCount, 2);
    assert.equal(initialBuckets[0]?.volumeSats, "150");
    assert.equal(
      Number.isFinite(initialBuckets[0]?.updatedAt ?? Number.NaN),
      true,
    );
    assert.equal(initialBuckets[1]?.tokenId, tokenId);
    assert.equal(initialBuckets[1]?.blockHeight, 101);
    assert.equal(initialBuckets[1]?.tradeCount, 1);
    assert.equal(initialBuckets[1]?.volumeSats, "70");
    assert.equal(
      Number.isFinite(initialBuckets[1]?.updatedAt ?? Number.NaN),
      true,
    );

    const secondInsert = db.insertProcessedTrades([
      makeTrade({
        tokenId,
        offerTxid: "offer-3",
        outIdx: 0,
        spendTxid: "spend-3-dup",
        paidSats: "70",
        blockHeight: 101,
        blockTimestamp: 1020,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-4",
        outIdx: 0,
        spendTxid: "spend-4",
        paidSats: "30",
        blockHeight: 100,
        blockTimestamp: 1030,
      }),
    ]);
    assert.equal(secondInsert.length, 1);

    const buckets = db.getTokenBlockStats(tokenId);
    assert.equal(buckets[0]?.tradeCount, 3);
    assert.equal(buckets[0]?.volumeSats, "180");
    assert.equal(buckets[1]?.tradeCount, 1);
    assert.equal(buckets[1]?.volumeSats, "70");
  } finally {
    db.close();
  }
});

test("recomputeTokenAggregateStats builds total + 144/1008 windows and keeps backward-compatible updates", () => {
  const db = openDatabase(":memory:");

  try {
    const tokenId = "token-window";
    db.insertProcessedTrades([
      makeTrade({
        tokenId,
        offerTxid: "offer-old",
        outIdx: 0,
        spendTxid: "spend-old",
        paidSats: "200",
        blockHeight: 800,
        blockTimestamp: 8000,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-mid",
        outIdx: 0,
        spendTxid: "spend-mid",
        paidSats: "300",
        blockHeight: 950,
        blockTimestamp: 9500,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-new",
        outIdx: 0,
        spendTxid: "spend-new",
        paidSats: "50",
        blockHeight: 1000,
        blockTimestamp: 10000,
      }),
    ]);

    const aggregate = db.recomputeTokenAggregateStats(tokenId, 1000);
    assert.equal(aggregate.tradeCount, 3);
    assert.equal(aggregate.cumulativePaidSats, "550");
    assert.equal(aggregate.recent144TradeCount, 2);
    assert.equal(aggregate.recent144VolumeSats, "350");
    assert.equal(aggregate.recent1008TradeCount, 3);
    assert.equal(aggregate.recent1008VolumeSats, "550");
    assert.equal(aggregate.lastTradeOfferTxid, "offer-new");
    assert.equal(aggregate.lastTradeBlockHeight, 1000);

    db.replaceTokenStats({
      tokenId,
      tradeCount: 4,
      cumulativePaidSats: "999",
      lastTradeOfferTxid: "offer-new",
      lastTradeOfferOutIdx: 0,
      lastTradeBlockHeight: 1000,
      lastTradeBlockTimestamp: 10000,
    });

    const afterCompatUpdate = db.getTokenAggregateStats(tokenId);
    assert.equal(afterCompatUpdate?.tradeCount, 4);
    assert.equal(afterCompatUpdate?.cumulativePaidSats, "999");
    assert.equal(afterCompatUpdate?.recent144TradeCount, 2);
    assert.equal(afterCompatUpdate?.recent144VolumeSats, "350");
    assert.equal(afterCompatUpdate?.recent1008TradeCount, 3);
    assert.equal(afterCompatUpdate?.recent1008VolumeSats, "550");
  } finally {
    db.close();
  }
});

test("listTokenStatsPage and listTradeHistory return paginated rows", () => {
  const db = openDatabase(":memory:");

  try {
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
    db.markTokenReady("token-a", true, 1000);
    db.markTokenReady("token-b", false, 1000);

    db.insertProcessedTrades([
      makeTrade({
        tokenId: "token-a",
        offerTxid: "a1",
        outIdx: 0,
        spendTxid: "sa1",
        paidSats: "400",
        blockHeight: 1000,
        blockTimestamp: 10000,
      }),
      makeTrade({
        tokenId: "token-b",
        offerTxid: "b1",
        outIdx: 0,
        spendTxid: "sb1",
        paidSats: "50",
        blockHeight: 1000,
        blockTimestamp: 10001,
      }),
    ]);

    db.recomputeAllTokenAggregateStats(1000);

    const readyOnly = db.listTokenStatsPage({
      limit: 10,
      readyOnly: true,
      sortBy: "recent_144_volume_sats",
      order: "desc",
    });
    assert.equal(readyOnly.length, 1);
    assert.equal(readyOnly[0]?.tokenId, "token-a");

    const tokenTrades = db.listTradeHistory({
      tokenId: "token-a",
      limit: 10,
      order: "desc",
    });
    assert.equal(tokenTrades.length, 1);
    assert.equal(tokenTrades[0]?.offerTxid, "a1");

    const globalTrades = db.listTradeHistory({
      limit: 1,
      order: "desc",
    });
    assert.equal(globalTrades.length, 1);
    assert.equal(globalTrades[0]?.offerTxid, "b1");
  } finally {
    db.close();
  }
});
