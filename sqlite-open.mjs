import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

export function isSqliteIoError(err) {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String(err.code) : "";
  if (code.startsWith("SQLITE_IOERR") || code === "SQLITE_CORRUPT" || code === "SQLITE_BUSY") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /disk I\/O error|database disk image is malformed|SQLITE_IOERR/i.test(msg);
}

/** Google Drive / iCloud / Dropbox sync folders break SQLite WAL reliably. */
export function isCloudSyncedPath(dbPath) {
  return /CloudStorage|GoogleDrive|Google Drive|Dropbox|OneDrive|iCloud/i.test(String(dbPath));
}

/**
 * Prefer a local Application Support path when the project lives on Google Drive.
 * Copies an existing cloud DB once if the local file does not exist yet.
 * @param {string | undefined} envPath
 * @param {string} filename e.g. health-summary.sqlite
 * @param {string} cwdRelativeDefault e.g. join(cwd, "data", filename)
 */
export function resolveSqliteDbPath(envPath, filename, cwdRelativeDefault) {
  if (envPath && String(envPath).trim()) return String(envPath).trim();
  if (!isCloudSyncedPath(cwdRelativeDefault)) return cwdRelativeDefault;

  const localDir = join(homedir(), "Library", "Application Support", "CanteenEMHealth");
  const localPath = join(localDir, filename);
  try {
    mkdirSync(localDir, { recursive: true });
    if (!existsSync(localPath) && existsSync(cwdRelativeDefault)) {
      copyFileSync(cwdRelativeDefault, localPath);
      console.warn(
        `SQLite: copied ${filename} from Google Drive folder to local path (avoids disk I/O errors):\n  ${localPath}`,
      );
    } else if (!existsSync(localPath)) {
      console.warn(
        `SQLite: using local path for ${filename} (project is on a cloud-synced folder):\n  ${localPath}`,
      );
    }
    return localPath;
  } catch (e) {
    console.warn(
      `SQLite: could not use local Application Support path for ${filename}; falling back to project data/ —`,
      e instanceof Error ? e.message : e,
    );
    return cwdRelativeDefault;
  }
}

/**
 * @param {string} dbPath
 * @param {(db: import("better-sqlite3").Database) => void} initSchema
 */
export function openSqliteDb(dbPath, initSchema) {
  // WAL + cloud sync = frequent SQLITE_IOERR; DELETE is slower but reliable on synced folders.
  const journalMode = isCloudSyncedPath(dbPath) ? "DELETE" : "WAL";
  if (journalMode === "DELETE" || isCloudSyncedPath(dbPath)) {
    recoverStaleWalSidecars(dbPath);
  }

  const openOnce = () => {
    const db = new Database(dbPath);
    db.pragma(`journal_mode = ${journalMode}`);
    if (journalMode === "DELETE") {
      db.pragma("synchronous = FULL");
    }
    initSchema(db);
    return db;
  };

  try {
    return openOnce();
  } catch (err) {
    if (!isSqliteIoError(err)) throw err;
    recoverStaleWalSidecars(dbPath);
    return openOnce();
  }
}

/** Flush WAL pages into the main database file (important before shutdown on synced folders). */
export function checkpointSqliteDb(db) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* ignore — best effort (no-op when journal_mode=DELETE) */
  }
}
