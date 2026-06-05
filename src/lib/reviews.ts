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
export const REVIEW_STAR_SHARD_TOKEN_ID =
  "d1131675cb62b65909fb45ba53b022da0bd0f34aaa71fc61770115472b186ffb";
export const REVIEW_STAR_CRYSTAL_TOKEN_ID =
  "ac31bb0bccf33de1683efce4da64f1cb6d8e8d6e098bc01c51d5864deb0e783f";

export type ReviewPaymentKind = "xec" | "token";
export type ReviewPaymentTokenSymbol = "SS" | "SC";

export interface ReviewPaymentTokenConfig {
  symbol: ReviewPaymentTokenSymbol;
  tokenId: string;
  creditSatsPerAtom: number;
}

export const REVIEW_PAYMENT_TOKEN_CONFIGS: ReviewPaymentTokenConfig[] = [
  {
    symbol: "SS",
    tokenId: REVIEW_STAR_SHARD_TOKEN_ID,
    creditSatsPerAtom: 500,
  },
  {
    symbol: "SC",
    tokenId: REVIEW_STAR_CRYSTAL_TOKEN_ID,
    creditSatsPerAtom: 30_000,
  },
];

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
  paymentKind: ReviewPaymentKind;
  paymentTokenId: string | null;
  paymentTokenSymbol: ReviewPaymentTokenSymbol | null;
  creditSatsPerAtom: number | null;
  expectedPaidAtoms: string | null;
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
  paymentKind?: ReviewPaymentKind;
  paymentTokenId?: string | null;
  paymentTokenSymbol?: ReviewPaymentTokenSymbol | null;
  creditSatsPerAtom?: number | null;
  expectedPaidAtoms?: string | null;
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

export function getReviewPaymentTokenConfig(
  symbol: ReviewPaymentTokenSymbol,
): ReviewPaymentTokenConfig {
  const config = REVIEW_PAYMENT_TOKEN_CONFIGS.find(
    (entry) => entry.symbol === symbol,
  );
  if (!config) {
    throw new ReviewError(
      400,
      "INVALID_REVIEW_PAYMENT_TOKEN",
      "paymentTokenSymbol must be SS or SC",
    );
  }
  return config;
}

export function normalizeReviewPaymentKind(
  value: unknown,
): ReviewPaymentKind {
  if (value === undefined || value === null || value === "") {
    return "xec";
  }
  if (value === "xec" || value === "token") {
    return value;
  }
  throw new ReviewError(
    400,
    "INVALID_REVIEW_PAYMENT_KIND",
    "paymentKind must be xec or token",
  );
}

export function normalizeReviewPaymentTokenSymbol(
  value: unknown,
): ReviewPaymentTokenSymbol {
  if (value === "SS" || value === "SC") {
    return value;
  }
  if (typeof value === "string") {
    const upperValue = value.trim().toUpperCase();
    if (upperValue === "SS" || upperValue === "SC") {
      return upperValue;
    }
  }
  throw new ReviewError(
    400,
    "INVALID_REVIEW_PAYMENT_TOKEN",
    "paymentTokenSymbol must be SS or SC",
  );
}

