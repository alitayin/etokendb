import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import {
  createSyncDependencies,
  discoverActiveTokens,
  type SyncProgressHandlers,
  syncActiveTokens,
  syncTrackedTokens,
  syncTokenHistory,
} from "../lib/agoraSync.js";
import { AgoraLiveSyncService } from "../lib/liveSync.js";

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  tsx src/cli/agoraSync.ts discover-active",
      "  tsx src/cli/agoraSync.ts backfill-token <tokenId>",
      "  tsx src/cli/agoraSync.ts sync-active-once",
      "  tsx src/cli/agoraSync.ts tail-active",
    ].join("\n"),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasProxyConfig(): boolean {
  return Boolean(
    process.env.http_proxy ||
      process.env.HTTP_PROXY ||
      process.env.https_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.all_proxy ||
      process.env.ALL_PROXY,
  );
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortTokenId(tokenId: string): string {
  if (tokenId.length <= 16) {
    return tokenId;
  }

  return `${tokenId.slice(0, 8)}...${tokenId.slice(-8)}`;
}

function createProgressLogger(prefix: string): SyncProgressHandlers {
  return {
    onDiscoveryPage: (progress) => {
      console.log(
        `${prefix} | discover page=${progress.page + 1} start=${progress.startHex || "beginning"} fetched=${progress.fetchedGroupCount} fungible=${progress.fungibleGroupCount} next=${progress.nextStart || "end"}`,
      );
    },
    onTokenSyncStart: (tokenId, index, total) => {
      console.log(
        `${prefix} | sync token ${index + 1}/${total} ${shortTokenId(tokenId)}`,
      );
    },
    onTokenSyncPage: (progress) => {
      console.log(
        `${prefix} | token ${shortTokenId(progress.tokenId)} page=${progress.page + 1}/${Math.max(progress.numPages, 1)} scanned=${progress.scannedTradeCount} inserted=${progress.insertedTradeCount}`,
      );
    },
    onTokenSyncComplete: (result, index, total) => {
      console.log(
        `${prefix} | done token ${index + 1}/${total} ${shortTokenId(result.tokenId)} pages=${result.pageCount} scanned=${result.scannedTradeCount} inserted=${result.insertedTradeCount}`,
      );
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.sqlitePath);
  const deps = createSyncDependencies(config);
  const [command, arg] = process.argv.slice(2);

  try {
    switch (command) {
      case "discover-active": {
        const seeds = await discoverActiveTokens(
          deps,
          config,
          createProgressLogger("discover-active"),
        );
        db.markAllTrackedTokensInactive();
        for (const seed of seeds) {
          db.upsertTrackedToken(seed);
        }

        console.log(
          JSON.stringify(
            {
              chronikUrl: config.chronikUrl,
              sqlitePath: config.sqlitePath,
              discoveredCount: seeds.length,
              sampleTokenIds: seeds.slice(0, 10).map((seed) => seed.tokenId),
            },
            null,
            2,
          ),
        );
        return;
      }
      case "backfill-token": {
        if (!arg) {
          usage();
        }

        const result = await syncTokenHistory(db, deps, config, arg, "full");
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case "sync-active-once": {
        const result = await syncActiveTokens(
          db,
          deps,
          config,
          "full",
          createProgressLogger("sync-active-once"),
        );
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case "tail-active": {
        console.log(
          [
            "tail-active starting",
            `chronik=${config.chronikUrl}`,
            `sqlite=${config.sqlitePath}`,
            `proxy=${hasProxyConfig() ? "yes" : "no"}`,
          ].join(" | "),
        );

        const live = new AgoraLiveSyncService(db, deps, config);
        const bootstrapProgress = createProgressLogger("bootstrap-tail");
        const pollingProgress = createProgressLogger("polling-tail");
        try {
          const startResult = await live.start((phase, details) => {
            switch (phase) {
              case "connecting-ws":
                console.log("tail-active | connecting websocket");
                return;
              case "ws-open":
                console.log("tail-active | websocket connected");
                return;
              case "refreshing-tracked-tokens":
                console.log("tail-active | discovering active fungible tokens");
                return;
              case "tracking-ready":
                console.log(
                  `tail-active | tracking ready | discovered=${details?.discoveredCount ?? 0} | subscribed=${details?.newlySubscribedCount ?? 0}`,
                );
                return;
              default:
                return;
            }
          });

          const bootstrapResults = await syncTrackedTokens(
            db,
            deps,
            config,
            db.listTrackedTokenIds(),
            "tail",
            bootstrapProgress,
          );
          console.log(
            JSON.stringify(
              {
                mode: "bootstrap-tail",
                discovered: startResult.discoveredCount,
                subscribed: startResult.newlySubscribedTokenIds.length,
                synced: bootstrapResults,
              },
              null,
              2,
            ),
          );

          await live.flushDirtyTokens();

          for (;;) {
            await sleep(config.pollIntervalMs);
          }
        } catch (error) {
          live.stop();
          console.error(
            `WebSocket unavailable; falling back to polling tail sync: ${formatErrorMessage(error)}`,
          );

          for (;;) {
            console.log("polling-tail | cycle start");
            const result = await syncActiveTokens(
              db,
              deps,
              config,
              "tail",
              pollingProgress,
            );
            console.log(
              JSON.stringify(
                {
                  mode: "polling-tail",
                  cycleFinishedAt: new Date().toISOString(),
                  ...result,
                },
                null,
                2,
              ),
            );
            await sleep(config.pollIntervalMs);
          }
        }
      }
      default:
        usage();
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
