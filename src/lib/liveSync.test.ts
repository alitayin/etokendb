import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "./db.js";
import type { AppConfig } from "./config.js";
import { AgoraLiveSyncService } from "./liveSync.js";
import type { SyncDependencies } from "./agoraSync.js";

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
  bootstrapConcurrency: 2,
  apiPageSizeDefault: 50,
  apiPageSizeMax: 200,
  requestTimeoutMs: 5_000,
  requestRetryCount: 2,
  wsConnectTimeoutMs: 5_000,
};

function makeTakenOffer(tokenId: string): unknown {
  return {
    outpoint: {
      txid: "offer-1",
      outIdx: 2,
    },
    status: "TAKEN",
    variant: {
      type: "PARTIAL",
    },
    token: {
      tokenId,
      atoms: 1_000n,
    },
    takenInfo: {
      sats: 100n,
      atoms: 10n,
      takerScriptHex: "76a914cafebabecafebabecafebabecafebabecafebabe88ac",
    },
  };
}

function makeRawSpendTx(tokenId: string): unknown {
  return {
    txid: "spend-1",
    block: {
      height: 101,
      hash: "block-101",
      timestamp: 1001,
    },
    inputs: [
      {
        prevOut: {
          txid: "offer-1",
          outIdx: 2,
        },
        plugins: {
          agora: {
            groups: [`54${tokenId}`],
          },
        },
      },
    ],
    outputs: [],
  };
}

test("live sync only marks subscribed fungible token ids dirty", async () => {
  const tokenId = "fungible-token";
  const subscribed: string[] = [];
  const db = openDatabase(":memory:");

  const deps: SyncDependencies = {
    chronik: {
      plugin: () =>
        ({
          groups: async () => ({
            groups: [{ group: `46${tokenId}` }],
            nextStart: "",
          }),
          history: async (groupHex: string) => {
            assert.equal(groupHex, `54${tokenId}`);
            return {
              txs: [makeRawSpendTx(tokenId)] as never[],
              numTxs: 1,
              numPages: 1,
            };
          },
        }) as never,
      tx: async () =>
        ({
          txid: "spend-1",
          inputs: [
            {
              prevOut: { txid: "offer-1", outIdx: 2 },
              plugins: {
                agora: {
                  groups: [`54${tokenId}`, "47nft-token"],
                },
              },
            },
          ],
          outputs: [],
        }) as never,
      ws: () =>
        ({
          waitForOpen: async () => {},
          close: () => {},
        }) as never,
      blockchainInfo: async () => ({
        tipHash: "tip",
        tipHeight: 101,
      }),
    },
    agora: {
      offeredFungibleTokenIds: async () => [tokenId],
      historicOffers: async (params) => {
        assert.equal(params.type, "TOKEN_ID");
        assert.equal(params.tokenId, tokenId);
        return {
          offers: [makeTakenOffer(tokenId)] as never[],
          numTxs: 1,
          numPages: 1,
        };
      },
      subscribeWs: (_ws, params) => {
        if (params.type === "TOKEN_ID") {
          subscribed.push(params.tokenId);
        }
      },
      unsubscribeWs: () => {},
    },
  };

  const live = new AgoraLiveSyncService(db, deps, BASE_CONFIG);

  try {
    const started = await live.start();
    assert.equal(started.discoveredCount, 1);
    assert.deepEqual(started.newlySubscribedTokenIds, [tokenId]);
    assert.deepEqual(subscribed, [tokenId]);

    await live.handleWsMessage({
      type: "Tx",
      txid: "spend-1",
    } as never);

    await live.flushDirtyTokens();

    assert.deepEqual(db.getTokenStats(tokenId), {
      tokenId,
      tradeCount: 1,
      cumulativePaidSats: "100",
      lastTradeOfferTxid: "offer-1",
      lastTradeOfferOutIdx: 2,
      lastTradeBlockHeight: 101,
      lastTradeBlockTimestamp: 1001,
      lastTradePriceNanosatsPerAtom: "10000000000",
    });
  } finally {
    live.stop();
    db.close();
  }
});