export function calculateExpectedPaidAtoms(
  requiredSats: number,
  creditSatsPerAtom: number,
): string {
  if (!Number.isInteger(requiredSats) || requiredSats <= 0) {
    throw new ReviewError(
      500,
      "INVALID_REVIEW_PAYMENT_AMOUNT",
      "required sats must be a positive integer",
    );
  }
  if (!Number.isInteger(creditSatsPerAtom) || creditSatsPerAtom <= 0) {
    throw new ReviewError(
      500,
      "INVALID_REVIEW_PAYMENT_TOKEN",
      "creditSatsPerAtom must be a positive integer",
    );
  }

  const sats = BigInt(requiredSats);
  const credit = BigInt(creditSatsPerAtom);
  return ((sats + credit - 1n) / credit).toString();
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
    | "authorAddress"
    | "paymentAddress"
    | "expectedPaidSats"
    | "paymentKind"
    | "paymentTokenId"
    | "paymentTokenSymbol"
    | "creditSatsPerAtom"
    | "expectedPaidAtoms"
    | "createdAt"
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

  const paymentSeenAt = getReviewPaymentSeenAt(params.tx, params.nowMs);
  if (params.invoice.paymentKind === "token") {
    verifyReviewTokenPaymentTx({
      tx: params.tx,
      invoice: params.invoice,
      authorOutputScript,
      paymentOutputScript,
      paymentSeenAt,
    });
    return {
      paidSats: params.invoice.expectedPaidSats,
      paymentSeenAt,
      paymentBlockHeight: params.tx.block?.height ?? null,
      paymentBlockTimestamp: params.tx.block?.timestamp ?? null,
    };
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
    paymentSeenAt,
    paymentBlockHeight: params.tx.block?.height ?? null,
    paymentBlockTimestamp: params.tx.block?.timestamp ?? null,
  };
}

function getReviewPaymentSeenAt(tx: Tx, nowMs: number): number {
  if (Number.isFinite(tx.timeFirstSeen) && tx.timeFirstSeen > 0) {
    return tx.timeFirstSeen * 1000;
  }
  if (
    tx.block &&
    Number.isFinite(tx.block.timestamp) &&
    tx.block.timestamp > 0
  ) {
    return tx.block.timestamp * 1000;
  }
  return nowMs;
}

function verifyReviewTokenPaymentTx(params: {
  tx: Tx;
  invoice: Pick<
    ReviewInvoiceRecord,
    | "paymentTokenId"
    | "paymentTokenSymbol"
    | "creditSatsPerAtom"
    | "expectedPaidAtoms"
    | "createdAt"
  >;
  authorOutputScript: string;
  paymentOutputScript: string;
  paymentSeenAt: number;
}): void {
  const tokenId = params.invoice.paymentTokenId?.toLowerCase();
  const expectedPaidAtomsRaw = params.invoice.expectedPaidAtoms;
  if (
    !tokenId ||
    !params.invoice.paymentTokenSymbol ||
    !params.invoice.creditSatsPerAtom ||
    !expectedPaidAtomsRaw
  ) {
    throw new ReviewError(
      500,
      "REVIEW_PAYMENT_CONFIG_INVALID",
      "token review invoice is missing payment token configuration",
    );
  }

  const expectedPaidAtoms = BigInt(expectedPaidAtomsRaw);
  if (expectedPaidAtoms <= 0n) {
    throw new ReviewError(
      500,
      "REVIEW_PAYMENT_CONFIG_INVALID",
      "token review invoice expected atoms must be positive",
    );
  }

  if (params.paymentSeenAt < params.invoice.createdAt) {
    throw new ReviewError(
      400,
      "PAYMENT_BEFORE_INVOICE",
      "token payment tx must be first seen after the invoice was created",
    );
  }

  const hasAuthorTokenInput = params.tx.inputs.some(
    (input) =>
      input.outputScript?.toLowerCase() === params.authorOutputScript &&
      input.token?.tokenId.toLowerCase() === tokenId &&
      input.token.isMintBaton !== true &&
      input.token.atoms > 0n,
  );
  if (!hasAuthorTokenInput) {
    throw new ReviewError(
      400,
      "PAYMENT_AUTHOR_MISMATCH",
      "token payment tx must spend the expected token from authorAddress",
    );
  }

  const hasTokenPaymentOutput = params.tx.outputs.some(
    (output) =>
      output.outputScript.toLowerCase() === params.paymentOutputScript &&
      output.token?.tokenId.toLowerCase() === tokenId &&
      output.token.isMintBaton !== true &&
      output.token.atoms >= expectedPaidAtoms,
  );
  if (!hasTokenPaymentOutput) {
    throw new ReviewError(
      400,
      "PAYMENT_OUTPUT_MISMATCH",
      "payment tx must pay at least the expected token atoms to the configured review address",
    );
  }
}
