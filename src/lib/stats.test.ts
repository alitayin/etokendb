import assert from "node:assert/strict";
import test from "node:test";

import { computeRollingStatsSnapshot } from "./stats.js";

test("computeRollingStatsSnapshot computes total and rolling windows from block buckets", () => {
  const snapshot = computeRollingStatsSnapshot(
    [
      {
        blockHeight: 500,
        tradeCount: 2,
        volumeSats: "300",
      },
      {
        blockHeight: 1900,
        tradeCount: 5,
        volumeSats: "700",
      },
      {
        blockHeight: 2000,
        tradeCount: 3,
        volumeSats: "900",
      },
    ],
    2000,
  );

  assert.deepEqual(snapshot, {
    totalTradeCount: 10,
    totalVolumeSats: "1900",
    recent144TradeCount: 8,
    recent144VolumeSats: "1600",
    recent1008TradeCount: 8,
    recent1008VolumeSats: "1600",
  });
});
