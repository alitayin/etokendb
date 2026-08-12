import assert from "node:assert/strict";
import test from "node:test";

import { encodeOutputScript, getOutputScriptFromAddress } from "ecashaddrjs";

import { openDatabase } from "../lib/db.js";
import type { AppConfig } from "../lib/config.js";
import {
  REVIEW_STAR_CRYSTAL_TOKEN_ID,
  REVIEW_STAR_SHARD_TOKEN_ID,
  ReviewError,
} from "../lib/reviews.js";
import { AgoraTokenService } from "./service.js";

function makeProcessedTrade(params: {
  tokenId: string;
  offerTxid: string;
  outIdx: number;
  spendTxid: string;
  paidSats: string;
  blockHeight: number;
  blockTimestamp: number;
}) {
  return {
    tokenId: params.tokenId,
    offerTxid: params.offerTxid,
    offerOutIdx: params.outIdx,
    spendTxid: params.spendTxid,
    variantType: "PARTIAL" as const,
    paidSats: params.paidSats,
    soldAtoms: "1",
    priceNanosatsPerAtom: params.paidSats,
    takerScriptHex: null,
    blockHeight: params.blockHeight,
    blockHash: `block-${params.blockHeight}`,
    blockTimestamp: params.blockTimestamp,
    rawTradeJson: "{}",
  };
}

function requireResolver(value: (() => void) | null): () => void {
  if (value === null) {
    throw new Error("resolver was not assigned");
  }
  return value;
}

const BASE_CONFIG: AppConfig = {
  chronikUrl: "https://example.invalid",
  sqlitePath: ":memory:",
  serverPort: 8787,
  serverHost: "127.0.0.1",
  activeGroupPageSize: 50,
  historyPageSize: 50,
  tailPageCount: 2,
  pollIntervalMs: 60_000,
  discoveryIntervalMs: 60_000,
  tipRefreshIntervalMs: 60_000,
  bootstrapConcurrency: 1,
  apiPageSizeDefault: 50,
  apiPageSizeMax: 200,
  analyticsHourlyRetentionHours: 90 * 24,
  reviewPaymentAddress: null,
  reviewBaseFeeSats: 10_000_000,
  reviewInvoiceTtlMs: 30 * 60 * 1000,
  reviewRetryIntervalMs: 60 * 1000,
  projectInfoPaymentAddress: null,
  requestTimeoutMs: 5_000,
  requestRetryCount: 2,
  wsConnectTimeoutMs: 5_000,
  readinessMaxTipAgeMs: 5 * 60_000,
  blockCatchUpBatchSize: 100,
};

const REVIEW_AUTHOR_ADDRESS =
  "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwva87rkuu2";
const REVIEW_PAYMENT_ADDRESS = REVIEW_AUTHOR_ADDRESS;
const OTHER_REVIEW_ADDRESS = encodeOutputScript(
  `76a914${"11".repeat(20)}88ac`,
);
const REVIEW_TOKEN_ID = "d".repeat(64);
const PROJECT_TOKEN_ID = "e".repeat(64);
const PROJECT_INFO_TEST_TOKEN_ID =
  "5cb20c6cdeaee3abf53f7dcaaa1092ad10a0e2e9dcd94ee07272b631e65d7371";
const PROJECT_AUTH_PUBKEY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROJECT_EDITOR_ADDRESS =
  "ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq";

function makeTx(params: {
  txid: string;
  authorAddress?: string;
  paymentAddress?: string;
  paidSats?: bigint;
  timeFirstSeen?: number;
  blockHeight?: number;
  blockTimestamp?: number;
}) {
  return {
    txid: params.txid,
    version: 2,
    inputs: [
      {
        prevOut: { txid: "0".repeat(64), outIdx: 0 },
        inputScript: "",
        outputScript: getOutputScriptFromAddress(
          params.authorAddress ?? REVIEW_AUTHOR_ADDRESS,
        ),
        sats: 100_000_000n,
        sequenceNo: 0,
      },
    ],
    outputs: [
      {
        outputScript: getOutputScriptFromAddress(
          params.paymentAddress ?? REVIEW_PAYMENT_ADDRESS,
        ),
        sats: params.paidSats ?? 1_023n,
      },
    ],
    lockTime: 0,
    block:
      params.blockHeight === undefined
        ? undefined
        : {
            height: params.blockHeight,
            hash: "block-hash",
            timestamp: params.blockTimestamp ?? 0,
          },
    timeFirstSeen: params.timeFirstSeen ?? 0,
    size: 100,
    isCoinbase: false,
    tokenEntries: [],
    tokenFailedParsings: [],
    tokenStatus: "TOKEN_STATUS_NORMAL",
    isFinal: true,
  } as never;
}

function makeTokenTx(params: {
  txid: string;
  tokenId: string;
  authorAddress?: string;
  paymentAddress?: string;
  inputTokenId?: string;
  outputTokenId?: string;
  inputAtoms?: bigint;
  paidAtoms?: bigint;
  timeFirstSeen?: number;
  blockHeight?: number;
  blockTimestamp?: number;
  mintBatonOutput?: boolean;
}) {
  const tokenType = {
    protocol: "SLP",
    type: "SLP_TOKEN_TYPE_FUNGIBLE",
    number: 1,
  };
  return {
    txid: params.txid,
    version: 2,
    inputs: [
      {
        prevOut: { txid: "1".repeat(64), outIdx: 0 },
        inputScript: "",
        outputScript: getOutputScriptFromAddress(
          params.authorAddress ?? REVIEW_AUTHOR_ADDRESS,
        ),
        sats: 546n,
        sequenceNo: 0,
        token: {
          tokenId: params.inputTokenId ?? params.tokenId,
          tokenType,
          atoms: params.inputAtoms ?? 100n,
          isMintBaton: false,
        },
      },
    ],
    outputs: [
      {
        outputScript: getOutputScriptFromAddress(
          params.paymentAddress ?? REVIEW_PAYMENT_ADDRESS,
        ),
        sats: 546n,
        token: {
          tokenId: params.outputTokenId ?? params.tokenId,
          tokenType,
          atoms: params.paidAtoms ?? 100n,
          isMintBaton: params.mintBatonOutput ?? false,
        },
      },
    ],
    lockTime: 0,
    block:
      params.blockHeight === undefined
        ? undefined
        : {
            height: params.blockHeight,
            hash: "block-hash",
            timestamp: params.blockTimestamp ?? 0,
          },
    timeFirstSeen: params.timeFirstSeen ?? 0,
    size: 120,
    isCoinbase: false,
    tokenEntries: [],
    tokenFailedParsings: [],
    tokenStatus: "TOKEN_STATUS_NORMAL",
    isFinal: true,
  } as never;
}

