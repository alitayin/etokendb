import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

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

test("recomputeTokenAggregateStats builds total + 144/1008/4320 windows and keeps backward-compatible updates", () => {
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
        blockHeight: 100,
        blockTimestamp: 1000,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-30d",
        outIdx: 0,
        spendTxid: "spend-30d",
        paidSats: "300",
        blockHeight: 2000,
        blockTimestamp: 20000,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-week",
        outIdx: 0,
        spendTxid: "spend-week",
        paidSats: "400",
        blockHeight: 4500,
        blockTimestamp: 45000,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-new",
        outIdx: 0,
        spendTxid: "spend-new",
        paidSats: "50",
        blockHeight: 5000,
        blockTimestamp: 50000,
      }),
    ]);

    const aggregate = db.recomputeTokenAggregateStats(tokenId, 5000);
    assert.equal(aggregate.tradeCount, 4);
    assert.equal(aggregate.cumulativePaidSats, "950");
    assert.equal(aggregate.recent144TradeCount, 1);
    assert.equal(aggregate.recent144VolumeSats, "50");
    assert.equal(aggregate.recent144PriceChangeBps, "0");
    assert.equal(aggregate.recent1008TradeCount, 2);
    assert.equal(aggregate.recent1008VolumeSats, "450");
    assert.equal(aggregate.recent4320TradeCount, 3);
    assert.equal(aggregate.recent4320VolumeSats, "750");
    assert.equal(aggregate.lastTradeOfferTxid, "offer-new");
    assert.equal(aggregate.lastTradeBlockHeight, 5000);
    assert.equal(aggregate.lastTradePriceNanosatsPerAtom, "50");

    db.replaceTokenStats({
      tokenId,
      tradeCount: 5,
      cumulativePaidSats: "999",
      lastTradeOfferTxid: "offer-new",
      lastTradeOfferOutIdx: 0,
      lastTradeBlockHeight: 5000,
      lastTradeBlockTimestamp: 50000,
      lastTradePriceNanosatsPerAtom: "50",
    });

    const afterCompatUpdate = db.getTokenAggregateStats(tokenId);
    assert.equal(afterCompatUpdate?.tradeCount, 5);
    assert.equal(afterCompatUpdate?.cumulativePaidSats, "999");
    assert.equal(afterCompatUpdate?.recent144TradeCount, 1);
    assert.equal(afterCompatUpdate?.recent144VolumeSats, "50");
    assert.equal(afterCompatUpdate?.recent144PriceChangeBps, "0");
    assert.equal(afterCompatUpdate?.recent1008TradeCount, 2);
    assert.equal(afterCompatUpdate?.recent1008VolumeSats, "450");
    assert.equal(afterCompatUpdate?.recent4320TradeCount, 3);
    assert.equal(afterCompatUpdate?.recent4320VolumeSats, "750");
    assert.equal(afterCompatUpdate?.lastTradePriceNanosatsPerAtom, "50");
  } finally {
    db.close();
  }
});

test("recomputeTokenAggregateStats computes recent 144 block price change only when there are at least two window trades", () => {
  const db = openDatabase(":memory:");

  try {
    const tokenId = "token-price-change";
    db.insertProcessedTrades([
      makeTrade({
        tokenId,
        offerTxid: "offer-old",
        outIdx: 0,
        spendTxid: "spend-old",
        paidSats: "20",
        soldAtoms: "1",
        blockHeight: 4700,
        blockTimestamp: 47_000,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-early-window",
        outIdx: 0,
        spendTxid: "spend-early-window",
        paidSats: "100",
        soldAtoms: "1",
        blockHeight: 4900,
        blockTimestamp: 49_000,
      }),
      makeTrade({
        tokenId,
        offerTxid: "offer-late-window",
        outIdx: 0,
        spendTxid: "spend-late-window",
        paidSats: "150",
        soldAtoms: "1",
        blockHeight: 5000,
        blockTimestamp: 50_000,
      }),
    ]);

    const aggregate = db.recomputeTokenAggregateStats(tokenId, 5000);
    assert.equal(aggregate.recent144TradeCount, 2);
    assert.equal(aggregate.lastTradePriceNanosatsPerAtom, "150");
    assert.equal(aggregate.recent144PriceChangeBps, "5000");

    const statsPage = db.listTokenStatsPage({
      limit: 5,
      sortBy: "last_trade_price_nanosats_per_atom",
      order: "desc",
    });
    assert.equal(statsPage[0]?.tokenId, tokenId);
    assert.equal(statsPage[0]?.recent144PriceChangeBps, "5000");
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
      sortBy: "recent_4320_volume_sats",
      order: "desc",
    });
    assert.equal(readyOnly.length, 1);
    assert.equal(readyOnly[0]?.tokenId, "token-a");
    assert.equal(readyOnly[0]?.recent4320TradeCount, 1);
    assert.equal(readyOnly[0]?.recent4320VolumeSats, "400");

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

test("openDatabase migrates legacy token_stats rows to include 30 day rolling columns", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "etokendb-legacy-"));
  const sqlitePath = path.join(tempDir, "legacy.sqlite");
  const legacy = new Database(sqlitePath);

  try {
    legacy.exec(`
      CREATE TABLE token_stats (
        token_id TEXT PRIMARY KEY,
        trade_count INTEGER NOT NULL,
        cumulative_paid_sats TEXT NOT NULL,
        recent_144_trade_count INTEGER NOT NULL DEFAULT 0,
        recent_144_volume_sats TEXT NOT NULL DEFAULT '0',
        recent_1008_trade_count INTEGER NOT NULL DEFAULT 0,
        recent_1008_volume_sats TEXT NOT NULL DEFAULT '0',
        last_trade_offer_txid TEXT,
        last_trade_offer_out_idx INTEGER,
        last_trade_block_height INTEGER,
        last_trade_block_timestamp INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        `
          INSERT INTO token_stats (
            token_id,
            trade_count,
            cumulative_paid_sats,
            recent_144_trade_count,
            recent_144_volume_sats,
            recent_1008_trade_count,
            recent_1008_volume_sats,
            last_trade_offer_txid,
            last_trade_offer_out_idx,
            last_trade_block_height,
            last_trade_block_timestamp,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "legacy-token",
        3,
        "999",
        1,
        "100",
        2,
        "300",
        "offer-legacy",
        0,
        123,
        456,
        789,
      );
  } finally {
    legacy.close();
  }

  const db = openDatabase(sqlitePath);

  try {
    const columns = db.sqlite
      .prepare(`PRAGMA table_info(token_stats)`)
      .all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "recent_144_price_change_bps"));
    assert.ok(columns.some((column) => column.name === "recent_4320_trade_count"));
    assert.ok(columns.some((column) => column.name === "recent_4320_volume_sats"));
    assert.ok(
      columns.some((column) => column.name === "last_trade_price_nanosats_per_atom"),
    );

    const aggregate = db.getTokenAggregateStats("legacy-token");
    assert.equal(aggregate?.tradeCount, 3);
    assert.equal(aggregate?.cumulativePaidSats, "999");
    assert.equal(aggregate?.recent144PriceChangeBps, "0");
    assert.equal(aggregate?.recent4320TradeCount, 0);
    assert.equal(aggregate?.recent4320VolumeSats, "0");
    assert.equal(aggregate?.lastTradePriceNanosatsPerAtom, null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
