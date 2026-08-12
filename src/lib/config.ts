import "dotenv/config";

import { DEFAULT_ANALYTICS_HOURLY_RETENTION_HOURS } from "./analytics.js";
import {
  REVIEW_DEFAULT_BASE_FEE_SATS,
  REVIEW_DEFAULT_INVOICE_TTL_MS,
  REVIEW_DEFAULT_RETRY_INTERVAL_MS,
} from "./reviews.js";

export interface AppConfig {
  chronikUrl: string;
  chronikUrls?: string[];
  sqlitePath: string;
  serverPort: number;
  activeGroupPageSize: number;
  historyPageSize: number;
  tailPageCount: number;
  pollIntervalMs: number;
  discoveryIntervalMs: number;
  discoveryPageDelayMs?: number;
  tipRefreshIntervalMs: number;
  bootstrapConcurrency: number;
  apiPageSizeDefault: number;
  apiPageSizeMax: number;
  analyticsHourlyRetentionHours: number;
  reviewPaymentAddress: string | null;
  reviewBaseFeeSats: number;
  reviewInvoiceTtlMs: number;
  reviewRetryIntervalMs: number;
  projectInfoPaymentAddress: string | null;
  requestTimeoutMs: number;
  requestRetryCount: number;
  wsConnectTimeoutMs: number;
}

function readChronikUrls(): string[] {
  const rawUrls = process.env.CHRONIK_URLS?.trim();
  if (rawUrls) {
    const urls = rawUrls
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      throw new Error("CHRONIK_URLS must contain at least one URL");
    }
    return urls;
  }

  return [
    process.env.CHRONIK_URL?.trim() ||
      "https://chronik-native1.fabien.cash",
  ];
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }

  return value;
}

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }

  return value;
}

function normalizeProxyEnv(): void {
  const pairs = [
    ["http_proxy", "HTTP_PROXY"],
    ["https_proxy", "HTTPS_PROXY"],
    ["all_proxy", "ALL_PROXY"],
  ] as const;

  for (const [lower, upper] of pairs) {
    const lowerValue = process.env[lower]?.trim();
    const upperValue = process.env[upper]?.trim();

    if (lowerValue && !upperValue) {
      process.env[upper] = lowerValue;
    }

    if (upperValue && !lowerValue) {
      process.env[lower] = upperValue;
    }
  }
}

export function loadConfig(): AppConfig {
  normalizeProxyEnv();
  const chronikUrls = readChronikUrls();

  return {
    chronikUrl: chronikUrls[0],
    chronikUrls,
    sqlitePath: process.env.SQLITE_PATH?.trim() || "./data/etokendb.sqlite",
    serverPort: readPositiveInt("SERVER_PORT", 8787),
    activeGroupPageSize: readPositiveInt("ACTIVE_GROUP_PAGE_SIZE", 50),
    historyPageSize: readPositiveInt("HISTORY_PAGE_SIZE", 200),
    tailPageCount: readPositiveInt("TAIL_PAGE_COUNT", 2),
    pollIntervalMs: readPositiveInt("POLL_INTERVAL_MS", 60_000),
    discoveryIntervalMs: readPositiveInt("DISCOVERY_INTERVAL_MS", 60 * 60_000),
    discoveryPageDelayMs: readNonNegativeInt("DISCOVERY_PAGE_DELAY_MS", 100),
    tipRefreshIntervalMs: readPositiveInt("TIP_REFRESH_INTERVAL_MS", 60_000),
    bootstrapConcurrency: readPositiveInt("BOOTSTRAP_CONCURRENCY", 8),
    apiPageSizeDefault: readPositiveInt("API_PAGE_SIZE_DEFAULT", 50),
    apiPageSizeMax: readPositiveInt("API_PAGE_SIZE_MAX", 200),
    analyticsHourlyRetentionHours: readPositiveInt(
      "ANALYTICS_HOURLY_RETENTION_HOURS",
      DEFAULT_ANALYTICS_HOURLY_RETENTION_HOURS,
    ),
    reviewPaymentAddress: process.env.REVIEW_PAYMENT_ADDRESS?.trim() || null,
    reviewBaseFeeSats: readPositiveInt(
      "REVIEW_BASE_FEE_SATS",
      REVIEW_DEFAULT_BASE_FEE_SATS,
    ),
    reviewInvoiceTtlMs: readPositiveInt(
      "REVIEW_INVOICE_TTL_MS",
      REVIEW_DEFAULT_INVOICE_TTL_MS,
    ),
    reviewRetryIntervalMs: readPositiveInt(
      "REVIEW_RETRY_INTERVAL_MS",
      REVIEW_DEFAULT_RETRY_INTERVAL_MS,
    ),
    projectInfoPaymentAddress:
      process.env.PROJECT_INFO_PAYMENT_ADDRESS?.trim() ||
      process.env.REVIEW_PAYMENT_ADDRESS?.trim() ||
      null,
    requestTimeoutMs: readPositiveInt("REQUEST_TIMEOUT_MS", 20_000),
    requestRetryCount: readPositiveInt("REQUEST_RETRY_COUNT", 3),
    wsConnectTimeoutMs: readPositiveInt("WS_CONNECT_TIMEOUT_MS", 10_000),
  };
}