function makeReviewService(options: {
  db?: ReturnType<typeof openDatabase>;
  txs?: Map<string, unknown>;
  nowMs?: () => number;
  projectAuthPubkey?: string | null | (() => string | null);
} = {}) {
  const db = options.db ?? openDatabase(":memory:");
  const txs = options.txs ?? new Map<string, unknown>();
  const getProjectAuthPubkey = () =>
    options.projectAuthPubkey === undefined
      ? PROJECT_AUTH_PUBKEY
      : typeof options.projectAuthPubkey === "function"
        ? options.projectAuthPubkey()
      : options.projectAuthPubkey;
  let invoiceCounter = 0;
  let reviewCounter = 0;
  let projectInfoInvoiceCounter = 0;
  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => {
          const projectAuthPubkey = getProjectAuthPubkey();
          return {
            tokenId: PROJECT_TOKEN_ID,
            tokenType: {
              protocol: "ALP",
              type: "ALP_TOKEN_TYPE_STANDARD",
              number: 0,
            },
            genesisInfo: {
              tokenTicker: "CRD",
              tokenName: "Credo In Unum Deo",
              url: "https://crd.network/token",
              decimals: 4,
              data: "",
              ...(projectAuthPubkey === null
                ? {}
                : { authPubkey: projectAuthPubkey }),
            },
            timeFirstSeen: 0,
          } as never;
        },
        plugin: () => ({}) as never,
        tx: async (txid: string) => {
          const tx = txs.get(txid);
          if (!tx) {
            throw new Error("tx not indexed");
          }
          return tx as never;
        },
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    {
      ...BASE_CONFIG,
      reviewPaymentAddress: REVIEW_PAYMENT_ADDRESS,
      reviewBaseFeeSats: 1_000,
      reviewInvoiceTtlMs: 1_000,
      projectInfoPaymentAddress: REVIEW_PAYMENT_ADDRESS,
    },
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      nowMs: options.nowMs ?? (() => 10_000),
      reviewInvoiceIdFactory: () => `invoice-${++invoiceCounter}`,
      reviewIdFactory: () => `review-${++reviewCounter}`,
      reviewVerifierSatsFactory: () => 23,
      projectInfoInvoiceIdFactory: () =>
        `project-info-invoice-${++projectInfoInvoiceCounter}`,
    },
  );
  return { db, service, txs };
}

test("service performs tail catch-up before marking bootstrap token ready", async () => {
  const db = openDatabase(":memory:");
  const modes: string[] = [];
  let releaseFullSync: (() => void) | null = null;
  let fullSyncStarted: (() => void) | null = null;

  const fullSyncStartedPromise = new Promise<void>((resolve) => {
    fullSyncStarted = resolve;
  });
  const releaseFullSyncPromise = new Promise<void>((resolve) => {
    releaseFullSync = resolve;
  });

  const ws = {
    ws: { readyState: 1 },
    subscribeToBlocks: () => {},
    waitForOpen: async () => {},
    close: () => {},
  };

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () =>
          ({
            txid: "spend-1",
            inputs: [
              {
                prevOut: { txid: "offer-1", outIdx: 0 },
                plugins: {
                  agora: {
                    groups: ["54token-a", "46token-a"],
                  },
                },
              },
            ],
            outputs: [],
          }) as never,
        ws: () => ws as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-a",
            groupHex: "46token-a",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          assert.equal(tokenId, "token-a");
          modes.push(mode);
          if (mode === "full") {
            fullSyncStarted?.();
            await releaseFullSyncPromise;
          }

          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    const startPromise = service.start();
    await fullSyncStartedPromise;

    await (service as unknown as { handleWsMessage: (msg: unknown) => Promise<void> })
      .handleWsMessage({
        type: "Tx",
        msgType: "TX_CONFIRMED",
        txid: "spend-1",
      });

    requireResolver(releaseFullSync)();
    await startPromise;

    assert.deepEqual(modes, ["full", "tail"]);
    assert.equal(service.isReady(), true);
    assert.equal(service.getStatus().bootstrapReadyCount, 1);
    assert.equal(service.getStatus().phase, "ready");
  } finally {
    service.stop();
    db.close();
  }
});

test("review invoice submit publishes valid mempool payment tx", async () => {
  const txid = "a".repeat(64);
  const { db, service, txs } = makeReviewService();
  txs.set(
    txid,
    makeTx({
      txid,
      paidSats: 1_023n,
      timeFirstSeen: 123,
    }),
  );

  try {
    const invoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 8,
      comment: "solid",
    });

    assert.equal(invoice.invoiceId, "invoice-1");
    assert.equal(invoice.expectedPaidSats, 1_023);
    assert.equal(invoice.expectedPaidXec, "10.23");

    const submitted = await service.submitReviewInvoiceTx(invoice.invoiceId, {
      txid,
    });
    assert.equal(submitted.status, "published");
    assert.equal(submitted.paymentTxid, txid);
    assert.equal(submitted.publishedReviewId, "review-1");

    assert.deepEqual(service.getTokenReviewSummary(REVIEW_TOKEN_ID), {
      averageScore: 8,
      scorerCount: 1,
      reviewCountTotal: 1,
      commentCountTotal: 1,
      lastReviewAt: 10_000,
    });
    assert.deepEqual(service.listTokenReviews(REVIEW_TOKEN_ID, { page: 1, pageSize: 10 }), {
      page: 1,
      pageSize: 10,
      total: 1,
      items: [
        {
          reviewId: "review-1",
          tokenId: REVIEW_TOKEN_ID,
          authorMasked: "ecash:q...kuu2",
          score: 8,
          comment: "solid",
          createdAt: 10_000,
        },
      ],
    });
  } finally {
    db.close();
  }
});

test("review invoice submit stores tx_submitted until Chronik indexes tx", async () => {
  const txid = "b".repeat(64);
  const { db, service, txs } = makeReviewService();

  try {
    const invoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 6,
    });
    const pending = await service.submitReviewInvoiceTx(invoice.invoiceId, {
      txid,
    });
    assert.equal(pending.status, "tx_submitted");
    assert.equal(pending.paymentTxid, txid);

    txs.set(txid, makeTx({ txid, paidSats: 1_023n }));
    const retry = await service.retryPendingReviewPayments();
    assert.deepEqual(retry, {
      checked: 1,
      published: 1,
      invalid: 0,
      expired: 0,
    });
    assert.equal(service.getReviewInvoice(invoice.invoiceId)?.status, "published");
  } finally {
    db.close();
  }
});

test("review invoice can be paid with overpaid SS token atoms", async () => {
  const txid = "1".repeat(64);
  const { db, service, txs } = makeReviewService();

  try {
    const invoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 9,
      comment: "paid with ss",
      paymentKind: "token",
      paymentTokenSymbol: "SS",
    });

    assert.equal(invoice.paymentKind, "token");
    assert.equal(invoice.paymentTokenId, REVIEW_STAR_SHARD_TOKEN_ID);
    assert.equal(invoice.paymentTokenSymbol, "SS");
    assert.equal(invoice.creditSatsPerAtom, 500);
    assert.equal(invoice.expectedPaidAtoms, "3");

    txs.set(
      txid,
      makeTokenTx({
        txid,
        tokenId: REVIEW_STAR_SHARD_TOKEN_ID,
        paidAtoms: 4n,
        timeFirstSeen: 11,
      }),
    );

    const submitted = await service.submitReviewInvoiceTx(invoice.invoiceId, {
      txid,
    });
    assert.equal(submitted.status, "published");
    assert.equal(submitted.paymentTxid, txid);
    assert.equal(submitted.publishedReviewId, "review-1");
  } finally {
    db.close();
  }
});

test("review invoice can be paid with exact SC token atoms", async () => {
  const txid = "2".repeat(64);
  const { db, service, txs } = makeReviewService();

  try {
    const invoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 9,
      paymentKind: "token",
      paymentTokenSymbol: "SC",
    });

    assert.equal(invoice.paymentKind, "token");
    assert.equal(invoice.paymentTokenId, REVIEW_STAR_CRYSTAL_TOKEN_ID);
    assert.equal(invoice.paymentTokenSymbol, "SC");
    assert.equal(invoice.creditSatsPerAtom, 30_000);
    assert.equal(invoice.expectedPaidAtoms, "1");

    txs.set(
      txid,
      makeTokenTx({
        txid,
        tokenId: REVIEW_STAR_CRYSTAL_TOKEN_ID,
        paidAtoms: 1n,
        timeFirstSeen: 11,
      }),
    );

    const submitted = await service.submitReviewInvoiceTx(invoice.invoiceId, {
      txid,
    });
    assert.equal(submitted.status, "published");
  } finally {
    db.close();
  }
});

