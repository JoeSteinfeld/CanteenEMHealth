import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";

/**
 * Remove orphaned -wal / -shm sidecars left after a crash or cloud sync (common on Google Drive).
 * Safe when no other process has the database open.
 */
export function recoverStaleWalSidecars(dbPath) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        unlinkSync(sidecar);
      } catch {
        /* another process may hold the file */
      }
    }
  }
}

/**
 * @param {string} dbPath
 * @param {(db: import("better-sqlite3").Database) => void} initSchema
 */
export function openSqliteDb(dbPath, initSchema) {
  recoverStaleWalSidecars(dbPath);

  let db;
  try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    initSchema(db);
    return db;
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "SQLITE_IOERR" || code === "SQLITE_IOERR_WRITE" || code === "SQLITE_CORRUPT") {
      recoverStaleWalSidecars(dbPath);
      db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      initSchema(db);
      return db;
    }
    throw err;
  }
}
