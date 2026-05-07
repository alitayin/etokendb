import type { Tx } from "chronik-client";

import {
  ReviewError,
  getEcashOutputScript,
  normalizeTxid,
} from "./reviews.js";

export const PROJECT_INFO_DESCRIPTION_MAX_BYTES = 1000;
export const PROJECT_INFO_URL_MAX_CHARS = 500;
export const PROJECT_INFO_INITIAL_FEE_SATS = 100_000_000;
export const PROJECT_INFO_UPDATE_FEE_SATS = 10_000_000;
export const PROJECT_INFO_TEST_TOKEN_ID =
  "5cb20c6cdeaee3abf53f7dcaaa1092ad10a0e2e9dcd94ee07272b631e65d7371";
export const PROJECT_INFO_TEST_FEE_SATS = 10_000;

export type ProjectInfoInvoiceStatus =
  | "pending"
  | "tx_submitted"
  | "published"
  | "invalid"
  | "expired";

export type ProjectInfoFeeTier = "initial" | "update";

export interface ProjectInfoFields {
  description: string;
  websiteUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
}

export interface TokenProjectInfoRecord extends ProjectInfoFields {
  tokenId: string;
  createdAt: number;
  updatedAt: number;
  updateCount: number;
  lastEditorAddress: string;
  lastPaymentTxid: string;
  lastPaidSats: number;
  lastPaymentSeenAt: number;
  lastPaymentBlockHeight: number | null;
  lastPaymentBlockTimestamp: number | null;
}

export interface ProjectInfoInvoiceRecord extends ProjectInfoFields {
  invoiceId: string;
  tokenId: string;
  editorAddress: string;
  paymentAddress: string;
  expectedPaidSats: number;
  feeTier: ProjectInfoFeeTier;
  status: ProjectInfoInvoiceStatus;
  paymentTxid: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInfoInvoiceRecord extends ProjectInfoFields {
  invoiceId: string;
  tokenId: string;
  editorAddress: string;
  paymentAddress: string;
  expectedPaidSats: number;
  feeTier: ProjectInfoFeeTier;
  expiresAt: number;
  createdAt: number;
}

export interface PublishTokenProjectInfoRecord extends ProjectInfoFields {
  invoiceId: string;
  tokenId: string;
  editorAddress: string;
  paymentTxid: string;
  paidSats: number;
  paymentSeenAt: number;
  paymentBlockHeight: number | null;
  paymentBlockTimestamp: number | null;
  updatedAt: number;
}

export interface ProjectInfoPaymentVerification {
  paidSats: number;
  paymentSeenAt: number;
  paymentBlockHeight: number | null;
  paymentBlockTimestamp: number | null;
}

export function getProjectInfoFeeSats(
  tokenId: string,
  hasExistingInfo: boolean,
): number {
  if (tokenId.toLowerCase() === PROJECT_INFO_TEST_TOKEN_ID) {
    return PROJECT_INFO_TEST_FEE_SATS;
  }
  return hasExistingInfo
    ? PROJECT_INFO_UPDATE_FEE_SATS
    : PROJECT_INFO_INITIAL_FEE_SATS;
}

function normalizeStringField(value: unknown, fieldName: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ReviewError(400, "INVALID_PROJECT_INFO", `${fieldName} must be a string`);
  }
  return value.trim();
}

function normalizeOptionalUrl(
  value: unknown,
  fieldName: string,
  predicate: (url: URL) => boolean,
  message: string,
): string | null {
  const rawValue = normalizeStringField(value, fieldName);
  if (rawValue.length === 0) {
    return null;
  }
  if (rawValue.length > PROJECT_INFO_URL_MAX_CHARS) {
    throw new ReviewError(
      400,
      "PROJECT_INFO_URL_TOO_LONG",
      `${fieldName} must be at most ${PROJECT_INFO_URL_MAX_CHARS} characters`,
    );
  }

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new ReviewError(400, "INVALID_PROJECT_INFO_URL", message);
  }

  if (!predicate(url)) {
    throw new ReviewError(400, "INVALID_PROJECT_INFO_URL", message);
  }

  const normalized = url.href;
  if (normalized.length > PROJECT_INFO_URL_MAX_CHARS) {
    throw new ReviewError(
      400,
      "PROJECT_INFO_URL_TOO_LONG",
      `${fieldName} must be at most ${PROJECT_INFO_URL_MAX_CHARS} characters`,
    );
  }
  return normalized;
}