test("review token invoice rejects underpaid or wrong token txs", async () => {
  const underpaidTxid = "3".repeat(64);
  const wrongTokenTxid = "4".repeat(64);
  const { db, service, txs } = makeReviewService();

  txs.set(
    underpaidTxid,
    makeTokenTx({
      txid: underpaidTxid,
      tokenId: REVIEW_STAR_SHARD_TOKEN_ID,
      paidAtoms: 2n,
      timeFirstSeen: 11,
    }),
  );
  txs.set(
    wrongTokenTxid,
    makeTokenTx({
      txid: wrongTokenTxid,
      tokenId: REVIEW_STAR_CRYSTAL_TOKEN_ID,
      timeFirstSeen: 11,
    }),
  );

  try {
    const underpaidInvoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 6,
      paymentKind: "token",
      paymentTokenSymbol: "SS",
    });
    await assert.rejects(
      () =>
        service.submitReviewInvoiceTx(underpaidInvoice.invoiceId, {
          txid: underpaidTxid,
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PAYMENT_OUTPUT_MISMATCH",
    );
    assert.equal(
      service.getReviewInvoice(underpaidInvoice.invoiceId)?.status,
      "invalid",
    );

    const wrongTokenInvoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 6,
      paymentKind: "token",
      paymentTokenSymbol: "SS",
    });
    await assert.rejects(
      () =>
        service.submitReviewInvoiceTx(wrongTokenInvoice.invoiceId, {
          txid: wrongTokenTxid,
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PAYMENT_AUTHOR_MISMATCH",
    );
    assert.equal(
      service.getReviewInvoice(wrongTokenInvoice.invoiceId)?.status,
      "invalid",
    );
  } finally {
    db.close();
  }
});

test("review invoice submit rejects wrong payment amount and marks invoice invalid", async () => {
  const txid = "c".repeat(64);
  const { db, service, txs } = makeReviewService();
  txs.set(txid, makeTx({ txid, paidSats: 1_024n }));

  try {
    const invoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 6,
    });

    await assert.rejects(
      () => service.submitReviewInvoiceTx(invoice.invoiceId, { txid }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PAYMENT_OUTPUT_MISMATCH",
    );
    assert.equal(service.getReviewInvoice(invoice.invoiceId)?.status, "invalid");
  } finally {
    db.close();
  }
});

test("review invoice submit rejects wrong payer and wrong recipient", async () => {
  const wrongPayerTxid = "e".repeat(64);
  const wrongRecipientTxid = "f".repeat(64);
  const { db, service, txs } = makeReviewService();
  txs.set(
    wrongPayerTxid,
    makeTx({
      txid: wrongPayerTxid,
      authorAddress: OTHER_REVIEW_ADDRESS,
      paidSats: 1_023n,
    }),
  );
  txs.set(
    wrongRecipientTxid,
    makeTx({
      txid: wrongRecipientTxid,
      paymentAddress: OTHER_REVIEW_ADDRESS,
      paidSats: 1_023n,
    }),
  );

  try {
    const wrongPayerInvoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 6,
    });
    await assert.rejects(
      () =>
        service.submitReviewInvoiceTx(wrongPayerInvoice.invoiceId, {
          txid: wrongPayerTxid,
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PAYMENT_AUTHOR_MISMATCH",
    );
    assert.equal(
      service.getReviewInvoice(wrongPayerInvoice.invoiceId)?.status,
      "invalid",
    );

    const wrongRecipientInvoice = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 6,
    });
    await assert.rejects(
      () =>
        service.submitReviewInvoiceTx(wrongRecipientInvoice.invoiceId, {
          txid: wrongRecipientTxid,
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PAYMENT_OUTPUT_MISMATCH",
    );
    assert.equal(
      service.getReviewInvoice(wrongRecipientInvoice.invoiceId)?.status,
      "invalid",
    );
  } finally {
    db.close();
  }
});

test("review invoice submit rejects expired invoices and duplicate txids", async () => {
  let nowMs = 10_000;
  const txid = "d".repeat(64);
  const { db, service } = makeReviewService({
    nowMs: () => nowMs,
    txs: new Map(),
  });

  try {
    const expired = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 6,
    });
    nowMs = 12_000;

    await assert.rejects(
      () => service.submitReviewInvoiceTx(expired.invoiceId, { txid }),
      (error) =>
        error instanceof ReviewError && error.code === "INVOICE_EXPIRED",
    );
    assert.equal(service.getReviewInvoice(expired.invoiceId)?.status, "expired");

    nowMs = 20_000;
    const first = service.createReviewInvoice(REVIEW_TOKEN_ID, {
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 7,
    });
    await service.submitReviewInvoiceTx(first.invoiceId, { txid });

    const second = db.createReviewInvoice({
      invoiceId: "invoice-manual",
      tokenId: REVIEW_TOKEN_ID,
      authorAddress: REVIEW_AUTHOR_ADDRESS,
      score: 8,
      commentText: "",
      paymentAddress: REVIEW_PAYMENT_ADDRESS,
      expectedPaidSats: 1_023,
      verifierSats: 23,
      expiresAt: 22_000,
      createdAt: 20_000,
    });
    await assert.rejects(
      () => service.submitReviewInvoiceTx(second.invoiceId, { txid }),
      (error) =>
        error instanceof ReviewError && error.code === "PAYMENT_TXID_REUSED",
    );
  } finally {
    db.close();
  }
});

test("project info invoice creation requires token creator editor", async () => {
  const { db, service } = makeReviewService();

  try {
    await assert.rejects(
      () =>
        service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
          editorAddress: REVIEW_AUTHOR_ADDRESS,
          description: "Credo project",
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PROJECT_INFO_CREATOR_REQUIRED",
    );
  } finally {
    db.close();
  }
});

test("project info invoice creation falls back to genesis input creator without authPubkey", async () => {
  const missing = makeReviewService({ projectAuthPubkey: null });
  missing.txs.set(
    PROJECT_TOKEN_ID,
    makeTx({
      txid: PROJECT_TOKEN_ID,
      authorAddress: PROJECT_EDITOR_ADDRESS,
    }),
  );

  try {
    const invoice = await missing.service.createProjectInfoInvoice(
      PROJECT_TOKEN_ID,
      {
        editorAddress: PROJECT_EDITOR_ADDRESS,
        description: "Project info",
      },
    );
    assert.equal(invoice.status, "pending");
    assert.equal(invoice.editorAddress, PROJECT_EDITOR_ADDRESS);
  } finally {
    missing.db.close();
  }
});

test("project info invoice creation rejects unresolved or mismatched genesis creator", async () => {
  const unresolved = makeReviewService({ projectAuthPubkey: null });
  try {
    await assert.rejects(
      () =>
        unresolved.service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
          editorAddress: PROJECT_EDITOR_ADDRESS,
          description: "Project info",
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PROJECT_INFO_CREATOR_REQUIRED",
    );
  } finally {
    unresolved.db.close();
  }

  const mismatched = makeReviewService({ projectAuthPubkey: null });
  mismatched.txs.set(
    PROJECT_TOKEN_ID,
    makeTx({
      txid: PROJECT_TOKEN_ID,
      authorAddress: PROJECT_EDITOR_ADDRESS,
    }),
  );
  try {
    await assert.rejects(
      () =>
        mismatched.service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
          editorAddress: REVIEW_AUTHOR_ADDRESS,
          description: "Project info",
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PROJECT_INFO_CREATOR_REQUIRED",
    );
  } finally {
    mismatched.db.close();
  }
});

test("project info invoice creation rejects invalid genesis authPubkey", async () => {
  const invalid = makeReviewService({ projectAuthPubkey: "abcd" });
  try {
    await assert.rejects(
      () =>
        invalid.service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
          editorAddress: PROJECT_EDITOR_ADDRESS,
          description: "Project info",
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PROJECT_INFO_AUTH_PUBKEY_REQUIRED",
    );
  } finally {
    invalid.db.close();
  }
});

