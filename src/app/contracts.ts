export type BootstrapPhase =
  | "starting"
  | "discovering"
  | "subscribing"
  | "initializing"
  | "ready"
  | "degraded"
  | "error";

export type TokenSortField =
  | "totalTradeCount"
  | "totalVolumeSats"
  | "latestPriceNanosatsPerAtom"
  | "recent144TradeCount"
  | "recent144VolumeSats"
  | "recent1008TradeCount"
  | "recent1008VolumeSats"
  | "recent4320TradeCount"
  | "recent4320VolumeSats"
  | "lastTradeBlockHeight"
  | "lastTradeBlockTimestamp";

export interface PaginationQuery {
  page: number;
  pageSize: number;
}

export interface TokenListQuery extends PaginationQuery {
  sort?: TokenSortField;
  order?: "asc" | "desc";
  readyOnly?: boolean;
}

export interface TradeListQuery extends PaginationQuery {
  tokenId?: string;
}

export type CandleInterval = "hour" | "day" | "week";

export interface TokenCandleQuery {
  interval: CandleInterval;
  limit: number;
}

export interface ServiceStatus {
  ready: boolean;
  phase: BootstrapPhase;
  wsConnected: boolean;
  chronikUrl: string;
  dbPath: string;
  dbSizeBytes: number | null;
  startedAt: string;
  statusDate: string;
  statusTimezone: string;
  tipHeight: number | null;
  totalTrackedTokenCount: number;
  activeTokenCount: number;
  readyTokenCount: number;
  tradedTokenCount: number;
  discoveredTodayCount: number;
  activeDiscoveredTodayCount: number;
  bootstrapTokenCount: number;
  bootstrapReadyCount: number;
  discoveryPageCount: number;
  lastDiscoveryAt: string | null;
  lastTipUpdateAt: string | null;
  lastError: string | null;
}

export interface TokenSummary {
  tokenId: string;
  isActive: boolean;
  isReady: boolean;
  bootstrapCohort: boolean;
  totalTradeCount: number;
  totalVolumeSats: string;
  latestPriceNanosatsPerAtom: string | null;
  recent144TradeCount: number;
  recent144VolumeSats: string;
  recent144PriceChangeBps: string;
  recent144PriceChangePct: string;
  recent1008TradeCount: number;
  recent1008VolumeSats: string;
  recent4320TradeCount: number;
  recent4320VolumeSats: string;
  lastTradeBlockHeight: number | null;
  lastTradeBlockTimestamp: number | null;
  lastSyncedAt: number | null;
  lastWsEventAt: number | null;
}

export interface TokenDetail {
  summary: TokenSummary;
  firstDiscoveredAt: number;
  lastDiscoveredAt: number;
  initStatus: string;
}

export interface TradeHistoryItem {
  tokenId: string;
  offerTxid: string;
  offerOutIdx: number;
  spendTxid: string;
  paidSats: string;
  soldAtoms: string;
  priceNanosatsPerAtom: string;
  takerScriptHex: string | null;
  blockHeight: number | null;
  blockTimestamp: number | null;
}

export interface TokenCandle {
  bucketStart: number;
  bucketEnd: number;
  openPriceNanosatsPerAtom: string;
  highPriceNanosatsPerAtom: string;
  lowPriceNanosatsPerAtom: string;
  closePriceNanosatsPerAtom: string;
  tradeCount: number;
  volumeSats: string;
  soldAtoms: string;
}

export interface TokenCandlesResult {
  tokenId: string;
  interval: CandleInterval;
  timezone: string;
  items: TokenCandle[];
}

export interface PaginatedResult<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

export interface ServiceReadApi {
  getStatus(): ServiceStatus;
  isReady(): boolean;
  listTokens(query: TokenListQuery): PaginatedResult<TokenSummary>;
  getToken(tokenId: string): TokenDetail | null;
  listTokenTrades(
    tokenId: string,
    query: TradeListQuery,
  ): PaginatedResult<TradeHistoryItem>;
  listTokenCandles(
    tokenId: string,
    query: TokenCandleQuery,
  ): TokenCandlesResult;
  listTrades(query: TradeListQuery): PaginatedResult<TradeHistoryItem>;
}
