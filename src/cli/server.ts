import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import { createSyncDependencies } from "../lib/agoraSync.js";
import { AgoraTokenService } from "../app/service.js";
import { startApplication } from "../app/runtime.js";
import { parseServerCliOptions } from "./serverOptions.js";

async function main(): Promise<void> {
  const cliOptions = parseServerCliOptions(process.argv.slice(2));
  const config = loadConfig();
  const db = openDatabase(config.sqlitePath);
  const deps = createSyncDependencies(config);
  const service = new AgoraTokenService(db, deps, config, {
    deferKnownTradeCountLte: cliOptions.deferKnownTradeCountLte,
  });
  if (cliOptions.deferKnownTradeCountLte !== null) {
    console.log(
      `server option enabled | defer_known_trade_count_lte=${cliOptions.deferKnownTradeCountLte}`,
    );
  }
  const runtime = await startApplication(service, config);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`server shutting down | signal=${signal}`);
    try {
      await runtime.close();
    } finally {
      db.close();
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
