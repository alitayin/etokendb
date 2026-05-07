import assert from "node:assert/strict";
import test from "node:test";

import { encodeOutputScript, getOutputScriptFromAddress } from "ecashaddrjs";

import { openDatabase } from "../lib/db.js";
import type { AppConfig } from "../lib/config.js";
import { ReviewError } from "../lib/reviews.js";
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
};

const REVIEW_AUTHOR_ADDRESS =
  "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwva87rkuu2";
const REVIEW_PAYMENT_ADDRESS = REVIEW_AUTHOR_ADDRESS;
const OTHER_REVIEW_ADDRESS = encodeOutputScript(
  `76a914${"11".repeat(20)}88ac`,
);
const REVIEW_TOKEN_ID = "d".repeat(64);
const PROJECT_TOKEN_ID = "e".repeat(64);
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

test("project info invoice creation requires genesis authPubkey editor", async () => {
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
        error.code === "PROJECT_INFO_AUTH_PUBKEY_REQUIRED",
    );
  } finally {
    db.close();
  }
});

test("project info invoice creation rejects missing or invalid genesis authPubkey", async () => {
  const missing = makeReviewService({ projectAuthPubkey: null });
  try {
    await assert.rejects(
      () =>
        missing.service.createProjectInfoInvoice(PROJECT_TOKEN_ID, {
          editorAddress: PROJECT_EDITOR_ADDRESS,
          description: "Project info",
        }),
      (error) =>
        error instanceof ReviewError &&
        error.code === "PROJECT_INFO_AUTH_PUBKEY_REQUIRED",
    );
  } finally {
    missing.db.close();
  }

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

test("project info invoice publish rejects if genesis authPubkey changes before payment verification", async () => {
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
        error.code === "PROJECT_INFO_AUTH_PUBKEY_REQUIRED",
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

test("service performs a polling catch-up before ready when websocket bootstrap is unavailable", async () => {
  const db = openDatabase(":memory:");
  const tipHeights = [900_100, 900_101, 900_101];
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
          tipHeight: tipHeights.shift() ?? 900_101,
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
    assert.deepEqual(modes, ["full", "tail"]);
    assert.equal(service.isReady(), true);
    assert.equal(service.getStatus().phase, "degraded");
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