test("project info invoice publish rejects if authPubkey creator changes before payment verification", async () => {
  const txid = "9".repeat(64);
  const authPubkey = { value: PROJECT_AUTH_PUBKEY };
  const { db, service, txs } = makeReviewService({
    projectAuthPubkey: () => authPubkey.value,
  });
  txs.set(
    txid,
    makeTx({
      txid,
      authorAddress: PROJECT_EDITOR_ADDRESS,
      paidSats: 100_000_000n,
    }),
  );

  try {
    const invoice = await service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
      editorAddress: PROJECT_EDITOR_ADDRESS,
      description: "Project info",
    });
    authPubkey.value =
      "03f028892bad7ed57d2fb57bf33081d5cfcf6f9ed3d3d7f159c2e2fff579dc341a";

    await assert.rejects(
      () => service.submitProjectInfoInvoiceTx(invoice.invoiceId, { txid }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PROJECT_INFO_CREATOR_REQUIRED",
    );
    assert.equal(
      service.getProjectInfoInvoice(invoice.invoiceId)?.status,
      "invalid",
    );
    assert.equal(service.getTokenProjectInfo(PROJECT_TOKEN_ID), null);
  } finally {
    db.close();
  }
});

test("project info invoice publish rejects if fallback genesis creator changes before payment verification", async () => {
  const txid = "4".repeat(64);
  const genesisAuthorAddress = { value: PROJECT_EDITOR_ADDRESS };
  const { db, service, txs } = makeReviewService({ projectAuthPubkey: null });
  txs.set(
    PROJECT_TOKEN_ID,
    makeTx({
      txid: PROJECT_TOKEN_ID,
      authorAddress: genesisAuthorAddress.value,
    }),
  );
  txs.set(
    txid,
    makeTx({
      txid,
      authorAddress: PROJECT_EDITOR_ADDRESS,
      paidSats: 100_000_000n,
    }),
  );

  try {
    const invoice = await service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
      editorAddress: PROJECT_EDITOR_ADDRESS,
      description: "Project info",
    });
    genesisAuthorAddress.value = REVIEW_AUTHOR_ADDRESS;
    txs.set(
      PROJECT_TOKEN_ID,
      makeTx({
        txid: PROJECT_TOKEN_ID,
        authorAddress: genesisAuthorAddress.value,
      }),
    );

    await assert.rejects(
      () => service.submitProjectInfoInvoiceTx(invoice.invoiceId, { txid }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PROJECT_INFO_CREATOR_REQUIRED",
    );
    assert.equal(
      service.getProjectInfoInvoice(invoice.invoiceId)?.status,
      "invalid",
    );
    assert.equal(service.getTokenProjectInfo(PROJECT_TOKEN_ID), null);
  } finally {
    db.close();
  }
});

test("project info invoices use initial fee then update fee", async () => {
  const firstTxid = "6".repeat(64);
  const { db, service, txs } = makeReviewService();
  txs.set(
    firstTxid,
    makeTx({
      txid: firstTxid,
      authorAddress: PROJECT_EDITOR_ADDRESS,
      paidSats: 100_000_000n,
    }),
  );

  try {
    const first = await service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
      editorAddress: PROJECT_EDITOR_ADDRESS,
      description: " Credo project ",
      websiteUrl: "https://example.com",
      xUrl: "https://x.com/project",
      telegramUrl: "https://t.me/project",
    });
    assert.equal(first.invoiceId, "project-info-invoice-1");
    assert.equal(first.expectedPaidSats, 100_000_000);
    assert.equal(first.expectedPaidXec, "1000000.00");
    assert.equal(first.feeTier, "initial");
    assert.equal(first.description, "Credo project");
    assert.equal(first.websiteUrl, "https://example.com/");

    const published = await service.submitProjectInfoInvoiceTx(first.invoiceId, {
      txid: firstTxid,
    });
    assert.equal(published.status, "published");

    const current = service.getTokenProjectInfo(PROJECT_TOKEN_ID);
    assert.deepEqual(current, {
      tokenId: PROJECT_TOKEN_ID,
      description: "Credo project",
      websiteUrl: "https://example.com/",
      xUrl: "https://x.com/project",
      telegramUrl: "https://t.me/project",
      createdAt: 10_000,
      updatedAt: 10_000,
      updateCount: 1,
      lastEditorMasked: "ecash:q...kzvq",
    });

    const update = await service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
      editorAddress: PROJECT_EDITOR_ADDRESS,
      description: "",
    });
    assert.equal(update.expectedPaidSats, 10_000_000);
    assert.equal(update.expectedPaidXec, "100000.00");
    assert.equal(update.feeTier, "update");
  } finally {
    db.close();
  }
});

test("project info test token invoices use 100 XEC for initial and update fees", async () => {
  const firstTxid = "5".repeat(64);
  const { db, service, txs } = makeReviewService();
  txs.set(
    firstTxid,
    makeTx({
      txid: firstTxid,
      authorAddress: PROJECT_EDITOR_ADDRESS,
      paidSats: 10_000n,
    }),
  );

  try {
    const first = await service.createProjectInfoInvoice(
      PROJECT_INFO_TEST_TOKEN_ID,
      {
        editorAddress: PROJECT_EDITOR_ADDRESS,
        description: "Test project",
      },
    );
    assert.equal(first.expectedPaidSats, 10_000);
    assert.equal(first.expectedPaidXec, "100.00");
    assert.equal(first.feeTier, "initial");

    const published = await service.submitProjectInfoInvoiceTx(first.invoiceId, {
      txid: firstTxid,
    });
    assert.equal(published.status, "published");

    const update = await service.createProjectInfoInvoice(
      PROJECT_INFO_TEST_TOKEN_ID,
      {
        editorAddress: PROJECT_EDITOR_ADDRESS,
        description: "Updated test project",
      },
    );
    assert.equal(update.expectedPaidSats, 10_000);
    assert.equal(update.expectedPaidXec, "100.00");
    assert.equal(update.feeTier, "update");
  } finally {
    db.close();
  }
});

test("project info invoice submit stores tx_submitted until Chronik indexes tx", async () => {
  const txid = "7".repeat(64);
  const { db, service, txs } = makeReviewService();

  try {
    const invoice = await service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
      editorAddress: PROJECT_EDITOR_ADDRESS,
      description: "Project info",
    });
    const pending = await service.submitProjectInfoInvoiceTx(invoice.invoiceId, {
      txid,
    });
    assert.equal(pending.status, "tx_submitted");

    txs.set(
      txid,
      makeTx({
        txid,
        authorAddress: PROJECT_EDITOR_ADDRESS,
        paidSats: 100_000_000n,
      }),
    );
    const retry = await service.retryPendingProjectInfoPayments();
    assert.deepEqual(retry, {
      checked: 1,
      published: 1,
      invalid: 0,
      expired: 0,
    });
    assert.equal(
      service.getProjectInfoInvoice(invoice.invoiceId)?.status,
      "published",
    );
  } finally {
    db.close();
  }
});

test("project info invoice submit rejects wrong payment amount and marks invalid", async () => {
  const txid = "8".repeat(64);
  const { db, service, txs } = makeReviewService();
  txs.set(
    txid,
    makeTx({
      txid,
      authorAddress: PROJECT_EDITOR_ADDRESS,
      paidSats: 100_000_001n,
    }),
  );

  try {
    const invoice = await service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
      editorAddress: PROJECT_EDITOR_ADDRESS,
      description: "Project info",
    });
    await assert.rejects(
      () => service.submitProjectInfoInvoiceTx(invoice.invoiceId, { txid }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PAYMENT_OUTPUT_MISMATCH",
    );
    assert.equal(
      service.getProjectInfoInvoice(invoice.invoiceId)?.status,
      "invalid",
    );
  } finally {
    db.close();
  }
});

