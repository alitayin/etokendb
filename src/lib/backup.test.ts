import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { backupSqliteDatabase } from "./backup.js";

test("backupSqliteDatabase creates a verified snapshot and prunes old backups", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "etokendb-backup-"));
  const sqlitePath = path.join(tempDir, "etokendb.sqlite");
  const destinationDir = path.join(tempDir, "backups");
  const source = new Database(sqlitePath);

  try {
    source.exec("CREATE TABLE sample (value TEXT NOT NULL)");
    source.prepare("INSERT INTO sample (value) VALUES (?)").run("first");

    const first = await backupSqliteDatabase({
      sqlitePath,
      destinationDir,
      retentionCount: 1,
      now: new Date("2026-08-12T00:00:00.000Z"),
    });
    source.prepare("INSERT INTO sample (value) VALUES (?)").run("second");
    const second = await backupSqliteDatabase({
      sqlitePath,
      destinationDir,
      retentionCount: 1,
      now: new Date("2026-08-12T01:00:00.000Z"),
    });

    assert.equal(fs.existsSync(first.backupPath), false);
    assert.deepEqual(second.removedPaths, [first.backupPath]);
    assert.ok(second.sizeBytes > 0);

    const snapshot = new Database(second.backupPath, { readonly: true });
    try {
      const row = snapshot
        .prepare("SELECT COUNT(*) AS count FROM sample")
        .get() as { count: number };
      assert.equal(row.count, 2);
    } finally {
      snapshot.close();
    }
  } finally {
    source.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
