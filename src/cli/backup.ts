import path from "node:path";

import { backupSqliteDatabase } from "../lib/backup.js";
import { loadConfig } from "../lib/config.js";

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const destinationDir =
    process.env.BACKUP_DIR?.trim() || path.resolve("./backups");
  const retentionCount = readPositiveInt("BACKUP_RETENTION_COUNT", 7);
  const result = await backupSqliteDatabase({
    sqlitePath: config.sqlitePath,
    destinationDir,
    retentionCount,
  });

  console.log(
    `backup complete | path=${result.backupPath} bytes=${result.sizeBytes} pruned=${result.removedPaths.length}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
