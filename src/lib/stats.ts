import type {
  TokenBlockStatsRecord,
  TokenRollingStatsSnapshot,
} from "./types.js";

export const RECENT_WINDOW_144_BLOCKS = 144;
export const RECENT_WINDOW_1008_BLOCKS = 1008;

export function computeRollingStatsSnapshot(
  buckets: Array<Pick<TokenBlockStatsRecord, "blockHeight" | "tradeCount" | "volumeSats">>,
  chainTipHeight: number,
): TokenRollingStatsSnapshot {
  let totalTradeCount = 0;
  let totalVolumeSats = 0n;
  let recent144TradeCount = 0;
  let recent144VolumeSats = 0n;
  let recent1008TradeCount = 0;
  let recent1008VolumeSats = 0n;

  const minHeight144 = chainTipHeight - (RECENT_WINDOW_144_BLOCKS - 1);
  const minHeight1008 = chainTipHeight - (RECENT_WINDOW_1008_BLOCKS - 1);

  for (const bucket of buckets) {
    totalTradeCount += bucket.tradeCount;
    const volume = BigInt(bucket.volumeSats);
    totalVolumeSats += volume;

    if (bucket.blockHeight >= minHeight1008) {
      recent1008TradeCount += bucket.tradeCount;
      recent1008VolumeSats += volume;
    }

    if (bucket.blockHeight >= minHeight144) {
      recent144TradeCount += bucket.tradeCount;
      recent144VolumeSats += volume;
    }
  }

  return {
    totalTradeCount,
    totalVolumeSats: totalVolumeSats.toString(),
    recent144TradeCount,
    recent144VolumeSats: recent144VolumeSats.toString(),
    recent1008TradeCount,
    recent1008VolumeSats: recent1008VolumeSats.toString(),
  };
}