test("service includes review summary fields in token list and detail", () => {
  const db = openDatabase(":memory:");
  const serviceDeps = makeReviewService({ db }).service;
  const tokenA = "review-token-a";
  const tokenB = "review-token-b";
  const authorA = REVIEW_AUTHOR_ADDRESS;
  const authorB = OTHER_REVIEW_ADDRESS;

  function publishReview(params: {
    invoiceId: string;
    reviewId: string;
    tokenId: string;
    authorAddress: string;
    score: number;
    commentText: string;
    txid: string;
    createdAt: number;
  }): void {
    db.createReviewInvoice({
      invoiceId: params.invoiceId,
      tokenId: params.tokenId,
      authorAddress: params.authorAddress,
      score: params.score,
      commentText: params.commentText,
      paymentAddress: REVIEW_PAYMENT_ADDRESS,
      expectedPaidSats: 1_023,
      verifierSats: 23,
      expiresAt: params.createdAt + 1_000,
      createdAt: params.createdAt - 100,
    });
    db.markReviewInvoiceTxSubmitted(
      params.invoiceId,
      params.txid,
      params.createdAt,
    );
    db.publishTokenReview(
      {
        reviewId: params.reviewId,
        invoiceId: params.invoiceId,
        tokenId: params.tokenId,
        authorAddress: params.authorAddress,
        score: params.score,
        commentText: params.commentText,
        paymentTxid: params.txid,
        paidSats: 1_023,
        paymentSeenAt: params.createdAt,
        paymentBlockHeight: null,
        paymentBlockTimestamp: null,
        createdAt: params.createdAt,
      },
      params.createdAt,
    );
  }

  try {
    for (const tokenId of [tokenA, tokenB]) {
      db.upsertTrackedToken({
        tokenId,
        groupHex: `46${tokenId}`,
        groupPrefixHex: "46",
        kind: "FUNGIBLE",
      });
      db.markTokenReady(tokenId, true, 1_000);
    }

    publishReview({
      invoiceId: "invoice-old",
      reviewId: "review-old",
      tokenId: tokenA,
      authorAddress: authorA,
      score: 2,
      commentText: "old",
      txid: "1".repeat(64),
      createdAt: 2_000,
    });
    publishReview({
      invoiceId: "invoice-other",
      reviewId: "review-other",
      tokenId: tokenA,
      authorAddress: authorB,
      score: 8,
      commentText: "",
      txid: "2".repeat(64),
      createdAt: 2_500,
    });
    publishReview({
      invoiceId: "invoice-new",
      reviewId: "review-new",
      tokenId: tokenA,
      authorAddress: authorA,
      score: 10,
      commentText: "new",
      txid: "3".repeat(64),
      createdAt: 3_000,
    });

    const page = serviceDeps.listTokens({
      page: 1,
      pageSize: 10,
      readyOnly: true,
      sort: "totalTradeCount",
      order: "asc",
    });
    const itemA = page.items.find((item) => item.tokenId === tokenA);
    const itemB = page.items.find((item) => item.tokenId === tokenB);

    assert.equal(itemA?.reviewAverageScore, 9);
    assert.equal(itemA?.reviewScorerCount, 2);
    assert.equal(itemA?.reviewCountTotal, 3);
    assert.equal(itemA?.reviewCommentCountTotal, 2);
    assert.equal(itemA?.lastReviewAt, 3_000);
    assert.equal(itemB?.reviewAverageScore, null);
    assert.equal(itemB?.reviewScorerCount, 0);
    assert.equal(itemB?.reviewCountTotal, 0);
    assert.equal(itemB?.reviewCommentCountTotal, 0);
    assert.equal(itemB?.lastReviewAt, null);

    const detail = serviceDeps.getToken(tokenA);
    assert.equal(detail?.summary.reviewAverageScore, 9);
    assert.equal(detail?.summary.reviewScorerCount, 2);
    assert.equal(detail?.summary.reviewCountTotal, 3);
    assert.equal(detail?.summary.reviewCommentCountTotal, 2);
    assert.equal(detail?.summary.lastReviewAt, 3_000);
  } finally {
    serviceDeps.stop();
    db.close();
  }
});

test("service rejects startup when a bootstrap token fails initialization", async () => {
  const db = openDatabase(":memory:");
  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_001,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-fail",
            groupHex: "46token-fail",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async () => {
          throw new Error("boom");
        },
      },
    },
  );

  try {
    await assert.rejects(service.start(), /Bootstrap failed for token-fail: boom/);
    assert.equal(service.isReady(), false);
    assert.equal(service.getStatus().phase, "error");
  } finally {
    service.stop();
    db.close();
  }
});

test("service establishes a cursor without scanning every token when block APIs are unavailable", async () => {
  const db = openDatabase(":memory:");
  const modes: string[] = [];

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {
              throw new Error("ws offline");
            },
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_101,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-tail",
            groupHex: "46token-tail",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          assert.equal(tokenId, "token-tail");
          modes.push(mode);
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    await service.start();
    assert.deepEqual(modes, ["full"]);
    assert.equal(service.isReady(), true);
    assert.equal(service.getStatus().phase, "degraded");
    assert.equal(service.getStatus().chainCursorHeight, 900_101);
  } finally {
    service.stop();
    db.close();
  }
});

test("service recreates websocket and restores all subscriptions after disconnect", async () => {
  const db = openDatabase(":memory:");
  const modes: string[] = [];
  const wsConfigs: Array<{
    autoReconnect?: boolean;
    onConnect?: (event: never) => void;
    onEnd?: (event: never) => void;
  }> = [];
  const blockSubscriptions: number[] = [];
  const lokadSubscriptions: Array<{ endpoint: number; lokadId: string }> = [];
  const tokenSubscriptions: Array<{ endpoint: number; tokenId: string }> = [];

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: (config) => {
          const endpoint = wsConfigs.length;
          wsConfigs.push(config as (typeof wsConfigs)[number]);
          return {
            endpoint,
            ws: { readyState: 1 },
            subscribeToBlocks: () => blockSubscriptions.push(endpoint),
            subscribeToLokadId: (lokadId: string) =>
              lokadSubscriptions.push({ endpoint, lokadId }),
            waitForOpen: async () => {
              wsConfigs[endpoint]?.onConnect?.({} as never);
            },
            close: () => {},
          } as never;
        },
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: (ws, params) => {
          if (params.type === "TOKEN_ID") {
            tokenSubscriptions.push({
              endpoint: (ws as unknown as { endpoint: number }).endpoint,
              tokenId: params.tokenId,
            });
          }
        },
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-reconnect",
            groupHex: "46token-reconnect",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          assert.equal(tokenId, "token-reconnect");
          modes.push(mode);
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
      retryDelayMsFactory: () => 0,
    },
  );

  try {
    await service.start();
    assert.deepEqual(modes, ["full"]);

    wsConfigs[0]?.onEnd?.({} as never);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(wsConfigs.length, 2);
    assert.deepEqual(
      wsConfigs.map((config) => config.autoReconnect),
      [false, false],
    );
    assert.deepEqual(blockSubscriptions, [0, 1]);
    assert.deepEqual(lokadSubscriptions, [
      { endpoint: 0, lokadId: "41475230" },
      { endpoint: 1, lokadId: "41475230" },
    ]);
    assert.deepEqual(tokenSubscriptions, [
      { endpoint: 0, tokenId: "token-reconnect" },
      { endpoint: 1, tokenId: "token-reconnect" },
    ]);
    assert.deepEqual(modes, ["full"]);
    assert.equal(service.getStatus().phase, "ready");
  } finally {
    service.stop();
    db.close();
  }
});

