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

function unixSeconds(iso8601: string): number {
  return Math.floor(Date.parse(iso8601) / 1000);
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

test("listTokenCandles aggregates hourly and daily OHLCV in Asia/Shanghai buckets", () => {
  const db = openDatabase(":memory:");

  try {
    const tokenId = "token-candles";
    db.insertProcessedTrades([
      makeTrade({
        tokenId,
        offerTxid: "h1-open",
        outIdx: 0,
        spendTxid: "sh1-open",
        paidSats: "300",
        soldAtoms: "3",
        blockHeight: 1000,
        blockTimestamp: unixSeconds("2026-04-13T10:05:00+08:00"),
      }),
      makeTrade({
        tokenId,
        offerTxid: "h1-low",
        outIdx: 0,
        spendTxid: "sh1-low",
        paidSats: "100",
        soldAtoms: "1",
        blockHeight: 1000,
        blockTimestamp: unixSeconds("2026-04-13T10:25:00+08:00"),
      }),
      makeTrade({
        tokenId,
        offerTxid: "h1-close",
        outIdx: 0,
        spendTxid: "sh1-close",
        paidSats: "200",
        soldAtoms: "2",
        blockHeight: 1000,
        blockTimestamp: unixSeconds("2026-04-13T10:55:00+08:00"),
      }),
      makeTrade({
        tokenId,
        offerTxid: "h2-single",
        outIdx: 0,
        spendTxid: "sh2-single",
        paidSats: "150",
        soldAtoms: "5",
        blockHeight: 1001,
        blockTimestamp: unixSeconds("2026-04-13T11:10:00+08:00"),
      }),
      makeTrade({
        tokenId,
        offerTxid: "d2-single",
        outIdx: 0,
        spendTxid: "sd2-single",
        paidSats: "90",
        soldAtoms: "1",
        blockHeight: 1002,
        blockTimestamp: unixSeconds("2026-04-14T09:00:00+08:00"),
      }),
    ]);

    const hourly = db.listTokenCandles({
      tokenId,
      interval: "hour",
      limit: 10,
    });
    assert.equal(hourly.length, 3);
    assert.deepEqual(hourly[0], {
      bucketStart: unixSeconds("2026-04-13T10:00:00+08:00"),
      bucketEnd: unixSeconds("2026-04-13T10:59:59+08:00"),
      openPriceNanosatsPerAtom: "300",
      highPriceNanosatsPerAtom: "300",
      lowPriceNanosatsPerAtom: "100",
      closePriceNanosatsPerAtom: "200",
      tradeCount: 3,
      volumeSats: "600",
      soldAtoms: "6",
    });
    assert.deepEqual(hourly[1], {
      bucketStart: unixSeconds("2026-04-13T11:00:00+08:00"),
      bucketEnd: unixSeconds("2026-04-13T11:59:59+08:00"),
      openPriceNanosatsPerAtom: "150",
      highPriceNanosatsPerAtom: "150",
      lowPriceNanosatsPerAtom: "150",
      closePriceNanosatsPerAtom: "150",
      tradeCount: 1,
      volumeSats: "150",
      soldAtoms: "5",
    });
    assert.deepEqual(hourly[2], {
      bucketStart: unixSeconds("2026-04-14T09:00:00+08:00"),
      bucketEnd: unixSeconds("2026-04-14T09:59:59+08:00"),
      openPriceNanosatsPerAtom: "90",
      highPriceNanosatsPerAtom: "90",
      lowPriceNanosatsPerAtom: "90",
      closePriceNanosatsPerAtom: "90",
      tradeCount: 1,
      volumeSats: "90",
      soldAtoms: "1",
    });

    const daily = db.listTokenCandles({
      tokenId,
      interval: "day",
      limit: 10,
    });
    assert.equal(daily.length, 2);
    assert.deepEqual(daily[0], {
      bucketStart: unixSeconds("2026-04-13T00:00:00+08:00"),
      bucketEnd: unixSeconds("2026-04-13T23:59:59+08:00"),
      openPriceNanosatsPerAtom: "300",
      highPriceNanosatsPerAtom: "300",
      lowPriceNanosatsPerAtom: "100",
      closePriceNanosatsPerAtom: "150",
      tradeCount: 4,
      volumeSats: "750",
      soldAtoms: "11",
    });
    assert.deepEqual(daily[1], {
      bucketStart: unixSeconds("2026-04-14T00:00:00+08:00"),
      bucketEnd: unixSeconds("2026-04-14T23:59:59+08:00"),
      openPriceNanosatsPerAtom: "90",
      highPriceNanosatsPerAtom: "90",
      lowPriceNanosatsPerAtom: "90",
      closePriceNanosatsPerAtom: "90",
      tradeCount: 1,
      volumeSats: "90",
      soldAtoms: "1",
    });
  } finally {
    db.close();
  }
});

test("listTokenCandles aggregates weekly buckets and returns the latest limited buckets in ascending order", () => {
  const db = openDatabase(":memory:");

  try {
    const tokenId = "token-weekly-candles";
    db.insertProcessedTrades([
      makeTrade({
        tokenId,
        offerTxid: "prev-week",
        outIdx: 0,
        spendTxid: "sprev-week",
        paidSats: "70",
        soldAtoms: "1",
        blockHeight: 900,
        blockTimestamp: unixSeconds("2026-04-12T23:30:00+08:00"),
      }),
      makeTrade({
        tokenId,
        offerTxid: "week-open",
        outIdx: 0,
        spendTxid: "sweek-open",
        paidSats: "120",
        soldAtoms: "2",
        blockHeight: 901,
        blockTimestamp: unixSeconds("2026-04-13T01:00:00+08:00"),
      }),
      makeTrade({
        tokenId,
        offerTxid: "week-close",
        outIdx: 0,
        spendTxid: "sweek-close",
        paidSats: "80",
        soldAtoms: "3",
        blockHeight: 902,
        blockTimestamp: unixSeconds("2026-04-15T12:00:00+08:00"),
      }),
    ]);

    const weekly = db.listTokenCandles({
      tokenId,
      interval: "week",
      limit: 2,
    });
    assert.equal(weekly.length, 2);
    assert.deepEqual(weekly[0], {
      bucketStart: unixSeconds("2026-04-06T00:00:00+08:00"),
      bucketEnd: unixSeconds("2026-04-12T23:59:59+08:00"),
      openPriceNanosatsPerAtom: "70",
      highPriceNanosatsPerAtom: "70",
      lowPriceNanosatsPerAtom: "70",
      closePriceNanosatsPerAtom: "70",
      tradeCount: 1,
      volumeSats: "70",
      soldAtoms: "1",
    });
    assert.deepEqual(weekly[1], {
      bucketStart: unixSeconds("2026-04-13T00:00:00+08:00"),
      bucketEnd: unixSeconds("2026-04-19T23:59:59+08:00"),
      openPriceNanosatsPerAtom: "120",
      highPriceNanosatsPerAtom: "120",
      lowPriceNanosatsPerAtom: "80",
      closePriceNanosatsPerAtom: "80",
      tradeCount: 2,
      volumeSats: "200",
      soldAtoms: "5",
    });

    const latestOnly = db.listTokenCandles({
      tokenId,
      interval: "week",
      limit: 1,
    });
    assert.equal(latestOnly.length, 1);
    assert.equal(
      latestOnly[0]?.bucketStart,
      unixSeconds("2026-04-13T00:00:00+08:00"),
    );
  } finally {
    db.close();
  }
});

test("recordApiAccess aggregates route stats and token visits into hourly buckets", () => {
  const db = openDatabase(":memory:");
  const baseMs = Date.parse("2026-04-20T10:15:00.000Z");
  const sameHourMs = Date.parse("2026-04-20T10:45:00.000Z");
  const previousHourMs = Date.parse("2026-04-20T09:15:00.000Z");
  const previous30hMs = Date.parse("2026-04-19T04:15:00.000Z");

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

    db.recordApiAccess({
      routeKey: "tokens.detail",
      statusCode: 200,
      tokenId: "token-a",
      countTokenVisit: true,
      occurredAtMs: baseMs,
    });
    db.recordApiAccess({
      routeKey: "tokens.detail",
      statusCode: 404,
      tokenId: "token-a",
      countTokenVisit: false,
      occurredAtMs: sameHourMs,
    });
    db.recordApiAccess({
      routeKey: "tokens.list",
      statusCode: 400,
      occurredAtMs: previousHourMs,
    });
    db.recordApiAccess({
      routeKey: "status",
      statusCode: 200,
      occurredAtMs: previousHourMs,
    });
    db.recordApiAccess({
      routeKey: "tokens.detail",
      statusCode: 200,
      tokenId: "token-a",
      countTokenVisit: true,
      occurredAtMs: previous30hMs,
    });
    db.recordApiAccess({
      routeKey: "tokens.detail",
      statusCode: 200,
      tokenId: "token-b",
      countTokenVisit: true,
      occurredAtMs: previousHourMs,
    });

    const detailBucketCount = db.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM api_route_access_hourly
          WHERE route_key = 'tokens.detail'
        `,
      )
      .get() as { count: number };
    assert.equal(detailBucketCount.count, 3);

    const endpointAnalytics = db.listEndpointAnalytics({
      hours: 48,
      nowMs: baseMs,
    });
    const detailAnalytics = endpointAnalytics.find(
      (item) => item.routeKey === "tokens.detail",
    );
    assert.deepEqual(detailAnalytics, {
      routeKey: "tokens.detail",
      accessCountTotal: 4,
      accessCountWindow: 4,
      successCountTotal: 3,
      successCountWindow: 3,
      clientErrorCountTotal: 1,
      clientErrorCountWindow: 1,
      serverErrorCountTotal: 0,
      serverErrorCountWindow: 0,
      lastAccessedAt: sameHourMs,
    });

    const summary = db.getAnalyticsSummary({
      hours: 48,
      nowMs: baseMs,
    });
    assert.equal(summary.apiAccessCountTotal, 6);
    assert.equal(summary.apiAccessCountWindow, 6);
    assert.equal(summary.tokenVisitCountTotal, 3);
    assert.equal(summary.tokenVisitCountWindow, 3);
    assert.equal(summary.apiAccessBuckets.length, 48);
    assert.equal(summary.tokenVisitBuckets.length, 48);

    const tokenSnapshot = db.getTokenVisitSnapshot("token-a", baseMs);
    assert.deepEqual(tokenSnapshot, {
      visitCountTotal: 2,
      visitCount24h: 1,
      lastVisitedAt: baseMs,
    });

    const tokenAnalytics = db.getTokenVisitAnalytics({
      tokenId: "token-a",
      hours: 48,
      nowMs: baseMs,
    });
    assert.equal(tokenAnalytics.visitCountTotal, 2);
    assert.equal(tokenAnalytics.visitCount24h, 1);
    assert.equal(tokenAnalytics.visitCountWindow, 2);
    assert.equal(tokenAnalytics.buckets.length, 48);

    const tokenVisits = db.listTokenVisits({
      page: 1,
      pageSize: 10,
      offset: 0,
      sort: "visitsTotal",
      order: "desc",
      nowMs: baseMs,
    });
    assert.deepEqual(tokenVisits.items.slice(0, 2), [
      {
        tokenId: "token-a",
        visitCountTotal: 2,
        visitCount24h: 1,
        lastVisitedAt: baseMs,
      },
      {
        tokenId: "token-b",
        visitCountTotal: 1,
        visitCount24h: 1,
        lastVisitedAt: previousHourMs,
      },
    ]);
  } finally {
    db.close();
  }
});

test("pruneOldAnalyticsBuckets removes stale hourly buckets without touching totals", () => {
  const db = openDatabase(":memory:");
  const nowMs = Date.parse("2026-04-20T10:15:00.000Z");
  const oldMs = Date.parse("2026-04-18T09:15:00.000Z");

  try {
    db.upsertTrackedToken({
      tokenId: "token-prune",
      groupHex: "46token-prune",
      groupPrefixHex: "46",
      kind: "FUNGIBLE",
    });

    db.recordApiAccess({
      routeKey: "tokens.detail",
      statusCode: 200,
      tokenId: "token-prune",
      countTokenVisit: true,
      occurredAtMs: oldMs,
    });
    db.recordApiAccess({
      routeKey: "tokens.detail",
      statusCode: 200,
      tokenId: "token-prune",
      countTokenVisit: true,
      occurredAtMs: nowMs,
    });

    const pruned = db.pruneOldAnalyticsBuckets(24, nowMs);
    assert.equal(pruned.apiRouteBucketCount, 1);
    assert.equal(pruned.tokenVisitBucketCount, 1);

    const detailAnalytics = db.getEndpointAnalytics({
      routeKey: "tokens.detail",
      hours: 48,
      nowMs,
    });
    assert.equal(detailAnalytics.accessCountTotal, 2);
    assert.equal(detailAnalytics.accessCountWindow, 1);

    const tokenAnalytics = db.getTokenVisitAnalytics({
      tokenId: "token-prune",
      hours: 48,
      nowMs,
    });
    assert.equal(tokenAnalytics.visitCountTotal, 2);
    assert.equal(tokenAnalytics.visitCountWindow, 1);
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

    const tables = db.sqlite
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'api_route_access_totals',
              'api_route_access_hourly',
              'token_visit_totals',
              'token_visit_hourly'
            )
          ORDER BY name ASC
        `,
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((table) => table.name), [
      "api_route_access_hourly",
      "api_route_access_totals",
      "token_visit_hourly",
      "token_visit_totals",
    ]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
