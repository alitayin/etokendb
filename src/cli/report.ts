import fs from "node:fs";

import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  tsx src/cli/report.ts status",
      "  tsx src/cli/report.ts tokens [limit]",
      "  tsx src/cli/report.ts token <tokenId> [tradeLimit]",
    ].join("\n"),
  );
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function getTodayStartMs(now = new Date()): number {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();
}

function getDbSizeBytes(sqlitePath: string): number | null {
  if (sqlitePath === ":memory:") {
    return null;
  }

  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${sqlitePath}${suffix}`;
    try {
      total += fs.statSync(path).size;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }
  return total;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.sqlitePath);
  const [command, arg1, arg2] = process.argv.slice(2);

  try {
    switch (command) {
      case "status": {
        const todayStartMs = getTodayStartMs();
        const trackedRow = db.sqlite
          .prepare(
            `
              SELECT
                COUNT(*) AS tracked_count,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_count,
                SUM(CASE WHEN is_ready = 1 THEN 1 ELSE 0 END) AS ready_count,
                SUM(CASE WHEN bootstrap_cohort = 1 THEN 1 ELSE 0 END) AS bootstrap_count,
                SUM(CASE WHEN bootstrap_cohort = 1 AND is_ready = 1 THEN 1 ELSE 0 END) AS bootstrap_ready_count,
                SUM(
                  CASE
                    WHEN first_discovered_at >= ? THEN 1
                    ELSE 0
                  END
                ) AS discovered_today_count,
                SUM(
                  CASE
                    WHEN is_active = 1 AND first_discovered_at >= ? THEN 1
                    ELSE 0
                  END
                ) AS active_discovered_today_count,
                MIN(first_discovered_at) AS first_discovered_at,
                MAX(last_discovered_at) AS last_discovered_at,
                MAX(last_synced_at) AS last_synced_at,
                MAX(last_ws_event_at) AS last_ws_event_at
              FROM tracked_tokens
            `,
          )
          .get(todayStartMs, todayStartMs) as Record<string, number | null>;

        const processedRow = db.sqlite
          .prepare(
            `
              SELECT
                COUNT(*) AS processed_trade_count,
                SUM(CAST(paid_sats AS INTEGER)) AS cumulative_paid_sats
              FROM processed_trades
            `,
          )
          .get() as Record<string, number | null>;

        const statsRow = db.sqlite
          .prepare(
            `
              SELECT
                COUNT(*) AS stats_token_count,
                SUM(trade_count) AS trade_count_sum,
                SUM(CAST(cumulative_paid_sats AS INTEGER)) AS cumulative_paid_sats_sum,
                SUM(recent_144_trade_count) AS recent_144_trade_count_sum,
                SUM(CAST(recent_144_volume_sats AS INTEGER)) AS recent_144_volume_sats_sum,
                SUM(recent_1008_trade_count) AS recent_1008_trade_count_sum,
                SUM(CAST(recent_1008_volume_sats AS INTEGER)) AS recent_1008_volume_sats_sum,
                MAX(last_trade_block_height) AS latest_trade_block_height,
                MAX(last_trade_block_timestamp) AS latest_trade_block_timestamp
              FROM token_stats
            `,
          )
          .get() as Record<string, number | null>;

        const todayLabel = new Intl.DateTimeFormat("en-CA", {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());

        const recentTokens = db.sqlite
          .prepare(
            `
              SELECT
                token_id,
                trade_count,
                cumulative_paid_sats,
                recent_144_trade_count,
                recent_144_volume_sats,
                recent_1008_trade_count,
                recent_1008_volume_sats,
                last_trade_block_height,
                last_trade_block_timestamp
              FROM token_stats
              ORDER BY
                last_trade_block_height DESC NULLS LAST,
                last_trade_block_timestamp DESC NULLS LAST
              LIMIT 10
            `,
          )
          .all();

        printJson({
          sqlitePath: config.sqlitePath,
          dbSizeBytes: getDbSizeBytes(config.sqlitePath),
          today: todayLabel,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
          tracked: trackedRow,
          processed: processedRow,
          stats: statsRow,
          recentTokens,
        });
        return;
      }
      case "tokens": {
        const limit = arg1 ? Number.parseInt(arg1, 10) : 50;
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new Error(`Invalid limit: ${arg1}`);
        }

        const rows = db.sqlite
          .prepare(
            `
              SELECT
                s.token_id,
                t.kind,
                t.group_prefix_hex,
                t.is_ready,
                t.init_status,
                s.trade_count,
                s.cumulative_paid_sats,
                s.recent_144_trade_count,
                s.recent_144_volume_sats,
                s.recent_1008_trade_count,
                s.recent_1008_volume_sats,
                s.last_trade_block_height,
                s.last_trade_block_timestamp,
                t.last_synced_at
              FROM token_stats s
              LEFT JOIN tracked_tokens t
                ON t.token_id = s.token_id
              ORDER BY
                CAST(s.cumulative_paid_sats AS INTEGER) DESC,
                s.trade_count DESC,
                s.token_id ASC
              LIMIT ?
            `,
          )
          .all(limit);

        printJson({
          limit,
          tokens: rows,
        });
        return;
      }
      case "token": {
        if (!arg1) {
          usage();
        }

        const tradeLimit = arg2 ? Number.parseInt(arg2, 10) : 20;
        if (!Number.isFinite(tradeLimit) || tradeLimit <= 0) {
          throw new Error(`Invalid tradeLimit: ${arg2}`);
        }

        const tracked = db.sqlite
          .prepare(
            `
              SELECT *
              FROM tracked_tokens
              WHERE token_id = ?
            `,
          )
          .get(arg1);

        const stats = db.sqlite
          .prepare(
            `
              SELECT *
              FROM token_stats
              WHERE token_id = ?
            `,
          )
          .get(arg1);

        const recentTrades = db.sqlite
          .prepare(
            `
              SELECT
                offer_txid,
                offer_out_idx,
                spend_txid,
                paid_sats,
                sold_atoms,
                price_nanosats_per_atom,
                taker_script_hex,
                block_height,
                block_timestamp
              FROM processed_trades
              WHERE token_id = ?
              ORDER BY
                block_height DESC NULLS LAST,
                block_timestamp DESC NULLS LAST,
                offer_txid DESC
              LIMIT ?
            `,
          )
          .all(arg1, tradeLimit);

        const blockStats = db.sqlite
          .prepare(
            `
              SELECT
                block_height,
                trade_count,
                volume_sats,
                updated_at
              FROM token_block_stats
              WHERE token_id = ?
              ORDER BY block_height DESC
              LIMIT 20
            `,
          )
          .all(arg1);

        printJson({
          tokenId: arg1,
          tracked,
          stats,
          blockStats,
          recentTrades,
        });
        return;
      }
      default:
        usage();
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
