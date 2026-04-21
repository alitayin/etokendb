export const ANALYTICS_ROUTE_KEYS = [
  "status",
  "tokens.list",
  "tokens.detail",
  "tokens.trades",
  "tokens.candles",
  "trades.list",
] as const;

export type AnalyticsRouteKey = (typeof ANALYTICS_ROUTE_KEYS)[number];

export interface ApiAccessRecord {
  routeKey: AnalyticsRouteKey;
  statusCode: number;
  occurredAtMs?: number;
  tokenId?: string | null;
  countTokenVisit?: boolean;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_ANALYTICS_HOURLY_RETENTION_HOURS = 90 * 24;
export const DEFAULT_ANALYTICS_QUERY_HOURS = 7 * 24;
export const ANALYTICS_PRUNE_INTERVAL_MS = DAY_MS;

const ANALYTICS_ROUTE_KEY_SET = new Set<AnalyticsRouteKey>(ANALYTICS_ROUTE_KEYS);

export function isAnalyticsRouteKey(value: string): value is AnalyticsRouteKey {
  return ANALYTICS_ROUTE_KEY_SET.has(value as AnalyticsRouteKey);
}

export function startOfHourMs(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

export function getBucketEndMs(bucketStartMs: number): number {
  return bucketStartMs + HOUR_MS - 1;
}

export function previousHoursWindowStartMs(
  nowMs: number,
  hours: number,
): number {
  return startOfHourMs(nowMs) - (hours - 1) * HOUR_MS;
}

export function retentionCutoffBucketStartMs(
  nowMs: number,
  retentionHours: number,
): number {
  return previousHoursWindowStartMs(nowMs, retentionHours);
}

export function getStatusCountDeltas(statusCode: number): {
  successDelta: number;
  clientErrorDelta: number;
  serverErrorDelta: number;
} {
  return {
    successDelta: statusCode >= 200 && statusCode < 400 ? 1 : 0,
    clientErrorDelta: statusCode >= 400 && statusCode < 500 ? 1 : 0,
    serverErrorDelta: statusCode >= 500 ? 1 : 0,
  };
}
