import type { WsEndpoint, WsMsgClient } from "chronik-client";

import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db.js";
import { retryAsync, withTimeout } from "./async.js";
import { DirtyTokenQueue } from "./dirtyTokenQueue.js";
import {
  discoverActiveTokens,
  extractAgoraTokenIdsFromTx,
  syncTokenHistory,
  type SyncDependencies,
} from "./agoraSync.js";

export interface LiveStartResult {
  discoveredCount: number;
  newlySubscribedTokenIds: string[];
}

export class AgoraLiveSyncService {
  private readonly queue = new DirtyTokenQueue();
  private readonly subscribedTokenIds = new Set<string>();
  private ws: WsEndpoint | null = null;
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
  }

  markDirty(tokenId: string): void {
    this.db.markTokenWsEvent(tokenId, Date.now());
    this.queue.markDirty(tokenId);
  }

  async refreshTrackedTokens(): Promise<LiveStartResult> {
    const seeds = await discoverActiveTokens(this.deps, this.config);
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

    const newlySubscribed: string[] = [];
    for (const tokenId of this.db.listTrackedTokenIds()) {
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
    if (msg.type !== "Tx") {
      return;
    }

    const label = `Chronik tx lookup ${msg.txid}`;
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
    const tokenIds = extractAgoraTokenIdsFromTx(tx);
    for (const tokenId of tokenIds) {
      if (!this.subscribedTokenIds.has(tokenId)) {
        continue;
      }

      this.markDirty(tokenId);
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
