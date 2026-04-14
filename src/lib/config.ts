import "dotenv/config";

export interface AppConfig {
  chronikUrl: string;
  sqlitePath: string;
  serverPort: number;
  activeGroupPageSize: number;
  historyPageSize: number;
  tailPageCount: number;
  pollIntervalMs: number;
  discoveryIntervalMs: number;
  tipRefreshIntervalMs: number;
  bootstrapConcurrency: number;
  apiPageSizeDefault: number;
  apiPageSizeMax: number;
  requestTimeoutMs: number;
  requestRetryCount: number;
  wsConnectTimeoutMs: number;
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

  return {
    chronikUrl:
      process.env.CHRONIK_URL?.trim() || "https://chronik-native1.fabien.cash",
    sqlitePath: process.env.SQLITE_PATH?.trim() || "./data/etokendb.sqlite",
    serverPort: readPositiveInt("SERVER_PORT", 8787),
    activeGroupPageSize: readPositiveInt("ACTIVE_GROUP_PAGE_SIZE", 50),
    historyPageSize: readPositiveInt("HISTORY_PAGE_SIZE", 200),
    tailPageCount: readPositiveInt("TAIL_PAGE_COUNT", 2),
    pollIntervalMs: readPositiveInt("POLL_INTERVAL_MS", 60_000),
    discoveryIntervalMs: readPositiveInt("DISCOVERY_INTERVAL_MS", 60_000),
    tipRefreshIntervalMs: readPositiveInt("TIP_REFRESH_INTERVAL_MS", 60_000),
    bootstrapConcurrency: readPositiveInt("BOOTSTRAP_CONCURRENCY", 8),
    apiPageSizeDefault: readPositiveInt("API_PAGE_SIZE_DEFAULT", 50),
    apiPageSizeMax: readPositiveInt("API_PAGE_SIZE_MAX", 200),
    requestTimeoutMs: readPositiveInt("REQUEST_TIMEOUT_MS", 20_000),
    requestRetryCount: readPositiveInt("REQUEST_RETRY_COUNT", 3),
    wsConnectTimeoutMs: readPositiveInt("WS_CONNECT_TIMEOUT_MS", 10_000),
  };
}