function isAllowedSocialHost(url: URL, hosts: Set<string>): boolean {
  return url.protocol === "https:" && hosts.has(url.hostname.toLowerCase());
}

export function hasAnyProjectInfoField(fields: ProjectInfoFields): boolean {
  return (
    fields.description.length > 0 ||
    fields.websiteUrl !== null ||
    fields.xUrl !== null ||
    fields.telegramUrl !== null
  );
}

export function normalizeProjectInfoFields(
  input: {
    description?: unknown;
    websiteUrl?: unknown;
    xUrl?: unknown;
    telegramUrl?: unknown;
  },
  options: { allowEmpty: boolean },
): ProjectInfoFields {
  const description = normalizeStringField(input.description, "description");
  if (Buffer.byteLength(description, "utf8") > PROJECT_INFO_DESCRIPTION_MAX_BYTES) {
    throw new ReviewError(
      400,
      "PROJECT_INFO_DESCRIPTION_TOO_LONG",
      `description must be at most ${PROJECT_INFO_DESCRIPTION_MAX_BYTES} UTF-8 bytes`,
    );
  }

  const websiteUrl = normalizeOptionalUrl(
    input.websiteUrl,
    "websiteUrl",
    (url) => url.protocol === "http:" || url.protocol === "https:",
    "websiteUrl must be an http:// or https:// URL",
  );
  const xUrl = normalizeOptionalUrl(
    input.xUrl,
    "xUrl",
    (url) =>
      isAllowedSocialHost(
        url,
        new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
      ),
    "xUrl must be a https://x.com/... or https://twitter.com/... URL",
  );
  const telegramUrl = normalizeOptionalUrl(
    input.telegramUrl,
    "telegramUrl",
    (url) =>
      isAllowedSocialHost(
        url,
        new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me"]),
      ),
    "telegramUrl must be a https://t.me/... or https://telegram.me/... URL",
  );

  const fields = {
    description,
    websiteUrl,
    xUrl,
    telegramUrl,
  };
  if (!options.allowEmpty && !hasAnyProjectInfoField(fields)) {
    throw new ReviewError(
      400,
      "PROJECT_INFO_EMPTY",
      "initial project info must include at least one field",
    );
  }

  return fields;
}

export function verifyProjectInfoPaymentTx(params: {
  tx: Tx;
  txid: string;
  invoice: Pick<
    ProjectInfoInvoiceRecord,
    "editorAddress" | "paymentAddress" | "expectedPaidSats"
  >;
  nowMs: number;
}): ProjectInfoPaymentVerification {
  const txid = normalizeTxid(params.txid);
  if (params.tx.txid.toLowerCase() !== txid) {
    throw new ReviewError(
      400,
      "PAYMENT_TXID_MISMATCH",
      "Chronik returned a transaction with a different txid",
    );
  }

  const editorOutputScript = getEcashOutputScript(
    params.invoice.editorAddress,
    "editorAddress",
  );
  const paymentOutputScript = getEcashOutputScript(
    params.invoice.paymentAddress,
    "paymentAddress",
  );
  const expectedPaidSats = BigInt(params.invoice.expectedPaidSats);

  const hasEditorInput = params.tx.inputs.some(
    (input) => input.outputScript?.toLowerCase() === editorOutputScript,
  );
  if (!hasEditorInput) {
    throw new ReviewError(
      400,
      "PAYMENT_AUTHOR_MISMATCH",
      "payment tx must spend at least one input from editorAddress",
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
      "payment tx must pay the exact expected sats to the configured project info address",
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
