import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  ANALYTICS_ROUTE_KEYS,
  HOUR_MS,
  type AnalyticsRouteKey,
  type ApiAccessRecord,
  getBucketEndMs,
  getStatusCountDeltas,
  previousHoursWindowStartMs,
  retentionCutoffBucketStartMs,
  startOfHourMs,
} from "./analytics.js";
import { computeRollingStatsSnapshot } from "./stats.js";
import type {
  ActiveTokenSeed,
  CandleInterval,
  ListTokenCandlesOptions,
  ListTokenStatsPageOptions,
  ListTradeHistoryOptions,
  ProcessedTradeRecord,
  TokenAggregateStatsRecord,
  TokenBlockStatsRecord,
  TokenCandleRow,
  TokenInitStatus,
  TokenStatsPageRow,
  TokenStatsRecord,
  TrackedTokenRecord,
  TradeHistoryRow,
} from "./types.js";

interface BucketDelta {
  tokenId: string;
  blockHeight: number;
  tradeCountDelta: number;
  volumeSatsDelta: bigint;
}

interface DbApiAccessBucket {
  bucketStart: number;
  bucketEnd: number;
  accessCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
}

interface DbTokenVisitBucket {
  bucketStart: number;
  bucketEnd: number;
  visitCount: number;
}

interface DbEndpointAnalyticsSummary {
  routeKey: AnalyticsRouteKey;
  accessCountTotal: number;
  accessCountWindow: number;
  successCountTotal: number;
  successCountWindow: number;
  clientErrorCountTotal: number;
  clientErrorCountWindow: number;
  serverErrorCountTotal: number;
  serverErrorCountWindow: number;
  lastAccessedAt: number | null;
}

interface DbEndpointAnalyticsDetail extends DbEndpointAnalyticsSummary {
  hours: number;
  windowStart: number;
  windowEnd: number;
  buckets: DbApiAccessBucket[];
}

interface DbAnalyticsSummary {
  hours: number;
  windowStart: number;
  windowEnd: number;
  apiAccessCountTotal: number;
  apiAccessCountWindow: number;
  apiAccessBuckets: DbApiAccessBucket[];
  tokenVisitCountTotal: number;
  tokenVisitCountWindow: number;
  tokenVisitBuckets: DbTokenVisitBucket[];
}

type DbTokenVisitSortField = "visitsTotal" | "visits24h" | "lastVisitedAt";

interface DbTokenVisitSummary {
  tokenId: string;
  visitCountTotal: number;
  visitCount24h: number;
  lastVisitedAt: number | null;
}

interface DbTokenVisitAnalytics extends DbTokenVisitSummary {
  hours: number;
  windowStart: number;
  windowEnd: number;
  visitCountWindow: number;
  buckets: DbTokenVisitBucket[];
}

interface DbTokenVisitSnapshot {
  visitCountTotal: number;
  visitCount24h: number;
  lastVisitedAt: number | null;
}

interface ListTokenVisitsOptions {
  page: number;
  pageSize: number;
  offset: number;
  sort?: DbTokenVisitSortField;
  order?: "asc" | "desc";
  nowMs?: number;
}

export interface AppDatabase {
  sqlite: Database.Database;
  close: () => void;
  recordApiAccess: (entry: ApiAccessRecord) => void;
  markAllTrackedTokensInactive: () => void;
  upsertTrackedToken: (token: ActiveTokenSeed) => void;
  listTrackedTokenIds: () => string[];
  markTokenSynced: (tokenId: string, syncedAtMs: number) => void;
  markTokenWsEvent: (tokenId: string, eventAtMs: number) => void;
  insertProcessedTrades: (trades: ProcessedTradeRecord[]) => ProcessedTradeRecord[];
  getTokenStats: (tokenId: string) => TokenStatsRecord | null;
  replaceTokenStats: (stats: TokenStatsRecord) => void;
  getTrackedToken: (tokenId: string) => TrackedTokenRecord | null;
  listTrackedTokens: (activeOnly?: boolean) => TrackedTokenRecord[];
  setBootstrapCohort: (tokenIds: string[], isBootstrap?: boolean) => void;
  markTokenInitPending: (tokenId: string, atMs: number) => void;
  markTokenInitStarted: (tokenId: string, atMs: number) => void;
  markTokenInitCompleted: (tokenId: string, atMs: number) => void;
  markTokenInitFailed: (tokenId: string, atMs: number, errorMessage: string) => void;
  markTokenReady: (tokenId: string, isReady: boolean, atMs: number) => void;
  countBootstrapTokens: () => number;
  countReadyBootstrapTokens: () => number;
  getTokenBlockStats: (tokenId: string) => TokenBlockStatsRecord[];
  recomputeTokenAggregateStats: (
    tokenId: string,
    chainTipHeight: number,
  ) => TokenAggregateStatsRecord;
  recomputeAllTokenAggregateStats: (chainTipHeight: number) => number;
  getTokenAggregateStats: (tokenId: string) => TokenAggregateStatsRecord | null;
  listTokenStatsPage: (options: ListTokenStatsPageOptions) => TokenStatsPageRow[];
  listTradeHistory: (options: ListTradeHistoryOptions) => TradeHistoryRow[];
  listTokenCandles: (options: ListTokenCandlesOptions) => TokenCandleRow[];
  getAnalyticsSummary: (options: {
    hours: number;
    nowMs?: number;
  }) => DbAnalyticsSummary;
  listEndpointAnalytics: (options: {
    hours: number;
    nowMs?: number;
  }) => DbEndpointAnalyticsSummary[];
  getEndpointAnalytics: (options: {
    routeKey: AnalyticsRouteKey;
    hours: number;
    nowMs?: number;
  }) => DbEndpointAnalyticsDetail;
  listTokenVisits: (options: ListTokenVisitsOptions) => {
    page: number;
    pageSize: number;
    total: number;
    items: DbTokenVisitSummary[];
  };
  getTokenVisitAnalytics: (options: {
    tokenId: string;
    hours: number;
    nowMs?: number;
  }) => DbTokenVisitAnalytics;
  getTokenVisitSnapshot: (
    tokenId: string,
    nowMs?: number,
  ) => DbTokenVisitSnapshot;
  pruneOldAnalyticsBuckets: (
    retentionHours: number,
    nowMs?: number,
  ) => {
    apiRouteBucketCount: number;
    tokenVisitBucketCount: number;
  };
}

const SHANGHAI_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const MONDAY_ANCHOR_LOCAL_SECONDS = 4 * DAY_SECONDS;

