import assert from "node:assert/strict";
import test from "node:test";

import { computeRollingStatsSnapshot } from "./stats.js";

test("computeRollingStatsSnapshot computes total and rolling windows from block buckets", () => {
  const snapshot = computeRollingStatsSnapshot(
    [
      {
        blockHeight: 100,
        tradeCount: 2,
        volumeSats: "300",
      },
      {
        blockHeight: 2000,
        tradeCount: 4,
        volumeSats: "500",
      },
      {
        blockHeight: 4500,
        tradeCount: 5,
        volumeSats: "700",
      },
      {
        blockHeight: 5000,
        tradeCount: 3,
        volumeSats: "900",
      },
    ],
    5000,
  );

  assert.deepEqual(snapshot, {
    totalTradeCount: 14,
    totalVolumeSats: "2400",
    recent144TradeCount: 3,
    recent144VolumeSats: "900",
    recent1008TradeCount: 8,
    recent1008VolumeSats: "1600",
    recent4320TradeCount: 12,
    recent4320VolumeSats: "2100",
  });
});
