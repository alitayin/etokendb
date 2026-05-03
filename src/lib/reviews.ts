import type { Tx } from "chronik-client";
import {
  encodeOutputScript,
  getOutputScriptFromAddress,
} from "ecashaddrjs";

export const REVIEW_COMMENT_MAX_BYTES = 500;
export const REVIEW_INVOICE_VERIFIER_MIN_SATS = 1;
export const REVIEW_INVOICE_VERIFIER_MAX_SATS = 9_999;
export const REVIEW_DEFAULT_BASE_FEE_SATS = 10_000_000;
export const REVIEW_DEFAULT_INVOICE_TTL_MS = 30 * 60 * 1000;
export const REVIEW_DEFAULT_RETRY_INTERVAL_MS = 60 * 1000;

export type ReviewInvoiceStatus =
  | "pending"
  | "tx_submitted"
  | "published"
  | "invalid"
  | "expired";

export interface ReviewInvoiceRecord {
  invoiceId: string;
  tokenId: string;
  authorAddress: string;
  score: number;
  commentText: string;
  paymentAddress: string;
  expectedPaidSats: number;
  verifierSats: number;
  status: ReviewInvoiceStatus;
  paymentTxid: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  publishedReviewId: string | null;
}

export interface CreateReviewInvoiceRecord {
  invoiceId: string;
  tokenId: string;
  authorAddress: string;
  score: number;
  commentText: string;
  paymentAddress: string;
  expectedPaidSats: number;
  verifierSats: number;
  expiresAt: number;
  createdAt: number;
}

export interface TokenReviewRecord {
  reviewId: string;
  invoiceId: string;
  tokenId: string;
  authorAddress: string;
  score: number;
  commentText: string;
  paymentTxid: string;
  paidSats: number;
  paymentSeenAt: number;
  paymentBlockHeight: number | null;
  paymentBlockTimestamp: number | null;
  createdAt: number;
}

export interface PublishTokenReviewRecord {
  reviewId: string;
  invoiceId: string;
  tokenId: string;
  authorAddress: string;
  score: number;
  commentText: string;
  paymentTxid: string;
  paidSats: number;
  paymentSeenAt: number;
  paymentBlockHeight: number | null;
  paymentBlockTimestamp: number | null;
  createdAt: number;
}

export interface TokenReviewSummaryRecord {
  averageScore: number | null;
  scorerCount: number;
  reviewCountTotal: number;
  commentCountTotal: number;
  lastReviewAt: number | null;
}

export interface ReviewPaymentVerification {
  paidSats: number;
  paymentSeenAt: number;
  paymentBlockHeight: number | null;
  paymentBlockTimestamp: number | null;
}

export class ReviewError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isValidTokenId(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

export function normalizeTokenId(value: string): string {
  const tokenId = value.trim().toLowerCase();
  if (!isValidTokenId(tokenId)) {
    throw new ReviewError(
      400,
      "INVALID_TOKEN_ID",
      "tokenId must be a 64-character hex string",
    );
  }
  return tokenId;
}

export function normalizeTxid(value: string): string {
  const txid = value.trim().toLowerCase();
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new ReviewError(
      400,
      "INVALID_TXID",
      "txid must be a 64-character hex string",
    );
  }
  return txid;
}

export function normalizeScore(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new ReviewError(
      400,
      "INVALID_SCORE",
      "score must be an integer from 0 to 10",
    );
  }
  return value;
}

export function normalizeComment(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ReviewError(400, "INVALID_COMMENT", "comment must be a string");
  }
  if (Buffer.byteLength(value, "utf8") > REVIEW_COMMENT_MAX_BYTES) {
    throw new ReviewError(
      400,
      "COMMENT_TOO_LONG",
      `comment must be at most ${REVIEW_COMMENT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

export function normalizeEcashAddress(value: string, fieldName: string): string {
  const address = value.trim();
  if (address.length === 0) {
    throw new ReviewError(400, "INVALID_ADDRESS", `${fieldName} is required`);
  }

  try {
    return encodeOutputScript(getOutputScriptFromAddress(address), "ecash");
  } catch {
    throw new ReviewError(
      400,
      "INVALID_ADDRESS",
      `${fieldName} must be a valid eCash p2pkh or p2sh address`,
    );
  }
}

export function getEcashOutputScript(value: string, fieldName: string): string {
  try {
    return getOutputScriptFromAddress(value).toLowerCase();
  } catch {
    throw new ReviewError(
      400,
      "INVALID_ADDRESS",
      `${fieldName} must be a valid eCash p2pkh or p2sh address`,
    );
  }
}

export function normalizeVerifierSats(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < REVIEW_INVOICE_VERIFIER_MIN_SATS ||
    value > REVIEW_INVOICE_VERIFIER_MAX_SATS
  ) {
    throw new ReviewError(
      500,
      "INVALID_VERIFIER_SATS",
      `verifier_sats must be between ${REVIEW_INVOICE_VERIFIER_MIN_SATS} and ${REVIEW_INVOICE_VERIFIER_MAX_SATS}`,
    );
  }
  return value;
}

export function satsToXecString(sats: number): string {
  const whole = Math.floor(sats / 100);
  const fraction = Math.abs(sats % 100).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

export function maskEcashAddress(address: string): string {
  const [prefix, payload] = address.includes(":")
    ? (address.split(":", 2) as [string, string])
    : ["ecash", address];
  if (payload.length <= 5) {
    return `${prefix}:${payload}`;
  }
  return `${prefix}:${payload.slice(0, 1)}...${payload.slice(-4)}`;
}

export function verifyReviewPaymentTx(params: {
  tx: Tx;
  txid: string;
  invoice: Pick<
    ReviewInvoiceRecord,
    "authorAddress" | "paymentAddress" | "expectedPaidSats"
  >;
  nowMs: number;
}): ReviewPaymentVerification {
  const txid = normalizeTxid(params.txid);
  if (params.tx.txid.toLowerCase() !== txid) {
    throw new ReviewError(
      400,
      "PAYMENT_TXID_MISMATCH",
      "Chronik returned a transaction with a different txid",
    );
  }

  const authorOutputScript = getEcashOutputScript(
    params.invoice.authorAddress,
    "authorAddress",
  );
  const paymentOutputScript = getEcashOutputScript(
    params.invoice.paymentAddress,
    "paymentAddress",
  );
  const expectedPaidSats = BigInt(params.invoice.expectedPaidSats);

  const hasAuthorInput = params.tx.inputs.some(
    (input) => input.outputScript?.toLowerCase() === authorOutputScript,
  );
  if (!hasAuthorInput) {
    throw new ReviewError(
      400,
      "PAYMENT_AUTHOR_MISMATCH",
      "payment tx must spend at least one input from authorAddress",
    );
  }

  const hasExactPaymentOutput = params.tx.outputs.some(
    (output) =>
      output.outputScript.toLowerCase() === paymentOutputScript &&
      output.sats === expectedPaidSats,
  );
  if (!hasExactPaymentOutput) {
    throw new ReviewError(
      400,
      "PAYMENT_OUTPUT_MISMATCH",
      "payment tx must pay the exact expected sats to the configured review address",
    );
  }

  return {
    paidSats: params.invoice.expectedPaidSats,
    paymentSeenAt:
      Number.isFinite(params.tx.timeFirstSeen) && params.tx.timeFirstSeen > 0
        ? params.tx.timeFirstSeen * 1000
        : params.nowMs,
    paymentBlockHeight: params.tx.block?.height ?? null,
    paymentBlockTimestamp: params.tx.block?.timestamp ?? null,
  };
}