function ensureParentDir(filePath: string): void {
  if (filePath === ":memory:") {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function tableHasColumn(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  if (tableHasColumn(sqlite, tableName, columnName)) {
    return;
  }

  sqlite.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
  );
}

function createSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS tracked_tokens (
      token_id TEXT PRIMARY KEY,
      group_hex TEXT NOT NULL,
      group_prefix_hex TEXT NOT NULL,
      kind TEXT NOT NULL,
      discovery_source TEXT NOT NULL,
      first_discovered_at INTEGER NOT NULL,
      last_discovered_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_ready INTEGER NOT NULL DEFAULT 0,
      bootstrap_cohort INTEGER NOT NULL DEFAULT 0,
      init_status TEXT NOT NULL DEFAULT 'PENDING',
      init_started_at INTEGER,
      init_completed_at INTEGER,
      last_init_error TEXT,
      last_synced_at INTEGER,
      last_ws_event_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS processed_trades (
      offer_txid TEXT NOT NULL,
      offer_out_idx INTEGER NOT NULL,
      spend_txid TEXT NOT NULL,
      token_id TEXT NOT NULL,
      variant_type TEXT NOT NULL,
      paid_sats TEXT NOT NULL,
      sold_atoms TEXT NOT NULL,
      price_nanosats_per_atom TEXT NOT NULL,
      taker_script_hex TEXT,
      block_height INTEGER,
      block_hash TEXT,
      block_timestamp INTEGER,
      raw_trade_json TEXT NOT NULL,
      inserted_at INTEGER NOT NULL,
      PRIMARY KEY (offer_txid, offer_out_idx)
    );

    CREATE INDEX IF NOT EXISTS idx_processed_trades_token_id
      ON processed_trades (token_id);

    CREATE INDEX IF NOT EXISTS idx_processed_trades_spend_txid
      ON processed_trades (spend_txid);

    CREATE INDEX IF NOT EXISTS idx_processed_trades_token_block
      ON processed_trades (token_id, block_height, block_timestamp);

    CREATE TABLE IF NOT EXISTS token_block_stats (
      token_id TEXT NOT NULL,
      block_height INTEGER NOT NULL,
      trade_count INTEGER NOT NULL,
      volume_sats TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (token_id, block_height)
    );

    CREATE INDEX IF NOT EXISTS idx_token_block_stats_height
      ON token_block_stats (block_height);

    CREATE TABLE IF NOT EXISTS token_stats (
      token_id TEXT PRIMARY KEY,
      trade_count INTEGER NOT NULL,
      cumulative_paid_sats TEXT NOT NULL,
      recent_144_trade_count INTEGER NOT NULL DEFAULT 0,
      recent_144_volume_sats TEXT NOT NULL DEFAULT '0',
      recent_144_price_change_bps TEXT NOT NULL DEFAULT '0',
      recent_1008_trade_count INTEGER NOT NULL DEFAULT 0,
      recent_1008_volume_sats TEXT NOT NULL DEFAULT '0',
      recent_4320_trade_count INTEGER NOT NULL DEFAULT 0,
      recent_4320_volume_sats TEXT NOT NULL DEFAULT '0',
      last_trade_offer_txid TEXT,
      last_trade_offer_out_idx INTEGER,
      last_trade_block_height INTEGER,
      last_trade_block_timestamp INTEGER,
      last_trade_price_nanosats_per_atom TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_route_access_totals (
      route_key TEXT PRIMARY KEY,
      access_count_total INTEGER NOT NULL DEFAULT 0,
      success_count_total INTEGER NOT NULL DEFAULT 0,
      client_error_count_total INTEGER NOT NULL DEFAULT 0,
      server_error_count_total INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS api_route_access_hourly (
      route_key TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      client_error_count INTEGER NOT NULL DEFAULT 0,
      server_error_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (route_key, bucket_start)
    );

    CREATE INDEX IF NOT EXISTS idx_api_route_access_hourly_bucket_start
      ON api_route_access_hourly (bucket_start);

    CREATE TABLE IF NOT EXISTS token_visit_totals (
      token_id TEXT PRIMARY KEY,
      visit_count_total INTEGER NOT NULL DEFAULT 0,
      last_visited_at INTEGER,
      FOREIGN KEY (token_id) REFERENCES tracked_tokens(token_id)
    );

    CREATE INDEX IF NOT EXISTS idx_token_visit_totals_last_visited_at
      ON token_visit_totals (last_visited_at);

    CREATE TABLE IF NOT EXISTS token_visit_hourly (
      token_id TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (token_id, bucket_start),
      FOREIGN KEY (token_id) REFERENCES tracked_tokens(token_id)
    );

    CREATE INDEX IF NOT EXISTS idx_token_visit_hourly_bucket_start
      ON token_visit_hourly (bucket_start);
  `);

  ensureColumn(sqlite, "tracked_tokens", "is_ready", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(
    sqlite,
    "tracked_tokens",
    "bootstrap_cohort",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    sqlite,
    "tracked_tokens",
    "init_status",
    "TEXT NOT NULL DEFAULT 'PENDING'",
  );
  ensureColumn(sqlite, "tracked_tokens", "init_started_at", "INTEGER");
  ensureColumn(sqlite, "tracked_tokens", "init_completed_at", "INTEGER");
  ensureColumn(sqlite, "tracked_tokens", "last_init_error", "TEXT");

  ensureColumn(
    sqlite,
    "token_stats",
    "recent_144_trade_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    sqlite,
    "token_stats",
    "recent_144_volume_sats",
    "TEXT NOT NULL DEFAULT '0'",
  );
  ensureColumn(
    sqlite,
    "token_stats",
    "recent_144_price_change_bps",
    "TEXT NOT NULL DEFAULT '0'",
  );
  ensureColumn(
    sqlite,
    "token_stats",
    "recent_1008_trade_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    sqlite,
    "token_stats",
    "recent_1008_volume_sats",
    "TEXT NOT NULL DEFAULT '0'",
  );
  ensureColumn(
    sqlite,
    "token_stats",
    "recent_4320_trade_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    sqlite,
    "token_stats",
    "recent_4320_volume_sats",
    "TEXT NOT NULL DEFAULT '0'",
  );
  ensureColumn(
    sqlite,
    "token_stats",
    "last_trade_price_nanosats_per_atom",
    "TEXT",
  );
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function createEmptyApiAccessBucket(bucketStart: number): DbApiAccessBucket {
  return {
    bucketStart,
    bucketEnd: getBucketEndMs(bucketStart),
    accessCount: 0,
    successCount: 0,
    clientErrorCount: 0,
    serverErrorCount: 0,
  };
}

function createEmptyTokenVisitBucket(bucketStart: number): DbTokenVisitBucket {
  return {
    bucketStart,
    bucketEnd: getBucketEndMs(bucketStart),
    visitCount: 0,
  };
}

function denseApiAccessBuckets(
  rows: Array<Record<string, unknown>>,
  windowStart: number,
  hours: number,
): DbApiAccessBucket[] {
  const buckets = new Map<number, DbApiAccessBucket>();
  for (const row of rows) {
    const bucketStart = Number(row.bucket_start);
    buckets.set(bucketStart, {
      bucketStart,
      bucketEnd: getBucketEndMs(bucketStart),
      accessCount: Number(row.access_count ?? 0),
      successCount: Number(row.success_count ?? 0),
      clientErrorCount: Number(row.client_error_count ?? 0),
      serverErrorCount: Number(row.server_error_count ?? 0),
    });
  }

  const dense: DbApiAccessBucket[] = [];
  for (let index = 0; index < hours; index += 1) {
    const bucketStart = windowStart + index * HOUR_MS;
    dense.push(buckets.get(bucketStart) ?? createEmptyApiAccessBucket(bucketStart));
  }
  return dense;
}

function denseTokenVisitBuckets(
  rows: Array<Record<string, unknown>>,
  windowStart: number,
  hours: number,
): DbTokenVisitBucket[] {
  const buckets = new Map<number, DbTokenVisitBucket>();
  for (const row of rows) {
    const bucketStart = Number(row.bucket_start);
    buckets.set(bucketStart, {
      bucketStart,
      bucketEnd: getBucketEndMs(bucketStart),
      visitCount: Number(row.visit_count ?? 0),
    });
  }

  const dense: DbTokenVisitBucket[] = [];
  for (let index = 0; index < hours; index += 1) {
    const bucketStart = windowStart + index * HOUR_MS;
    dense.push(buckets.get(bucketStart) ?? createEmptyTokenVisitBucket(bucketStart));
  }
  return dense;
}

function emptyEndpointAnalyticsSummary(
  routeKey: AnalyticsRouteKey,
): DbEndpointAnalyticsSummary {
  return {
    routeKey,
    accessCountTotal: 0,
    accessCountWindow: 0,
    successCountTotal: 0,
    successCountWindow: 0,
    clientErrorCountTotal: 0,
    clientErrorCountWindow: 0,
    serverErrorCountTotal: 0,
    serverErrorCountWindow: 0,
    lastAccessedAt: null,
  };
}

function tokenVisitOrderByClause(
  sort: DbTokenVisitSortField,
  order: "asc" | "desc",
): string {
  const direction = order === "asc" ? "ASC" : "DESC";

  switch (sort) {
    case "visits24h":
      return `COALESCE(v24.visit_count_24h, 0) ${direction}, COALESCE(v.last_visited_at, 0) ${direction}, t.token_id ASC`;
    case "lastVisitedAt":
      return `CASE WHEN v.last_visited_at IS NULL THEN 1 ELSE 0 END ASC, COALESCE(v.last_visited_at, 0) ${direction}, t.token_id ASC`;
    case "visitsTotal":
    default:
      return `COALESCE(v.visit_count_total, 0) ${direction}, COALESCE(v.last_visited_at, 0) ${direction}, t.token_id ASC`;
  }
}

function normalizeInitStatus(value: string | null | undefined): TokenInitStatus {
  if (
    value === "PENDING" ||
    value === "INITIALIZING" ||
    value === "READY" ||
    value === "ERROR"
  ) {
    return value;
  }

  return "PENDING";
}

function toTrackedTokenRecord(row: Record<string, unknown>): TrackedTokenRecord {
  return {
    tokenId: row.token_id as string,
    groupHex: row.group_hex as string,
    groupPrefixHex: row.group_prefix_hex as string,
    kind: row.kind as TrackedTokenRecord["kind"],
    discoverySource: row.discovery_source as string,
    firstDiscoveredAt: row.first_discovered_at as number,
    lastDiscoveredAt: row.last_discovered_at as number,
    isActive: Number(row.is_active) === 1,
    isReady: Number(row.is_ready) === 1,
    bootstrapCohort: Number(row.bootstrap_cohort) === 1,
    initStatus: normalizeInitStatus(row.init_status as string | null),
    initStartedAt: (row.init_started_at as number | null) ?? null,
    initCompletedAt: (row.init_completed_at as number | null) ?? null,
    lastInitError: (row.last_init_error as string | null) ?? null,
    lastSyncedAt: (row.last_synced_at as number | null) ?? null,
    lastWsEventAt: (row.last_ws_event_at as number | null) ?? null,
  };
}

function toTokenStatsRecord(row: Record<string, unknown>): TokenStatsRecord {
  return {
    tokenId: row.token_id as string,
    tradeCount: row.trade_count as number,
    cumulativePaidSats: row.cumulative_paid_sats as string,
    lastTradeOfferTxid: (row.last_trade_offer_txid as string | null) ?? null,
    lastTradeOfferOutIdx:
      (row.last_trade_offer_out_idx as number | null) ?? null,
    lastTradeBlockHeight:
      (row.last_trade_block_height as number | null) ?? null,
    lastTradeBlockTimestamp:
      (row.last_trade_block_timestamp as number | null) ?? null,
    lastTradePriceNanosatsPerAtom:
      (row.last_trade_price_nanosats_per_atom as string | null) ?? null,
  };
}

function toTokenAggregateStatsRecord(
  row: Record<string, unknown>,
): TokenAggregateStatsRecord {
  return {
    ...toTokenStatsRecord(row),
    recent144TradeCount: row.recent_144_trade_count as number,
    recent144VolumeSats: row.recent_144_volume_sats as string,
    recent144PriceChangeBps: row.recent_144_price_change_bps as string,
    recent1008TradeCount: row.recent_1008_trade_count as number,
    recent1008VolumeSats: row.recent_1008_volume_sats as string,
    recent4320TradeCount: row.recent_4320_trade_count as number,
    recent4320VolumeSats: row.recent_4320_volume_sats as string,
    updatedAt: row.updated_at as number,
  };
}

function toTradeHistoryRow(row: Record<string, unknown>): TradeHistoryRow {
  return {
    offerTxid: row.offer_txid as string,
    offerOutIdx: row.offer_out_idx as number,
    spendTxid: row.spend_txid as string,
    tokenId: row.token_id as string,
    variantType: row.variant_type as ProcessedTradeRecord["variantType"],
    paidSats: row.paid_sats as string,
    soldAtoms: row.sold_atoms as string,
    priceNanosatsPerAtom: row.price_nanosats_per_atom as string,
    takerScriptHex: (row.taker_script_hex as string | null) ?? null,
    blockHeight: (row.block_height as number | null) ?? null,
    blockHash: (row.block_hash as string | null) ?? null,
    blockTimestamp: (row.block_timestamp as number | null) ?? null,
    rawTradeJson: row.raw_trade_json as string,
    insertedAt: row.inserted_at as number,
  };
}

function toTokenCandleRow(row: Record<string, unknown>): TokenCandleRow {
  return {
    bucketStart: Number(row.bucket_start),
    bucketEnd: Number(row.bucket_end),
    openPriceNanosatsPerAtom: String(row.open_price_nanosats_per_atom),
    highPriceNanosatsPerAtom: String(row.high_price_nanosats_per_atom),
    lowPriceNanosatsPerAtom: String(row.low_price_nanosats_per_atom),
    closePriceNanosatsPerAtom: String(row.close_price_nanosats_per_atom),
    tradeCount: Number(row.trade_count),
    volumeSats: String(row.volume_sats),
    soldAtoms: String(row.sold_atoms),
  };
}

function candleBucketSql(interval: CandleInterval): {
  bucketStartSql: string;
  bucketSeconds: number;
} {
  switch (interval) {
    case "hour":
      return {
        bucketStartSql: "CAST(block_timestamp / 3600 AS INTEGER) * 3600",
        bucketSeconds: 3600,
      };
    case "day":
      return {
        bucketStartSql: `CAST((block_timestamp + ${SHANGHAI_OFFSET_SECONDS}) / ${DAY_SECONDS} AS INTEGER) * ${DAY_SECONDS} - ${SHANGHAI_OFFSET_SECONDS}`,
        bucketSeconds: DAY_SECONDS,
      };
    case "week":
      return {
        bucketStartSql: `CAST(((block_timestamp + ${SHANGHAI_OFFSET_SECONDS}) - ${MONDAY_ANCHOR_LOCAL_SECONDS}) / ${WEEK_SECONDS} AS INTEGER) * ${WEEK_SECONDS} + ${MONDAY_ANCHOR_LOCAL_SECONDS} - ${SHANGHAI_OFFSET_SECONDS}`,
        bucketSeconds: WEEK_SECONDS,
      };
  }
}

function toTokenBlockStatsRecord(
  row: Record<string, unknown>,
): TokenBlockStatsRecord {
  return {
    tokenId: row.token_id as string,
    blockHeight: row.block_height as number,
    tradeCount: row.trade_count as number,
    volumeSats: row.volume_sats as string,
    updatedAt: row.updated_at as number,
  };
}

function buildStatsOrderByClause(
  sortBy: ListTokenStatsPageOptions["sortBy"],
  order: NonNullable<ListTokenStatsPageOptions["order"]>,
): string {
  const direction = order === "asc" ? "ASC" : "DESC";

  switch (sortBy) {
    case "trade_count":
      return `s.trade_count ${direction}, s.token_id ASC`;
    case "cumulative_paid_sats":
      return `LENGTH(s.cumulative_paid_sats) ${direction}, s.cumulative_paid_sats ${direction}, s.token_id ASC`;
    case "last_trade_price_nanosats_per_atom":
      return `LENGTH(COALESCE(s.last_trade_price_nanosats_per_atom, '0')) ${direction}, COALESCE(s.last_trade_price_nanosats_per_atom, '0') ${direction}, s.token_id ASC`;
    case "recent_144_trade_count":
      return `s.recent_144_trade_count ${direction}, s.token_id ASC`;
    case "recent_144_volume_sats":
      return `LENGTH(s.recent_144_volume_sats) ${direction}, s.recent_144_volume_sats ${direction}, s.token_id ASC`;
    case "recent_1008_trade_count":
      return `s.recent_1008_trade_count ${direction}, s.token_id ASC`;
    case "recent_1008_volume_sats":
      return `LENGTH(s.recent_1008_volume_sats) ${direction}, s.recent_1008_volume_sats ${direction}, s.token_id ASC`;
    case "recent_4320_trade_count":
      return `s.recent_4320_trade_count ${direction}, s.token_id ASC`;
    case "recent_4320_volume_sats":
      return `LENGTH(s.recent_4320_volume_sats) ${direction}, s.recent_4320_volume_sats ${direction}, s.token_id ASC`;
    case "last_trade_block_height":
      return `s.last_trade_block_height ${direction} NULLS LAST, s.last_trade_block_timestamp ${direction} NULLS LAST, s.token_id ASC`;
    case "last_trade_block_timestamp":
      return `s.last_trade_block_timestamp ${direction} NULLS LAST, s.last_trade_block_height ${direction} NULLS LAST, s.token_id ASC`;
    default:
      return `LENGTH(s.cumulative_paid_sats) DESC, s.cumulative_paid_sats DESC, s.trade_count DESC, s.token_id ASC`;
  }
}

function computePriceChangeBps(
  earliestPriceRaw: string | null | undefined,
  latestPriceRaw: string | null | undefined,
): string {
  if (!earliestPriceRaw || !latestPriceRaw) {
    return "0";
  }

  const earliestPrice = BigInt(earliestPriceRaw);
  const latestPrice = BigInt(latestPriceRaw);
  if (earliestPrice <= 0n) {
    return "0";
  }

  return (((latestPrice - earliestPrice) * 10_000n) / earliestPrice).toString();
}

function upsertBlockBucket(
  selectStmt: Database.Statement,
  insertStmt: Database.Statement,
  updateStmt: Database.Statement,
  delta: BucketDelta,
  now: number,
): void {
  const existing = selectStmt.get(delta.tokenId, delta.blockHeight) as
    | { trade_count: number; volume_sats: string }
    | undefined;

  if (!existing) {
    insertStmt.run(
      delta.tokenId,
      delta.blockHeight,
      delta.tradeCountDelta,
      delta.volumeSatsDelta.toString(),
      now,
    );
    return;
  }

  const nextTradeCount = existing.trade_count + delta.tradeCountDelta;
  const nextVolume = (BigInt(existing.volume_sats) + delta.volumeSatsDelta).toString();
  updateStmt.run(nextTradeCount, nextVolume, now, delta.tokenId, delta.blockHeight);
}

export function openDatabase(sqlitePath: string): AppDatabase {
  ensureParentDir(sqlitePath);

  const sqlite = new Database(sqlitePath);
  createSchema(sqlite);

  const upsertTrackedTokenStmt = sqlite.prepare(`
    INSERT INTO tracked_tokens (
      token_id,
      group_hex,
      group_prefix_hex,
      kind,
      discovery_source,
      first_discovered_at,
      last_discovered_at,
      is_active
    ) VALUES (
      @tokenId,
      @groupHex,
      @groupPrefixHex,
      @kind,
      @discoverySource,
      @discoveredAt,
      @discoveredAt,
      1
    )
    ON CONFLICT(token_id) DO UPDATE SET
      group_hex = excluded.group_hex,
      group_prefix_hex = excluded.group_prefix_hex,
      kind = excluded.kind,
      discovery_source = excluded.discovery_source,
      last_discovered_at = excluded.last_discovered_at,
      is_active = 1
  `);

  const markAllTrackedTokensInactiveStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET is_active = 0
  `);

  const listTrackedTokenIdsStmt = sqlite.prepare(`
    SELECT token_id
    FROM tracked_tokens
    ORDER BY token_id ASC
  `);

  const getTrackedTokenStmt = sqlite.prepare(`
    SELECT
      token_id,
      group_hex,
      group_prefix_hex,
      kind,
      discovery_source,
      first_discovered_at,
      last_discovered_at,
      is_active,
      is_ready,
      bootstrap_cohort,
      init_status,
      init_started_at,
      init_completed_at,
      last_init_error,
      last_synced_at,
      last_ws_event_at
    FROM tracked_tokens
    WHERE token_id = ?
  `);

  const listTrackedTokensStmt = sqlite.prepare(`
    SELECT
      token_id,
      group_hex,
      group_prefix_hex,
      kind,
      discovery_source,
      first_discovered_at,
      last_discovered_at,
      is_active,
      is_ready,
      bootstrap_cohort,
      init_status,
      init_started_at,
      init_completed_at,
      last_init_error,
      last_synced_at,
      last_ws_event_at
    FROM tracked_tokens
    ORDER BY token_id ASC
  `);

  const listActiveTrackedTokensStmt = sqlite.prepare(`
    SELECT
      token_id,
      group_hex,
      group_prefix_hex,
      kind,
      discovery_source,
      first_discovered_at,
      last_discovered_at,
      is_active,
      is_ready,
      bootstrap_cohort,
      init_status,
      init_started_at,
      init_completed_at,
      last_init_error,
      last_synced_at,
      last_ws_event_at
    FROM tracked_tokens
    WHERE is_active = 1
    ORDER BY token_id ASC
  `);

  const resetBootstrapStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET bootstrap_cohort = 0
  `);

  const setBootstrapForTokenStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET bootstrap_cohort = 1
    WHERE token_id = ?
  `);

  const markTokenSyncedStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET last_synced_at = ?
    WHERE token_id = ?
  `);

  const markTokenWsEventStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET last_ws_event_at = ?
    WHERE token_id = ?
  `);

  const markTokenInitPendingStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET
      is_ready = 0,
      init_status = 'PENDING',
      init_started_at = NULL,
      init_completed_at = NULL,
      last_init_error = NULL,
      last_synced_at = ?
    WHERE token_id = ?
  `);

  const markTokenInitStartedStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET
      is_ready = 0,
      init_status = 'INITIALIZING',
      init_started_at = ?,
      last_init_error = NULL
    WHERE token_id = ?
  `);

  const markTokenInitCompletedStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET
      is_ready = 1,
      init_status = 'READY',
      init_completed_at = ?,
      last_init_error = NULL
    WHERE token_id = ?
  `);

  const markTokenInitFailedStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET
      is_ready = 0,
      init_status = 'ERROR',
      init_completed_at = ?,
      last_init_error = ?
    WHERE token_id = ?
  `);

  const markTokenReadyStmt = sqlite.prepare(`
    UPDATE tracked_tokens
    SET
      is_ready = ?,
      init_status = CASE
        WHEN ? = 1 THEN 'READY'
        WHEN init_status = 'READY' THEN 'PENDING'
        ELSE init_status
      END,
      init_completed_at = CASE
        WHEN ? = 1 THEN ?
        ELSE init_completed_at
      END
    WHERE token_id = ?
  `);

  const countBootstrapTokensStmt = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM tracked_tokens
    WHERE bootstrap_cohort = 1
  `);

  const countReadyBootstrapTokensStmt = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM tracked_tokens
    WHERE bootstrap_cohort = 1
      AND is_ready = 1
  `);

  const insertProcessedTradeStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO processed_trades (
      offer_txid,
      offer_out_idx,
      spend_txid,
      token_id,
      variant_type,
      paid_sats,
      sold_atoms,
      price_nanosats_per_atom,
      taker_script_hex,
      block_height,
      block_hash,
      block_timestamp,
      raw_trade_json,
      inserted_at
    ) VALUES (
      @offerTxid,
      @offerOutIdx,
      @spendTxid,
      @tokenId,
      @variantType,
      @paidSats,
      @soldAtoms,
      @priceNanosatsPerAtom,
      @takerScriptHex,
      @blockHeight,
      @blockHash,
      @blockTimestamp,
      @rawTradeJson,
      @insertedAt
    )
  `);

  const selectTokenBlockStatsStmt = sqlite.prepare(`
    SELECT
      token_id,
      block_height,
      trade_count,
      volume_sats,
      updated_at
    FROM token_block_stats
    WHERE token_id = ?
    ORDER BY block_height ASC
  `);

  const selectTokenBlockBucketStmt = sqlite.prepare(`
    SELECT
      trade_count,
      volume_sats
    FROM token_block_stats
    WHERE token_id = ?
      AND block_height = ?
  `);

  const insertTokenBlockBucketStmt = sqlite.prepare(`
    INSERT INTO token_block_stats (
      token_id,
      block_height,
      trade_count,
      volume_sats,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const updateTokenBlockBucketStmt = sqlite.prepare(`
    UPDATE token_block_stats
    SET
      trade_count = ?,
      volume_sats = ?,
      updated_at = ?
    WHERE token_id = ?
      AND block_height = ?
  `);

  const getTokenStatsStmt = sqlite.prepare(`
    SELECT
      token_id,
      trade_count,
      cumulative_paid_sats,
      last_trade_offer_txid,
      last_trade_offer_out_idx,
      last_trade_block_height,
      last_trade_block_timestamp,
      last_trade_price_nanosats_per_atom
    FROM token_stats
    WHERE token_id = ?
  `);

  const getTokenAggregateStatsStmt = sqlite.prepare(`
    SELECT
      token_id,
      trade_count,
      cumulative_paid_sats,
      recent_144_trade_count,
      recent_144_volume_sats,
      recent_144_price_change_bps,
      recent_1008_trade_count,
      recent_1008_volume_sats,
      recent_4320_trade_count,
      recent_4320_volume_sats,
      last_trade_offer_txid,
      last_trade_offer_out_idx,
      last_trade_block_height,
      last_trade_block_timestamp,
      last_trade_price_nanosats_per_atom,
      updated_at
    FROM token_stats
    WHERE token_id = ?
  `);

  const replaceTokenStatsStmt = sqlite.prepare(`
    INSERT INTO token_stats (
      token_id,
      trade_count,
      cumulative_paid_sats,
      recent_144_trade_count,
      recent_144_volume_sats,
      recent_144_price_change_bps,
      recent_1008_trade_count,
      recent_1008_volume_sats,
      recent_4320_trade_count,
      recent_4320_volume_sats,
      last_trade_offer_txid,
      last_trade_offer_out_idx,
      last_trade_block_height,
      last_trade_block_timestamp,
      last_trade_price_nanosats_per_atom,
      updated_at
    ) VALUES (
      @tokenId,
      @tradeCount,
      @cumulativePaidSats,
      @recent144TradeCount,
      @recent144VolumeSats,
      @recent144PriceChangeBps,
      @recent1008TradeCount,
      @recent1008VolumeSats,
      @recent4320TradeCount,
      @recent4320VolumeSats,
      @lastTradeOfferTxid,
      @lastTradeOfferOutIdx,
      @lastTradeBlockHeight,
      @lastTradeBlockTimestamp,
      @lastTradePriceNanosatsPerAtom,
      @updatedAt
    )
    ON CONFLICT(token_id) DO UPDATE SET
      trade_count = excluded.trade_count,
      cumulative_paid_sats = excluded.cumulative_paid_sats,
      last_trade_offer_txid = excluded.last_trade_offer_txid,
      last_trade_offer_out_idx = excluded.last_trade_offer_out_idx,
      last_trade_block_height = excluded.last_trade_block_height,
      last_trade_block_timestamp = excluded.last_trade_block_timestamp,
      last_trade_price_nanosats_per_atom = excluded.last_trade_price_nanosats_per_atom,
      updated_at = excluded.updated_at
  `);

  const replaceTokenAggregateStatsStmt = sqlite.prepare(`
    INSERT INTO token_stats (
      token_id,
      trade_count,
      cumulative_paid_sats,
      recent_144_trade_count,
      recent_144_volume_sats,
      recent_144_price_change_bps,
      recent_1008_trade_count,
      recent_1008_volume_sats,
      recent_4320_trade_count,
      recent_4320_volume_sats,
      last_trade_offer_txid,
      last_trade_offer_out_idx,
      last_trade_block_height,
      last_trade_block_timestamp,
      last_trade_price_nanosats_per_atom,
      updated_at
    ) VALUES (
      @tokenId,
      @tradeCount,
      @cumulativePaidSats,
      @recent144TradeCount,
      @recent144VolumeSats,
      @recent144PriceChangeBps,
      @recent1008TradeCount,
      @recent1008VolumeSats,
      @recent4320TradeCount,
      @recent4320VolumeSats,
      @lastTradeOfferTxid,
      @lastTradeOfferOutIdx,
      @lastTradeBlockHeight,
      @lastTradeBlockTimestamp,
      @lastTradePriceNanosatsPerAtom,
      @updatedAt
    )
    ON CONFLICT(token_id) DO UPDATE SET
      trade_count = excluded.trade_count,
      cumulative_paid_sats = excluded.cumulative_paid_sats,
      recent_144_trade_count = excluded.recent_144_trade_count,
      recent_144_volume_sats = excluded.recent_144_volume_sats,
      recent_144_price_change_bps = excluded.recent_144_price_change_bps,
      recent_1008_trade_count = excluded.recent_1008_trade_count,
      recent_1008_volume_sats = excluded.recent_1008_volume_sats,
      recent_4320_trade_count = excluded.recent_4320_trade_count,
      recent_4320_volume_sats = excluded.recent_4320_volume_sats,
      last_trade_offer_txid = excluded.last_trade_offer_txid,
      last_trade_offer_out_idx = excluded.last_trade_offer_out_idx,
      last_trade_block_height = excluded.last_trade_block_height,
      last_trade_block_timestamp = excluded.last_trade_block_timestamp,
      last_trade_price_nanosats_per_atom = excluded.last_trade_price_nanosats_per_atom,
      updated_at = excluded.updated_at
  `);

  const listDistinctTokenIdsStmt = sqlite.prepare(`
    SELECT token_id FROM tracked_tokens
    UNION
    SELECT token_id FROM token_stats
    UNION
    SELECT token_id FROM token_block_stats
    ORDER BY token_id ASC
  `);

  const getLatestTradeByTokenStmt = sqlite.prepare(`
    SELECT
      offer_txid,
      offer_out_idx,
      block_height,
      block_timestamp,
      price_nanosats_per_atom,
      inserted_at
    FROM processed_trades
    WHERE token_id = ?
    ORDER BY
      block_height DESC NULLS LAST,
      block_timestamp DESC NULLS LAST,
      inserted_at DESC,
      offer_txid DESC,
      offer_out_idx DESC
    LIMIT 1
  `);

  const getEarliestRecent144TradeByTokenStmt = sqlite.prepare(`
    SELECT
      offer_txid,
      offer_out_idx,
      price_nanosats_per_atom
    FROM processed_trades
    WHERE token_id = ?
      AND block_height >= ?
    ORDER BY
      block_height ASC,
      block_timestamp ASC,
      inserted_at ASC,
      offer_txid ASC,
      offer_out_idx ASC
    LIMIT 1
  `);

  const getLatestRecent144TradeByTokenStmt = sqlite.prepare(`
    SELECT
      offer_txid,
      offer_out_idx,
      price_nanosats_per_atom
    FROM processed_trades
    WHERE token_id = ?
      AND block_height >= ?
    ORDER BY
      block_height DESC,
      block_timestamp DESC,
      inserted_at DESC,
      offer_txid DESC,
      offer_out_idx DESC
    LIMIT 1
  `);

  const listTradeHistoryByTokenDescStmt = sqlite.prepare(`
    SELECT
      offer_txid,
      offer_out_idx,
      spend_txid,
      token_id,
      variant_type,
      paid_sats,
      sold_atoms,
      price_nanosats_per_atom,
      taker_script_hex,
      block_height,
      block_hash,
      block_timestamp,
      raw_trade_json,
      inserted_at
    FROM processed_trades
    WHERE token_id = ?
    ORDER BY
      block_height DESC NULLS LAST,
      block_timestamp DESC NULLS LAST,
      inserted_at DESC,
      offer_txid DESC,
      offer_out_idx DESC
    LIMIT ? OFFSET ?
  `);

  const listTradeHistoryByTokenAscStmt = sqlite.prepare(`
    SELECT
      offer_txid,
      offer_out_idx,
      spend_txid,
      token_id,
      variant_type,
      paid_sats,
      sold_atoms,
      price_nanosats_per_atom,
      taker_script_hex,
      block_height,
      block_hash,
      block_timestamp,
      raw_trade_json,
      inserted_at
    FROM processed_trades
    WHERE token_id = ?
    ORDER BY
      block_height ASC NULLS FIRST,
      block_timestamp ASC NULLS FIRST,
      inserted_at ASC,
      offer_txid ASC,
      offer_out_idx ASC
    LIMIT ? OFFSET ?
  `);

  const listGlobalTradeHistoryDescStmt = sqlite.prepare(`
    SELECT
      offer_txid,
      offer_out_idx,
      spend_txid,
      token_id,
      variant_type,
      paid_sats,
      sold_atoms,
      price_nanosats_per_atom,
      taker_script_hex,
      block_height,
      block_hash,
      block_timestamp,
      raw_trade_json,
      inserted_at
    FROM processed_trades
    ORDER BY
      block_height DESC NULLS LAST,
      block_timestamp DESC NULLS LAST,
      inserted_at DESC,
      offer_txid DESC,
      offer_out_idx DESC
    LIMIT ? OFFSET ?
  `);

  const listGlobalTradeHistoryAscStmt = sqlite.prepare(`
    SELECT
      offer_txid,
      offer_out_idx,
      spend_txid,
      token_id,
      variant_type,
      paid_sats,
      sold_atoms,
      price_nanosats_per_atom,
      taker_script_hex,
      block_height,
      block_hash,
      block_timestamp,
      raw_trade_json,
      inserted_at
    FROM processed_trades
    ORDER BY
      block_height ASC NULLS FIRST,
      block_timestamp ASC NULLS FIRST,
      inserted_at ASC,
      offer_txid ASC,
      offer_out_idx ASC
    LIMIT ? OFFSET ?
  `);

  const listTokenCandlesStmtByInterval = new Map<CandleInterval, Database.Statement>();
  for (const interval of ["hour", "day", "week"] as const) {
    const { bucketStartSql, bucketSeconds } = candleBucketSql(interval);
    listTokenCandlesStmtByInterval.set(
      interval,
      sqlite.prepare(`
        WITH bucketed AS (
          SELECT
            ${bucketStartSql} AS bucket_start,
            (${bucketStartSql} + ${bucketSeconds} - 1) AS bucket_end,
            price_nanosats_per_atom,
            paid_sats,
            sold_atoms,
            block_height,
            block_timestamp,
            inserted_at,
            offer_txid,
            offer_out_idx
          FROM processed_trades
          WHERE token_id = ?
            AND block_timestamp IS NOT NULL
        ),
        ranked AS (
          SELECT
            bucket_start,
            bucket_end,
            price_nanosats_per_atom,
            paid_sats,
            sold_atoms,
            ROW_NUMBER() OVER (
              PARTITION BY bucket_start
              ORDER BY
                block_height ASC,
                block_timestamp ASC,
                inserted_at ASC,
                offer_txid ASC,
                offer_out_idx ASC
            ) AS open_rank,
            ROW_NUMBER() OVER (
              PARTITION BY bucket_start
              ORDER BY
                block_height DESC,
                block_timestamp DESC,
                inserted_at DESC,
                offer_txid DESC,
                offer_out_idx DESC
            ) AS close_rank
          FROM bucketed
        ),
        aggregated AS (
          SELECT
            bucket_start,
            bucket_end,
            MAX(CASE WHEN open_rank = 1 THEN price_nanosats_per_atom END) AS open_price_nanosats_per_atom,
            CAST(MAX(CAST(price_nanosats_per_atom AS INTEGER)) AS TEXT) AS high_price_nanosats_per_atom,
            CAST(MIN(CAST(price_nanosats_per_atom AS INTEGER)) AS TEXT) AS low_price_nanosats_per_atom,
            MAX(CASE WHEN close_rank = 1 THEN price_nanosats_per_atom END) AS close_price_nanosats_per_atom,
            COUNT(*) AS trade_count,
            COALESCE(CAST(SUM(CAST(paid_sats AS INTEGER)) AS TEXT), '0') AS volume_sats,
            COALESCE(CAST(SUM(CAST(sold_atoms AS INTEGER)) AS TEXT), '0') AS sold_atoms
          FROM ranked
          GROUP BY bucket_start, bucket_end
        ),
        limited AS (
          SELECT
            bucket_start,
            bucket_end,
            open_price_nanosats_per_atom,
            high_price_nanosats_per_atom,
            low_price_nanosats_per_atom,
            close_price_nanosats_per_atom,
            trade_count,
            volume_sats,
            sold_atoms
          FROM aggregated
          ORDER BY bucket_start DESC
          LIMIT ?
        )
        SELECT
          bucket_start,
          bucket_end,
          open_price_nanosats_per_atom,
          high_price_nanosats_per_atom,
          low_price_nanosats_per_atom,
          close_price_nanosats_per_atom,
          trade_count,
          volume_sats,
          sold_atoms
        FROM limited
        ORDER BY bucket_start ASC
      `),
    );
  }

  const upsertApiRouteAccessTotalStmt = sqlite.prepare(`
    INSERT INTO api_route_access_totals (
      route_key,
      access_count_total,
      success_count_total,
      client_error_count_total,
      server_error_count_total,
      last_accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(route_key) DO UPDATE SET
      access_count_total = api_route_access_totals.access_count_total + excluded.access_count_total,
      success_count_total = api_route_access_totals.success_count_total + excluded.success_count_total,
      client_error_count_total = api_route_access_totals.client_error_count_total + excluded.client_error_count_total,
      server_error_count_total = api_route_access_totals.server_error_count_total + excluded.server_error_count_total,
      last_accessed_at = CASE
        WHEN api_route_access_totals.last_accessed_at IS NULL OR excluded.last_accessed_at > api_route_access_totals.last_accessed_at
          THEN excluded.last_accessed_at
        ELSE api_route_access_totals.last_accessed_at
      END
  `);

  const upsertApiRouteAccessHourlyStmt = sqlite.prepare(`
    INSERT INTO api_route_access_hourly (
      route_key,
      bucket_start,
      access_count,
      success_count,
      client_error_count,
      server_error_count
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(route_key, bucket_start) DO UPDATE SET
      access_count = api_route_access_hourly.access_count + excluded.access_count,
      success_count = api_route_access_hourly.success_count + excluded.success_count,
      client_error_count = api_route_access_hourly.client_error_count + excluded.client_error_count,
      server_error_count = api_route_access_hourly.server_error_count + excluded.server_error_count
  `);

  const upsertTokenVisitTotalStmt = sqlite.prepare(`
    INSERT INTO token_visit_totals (
      token_id,
      visit_count_total,
      last_visited_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(token_id) DO UPDATE SET
      visit_count_total = token_visit_totals.visit_count_total + excluded.visit_count_total,
      last_visited_at = CASE
        WHEN token_visit_totals.last_visited_at IS NULL OR excluded.last_visited_at > token_visit_totals.last_visited_at
          THEN excluded.last_visited_at
        ELSE token_visit_totals.last_visited_at
      END
  `);

  const upsertTokenVisitHourlyStmt = sqlite.prepare(`
    INSERT INTO token_visit_hourly (
      token_id,
      bucket_start,
      visit_count
    ) VALUES (?, ?, ?)
    ON CONFLICT(token_id, bucket_start) DO UPDATE SET
      visit_count = token_visit_hourly.visit_count + excluded.visit_count
  `);

  const listApiRouteTotalsStmt = sqlite.prepare(`
    SELECT
      route_key,
      access_count_total,
      success_count_total,
      client_error_count_total,
      server_error_count_total,
      last_accessed_at
    FROM api_route_access_totals
  `);

  const listApiRouteWindowTotalsStmt = sqlite.prepare(`
    SELECT
      route_key,
      COALESCE(SUM(access_count), 0) AS access_count_window,
      COALESCE(SUM(success_count), 0) AS success_count_window,
      COALESCE(SUM(client_error_count), 0) AS client_error_count_window,
      COALESCE(SUM(server_error_count), 0) AS server_error_count_window
    FROM api_route_access_hourly
    WHERE bucket_start >= ?
    GROUP BY route_key
  `);

  const listApiRouteHourlyByRouteStmt = sqlite.prepare(`
    SELECT
      bucket_start,
      access_count,
      success_count,
      client_error_count,
      server_error_count
    FROM api_route_access_hourly
    WHERE route_key = ?
      AND bucket_start >= ?
    ORDER BY bucket_start ASC
  `);

  const listApiRouteHourlyGlobalStmt = sqlite.prepare(`
    SELECT
      bucket_start,
      COALESCE(SUM(access_count), 0) AS access_count,
      COALESCE(SUM(success_count), 0) AS success_count,
      COALESCE(SUM(client_error_count), 0) AS client_error_count,
      COALESCE(SUM(server_error_count), 0) AS server_error_count
    FROM api_route_access_hourly
    WHERE bucket_start >= ?
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `);

  const getApiAccessTotalsSummaryStmt = sqlite.prepare(`
    SELECT
      COALESCE(SUM(access_count_total), 0) AS access_count_total,
      COALESCE(SUM(success_count_total), 0) AS success_count_total,
      COALESCE(SUM(client_error_count_total), 0) AS client_error_count_total,
      COALESCE(SUM(server_error_count_total), 0) AS server_error_count_total
    FROM api_route_access_totals
  `);

  const getTokenVisitTotalsSummaryStmt = sqlite.prepare(`
    SELECT
      COALESCE(SUM(visit_count_total), 0) AS visit_count_total
    FROM token_visit_totals
  `);

  const listTokenVisitHourlyGlobalStmt = sqlite.prepare(`
    SELECT
      bucket_start,
      COALESCE(SUM(visit_count), 0) AS visit_count
    FROM token_visit_hourly
    WHERE bucket_start >= ?
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `);

  const countTrackedTokensStmt = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM tracked_tokens
  `);

  const getTokenVisitSnapshotStmt = sqlite.prepare(`
    SELECT
      COALESCE(v.visit_count_total, 0) AS visit_count_total,
      v.last_visited_at,
      COALESCE((
        SELECT SUM(h.visit_count)
        FROM token_visit_hourly h
        WHERE h.token_id = t.token_id
          AND h.bucket_start >= ?
      ), 0) AS visit_count_24h
    FROM tracked_tokens t
    LEFT JOIN token_visit_totals v
      ON v.token_id = t.token_id
    WHERE t.token_id = ?
  `);

  const listTokenVisitHourlyByTokenStmt = sqlite.prepare(`
    SELECT
      bucket_start,
      visit_count
    FROM token_visit_hourly
    WHERE token_id = ?
      AND bucket_start >= ?
    ORDER BY bucket_start ASC
  `);

  const deleteOldApiRouteBucketsStmt = sqlite.prepare(`
    DELETE FROM api_route_access_hourly
    WHERE bucket_start < ?
  `);

  const deleteOldTokenVisitBucketsStmt = sqlite.prepare(`
    DELETE FROM token_visit_hourly
    WHERE bucket_start < ?
  `);

  const recordApiAccessTx = sqlite.transaction((entry: ApiAccessRecord) => {
    const occurredAtMs = entry.occurredAtMs ?? Date.now();
    const bucketStart = startOfHourMs(occurredAtMs);
    const { successDelta, clientErrorDelta, serverErrorDelta } =
      getStatusCountDeltas(entry.statusCode);

    upsertApiRouteAccessTotalStmt.run(
      entry.routeKey,
      1,
      successDelta,
      clientErrorDelta,
      serverErrorDelta,
      occurredAtMs,
    );
    upsertApiRouteAccessHourlyStmt.run(
      entry.routeKey,
      bucketStart,
      1,
      successDelta,
      clientErrorDelta,
      serverErrorDelta,
    );

    if (entry.countTokenVisit && entry.tokenId) {
      upsertTokenVisitTotalStmt.run(entry.tokenId, 1, occurredAtMs);
      upsertTokenVisitHourlyStmt.run(entry.tokenId, bucketStart, 1);
    }
  });

  const setBootstrapCohortTx = sqlite.transaction((tokenIds: string[]) => {
    resetBootstrapStmt.run();
    for (const tokenId of tokenIds) {
      setBootstrapForTokenStmt.run(tokenId);
    }
  });

  const insertManyTradesTx = sqlite.transaction((records: ProcessedTradeRecord[]) => {
    const inserted: ProcessedTradeRecord[] = [];
    const now = Date.now();
    const deltas = new Map<string, BucketDelta>();

    for (const record of records) {
      const result = insertProcessedTradeStmt.run({
        ...record,
        insertedAt: now,
      });
      if (result.changes === 0) {
        continue;
      }

      inserted.push(record);
      if (record.blockHeight === null) {
        continue;
      }

      const key = `${record.tokenId}:${record.blockHeight}`;
      const existing = deltas.get(key);
      if (existing) {
        existing.tradeCountDelta += 1;
        existing.volumeSatsDelta += BigInt(record.paidSats);
        continue;
      }

      deltas.set(key, {
        tokenId: record.tokenId,
        blockHeight: record.blockHeight,
        tradeCountDelta: 1,
        volumeSatsDelta: BigInt(record.paidSats),
      });
    }

    for (const delta of deltas.values()) {
      upsertBlockBucket(
        selectTokenBlockBucketStmt,
        insertTokenBlockBucketStmt,
        updateTokenBlockBucketStmt,
        delta,
        now,
      );
    }

    return inserted;
  });

  const recomputeTokenAggregateStatsTx = sqlite.transaction(
    (tokenId: string, chainTipHeight: number) => {
      const buckets = (
        selectTokenBlockStatsStmt.all(tokenId) as Array<Record<string, unknown>>
      ).map(toTokenBlockStatsRecord);

      const snapshot = computeRollingStatsSnapshot(buckets, chainTipHeight);
      const latestTrade = getLatestTradeByTokenStmt.get(tokenId) as
        | Record<string, unknown>
        | undefined;
      const minRecent144Height = chainTipHeight - 143;
      const earliestRecent144Trade = getEarliestRecent144TradeByTokenStmt.get(
        tokenId,
        minRecent144Height,
      ) as Record<string, unknown> | undefined;
      const latestRecent144Trade = getLatestRecent144TradeByTokenStmt.get(
        tokenId,
        minRecent144Height,
      ) as Record<string, unknown> | undefined;
      const hasDistinctRecent144Trades =
        earliestRecent144Trade !== undefined &&
        latestRecent144Trade !== undefined &&
        (
          (earliestRecent144Trade.offer_txid as string) !==
            (latestRecent144Trade.offer_txid as string) ||
          (earliestRecent144Trade.offer_out_idx as number) !==
            (latestRecent144Trade.offer_out_idx as number)
        );
      const now = Date.now();

      const aggregate: TokenAggregateStatsRecord = {
        tokenId,
        tradeCount: snapshot.totalTradeCount,
        cumulativePaidSats: snapshot.totalVolumeSats,
        recent144TradeCount: snapshot.recent144TradeCount,
        recent144VolumeSats: snapshot.recent144VolumeSats,
        recent144PriceChangeBps: hasDistinctRecent144Trades
          ? computePriceChangeBps(
              earliestRecent144Trade.price_nanosats_per_atom as string | null | undefined,
              latestRecent144Trade?.price_nanosats_per_atom as string | null | undefined,
            )
          : "0",
        recent1008TradeCount: snapshot.recent1008TradeCount,
        recent1008VolumeSats: snapshot.recent1008VolumeSats,
        recent4320TradeCount: snapshot.recent4320TradeCount,
        recent4320VolumeSats: snapshot.recent4320VolumeSats,
        lastTradeOfferTxid: (latestTrade?.offer_txid as string | null) ?? null,
        lastTradeOfferOutIdx:
          (latestTrade?.offer_out_idx as number | null) ?? null,
        lastTradeBlockHeight:
          (latestTrade?.block_height as number | null) ?? null,
        lastTradeBlockTimestamp:
          (latestTrade?.block_timestamp as number | null) ?? null,
        lastTradePriceNanosatsPerAtom:
          (latestTrade?.price_nanosats_per_atom as string | null) ?? null,
        updatedAt: now,
      };

      replaceTokenAggregateStatsStmt.run({
        tokenId: aggregate.tokenId,
        tradeCount: aggregate.tradeCount,
        cumulativePaidSats: aggregate.cumulativePaidSats,
        recent144TradeCount: aggregate.recent144TradeCount,
        recent144VolumeSats: aggregate.recent144VolumeSats,
        recent144PriceChangeBps: aggregate.recent144PriceChangeBps,
        recent1008TradeCount: aggregate.recent1008TradeCount,
        recent1008VolumeSats: aggregate.recent1008VolumeSats,
        recent4320TradeCount: aggregate.recent4320TradeCount,
        recent4320VolumeSats: aggregate.recent4320VolumeSats,
        lastTradeOfferTxid: aggregate.lastTradeOfferTxid,
        lastTradeOfferOutIdx: aggregate.lastTradeOfferOutIdx,
        lastTradeBlockHeight: aggregate.lastTradeBlockHeight,
        lastTradeBlockTimestamp: aggregate.lastTradeBlockTimestamp,
        lastTradePriceNanosatsPerAtom: aggregate.lastTradePriceNanosatsPerAtom,
        updatedAt: aggregate.updatedAt,
      });

      return aggregate;
    },
  );

  function readEndpointAnalyticsSummary(
    hours: number,
    nowMs = Date.now(),
  ): DbEndpointAnalyticsSummary[] {
    const windowStart = previousHoursWindowStartMs(nowMs, hours);
    const summaries = new Map<AnalyticsRouteKey, DbEndpointAnalyticsSummary>(
      ANALYTICS_ROUTE_KEYS.map((routeKey) => [
        routeKey,
        emptyEndpointAnalyticsSummary(routeKey),
      ]),
    );

    const totalRows = listApiRouteTotalsStmt.all() as Array<Record<string, unknown>>;
    for (const row of totalRows) {
      const routeKey = row.route_key as AnalyticsRouteKey;
      const existing = summaries.get(routeKey);
      if (!existing) {
        continue;
      }
      summaries.set(routeKey, {
        ...existing,
        accessCountTotal: Number(row.access_count_total ?? 0),
        successCountTotal: Number(row.success_count_total ?? 0),
        clientErrorCountTotal: Number(row.client_error_count_total ?? 0),
        serverErrorCountTotal: Number(row.server_error_count_total ?? 0),
        lastAccessedAt: toNullableNumber(row.last_accessed_at),
      });
    }

    const windowRows = listApiRouteWindowTotalsStmt.all(windowStart) as Array<
      Record<string, unknown>
    >;
    for (const row of windowRows) {
      const routeKey = row.route_key as AnalyticsRouteKey;
      const existing = summaries.get(routeKey);
      if (!existing) {
        continue;
      }
      summaries.set(routeKey, {
        ...existing,
        accessCountWindow: Number(row.access_count_window ?? 0),
        successCountWindow: Number(row.success_count_window ?? 0),
        clientErrorCountWindow: Number(row.client_error_count_window ?? 0),
        serverErrorCountWindow: Number(row.server_error_count_window ?? 0),
      });
    }

    return ANALYTICS_ROUTE_KEYS.map(
      (routeKey) => summaries.get(routeKey) ?? emptyEndpointAnalyticsSummary(routeKey),
    );
  }

  function readTokenVisitSnapshot(
    tokenId: string,
    nowMs = Date.now(),
  ): DbTokenVisitSnapshot {
    const visit24hWindowStart = previousHoursWindowStartMs(nowMs, 24);
    const row = getTokenVisitSnapshotStmt.get(visit24hWindowStart, tokenId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return {
        visitCountTotal: 0,
        visitCount24h: 0,
        lastVisitedAt: null,
      };
    }

    return {
      visitCountTotal: Number(row.visit_count_total ?? 0),
      visitCount24h: Number(row.visit_count_24h ?? 0),
      lastVisitedAt: toNullableNumber(row.last_visited_at),
    };
  }

  function readTokenVisitAnalytics(
    tokenId: string,
    hours: number,
    nowMs = Date.now(),
  ): DbTokenVisitAnalytics {
    const windowStart = previousHoursWindowStartMs(nowMs, hours);
    const snapshot = readTokenVisitSnapshot(tokenId, nowMs);
    const rows = listTokenVisitHourlyByTokenStmt.all(
      tokenId,
      windowStart,
    ) as Array<Record<string, unknown>>;
    const buckets = denseTokenVisitBuckets(rows, windowStart, hours);

    return {
      tokenId,
      ...snapshot,
      hours,
      windowStart,
      windowEnd: nowMs,
      visitCountWindow: buckets.reduce(
        (total, bucket) => total + bucket.visitCount,
        0,
      ),
      buckets,
    };
  }

  function readAnalyticsSummary(
    hours: number,
    nowMs = Date.now(),
  ): DbAnalyticsSummary {
    const windowStart = previousHoursWindowStartMs(nowMs, hours);
    const apiTotalsRow = getApiAccessTotalsSummaryStmt.get() as Record<string, unknown>;
    const apiHourlyRows = listApiRouteHourlyGlobalStmt.all(
      windowStart,
    ) as Array<Record<string, unknown>>;
    const apiAccessBuckets = denseApiAccessBuckets(apiHourlyRows, windowStart, hours);
    const tokenVisitTotalsRow = getTokenVisitTotalsSummaryStmt.get() as Record<
      string,
      unknown
    >;
    const tokenVisitHourlyRows = listTokenVisitHourlyGlobalStmt.all(
      windowStart,
    ) as Array<Record<string, unknown>>;
    const tokenVisitBuckets = denseTokenVisitBuckets(
      tokenVisitHourlyRows,
      windowStart,
      hours,
    );

    return {
      hours,
      windowStart,
      windowEnd: nowMs,
      apiAccessCountTotal: Number(apiTotalsRow.access_count_total ?? 0),
      apiAccessCountWindow: apiAccessBuckets.reduce(
        (total, bucket) => total + bucket.accessCount,
        0,
      ),
      apiAccessBuckets,
      tokenVisitCountTotal: Number(tokenVisitTotalsRow.visit_count_total ?? 0),
      tokenVisitCountWindow: tokenVisitBuckets.reduce(
        (total, bucket) => total + bucket.visitCount,
        0,
      ),
      tokenVisitBuckets,
    };
  }

  function readTokenVisitsPage(options: ListTokenVisitsOptions): {
    page: number;
    pageSize: number;
    total: number;
    items: DbTokenVisitSummary[];
  } {
    const sort = options.sort ?? "visitsTotal";
    const order = options.order ?? "desc";
    const nowMs = options.nowMs ?? Date.now();
    const visit24hWindowStart = previousHoursWindowStartMs(nowMs, 24);
    const orderBy = tokenVisitOrderByClause(sort, order);
    const stmt = sqlite.prepare(`
      SELECT
        t.token_id,
        COALESCE(v.visit_count_total, 0) AS visit_count_total,
        COALESCE(v24.visit_count_24h, 0) AS visit_count_24h,
        v.last_visited_at
      FROM tracked_tokens t
      LEFT JOIN token_visit_totals v
        ON v.token_id = t.token_id
      LEFT JOIN (
        SELECT
          token_id,
          SUM(visit_count) AS visit_count_24h
        FROM token_visit_hourly
        WHERE bucket_start >= ?
        GROUP BY token_id
      ) v24
        ON v24.token_id = t.token_id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `);
    const totalRow = countTrackedTokensStmt.get() as { count: number };
    const rows = stmt.all(
      visit24hWindowStart,
      options.pageSize,
      options.offset,
    ) as Array<Record<string, unknown>>;

    return {
      page: options.page,
      pageSize: options.pageSize,
      total: totalRow.count,
      items: rows.map((row) => ({
        tokenId: String(row.token_id),
        visitCountTotal: Number(row.visit_count_total ?? 0),
        visitCount24h: Number(row.visit_count_24h ?? 0),
        lastVisitedAt: toNullableNumber(row.last_visited_at),
      })),
    };
  }

  return {
    sqlite,
    close: () => sqlite.close(),
    recordApiAccess: (entry) => {
      recordApiAccessTx(entry);
    },
    markAllTrackedTokensInactive: () => {
      markAllTrackedTokensInactiveStmt.run();
    },
    upsertTrackedToken: (token) => {
      const discoveredAt = Date.now();
      upsertTrackedTokenStmt.run({
        tokenId: token.tokenId,
        groupHex: token.groupHex,
        groupPrefixHex: token.groupPrefixHex,
        kind: token.kind,
        discoverySource: `agora-group-${token.groupPrefixHex}`,
        discoveredAt,
      });
    },
    listTrackedTokenIds: () =>
      (listTrackedTokenIdsStmt.all() as Array<{ token_id: string }>).map(
        (row) => row.token_id,
      ),
    markTokenSynced: (tokenId, syncedAtMs) => {
      markTokenSyncedStmt.run(syncedAtMs, tokenId);
    },
    markTokenWsEvent: (tokenId, eventAtMs) => {
      markTokenWsEventStmt.run(eventAtMs, tokenId);
    },
    insertProcessedTrades: (trades) => insertManyTradesTx(trades),
    getTokenStats: (tokenId) => {
      const row = getTokenStatsStmt.get(tokenId) as Record<string, unknown> | undefined;
      return row ? toTokenStatsRecord(row) : null;
    },
    replaceTokenStats: (stats) => {
      replaceTokenStatsStmt.run({
        ...stats,
        recent144TradeCount: 0,
        recent144VolumeSats: "0",
        recent144PriceChangeBps: "0",
        recent1008TradeCount: 0,
        recent1008VolumeSats: "0",
        recent4320TradeCount: 0,
        recent4320VolumeSats: "0",
        lastTradePriceNanosatsPerAtom: stats.lastTradePriceNanosatsPerAtom,
        updatedAt: Date.now(),
      });
    },
    getTrackedToken: (tokenId) => {
      const row = getTrackedTokenStmt.get(tokenId) as
        | Record<string, unknown>
        | undefined;
      return row ? toTrackedTokenRecord(row) : null;
    },
    listTrackedTokens: (activeOnly = false) => {
      const rows = activeOnly
        ? (listActiveTrackedTokensStmt.all() as Array<Record<string, unknown>>)
        : (listTrackedTokensStmt.all() as Array<Record<string, unknown>>);
      return rows.map(toTrackedTokenRecord);
    },
    setBootstrapCohort: (tokenIds, isBootstrap = true) => {
      if (!isBootstrap) {
        setBootstrapCohortTx([]);
        return;
      }
      setBootstrapCohortTx(tokenIds);
    },
    markTokenInitPending: (tokenId, atMs) => {
      markTokenInitPendingStmt.run(atMs, tokenId);
    },
    markTokenInitStarted: (tokenId, atMs) => {
      markTokenInitStartedStmt.run(atMs, tokenId);
    },
    markTokenInitCompleted: (tokenId, atMs) => {
      markTokenInitCompletedStmt.run(atMs, tokenId);
    },
    markTokenInitFailed: (tokenId, atMs, errorMessage) => {
      markTokenInitFailedStmt.run(atMs, errorMessage, tokenId);
    },
    markTokenReady: (tokenId, isReady, atMs) => {
      const readyFlag = isReady ? 1 : 0;
      markTokenReadyStmt.run(readyFlag, readyFlag, readyFlag, atMs, tokenId);
    },
    countBootstrapTokens: () => {
      const row = countBootstrapTokensStmt.get() as { count: number };
      return row.count;
    },
    countReadyBootstrapTokens: () => {
      const row = countReadyBootstrapTokensStmt.get() as { count: number };
      return row.count;
    },
    getTokenBlockStats: (tokenId) =>
      (selectTokenBlockStatsStmt.all(tokenId) as Array<Record<string, unknown>>).map(
        toTokenBlockStatsRecord,
      ),
    recomputeTokenAggregateStats: (tokenId, chainTipHeight) =>
      recomputeTokenAggregateStatsTx(tokenId, chainTipHeight),
    recomputeAllTokenAggregateStats: (chainTipHeight) => {
      const tokenIds = (
        listDistinctTokenIdsStmt.all() as Array<{ token_id: string }>
      ).map((row) => row.token_id);
      const recomputeAllTx = sqlite.transaction((ids: string[]) => {
        for (const tokenId of ids) {
          recomputeTokenAggregateStatsTx(tokenId, chainTipHeight);
        }
      });
      recomputeAllTx(tokenIds);
      return tokenIds.length;
    },
    getTokenAggregateStats: (tokenId) => {
      const row = getTokenAggregateStatsStmt.get(tokenId) as
        | Record<string, unknown>
        | undefined;
      return row ? toTokenAggregateStatsRecord(row) : null;
    },
    listTokenStatsPage: (options) => {
      const limit = options.limit;
      const offset = options.offset ?? 0;
      const order = options.order ?? "desc";
      const orderBy = buildStatsOrderByClause(options.sortBy, order);
      const whereClause = options.readyOnly
        ? "WHERE COALESCE(t.is_ready, 0) = 1"
        : "";
      const stmt = sqlite.prepare(`
        SELECT
          s.token_id,
          s.trade_count,
          s.cumulative_paid_sats,
          s.last_trade_price_nanosats_per_atom,
          s.recent_144_trade_count,
          s.recent_144_volume_sats,
          s.recent_144_price_change_bps,
          s.recent_1008_trade_count,
          s.recent_1008_volume_sats,
          s.recent_4320_trade_count,
          s.recent_4320_volume_sats,
          s.last_trade_offer_txid,
          s.last_trade_offer_out_idx,
          s.last_trade_block_height,
          s.last_trade_block_timestamp,
          s.updated_at,
          COALESCE(t.is_active, 0) AS is_active,
          COALESCE(t.is_ready, 0) AS is_ready,
          COALESCE(t.bootstrap_cohort, 0) AS bootstrap_cohort,
          COALESCE(t.init_status, 'PENDING') AS init_status,
          t.last_synced_at
        FROM token_stats s
        LEFT JOIN tracked_tokens t
          ON t.token_id = s.token_id
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(limit, offset) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        ...toTokenAggregateStatsRecord(row),
        isActive: Number(row.is_active) === 1,
        isReady: Number(row.is_ready) === 1,
        bootstrapCohort: Number(row.bootstrap_cohort) === 1,
        initStatus: normalizeInitStatus(row.init_status as string | null),
        lastSyncedAt: (row.last_synced_at as number | null) ?? null,
      }));
    },
    listTradeHistory: (options) => {
      const limit = options.limit;
      const offset = options.offset ?? 0;
      const order = options.order ?? "desc";

      if (options.tokenId) {
        const stmt =
          order === "asc"
            ? listTradeHistoryByTokenAscStmt
            : listTradeHistoryByTokenDescStmt;
        return (
          stmt.all(options.tokenId, limit, offset) as Array<Record<string, unknown>>
        ).map(toTradeHistoryRow);
      }

      const stmt =
        order === "asc" ? listGlobalTradeHistoryAscStmt : listGlobalTradeHistoryDescStmt;
      return (stmt.all(limit, offset) as Array<Record<string, unknown>>).map(
        toTradeHistoryRow,
      );
    },
    listTokenCandles: (options) => {
      const stmt = listTokenCandlesStmtByInterval.get(options.interval);
      if (!stmt) {
        return [];
      }
      return (
        stmt.all(options.tokenId, options.limit) as Array<Record<string, unknown>>
      ).map(toTokenCandleRow);
    },
    getAnalyticsSummary: (options) =>
      readAnalyticsSummary(options.hours, options.nowMs),
    listEndpointAnalytics: (options) =>
      readEndpointAnalyticsSummary(options.hours, options.nowMs),
    getEndpointAnalytics: (options) => {
      const nowMs = options.nowMs ?? Date.now();
      const summary = readEndpointAnalyticsSummary(
        options.hours,
        nowMs,
      ).find((item) => item.routeKey === options.routeKey) ??
        emptyEndpointAnalyticsSummary(options.routeKey);
      const windowStart = previousHoursWindowStartMs(nowMs, options.hours);
      const rows = listApiRouteHourlyByRouteStmt.all(
        options.routeKey,
        windowStart,
      ) as Array<Record<string, unknown>>;

      return {
        ...summary,
        hours: options.hours,
        windowStart,
        windowEnd: nowMs,
        buckets: denseApiAccessBuckets(rows, windowStart, options.hours),
      };
    },
    listTokenVisits: (options) => readTokenVisitsPage(options),
    getTokenVisitAnalytics: (options) =>
      readTokenVisitAnalytics(options.tokenId, options.hours, options.nowMs),
    getTokenVisitSnapshot: (tokenId, nowMs) =>
      readTokenVisitSnapshot(tokenId, nowMs),
    pruneOldAnalyticsBuckets: (retentionHours, nowMs = Date.now()) => {
      const cutoffBucketStart = retentionCutoffBucketStartMs(nowMs, retentionHours);
      return {
        apiRouteBucketCount: deleteOldApiRouteBucketsStmt.run(cutoffBucketStart)
          .changes,
        tokenVisitBucketCount: deleteOldTokenVisitBucketsStmt.run(cutoffBucketStart)
          .changes,
      };
    },
  };
}
