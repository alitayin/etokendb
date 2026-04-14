export type ActiveTokenGroupKind = "FUNGIBLE" | "NFT_GROUP";
export type TokenInitStatus = "PENDING" | "INITIALIZING" | "READY" | "ERROR";

export type TokenStatsSortField =
  | "trade_count"
  | "cumulative_paid_sats"
  | "recent_144_trade_count"
  | "recent_144_volume_sats"
  | "recent_1008_trade_count"
  | "recent_1008_volume_sats"
  | "recent_4320_trade_count"
  | "recent_4320_volume_sats"
  | "last_trade_block_height"
  | "last_trade_block_timestamp";

export interface ListTokenStatsPageOptions {
  limit: number;
  offset?: number;
  sortBy?: TokenStatsSortField;
  order?: "asc" | "desc";
  readyOnly?: boolean;
}

export interface ListTradeHistoryOptions {
  tokenId?: string;
  limit: number;
  offset?: number;
  order?: "asc" | "desc";
}

export interface ActiveTokenSeed {
  tokenId: string;
  groupHex: string;
  groupPrefixHex: string;
  kind: ActiveTokenGroupKind;
}

export interface ProcessedTradeRecord {
  offerTxid: string;
  offerOutIdx: number;
  spendTxid: string;
  tokenId: string;
  variantType: "ONESHOT" | "PARTIAL";
  paidSats: string;
  soldAtoms: string;
  priceNanosatsPerAtom: string;
  takerScriptHex: string | null;
  blockHeight: number | null;
  blockHash: string | null;
  blockTimestamp: number | null;
  rawTradeJson: string;
}

export interface TokenStatsRecord {
  tokenId: string;
  tradeCount: number;
  cumulativePaidSats: string;
  lastTradeOfferTxid: string | null;
  lastTradeOfferOutIdx: number | null;
  lastTradeBlockHeight: number | null;
  lastTradeBlockTimestamp: number | null;
}

export interface TokenAggregateStatsRecord extends TokenStatsRecord {
  recent144TradeCount: number;
  recent144VolumeSats: string;
  recent1008TradeCount: number;
  recent1008VolumeSats: string;
  recent4320TradeCount: number;
  recent4320VolumeSats: string;
  updatedAt: number;
}

export interface TokenStatsPageRow extends TokenAggregateStatsRecord {
  isActive: boolean;
  isReady: boolean;
  bootstrapCohort: boolean;
  initStatus: TokenInitStatus;
  lastSyncedAt: number | null;
}

export interface TokenBlockStatsRecord {
  tokenId: string;
  blockHeight: number;
  tradeCount: number;
  volumeSats: string;
  updatedAt: number;
}

export interface TrackedTokenRecord {
  tokenId: string;
  groupHex: string;
  groupPrefixHex: string;
  kind: ActiveTokenGroupKind;
  discoverySource: string;
  firstDiscoveredAt: number;
  lastDiscoveredAt: number;
  isActive: boolean;
  isReady: boolean;
  bootstrapCohort: boolean;
  initStatus: TokenInitStatus;
  initStartedAt: number | null;
  initCompletedAt: number | null;
  lastInitError: string | null;
  lastSyncedAt: number | null;
  lastWsEventAt: number | null;
}

export interface TokenRollingStatsSnapshot {
  totalTradeCount: number;
  totalVolumeSats: string;
  recent144TradeCount: number;
  recent144VolumeSats: string;
  recent1008TradeCount: number;
  recent1008VolumeSats: string;
  recent4320TradeCount: number;
  recent4320VolumeSats: string;
}

export interface TradeHistoryRow extends ProcessedTradeRecord {
  insertedAt: number;
}

export interface TokenSyncResult {
  tokenId: string;
  pageCount: number;
  scannedTradeCount: number;
  insertedTradeCount: number;
}