test("service retries when waitForOpen returns without an open socket", async () => {
  const db = openDatabase(":memory:");
  const endpoints: Array<{ readyState: number | null }> = [];

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () => {
          const endpoint = endpoints.length;
          const socket = endpoint === 0 ? undefined : { readyState: 1 };
          endpoints.push({ readyState: socket?.readyState ?? null });
          return {
            ws: socket,
            subscribeToBlocks: () => {},
            subscribeToLokadId: () => {},
            waitForOpen: async () => {},
            close: () => {},
          } as never;
        },
        blockchainInfo: async () => ({ tipHash: "tip", tipHeight: 100 }),
      },
      agora: {
        historicOffers: async () => { throw new Error("unused"); },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      retryDelayMsFactory: () => 0,
      ops: { discoverActiveTokens: async () => [] },
    },
  );

  try {
    await service.start();
    assert.equal(service.getStatus().phase, "degraded");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(endpoints, [{ readyState: null }, { readyState: 1 }]);
    assert.equal(service.getStatus().wsConnected, true);
    assert.equal(service.getStatus().phase, "ready");
  } finally {
    service.stop();
    db.close();
  }
});

test("first cursor startup rewinds finalized blocks and syncs only affected tokens", async () => {
  const db = openDatabase(":memory:");
  const tokenA = "a".repeat(64);
  const tokenB = "b".repeat(64);
  const syncs: Array<{ tokenId: string; mode: string; afterHeight?: number }> = [];
  const scannedHeights: number[] = [];

  for (const tokenId of [tokenA, tokenB]) {
    db.upsertTrackedToken({
      tokenId,
      groupHex: `46${tokenId}`,
      groupPrefixHex: "46",
      kind: "FUNGIBLE",
    });
    db.markTokenReady(tokenId, true, 1_000);
  }

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            subscribeToLokadId: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({ tipHash: "block-112", tipHeight: 112 }),
        block: async function (height: string | number) {
          assert.equal(typeof this.blockchainInfo, "function");
          return {
            blockInfo: {
              height: Number(height),
              hash: `block-${height}`,
              isFinal: true,
            },
          } as never;
        },
        blockTxs: async function (height: string | number) {
          assert.equal(typeof this.blockchainInfo, "function");
          scannedHeights.push(Number(height));
          return {
            txs:
              Number(height) === 110
                ? [
                    {
                      txid: "agora-a",
                      inputs: [
                        {
                          prevOut: { txid: "offer-a", outIdx: 0 },
                          plugins: { agora: { groups: [`54${tokenA}`] } },
                        },
                      ],
                      outputs: [],
                    },
                  ]
                : [],
            numPages: 1,
            numTxs: Number(height) === 110 ? 1 : 0,
          } as never;
        },
      },
      agora: {
        historicOffers: async () => { throw new Error("unused"); },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      deferKnownTradeCountLte: Number.MAX_SAFE_INTEGER,
      ops: {
        discoverActiveTokens: async () =>
          [tokenA, tokenB].map((tokenId) => ({
            tokenId,
            groupHex: `46${tokenId}`,
            groupPrefixHex: "46",
            kind: "FUNGIBLE" as const,
          })),
        syncTokenHistory: async (
          _db,
          _deps,
          _config,
          tokenId,
          mode,
          _progress,
          afterHeight,
        ) => {
          syncs.push({ tokenId, mode, afterHeight });
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    await service.start();
    assert.deepEqual(scannedHeights, [
      101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112,
    ]);
    assert.deepEqual(syncs, [
      { tokenId: tokenA, mode: "catchup", afterHeight: 100 },
    ]);
    assert.deepEqual(db.getChainSyncCursor(), {
      blockHeight: 112,
      blockHash: "block-112",
      updatedAt: db.getChainSyncCursor()?.updatedAt,
    });
  } finally {
    service.stop();
    db.close();
  }
});

test("failed block token sync leaves the persisted cursor unchanged", async () => {
  const db = openDatabase(":memory:");
  const tokenId = "c".repeat(64);
  db.upsertTrackedToken({
    tokenId,
    groupHex: `46${tokenId}`,
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady(tokenId, true, 1_000);
  db.setChainSyncCursor(100, "block-100", 1_000);

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({ tipHash: "block-101", tipHeight: 101 }),
        block: async (height: string | number) => ({
          blockInfo: {
            height: Number(height),
            hash: `block-${height}`,
            isFinal: true,
          },
        }) as never,
        blockTxs: async () => ({
          txs: [
            {
              txid: "agora-c",
              inputs: [
                {
                  prevOut: { txid: "offer-c", outIdx: 0 },
                  plugins: { agora: { groups: [`54${tokenId}`] } },
                },
              ],
              outputs: [],
            },
          ],
          numPages: 1,
          numTxs: 1,
        }) as never,
      },
      agora: {
        historicOffers: async () => { throw new Error("unused"); },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      deferKnownTradeCountLte: Number.MAX_SAFE_INTEGER,
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId,
            groupHex: `46${tokenId}`,
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async () => {
          throw new Error("Chronik rate limited");
        },
      },
    },
  );

  try {
    await assert.rejects(service.start(), /Chronik rate limited/);
    assert.deepEqual(db.getChainSyncCursor(), {
      blockHeight: 100,
      blockHash: "block-100",
      updatedAt: 1_000,
    });
  } finally {
    service.stop();
    db.close();
  }
});

