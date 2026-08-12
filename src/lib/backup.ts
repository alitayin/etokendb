import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export interface BackupOptions {
  sqlitePath: string;
  destinationDir: string;
  retentionCount: number;
  now?: Date;
}

export interface BackupResult {
  backupPath: string;
  sizeBytes: number;
  removedPaths: string[];
}

function formatTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export async function backupSqliteDatabase(
  options: BackupOptions,
): Promise<BackupResult> {
  assertPositiveInteger(options.retentionCount, "retentionCount");
  const sourcePath = path.resolve(options.sqlitePath);
  const destinationDir = path.resolve(options.destinationDir);
  const basename = path.basename(sourcePath, path.extname(sourcePath));
  const backupName = `${basename}-${formatTimestamp(options.now ?? new Date())}.sqlite`;
  const backupPath = path.join(destinationDir, backupName);

  fs.mkdirSync(destinationDir, { recursive: true });
  if (fs.existsSync(backupPath)) {
    throw new Error(`backup destination already exists: ${backupPath}`);
  }

  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await source.backup(backupPath);
  } catch (error) {
    fs.rmSync(backupPath, { force: true });
    throw error;
  } finally {
    source.close();
  }

  const backup = new Database(backupPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = backup.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`backup integrity check failed: ${String(integrity)}`);
    }
  } catch (error) {
    backup.close();
    fs.rmSync(backupPath, { force: true });
    throw error;
  }
  backup.close();

  const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const backupPattern = new RegExp(
    `^${escapedBasename}-\\d{8}T\\d{6}Z\\.sqlite$`,
  );
  const retained = fs
    .readdirSync(destinationDir)
    .filter((entry) => backupPattern.test(entry))
    .sort()
    .reverse();
  const removedPaths = retained
    .slice(options.retentionCount)
    .map((entry) => path.join(destinationDir, entry));
  for (const oldBackupPath of removedPaths) {
    fs.rmSync(oldBackupPath);
  }

  return {
    backupPath,
    sizeBytes: fs.statSync(backupPath).size,
    removedPaths,
  };
}
