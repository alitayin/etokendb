import type { WsEndpoint, WsMsgClient } from "chronik-client";

import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db.js";
import { retryAsync, withTimeout } from "./async.js";
import { DirtyTokenQueue } from "./dirtyTokenQueue.js";
import {
  AGORA_LOKAD_ID_HEX,
  GROUP_PREFIX_ACTIVE_FUNGIBLE,
  discoverActiveTokens,
  extractAgoraFungibleTokenIdsFromTx,
  extractAgoraTokenIdsFromTx,
  syncTokenHistory,
  type SyncDependencies,
} from "./agoraSync.js";

export interface LiveStartResult {
  discoveredCount: number;
  newlySubscribedTokenIds: string[];
}

const WS_TX_DEDUP_TTL_MS = 5 * 60 * 1000;

export class AgoraLiveSyncService {
  private readonly queue = new DirtyTokenQueue();
  private readonly subscribedTokenIds = new Set<string>();
  private readonly recentWsTxids = new Map<string, number>();
  private readonly wsDiscoveredDuringRefresh = new Set<string>();
  private ws: WsEndpoint | null = null;
  private refreshPromise: Promise<LiveStartResult> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private flushInProgress = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly deps: SyncDependencies,
    private readonly config: AppConfig,
  ) {}

  async start(
    onStatus?: (phase: string, details?: Record<string, unknown>) => void,
  ): Promise<LiveStartResult> {
    onStatus?.("connecting-ws");
    this.ws = this.deps.chronik.ws({
      autoReconnect: true,
      onMessage: (msg) => {
        void this.handleWsMessage(msg).catch((error) => {
          this.reportError("handling websocket message", error);
        });
      },
    });
    this.ws.subscribeToLokadId?.(AGORA_LOKAD_ID_HEX);
    await withTimeout(
      this.ws.waitForOpen(),
      this.config.wsConnectTimeoutMs,
      "Chronik websocket connection",
    );

    onStatus?.("ws-open");
    onStatus?.("refreshing-tracked-tokens");
    const refreshResult = await withTimeout(
      this.refreshTrackedTokens(),
      this.config.requestTimeoutMs,
      "Tracked token refresh",
    );

    this.flushTimer = setInterval(() => {
      void this.flushDirtyTokens().catch((error) => {
        this.reportError("flushing dirty tokens", error);
      });
    }, this.config.pollIntervalMs);

    this.discoveryTimer = setInterval(() => {
      void this.refreshTrackedTokens().catch((error) => {
        this.reportError("refreshing tracked tokens", error);
      });
    }, this.config.discoveryIntervalMs);

    onStatus?.("tracking-ready", {
      discoveredCount: refreshResult.discoveredCount,
      newlySubscribedCount: refreshResult.newlySubscribedTokenIds.length,
    });

    return refreshResult;
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.recentWsTxids.clear();
  }

  markDirty(tokenId: string): void {
    this.db.markTokenWsEvent(tokenId, Date.now());
    this.queue.markDirty(tokenId);
  }

  async refreshTrackedTokens(): Promise<LiveStartResult> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.runTrackedTokenRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async runTrackedTokenRefresh(): Promise<LiveStartResult> {
    const seeds = await discoverActiveTokens(this.deps, this.config);
    const discoveredTokenIds = new Set(seeds.map((seed) => seed.tokenId));
    for (const tokenId of this.wsDiscoveredDuringRefresh) {
      if (discoveredTokenIds.has(tokenId)) {
        continue;
      }
      seeds.push({
        tokenId,
        groupHex: `${GROUP_PREFIX_ACTIVE_FUNGIBLE}${tokenId}`,
        groupPrefixHex: GROUP_PREFIX_ACTIVE_FUNGIBLE,
        kind: "FUNGIBLE",
      });
    }
    this.wsDiscoveredDuringRefresh.clear();
    this.db.markAllTrackedTokensInactive();
    for (const seed of seeds) {
      this.db.upsertTrackedToken(seed);
    }

    if (!this.ws) {
      return {
        discoveredCount: seeds.length,
        newlySubscribedTokenIds: [],
      };
    }

    const activeTokenIds = new Set(seeds.map((seed) => seed.tokenId));
    for (const tokenId of this.subscribedTokenIds) {
      if (activeTokenIds.has(tokenId)) {
        continue;
      }

      this.deps.agora.unsubscribeWs(this.ws, {
        type: "TOKEN_ID",
        tokenId,
      });
      this.subscribedTokenIds.delete(tokenId);
    }

    const newlySubscribed: string[] = [];
    for (const tokenId of activeTokenIds) {
      if (this.subscribedTokenIds.has(tokenId)) {
        continue;
      }

      this.deps.agora.subscribeWs(this.ws, {
        type: "TOKEN_ID",
        tokenId,
      });
      this.subscribedTokenIds.add(tokenId);
      newlySubscribed.push(tokenId);
    }

    return {
      discoveredCount: seeds.length,
      newlySubscribedTokenIds: newlySubscribed,
    };
  }

  async handleWsMessage(msg: WsMsgClient): Promise<void> {
    if (msg.type !== "Tx" || msg.msgType !== "TX_CONFIRMED") {
      return;
    }

    const nowMs = Date.now();
    const lastHandledAt = this.recentWsTxids.get(msg.txid);
    if (
      lastHandledAt !== undefined &&
      nowMs - lastHandledAt < WS_TX_DEDUP_TTL_MS
    ) {
      return;
    }
    this.recentWsTxids.set(msg.txid, nowMs);

    const label = `Chronik tx lookup ${msg.txid}`;
    try {
      const tx = await retryAsync(
        () =>
          withTimeout(
            this.deps.chronik.tx(msg.txid),
            this.config.requestTimeoutMs,
            label,
          ),
        this.config.requestRetryCount,
        label,
      );

      for (const tokenId of extractAgoraFungibleTokenIdsFromTx(tx)) {
        if (this.subscribedTokenIds.has(tokenId)) {
          continue;
        }

        this.db.upsertTrackedToken({
          tokenId,
          groupHex: `${GROUP_PREFIX_ACTIVE_FUNGIBLE}${tokenId}`,
          groupPrefixHex: GROUP_PREFIX_ACTIVE_FUNGIBLE,
          kind: "FUNGIBLE",
        });
        if (this.refreshPromise) {
          this.wsDiscoveredDuringRefresh.add(tokenId);
        }
        if (this.ws) {
          this.deps.agora.subscribeWs(this.ws, {
            type: "TOKEN_ID",
            tokenId,
          });
          this.subscribedTokenIds.add(tokenId);
        }
      }

      for (const tokenId of extractAgoraTokenIdsFromTx(tx)) {
        if (this.subscribedTokenIds.has(tokenId)) {
          this.markDirty(tokenId);
        }
      }
    } catch (error) {
      this.recentWsTxids.delete(msg.txid);
      throw error;
    } finally {
      for (const [txid, handledAt] of this.recentWsTxids) {
        if (nowMs - handledAt < WS_TX_DEDUP_TTL_MS) {
          break;
        }
        this.recentWsTxids.delete(txid);
      }
    }
  }

  async flushDirtyTokens(batchSize = 1): Promise<void> {
    if (this.flushInProgress) {
      return;
    }

    this.flushInProgress = true;
    try {
      while (this.queue.hasPending()) {
        const batch = this.queue.takeNext(batchSize);
        for (const tokenId of batch) {
          try {
            await syncTokenHistory(
              this.db,
              this.deps,
              this.config,
              tokenId,
              "tail",
            );
          } finally {
            this.queue.markCompleted(tokenId);
          }
        }
      }
    } finally {
      this.flushInProgress = false;
    }
  }

  private reportError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Live sync error while ${context}: ${message}`);
  }
}