test("tail sync failure remains dirty and retries", async () => {
  const db = openDatabase(":memory:");
  const tokenId = "d".repeat(64);
  let tailAttempts = 0;
  db.upsertTrackedToken({
    tokenId,
    groupHex: `46${tokenId}`,
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady(tokenId, true, 1_000);

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () =>
          ({
            txid: "tail-event",
            inputs: [
              {
                prevOut: { txid: "offer-d", outIdx: 0 },
                plugins: { agora: { groups: [`54${tokenId}`] } },
              },
            ],
            outputs: [],
          }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({ tipHash: "tip", tipHeight: 101 }),
      },
      agora: {
        historicOffers: async () => { throw new Error("unused"); },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      deferKnownTradeCountLte: Number.MAX_SAFE_INTEGER,
      retryDelayMsFactory: () => 0,
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId,
            groupHex: `46${tokenId}`,
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, syncedTokenId, mode) => {
          assert.equal(syncedTokenId, tokenId);
          assert.equal(mode, "tail");
          tailAttempts += 1;
          if (tailAttempts === 1) {
            throw new Error("temporary tail failure");
          }
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    await service.start();
    await (
      service as unknown as { handleWsMessage: (msg: unknown) => Promise<void> }
    ).handleWsMessage({
      type: "Tx",
      msgType: "TX_CONFIRMED",
      txid: "tail-event",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(tailAttempts, 2);
    assert.equal(service.getStatus().pendingTokenCount, 0);
  } finally {
    service.stop();
    db.close();
  }
});

test("readiness becomes false when tip and catch-up timestamps are stale", async () => {
  const db = openDatabase(":memory:");
  let nowMs = 1_000;
  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({ tipHash: "tip", tipHeight: 101 }),
      },
      agora: {
        historicOffers: async () => { throw new Error("unused"); },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      nowMs: () => nowMs,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      ops: { discoverActiveTokens: async () => [] },
    },
  );

  try {
    await service.start();
    assert.equal(service.isReady(), true);
    nowMs += BASE_CONFIG.readinessMaxTipAgeMs + 1;
    assert.equal(service.isReady(), false);
    assert.equal(service.getStatus().ready, false);
    assert.equal(service.isHealthy(), true);
  } finally {
    service.stop();
    db.close();
  }
});

test("service discovers new fungible tokens from AGR0 websocket events", async () => {
  const db = openDatabase(":memory:");
  const tokenId = "a".repeat(64);
  const subscribedTokenIds: string[] = [];
  const syncModes: string[] = [];
  const lokadIds: string[] = [];
  let txLookupCount = 0;

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => {
          txLookupCount += 1;
          return {
            txid: "new-offer",
            inputs: [],
            outputs: [
              {
                plugins: {
                  agora: {
                    groups: [`46${tokenId}`, `54${tokenId}`],
                  },
                },
              },
            ],
          } as never;
        },
        ws: () =>
          ({
            ws: { readyState: 1 },
            subscribeToBlocks: () => {},
            subscribeToLokadId: (lokadId: string) => lokadIds.push(lokadId),
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => { throw new Error("unused"); },
        subscribeWs: (_ws, params) => {
          if (params.type === "TOKEN_ID") {
            subscribedTokenIds.push(params.tokenId);
          }
        },
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ops: {
        discoverActiveTokens: async () => [],
        syncTokenHistory: async (_db, _deps, _config, syncedTokenId, mode) => {
          syncModes.push(`${syncedTokenId}:${mode}`);
          return {
            tokenId: syncedTokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    await service.start();
    assert.deepEqual(lokadIds, ["41475230"]);

    const wsMessage = {
      type: "Tx",
      msgType: "TX_CONFIRMED",
      txid: "new-offer",
    } as const;
    const handleWsMessage = (
      service as unknown as { handleWsMessage: (msg: unknown) => Promise<void> }
    ).handleWsMessage.bind(service);
    await handleWsMessage(wsMessage);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(db.getTrackedToken(tokenId)?.isActive, true);
    assert.deepEqual(subscribedTokenIds, [tokenId]);
    assert.deepEqual(syncModes, [`${tokenId}:full`, `${tokenId}:tail`]);

    await handleWsMessage(wsMessage);
    assert.equal(txLookupCount, 1);
  } finally {
    service.stop();
    db.close();
  }
});

test("service can defer known zero-trade tokens out of blocking bootstrap", async () => {
  const db = openDatabase(":memory:");
  db.upsertTrackedToken({
    tokenId: "token-zero",
    groupHex: "46token-zero",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-zero", true, 1000);
  db.markTokenSynced("token-zero", 1000);
  db.recomputeTokenAggregateStats("token-zero", 900_000);

  const seen: string[] = [];
  let releaseBlocking: (() => void) | null = null;
  const blockingPromise = new Promise<void>((resolve) => {
    releaseBlocking = resolve;
  });

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      deferKnownTradeCountLte: 0,
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-zero",
            groupHex: "46token-zero",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
          {
            tokenId: "token-live",
            groupHex: "46token-live",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          seen.push(`${tokenId}:${mode}`);
          if (tokenId === "token-live" && mode === "full") {
            await blockingPromise;
          }
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
        extractAgoraTokenIdsFromTx: () => ["token-zero"],
      },
    },
  );

  try {
    const startPromise = service.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["token-live:full"]);

    requireResolver(releaseBlocking)();
    await startPromise;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(service.getStatus().bootstrapTokenCount, 1);
    assert.equal(db.getTrackedToken("token-zero")?.bootstrapCohort, false);

    await (service as unknown as { handleWsMessage: (msg: unknown) => Promise<void> })
      .handleWsMessage({
        type: "Tx",
        msgType: "TX_CONFIRMED",
        txid: "spend-zero",
      });
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(!seen.includes("token-zero:full"));
    assert.ok(seen.includes("token-zero:tail"));
  } finally {
    service.stop();
    db.close();
  }
});

test("service can defer known low-trade tokens by configurable threshold", async () => {
  const db = openDatabase(":memory:");
  db.upsertTrackedToken({
    tokenId: "token-one",
    groupHex: "46token-one",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.insertProcessedTrades([
    {
      tokenId: "token-one",
      offerTxid: "offer-1",
      offerOutIdx: 0,
      spendTxid: "spend-1",
      variantType: "PARTIAL",
      paidSats: "100",
      soldAtoms: "10",
      priceNanosatsPerAtom: "10000000",
      takerScriptHex: null,
      blockHeight: 900_000,
      blockHash: "block-900000",
      blockTimestamp: 1_700_000_000,
      rawTradeJson: "{}",
    },
  ]);
  db.markTokenReady("token-one", true, 1000);
  db.markTokenSynced("token-one", 1000);
  db.recomputeTokenAggregateStats("token-one", 900_000);

  const seen: string[] = [];

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 900_000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      deferKnownTradeCountLte: 1,
      ops: {
        discoverActiveTokens: async () => [
          {
            tokenId: "token-one",
            groupHex: "46token-one",
            groupPrefixHex: "46",
            kind: "FUNGIBLE",
          },
        ],
        syncTokenHistory: async (_db, _deps, _config, tokenId, mode) => {
          seen.push(`${tokenId}:${mode}`);
          return {
            tokenId,
            pageCount: 1,
            scannedTradeCount: 0,
            insertedTradeCount: 0,
          };
        },
      },
    },
  );

  try {
    await service.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.getStatus().bootstrapTokenCount, 0);
    assert.deepEqual(seen, []);
  } finally {
    service.stop();
    db.close();
  }
});

test("service exposes latest price and rolling stats in token list and detail views", () => {
  const db = openDatabase(":memory:");

  db.upsertTrackedToken({
    tokenId: "token-30d",
    groupHex: "46token-30d",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.upsertTrackedToken({
    tokenId: "token-small",
    groupHex: "46token-small",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-30d", true, 1000);
  db.markTokenReady("token-small", true, 1000);
  db.insertProcessedTrades([
    makeProcessedTrade({
      tokenId: "token-30d",
      offerTxid: "offer-30d",
      outIdx: 0,
      spendTxid: "spend-30d",
      paidSats: "300",
      blockHeight: 2000,
      blockTimestamp: 20_000,
    }),
    makeProcessedTrade({
      tokenId: "token-30d",
      offerTxid: "offer-week",
      outIdx: 0,
      spendTxid: "spend-week",
      paidSats: "400",
      blockHeight: 4500,
      blockTimestamp: 45_000,
    }),
    makeProcessedTrade({
      tokenId: "token-30d",
      offerTxid: "offer-24h-early",
      outIdx: 0,
      spendTxid: "spend-24h-early",
      paidSats: "100",
      blockHeight: 4900,
      blockTimestamp: 49_000,
    }),
    makeProcessedTrade({
      tokenId: "token-30d",
      offerTxid: "offer-new",
      outIdx: 0,
      spendTxid: "spend-new",
      paidSats: "150",
      blockHeight: 5000,
      blockTimestamp: 50_000,
    }),
    makeProcessedTrade({
      tokenId: "token-small",
      offerTxid: "offer-small",
      outIdx: 0,
      spendTxid: "spend-small",
      paidSats: "100",
      blockHeight: 5000,
      blockTimestamp: 50_100,
    }),
  ]);
  db.recomputeAllTokenAggregateStats(5000);

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 5000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  try {
    const page = service.listTokens({
      page: 1,
      pageSize: 10,
      sort: "recent4320VolumeSats",
      order: "desc",
      readyOnly: true,
    });
    assert.equal(page.items[0]?.tokenId, "token-30d");
    assert.equal(page.items[0]?.recent4320TradeCount, 4);
    assert.equal(page.items[0]?.recent4320VolumeSats, "950");
    assert.equal(page.items[0]?.latestPriceNanosatsPerAtom, "150");
    assert.equal(page.items[0]?.recent144PriceChangeBps, "5000");
    assert.equal(page.items[0]?.recent144PriceChangePct, "50.00");

    const detail = service.getToken("token-30d");
    assert.equal(detail?.summary.recent4320TradeCount, 4);
    assert.equal(detail?.summary.recent4320VolumeSats, "950");
    assert.equal(detail?.summary.latestPriceNanosatsPerAtom, "150");
    assert.equal(detail?.summary.recent144PriceChangeBps, "5000");
    assert.equal(detail?.summary.recent144PriceChangePct, "50.00");

    const singleTradeToken = service.getToken("token-small");
    assert.equal(singleTradeToken?.summary.latestPriceNanosatsPerAtom, "100");
    assert.equal(singleTradeToken?.summary.recent144PriceChangeBps, "0");
    assert.equal(singleTradeToken?.summary.recent144PriceChangePct, "0.00");
  } finally {
    service.stop();
    db.close();
  }
});

test("service exposes token visit stats and analytics queries", () => {
  const db = openDatabase(":memory:");
  const nowMs = Date.now();
  const oneHourMs = 60 * 60 * 1000;

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
  db.markTokenReady("token-a", true, nowMs);
  db.markTokenReady("token-b", true, nowMs);
  db.recordApiAccess({
    routeKey: "tokens.detail",
    statusCode: 200,
    tokenId: "token-a",
    countTokenVisit: true,
    occurredAtMs: nowMs,
  });
  db.recordApiAccess({
    routeKey: "tokens.detail",
    statusCode: 200,
    tokenId: "token-a",
    countTokenVisit: true,
    occurredAtMs: nowMs - 30 * oneHourMs,
  });
  db.recordApiAccess({
    routeKey: "tokens.detail",
    statusCode: 200,
    tokenId: "token-b",
    countTokenVisit: true,
    occurredAtMs: nowMs - oneHourMs,
  });
  db.recordApiAccess({
    routeKey: "tokens.list",
    statusCode: 400,
    occurredAtMs: nowMs - oneHourMs,
  });

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 5000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  try {
    const tokens = service.listTokens({
      page: 1,
      pageSize: 10,
      readyOnly: true,
    });
    assert.deepEqual(tokens.items.slice(0, 2).map((item) => ({
      tokenId: item.tokenId,
      visitCountTotal: item.visitCountTotal,
      visitCount24h: item.visitCount24h,
    })), [
      {
        tokenId: "token-a",
        visitCountTotal: 2,
        visitCount24h: 1,
      },
      {
        tokenId: "token-b",
        visitCountTotal: 1,
        visitCount24h: 1,
      },
    ]);

    const tokenA = service.getToken("token-a");
    assert.equal(tokenA?.summary.visitCountTotal, 2);
    assert.equal(tokenA?.summary.visitCount24h, 1);
    assert.equal(tokenA?.summary.lastVisitedAt, nowMs);

    const summary = service.getAnalyticsSummary(48);
    assert.equal(summary.apiAccessCountTotal, 4);
    assert.equal(summary.tokenVisitCountTotal, 3);
    assert.equal(summary.apiAccessBuckets.length, 48);

    const endpoint = service.getEndpointAnalytics("tokens.detail", 48);
    assert.equal(endpoint.accessCountTotal, 3);
    assert.equal(endpoint.successCountTotal, 3);
    assert.equal(endpoint.buckets.length, 48);

    const visits = service.listTokenVisits({
      page: 1,
      pageSize: 10,
      sort: "visitsTotal",
      order: "desc",
    });
    assert.deepEqual(visits.items.slice(0, 2), [
      {
        tokenId: "token-a",
        visitCountTotal: 2,
        visitCount24h: 1,
        lastVisitedAt: nowMs,
      },
      {
        tokenId: "token-b",
        visitCountTotal: 1,
        visitCount24h: 1,
        lastVisitedAt: nowMs - oneHourMs,
      },
    ]);

    const tokenAnalytics = service.getTokenVisitAnalytics("token-a", 48);
    assert.equal(tokenAnalytics?.visitCountTotal, 2);
    assert.equal(tokenAnalytics?.visitCount24h, 1);
    assert.equal(tokenAnalytics?.visitCountWindow, 2);
    assert.equal(tokenAnalytics?.buckets.length, 48);

    assert.equal(service.getTokenVisitAnalytics("token-missing", 48), null);
  } finally {
    service.stop();
    db.close();
  }
});

test("service returns concrete trade history fields from stored trades", () => {
  const db = openDatabase(":memory:");

  db.upsertTrackedToken({
    tokenId: "token-trades",
    groupHex: "46token-trades",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-trades", true, 1000);
  db.insertProcessedTrades([
    makeProcessedTrade({
      tokenId: "token-trades",
      offerTxid: "offer-trades",
      outIdx: 3,
      spendTxid: "spend-trades",
      paidSats: "250",
      blockHeight: 5000,
      blockTimestamp: 50_000,
    }),
  ]);
  db.recomputeAllTokenAggregateStats(5000);

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 5000,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  try {
    const trades = service.listTokenTrades("token-trades", {
      page: 1,
      pageSize: 10,
    });
    assert.equal(trades.total, 1);
    assert.deepEqual(trades.items[0], {
      tokenId: "token-trades",
      offerTxid: "offer-trades",
      offerOutIdx: 3,
      spendTxid: "spend-trades",
      paidSats: "250",
      soldAtoms: "1",
      priceNanosatsPerAtom: "250",
      takerScriptHex: null,
      blockHeight: 5000,
      blockTimestamp: 50000,
    });
  } finally {
    service.stop();
    db.close();
  }
});

test("service returns aggregated token candles for charting", () => {
  const db = openDatabase(":memory:");

  db.upsertTrackedToken({
    tokenId: "token-candles",
    groupHex: "46token-candles",
    groupPrefixHex: "46",
    kind: "FUNGIBLE",
  });
  db.markTokenReady("token-candles", true, 1000);
  db.insertProcessedTrades([
    makeProcessedTrade({
      tokenId: "token-candles",
      offerTxid: "offer-open",
      outIdx: 0,
      spendTxid: "spend-open",
      paidSats: "300",
      blockHeight: 7000,
      blockTimestamp: Math.floor(Date.parse("2026-04-13T10:05:00+08:00") / 1000),
    }),
    makeProcessedTrade({
      tokenId: "token-candles",
      offerTxid: "offer-close",
      outIdx: 0,
      spendTxid: "spend-close",
      paidSats: "150",
      blockHeight: 7001,
      blockTimestamp: Math.floor(Date.parse("2026-04-13T10:45:00+08:00") / 1000),
    }),
  ]);

  const service = new AgoraTokenService(
    db,
    {
      chronik: {
        token: async () => { throw new Error("unused"); },
        plugin: () => ({}) as never,
        tx: async () => ({ txid: "unused", inputs: [], outputs: [] }) as never,
        ws: () =>
          ({
            subscribeToBlocks: () => {},
            waitForOpen: async () => {},
            close: () => {},
          }) as never,
        blockchainInfo: async () => ({
          tipHash: "tip",
          tipHeight: 7001,
        }),
      },
      agora: {
        historicOffers: async () => {
          throw new Error("unused");
        },
        subscribeWs: () => {},
        unsubscribeWs: () => {},
        offeredFungibleTokenIds: async () => [],
      },
    },
    BASE_CONFIG,
    {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  try {
    const candles = service.listTokenCandles("token-candles", {
      interval: "hour",
      limit: 5,
    });
    assert.deepEqual(candles, {
      tokenId: "token-candles",
      interval: "hour",
      timezone: "Asia/Shanghai",
      items: [
        {
          bucketStart: Math.floor(Date.parse("2026-04-13T10:00:00+08:00") / 1000),
          bucketEnd: Math.floor(Date.parse("2026-04-13T10:59:59+08:00") / 1000),
          openPriceNanosatsPerAtom: "300",
          highPriceNanosatsPerAtom: "300",
          lowPriceNanosatsPerAtom: "150",
          closePriceNanosatsPerAtom: "150",
          tradeCount: 2,
          volumeSats: "450",
          soldAtoms: "2",
        },
      ],
    });
  } finally {
    service.stop();
    db.close();
  }
});
