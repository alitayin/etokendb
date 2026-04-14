import fs from "node:fs";

import type { WsEndpoint, WsMsgClient } from "chronik-client";

import {
  discoverActiveTokens,
  extractAgoraTokenIdsFromTx,
  syncTokenHistory,
  type SyncDependencies,
  type SyncProgressHandlers,
} from "../lib/agoraSync.js";
import { retryAsync, withTimeout } from "../lib/async.js";
import type { AppConfig } from "../lib/config.js";
import type { AppDatabase } from "../lib/db.js";
import type { ActiveTokenSeed } from "../lib/types.js";
import type {
  PaginatedResult,
  ServiceReadApi,
  ServiceStatus,
  TokenDetail,
  TokenListQuery,
  TokenSortField,
  TokenSummary,
  TradeHistoryItem,
  TradeListQuery,
} from "./contracts.js";

type Logger = Pick<Console, "info" | "warn" | "error">;

type TokenPhase = "pending" | "initializing" | "catching-up" | "ready" | "error";

interface TokenRuntimeState {
  tokenId: string;
  active: boolean;
  ready: boolean;
  bootstrapCohort: boolean;
  dirty: boolean;
  processing: boolean;
  phase: TokenPhase;
  lastError: string | null;
}

interface CoordinatorOps {
  discoverActiveTokens: typeof discoverActiveTokens;
  syncTokenHistory: typeof syncTokenHistory;
  extractAgoraTokenIdsFromTx: typeof extractAgoraTokenIdsFromTx;
}

interface BootstrapPlan {
  blockingSeeds: ActiveTokenSeed[];
  skippedTradeThresholdSeeds: ActiveTokenSeed[];
}

interface ApplyDiscoveryOptions {
  bootstrapTokenIds?: Set<string>;
  enqueueTokenIds?: Set<string>;
}

export interface AgoraTokenServiceOptions {
  logger?: Logger;
  ops?: Partial<CoordinatorOps>;
  deferKnownTradeCountLte?: number | null;
}

function toIso(timestampMs: number | null): string | null {
  return timestampMs === null ? null : new Date(timestampMs).toISOString();
}

function startOfTodayMs(now = new Date()): number {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();
}

function formatLocalDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDbSizeBytes(sqlitePath: string): number | null {
  if (sqlitePath === ":memory:") {
    return null;
  }

  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${sqlitePath}${suffix}`;
    try {
      total += fs.statSync(path).size;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  return total;
}

function normalizePagination(
  page: number | undefined,
  pageSize: number | undefined,
  config: AppConfig,
): { page: number; pageSize: number; offset: number } {
  const normalizedPage = Number.isFinite(page) && page && page > 0 ? page : 1;
  const requestedPageSize =
    Number.isFinite(pageSize) && pageSize && pageSize > 0
      ? pageSize
      : config.apiPageSizeDefault;
  const normalizedPageSize = Math.min(requestedPageSize, config.apiPageSizeMax);
  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  };
}

function tokenSortSql(sort: TokenSortField, order: "asc" | "desc"): string {
  const direction = order === "asc" ? "ASC" : "DESC";
  const numericText = (field: string) => `CAST(COALESCE(${field}, '0') AS INTEGER)`;
  const numericInt = (field: string) => `COALESCE(${field}, 0)`;

  switch (sort) {
    case "totalTradeCount":
      return `${numericInt("s.trade_count")} ${direction}, t.token_id ASC`;
    case "totalVolumeSats":
      return `${numericText("s.cumulative_paid_sats")} ${direction}, t.token_id ASC`;
    case "recent144TradeCount":
      return `${numericInt("s.recent_144_trade_count")} ${direction}, t.token_id ASC`;
    case "recent144VolumeSats":
      return `${numericText("s.recent_144_volume_sats")} ${direction}, t.token_id ASC`;
    case "recent1008TradeCount":
      return `${numericInt("s.recent_1008_trade_count")} ${direction}, t.token_id ASC`;
    case "recent1008VolumeSats":
      return `${numericText("s.recent_1008_volume_sats")} ${direction}, t.token_id ASC`;
    case "recent4320TradeCount":
      return `${numericInt("s.recent_4320_trade_count")} ${direction}, t.token_id ASC`;
    case "recent4320VolumeSats":
      return `${numericText("s.recent_4320_volume_sats")} ${direction}, t.token_id ASC`;
    case "lastTradeBlockHeight":
      return `${numericInt("s.last_trade_block_height")} ${direction}, ${numericInt("s.last_trade_block_timestamp")} ${direction}, t.token_id ASC`;
    case "lastTradeBlockTimestamp":
      return `${numericInt("s.last_trade_block_timestamp")} ${direction}, ${numericInt("s.last_trade_block_height")} ${direction}, t.token_id ASC`;
    default:
      return `${numericText("s.recent_144_volume_sats")} DESC, t.token_id ASC`;
  }
}

function toTokenSummary(row: Record<string, unknown>): TokenSummary {
  return {
    tokenId: row.token_id as string,
    isActive: Number(row.is_active ?? 0) === 1,
    isReady: Number(row.is_ready ?? 0) === 1,
    bootstrapCohort: Number(row.bootstrap_cohort ?? 0) === 1,
    totalTradeCount: Number(row.trade_count ?? 0),
    totalVolumeSats: String(row.cumulative_paid_sats ?? "0"),
    recent144TradeCount: Number(row.recent_144_trade_count ?? 0),
    recent144VolumeSats: String(row.recent_144_volume_sats ?? "0"),
    recent1008TradeCount: Number(row.recent_1008_trade_count ?? 0),
    recent1008VolumeSats: String(row.recent_1008_volume_sats ?? "0"),
    recent4320TradeCount: Number(row.recent_4320_trade_count ?? 0),
    recent4320VolumeSats: String(row.recent_4320_volume_sats ?? "0"),
    lastTradeBlockHeight:
      row.last_trade_block_height === null || row.last_trade_block_height === undefined
        ? null
        : Number(row.last_trade_block_height),
    lastTradeBlockTimestamp:
      row.last_trade_block_timestamp === null ||
      row.last_trade_block_timestamp === undefined
        ? null
        : Number(row.last_trade_block_timestamp),
    lastSyncedAt:
      row.last_synced_at === null || row.last_synced_at === undefined
        ? null
        : Number(row.last_synced_at),
    lastWsEventAt:
      row.last_ws_event_at === null || row.last_ws_event_at === undefined
        ? null
        : Number(row.last_ws_event_at),
  };
}

function toTradeHistoryItem(row: Record<string, unknown>): TradeHistoryItem {
  return {
    tokenId: row.token_id as string,
    offerTxid: row.offer_txid as string,
    offerOutIdx: Number(row.offer_out_idx),
    spendTxid: row.spend_txid as string,
    paidSats: String(row.paid_sats),
    soldAtoms: String(row.sold_atoms),
    priceNanosatsPerAtom: String(row.price_nanosats_per_atom),
    takerScriptHex: (row.taker_script_hex as string | null) ?? null,
    blockHeight:
      row.block_height === null || row.block_height === undefined
        ? null
        : Number(row.block_height),
    blockTimestamp:
      row.block_timestamp === null || row.block_timestamp === undefined
        ? null
        : Number(row.block_timestamp),
  };
}

export class AgoraTokenService implements ServiceReadApi {
  private readonly logger: Logger;
  private readonly ops: CoordinatorOps;
  private readonly tokenStates = new Map<string, TokenRuntimeState>();
  private readonly subscribedTokenIds = new Set<string>();
  private readonly queuedTokenIds = new Set<string>();
  private readonly pendingQueue: string[] = [];
  private readonly bootstrapResolvers = new Set<() => void>();
  private readonly bootstrapRejectors = new Set<(error: Error) => void>();
  private ws: WsEndpoint | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private tipRefreshTimer: NodeJS.Timeout | null = null;
  private pollingTailTimer: NodeJS.Timeout | null = null;
  private workerCount = 0;
  private startedAt = Date.now();
  private phase: ServiceStatus["phase"] = "starting";
  private ready = false;
  private wsConnected = false;
  private tipHeight: number | null = null;
  private bootstrapTokenCount = 0;
  private discoveryPageCount = 0;
  private lastDiscoveryAtMs: number | null = null;
  private lastTipUpdateAtMs: number | null = null;
  private lastError: string | null = null;
  private bootstrapError: Error | null = null;
  private readonly deferKnownTradeCountLte: number | null;

  constructor(
    private readonly db: AppDatabase,
    private readonly deps: SyncDependencies,
    private readonly config: AppConfig,
    options?: AgoraTokenServiceOptions,
  ) {
    this.logger = options?.logger ?? console;
    this.ops = {
      discoverActiveTokens,
      syncTokenHistory,
      extractAgoraTokenIdsFromTx,
      ...options?.ops,
    };
    this.deferKnownTradeCountLte = options?.deferKnownTradeCountLte ?? null;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.ready = false;
    this.phase = "starting";
    this.bootstrapError = null;

    try {
      await this.refreshTipHeight();
      await this.startWs();
      await this.bootstrap();
      if (!this.wsConnected) {
        await this.runBootstrapTailSweepWithoutWs();
      }
      this.ready = true;
      this.phase = this.wsConnected ? "ready" : "degraded";
      this.startBackgroundLoops();
    } catch (error) {
      this.phase = "error";
      throw error;
    }
  }

  stop(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.tipRefreshTimer) {
      clearInterval(this.tipRefreshTimer);
      this.tipRefreshTimer = null;
    }
    if (this.pollingTailTimer) {
      clearInterval(this.pollingTailTimer);
      this.pollingTailTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedTokenIds.clear();
  }

  isReady(): boolean {
    return this.ready;
  }

  getStatus(): ServiceStatus {
    const trackedTokens = this.db.listTrackedTokens();
    const todayStartMs = startOfTodayMs();
    const now = new Date();
    const tradedTokenCount = this.db.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM token_stats
          WHERE trade_count > 0
        `,
      )
      .get() as { count: number };

    return {
      ready: this.ready,
      phase: this.phase,
      wsConnected: this.wsConnected,
      chronikUrl: this.config.chronikUrl,
      dbPath: this.config.sqlitePath,
      dbSizeBytes: getDbSizeBytes(this.config.sqlitePath),
      startedAt: new Date(this.startedAt).toISOString(),
      statusDate: formatLocalDate(now),
      statusTimezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      tipHeight: this.tipHeight,
      totalTrackedTokenCount: trackedTokens.length,
      activeTokenCount: trackedTokens.filter((token) => token.isActive).length,
      readyTokenCount: trackedTokens.filter((token) => token.isReady).length,
      tradedTokenCount: tradedTokenCount.count,
      discoveredTodayCount: trackedTokens.filter(
        (token) => token.firstDiscoveredAt >= todayStartMs,
      ).length,
      activeDiscoveredTodayCount: trackedTokens.filter(
        (token) => token.isActive && token.firstDiscoveredAt >= todayStartMs,
      ).length,
      bootstrapTokenCount: this.db.countBootstrapTokens(),
      bootstrapReadyCount: this.db.countReadyBootstrapTokens(),
      discoveryPageCount: this.discoveryPageCount,
      lastDiscoveryAt: toIso(this.lastDiscoveryAtMs),
      lastTipUpdateAt: toIso(this.lastTipUpdateAtMs),
      lastError: this.lastError,
    };
  }

  listTokens(query: TokenListQuery): PaginatedResult<TokenSummary> {
    const { page, pageSize, offset } = normalizePagination(
      query.page,
      query.pageSize,
      this.config,
    );
    const readyOnly = query.readyOnly ?? true;
    const totalRow = this.db.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM tracked_tokens t
          LEFT JOIN token_stats s
            ON s.token_id = t.token_id
          ${readyOnly ? "WHERE COALESCE(t.is_ready, 0) = 1" : ""}
        `,
      )
      .get() as { count: number };
    const rows = this.db.sqlite
      .prepare(
        `
          SELECT
            t.token_id,
            t.is_active,
            t.is_ready,
            t.bootstrap_cohort,
            t.last_synced_at,
            t.last_ws_event_at,
            s.trade_count,
            s.cumulative_paid_sats,
            s.recent_144_trade_count,
            s.recent_144_volume_sats,
            s.recent_1008_trade_count,
            s.recent_1008_volume_sats,
            s.recent_4320_trade_count,
            s.recent_4320_volume_sats,
            s.last_trade_block_height,
            s.last_trade_block_timestamp
          FROM tracked_tokens t
          LEFT JOIN token_stats s
            ON s.token_id = t.token_id
          ${readyOnly ? "WHERE COALESCE(t.is_ready, 0) = 1" : ""}
          ORDER BY ${tokenSortSql(query.sort ?? "recent144VolumeSats", query.order ?? "desc")}
          LIMIT ?
          OFFSET ?
        `,
      )
      .all(pageSize, offset) as Record<string, unknown>[];

    return {
      page,
      pageSize,
      total: totalRow.count,
      items: rows.map(toTokenSummary),
    };
  }

  getToken(tokenId: string): TokenDetail | null {
    const row = this.db.sqlite
      .prepare(
        `
          SELECT
            t.token_id,
            t.is_active,
            t.is_ready,
            t.bootstrap_cohort,
            t.first_discovered_at,
            t.last_discovered_at,
            t.init_status,
            t.last_synced_at,
            t.last_ws_event_at,
            s.trade_count,
            s.cumulative_paid_sats,
            s.recent_144_trade_count,
            s.recent_144_volume_sats,
            s.recent_1008_trade_count,
            s.recent_1008_volume_sats,
            s.recent_4320_trade_count,
            s.recent_4320_volume_sats,
            s.last_trade_block_height,
            s.last_trade_block_timestamp
          FROM tracked_tokens t
          LEFT JOIN token_stats s
            ON s.token_id = t.token_id
          WHERE t.token_id = ?
        `,
      )
      .get(tokenId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return {
      summary: toTokenSummary(row),
      firstDiscoveredAt: Number(row.first_discovered_at),
      lastDiscoveredAt: Number(row.last_discovered_at),
      initStatus: String(row.init_status ?? "PENDING"),
    };
  }

  listTokenTrades(
    tokenId: string,
    query: TradeListQuery,
  ): PaginatedResult<TradeHistoryItem> {
    return this.queryTrades({ ...query, tokenId });
  }

  listTrades(query: TradeListQuery): PaginatedResult<TradeHistoryItem> {
    return this.queryTrades(query);
  }

  private async bootstrap(): Promise<void> {
    this.phase = "discovering";
    const seeds = await this.discoverTokens("bootstrap");
    const plan = this.buildBootstrapPlan(seeds);
    this.bootstrapTokenCount = plan.blockingSeeds.length;
    if (plan.skippedTradeThresholdSeeds.length > 0) {
      this.logger.info(
        `skipping bootstrap tokens by trade-count threshold count=${plan.skippedTradeThresholdSeeds.length} threshold_lte=${this.deferKnownTradeCountLte}`,
      );
    }
    this.phase = "subscribing";
    this.applyDiscoverySeeds(seeds, {
      bootstrapTokenIds: new Set(plan.blockingSeeds.map((seed) => seed.tokenId)),
      enqueueTokenIds: new Set(plan.blockingSeeds.map((seed) => seed.tokenId)),
    });
    if (this.ws) {
      this.subscribeTrackedTokens(seeds.map((seed) => seed.tokenId));
    }
    this.phase = "initializing";
    await this.waitForBootstrapReady();
  }

  private startBackgroundLoops(): void {
    this.discoveryTimer = setInterval(() => {
      void this.refreshDiscovery().catch((error) => {
        this.setError(`discovery loop failed: ${this.formatError(error)}`);
      });
    }, this.config.discoveryIntervalMs);

    this.tipRefreshTimer = setInterval(() => {
      void this.refreshTipHeight().catch((error) => {
        this.setError(`tip refresh failed: ${this.formatError(error)}`);
      });
    }, this.config.tipRefreshIntervalMs);

    this.pollingTailTimer = setInterval(() => {
      if (this.wsConnected) {
        return;
      }

      for (const state of this.tokenStates.values()) {
        if (state.active && state.ready) {
          state.dirty = true;
          this.enqueueToken(state.tokenId);
        }
      }
    }, this.config.pollIntervalMs);
  }

  private async startWs(): Promise<void> {
    this.wsConnected = false;
    this.ws = this.deps.chronik.ws({
      autoReconnect: true,
      onConnect: () => {
        this.wsConnected = true;
        if (this.ready) {
          this.phase = "ready";
        }
        this.logger.info("ws connected");
      },
      onReconnect: () => {
        this.wsConnected = false;
        if (this.ready) {
          this.phase = "degraded";
        }
        this.logger.warn("ws reconnecting");
      },
      onEnd: () => {
        this.wsConnected = false;
        if (this.ready) {
          this.phase = "degraded";
        }
        this.logger.warn("ws ended");
      },
      onError: () => {
        this.wsConnected = false;
        if (this.ready) {
          this.phase = "degraded";
        }
      },
      onMessage: (msg) => {
        void this.handleWsMessage(msg).catch((error) => {
          this.setError(`ws message handling failed: ${this.formatError(error)}`);
        });
      },
    });
    this.ws.subscribeToBlocks();

    try {
      await withTimeout(
        this.ws.waitForOpen(),
        this.config.wsConnectTimeoutMs,
        "Chronik websocket connection",
      );
      this.wsConnected = true;
    } catch (error) {
      this.ws.close();
      this.ws = null;
      this.wsConnected = false;
      this.logger.warn(
        `ws unavailable, falling back to polling: ${this.formatError(error)}`,
      );
    }
  }

  private async handleWsMessage(msg: WsMsgClient): Promise<void> {
    if (msg.type === "Block") {
      await this.refreshTipHeight();
      return;
    }

    if (msg.type !== "Tx") {
      return;
    }

    const tx = await retryAsync(
      () =>
        withTimeout(
          this.deps.chronik.tx(msg.txid),
          this.config.requestTimeoutMs,
          `Chronik tx lookup ${msg.txid}`,
        ),
      this.config.requestRetryCount,
      `Chronik tx lookup ${msg.txid}`,
    );

    for (const tokenId of this.ops.extractAgoraTokenIdsFromTx(tx)) {
      const state = this.tokenStates.get(tokenId);
      if (!state || !state.active) {
        continue;
      }

      state.dirty = true;
      this.db.markTokenWsEvent(tokenId, Date.now());
      this.enqueueToken(tokenId);
    }
  }

  private async refreshDiscovery(): Promise<void> {
    const seeds = await this.discoverTokens("background");
    this.applyDiscoverySeeds(seeds);
  }

  private async discoverTokens(reason: "bootstrap" | "background"): Promise<ActiveTokenSeed[]> {
    const progress: SyncProgressHandlers = {
      onDiscoveryPage: (entry) => {
        this.discoveryPageCount = Math.max(this.discoveryPageCount, entry.page + 1);
        this.logger.info(
          `${reason} discovery page=${entry.page + 1} fetched=${entry.fetchedGroupCount} fungible=${entry.fungibleGroupCount} next=${entry.nextStart || "end"}`,
        );
      },
    };
    const seeds = await this.ops.discoverActiveTokens(this.deps, this.config, progress);
    this.lastDiscoveryAtMs = Date.now();
    return seeds;
  }

  private applyDiscoverySeeds(seeds: ActiveTokenSeed[], options: ApplyDiscoveryOptions = {}): void {
    const bootstrapTokenIds = options.bootstrapTokenIds ?? new Set<string>();
    const enqueueTokenIds = options.enqueueTokenIds;
    const activeIds = new Set(seeds.map((seed) => seed.tokenId));
    this.db.markAllTrackedTokensInactive();
    for (const seed of seeds) {
      this.db.upsertTrackedToken(seed);
    }

    if (options.bootstrapTokenIds) {
      this.db.setBootstrapCohort([...bootstrapTokenIds]);
    }

    for (const state of this.tokenStates.values()) {
      state.active = activeIds.has(state.tokenId);
      state.bootstrapCohort = bootstrapTokenIds.has(state.tokenId);
    }

    for (const seed of seeds) {
      const state = this.ensureTokenState(seed.tokenId);
      const tracked = this.db.getTrackedToken(seed.tokenId);
      state.active = true;
      state.bootstrapCohort = bootstrapTokenIds.has(seed.tokenId);
      if (!state.bootstrapCohort && tracked?.isReady) {
        state.ready = true;
      }
      const shouldEnqueue =
        enqueueTokenIds === undefined ? !state.ready : enqueueTokenIds.has(seed.tokenId);
      if (shouldEnqueue && !state.ready) {
        this.db.markTokenInitPending(seed.tokenId, Date.now());
        this.enqueueToken(seed.tokenId);
      }
    }

    if (this.ws) {
      this.subscribeTrackedTokens(seeds.map((seed) => seed.tokenId));
    }
  }

  private subscribeTrackedTokens(tokenIds: string[]): void {
    if (!this.ws) {
      return;
    }

    for (const tokenId of tokenIds) {
      if (this.subscribedTokenIds.has(tokenId)) {
        continue;
      }

      this.deps.agora.subscribeWs(this.ws, {
        type: "TOKEN_ID",
        tokenId,
      });
      this.subscribedTokenIds.add(tokenId);
    }
  }

  private buildBootstrapPlan(seeds: ActiveTokenSeed[]): BootstrapPlan {
    if (this.deferKnownTradeCountLte === null) {
      return {
        blockingSeeds: seeds,
        skippedTradeThresholdSeeds: [],
      };
    }

    const blockingSeeds: ActiveTokenSeed[] = [];
    const skippedTradeThresholdSeeds: ActiveTokenSeed[] = [];

    for (const seed of seeds) {
      if (this.shouldDeferBootstrap(seed.tokenId)) {
        skippedTradeThresholdSeeds.push(seed);
        continue;
      }
      blockingSeeds.push(seed);
    }

    return {
      blockingSeeds,
      skippedTradeThresholdSeeds,
    };
  }

  private shouldDeferBootstrap(tokenId: string): boolean {
    const tracked = this.db.getTrackedToken(tokenId);
    if (!tracked || !tracked.isReady) {
      return false;
    }

    const aggregate = this.db.getTokenAggregateStats(tokenId);
    return (aggregate?.tradeCount ?? 0) <= (this.deferKnownTradeCountLte as number);
  }

  private ensureTokenState(tokenId: string): TokenRuntimeState {
    let state = this.tokenStates.get(tokenId);
    if (!state) {
      state = {
        tokenId,
        active: true,
        ready: false,
        bootstrapCohort: false,
        dirty: false,
        processing: false,
        phase: "pending",
        lastError: null,
      };
      this.tokenStates.set(tokenId, state);
    }
    return state;
  }

  private enqueueToken(tokenId: string): void {
    const state = this.ensureTokenState(tokenId);
    if (state.processing || this.queuedTokenIds.has(tokenId)) {
      return;
    }

    this.pendingQueue.push(tokenId);
    this.queuedTokenIds.add(tokenId);
    this.pumpQueue();
  }

  private pumpQueue(): void {
    while (
      this.workerCount < this.config.bootstrapConcurrency &&
      this.pendingQueue.length > 0
    ) {
      const tokenId = this.pendingQueue.shift() as string;
      this.queuedTokenIds.delete(tokenId);
      this.workerCount += 1;
      void this.processToken(tokenId).finally(() => {
        this.workerCount -= 1;
        this.resolveBootstrapWaiters();
        this.pumpQueue();
      });
    }
  }

  private async processToken(tokenId: string): Promise<void> {
    const state = this.ensureTokenState(tokenId);
    state.processing = true;
    state.lastError = null;

    try {
      if (!state.ready) {
        state.phase = "initializing";
        this.db.markTokenInitStarted(tokenId, Date.now());
        await this.runTokenSync(tokenId, "full");
      }

      while (state.dirty) {
        state.dirty = false;
        state.phase = "catching-up";
        await this.runTokenSync(tokenId, "tail");
      }

      if (!state.ready) {
        state.ready = true;
      }

      state.phase = "ready";
      this.db.markTokenInitCompleted(tokenId, Date.now());
      this.db.markTokenReady(tokenId, true, Date.now());
    } catch (error) {
      state.phase = "error";
      state.lastError = this.formatError(error);
      this.db.markTokenInitFailed(tokenId, Date.now(), state.lastError);
      this.setError(`token ${tokenId} sync failed: ${state.lastError}`);
      if (!this.ready && state.bootstrapCohort) {
        this.rejectBootstrapWaiters(
          new Error(`Bootstrap failed for ${tokenId}: ${state.lastError}`),
        );
      }
    } finally {
      state.processing = false;
      if (state.dirty && !this.queuedTokenIds.has(tokenId)) {
        this.enqueueToken(tokenId);
      }
    }
  }

  private async runTokenSync(
    tokenId: string,
    mode: "full" | "tail",
  ): Promise<void> {
    const progress: SyncProgressHandlers = {
      onTokenSyncPage: (entry) => {
        this.logger.info(
          `${mode} token=${entry.tokenId} page=${entry.page + 1}/${Math.max(entry.numPages, 1)} scanned=${entry.scannedTradeCount} inserted=${entry.insertedTradeCount}`,
        );
      },
    };
    await this.ops.syncTokenHistory(
      this.db,
      this.deps,
      this.config,
      tokenId,
      mode,
      progress,
    );
    if (this.tipHeight !== null) {
      this.db.recomputeTokenAggregateStats(tokenId, this.tipHeight);
    }
  }

  private async refreshTipHeight(): Promise<void> {
    const info = await retryAsync(
      () =>
        withTimeout(
          this.deps.chronik.blockchainInfo(),
          this.config.requestTimeoutMs,
          "Chronik blockchainInfo",
        ),
      this.config.requestRetryCount,
      "Chronik blockchainInfo",
    );
    const changed = this.tipHeight !== info.tipHeight;
    this.tipHeight = info.tipHeight;
    this.lastTipUpdateAtMs = Date.now();
    if (changed) {
      this.db.recomputeAllTokenAggregateStats(info.tipHeight);
    }
  }

  private async runBootstrapTailSweepWithoutWs(): Promise<void> {
    const tokenIds = [...this.tokenStates.values()]
      .filter((state) => state.bootstrapCohort && state.active)
      .map((state) => state.tokenId);
    if (tokenIds.length === 0) {
      return;
    }

    let baselineTipHeight = this.tipHeight;
    for (let pass = 0; pass < 3; pass += 1) {
      await this.refreshTipHeight();
      if (this.tipHeight === null) {
        return;
      }
      if (baselineTipHeight !== null && this.tipHeight <= baselineTipHeight) {
        return;
      }

      this.logger.info(
        `polling bootstrap catch-up pass=${pass + 1} tip=${this.tipHeight} tokens=${tokenIds.length}`,
      );
      for (const tokenId of tokenIds) {
        const state = this.ensureTokenState(tokenId);
        state.phase = "catching-up";
        await this.runTokenSync(tokenId, "tail");
      }
      baselineTipHeight = this.tipHeight;
    }
  }

  private queryTrades(query: TradeListQuery): PaginatedResult<TradeHistoryItem> {
    const { page, pageSize, offset } = normalizePagination(
      query.page,
      query.pageSize,
      this.config,
    );
    const totalRow = query.tokenId
      ? (this.db.sqlite
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM processed_trades
              WHERE token_id = ?
            `,
          )
          .get(query.tokenId) as { count: number })
      : (this.db.sqlite
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM processed_trades
            `,
          )
          .get() as { count: number });

    const rows = this.db.listTradeHistory({
      tokenId: query.tokenId,
      limit: pageSize,
      offset,
      order: "desc",
    }) as unknown as Record<string, unknown>[];

    return {
      page,
      pageSize,
      total: totalRow.count,
      items: rows.map(toTradeHistoryItem),
    };
  }

  private waitForBootstrapReady(): Promise<void> {
    if (this.bootstrapTokenCount === 0) {
      return Promise.resolve();
    }
    if (this.bootstrapError) {
      return Promise.reject(this.bootstrapError);
    }
    if (this.db.countReadyBootstrapTokens() >= this.bootstrapTokenCount) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.bootstrapResolvers.add(resolve);
      this.bootstrapRejectors.add(reject);
      this.resolveBootstrapWaiters();
    });
  }

  private resolveBootstrapWaiters(): void {
    if (this.bootstrapError) {
      this.rejectBootstrapWaiters(this.bootstrapError);
      return;
    }
    if (this.db.countReadyBootstrapTokens() < this.bootstrapTokenCount) {
      return;
    }

    for (const resolve of this.bootstrapResolvers) {
      resolve();
    }
    this.bootstrapResolvers.clear();
    this.bootstrapRejectors.clear();
  }

  private rejectBootstrapWaiters(error: Error): void {
    this.bootstrapError = error;
    for (const reject of this.bootstrapRejectors) {
      reject(error);
    }
    this.bootstrapRejectors.clear();
    this.bootstrapResolvers.clear();
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private setError(message: string): void {
    this.lastError = message;
    this.logger.error(message);
    if (this.ready) {
      this.phase = this.wsConnected ? "ready" : "degraded";
      return;
    }

    this.phase = "error";
  }
}
