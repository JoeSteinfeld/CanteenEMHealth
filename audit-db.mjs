import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteDb } from "./sqlite-open.mjs";

/** Minimum gap between `site_access` rows for the same user + IP (return visits / refreshes). */
const SITE_ACCESS_DEDUPE_MS = 15 * 60 * 1000;

const MAX_USERNAME_LEN = 128;
const MAX_IP_LEN = 64;
const MAX_UA_LEN = 512;

/**
 * @param {string} dbPath Absolute or cwd-relative path to the SQLite file.
 */
export function openAuditDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openSqliteDb(dbPath, (conn) => {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        event TEXT NOT NULL,
        username TEXT,
        ip TEXT NOT NULL,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_access_log_at ON access_log (at DESC);
      CREATE INDEX IF NOT EXISTS idx_access_log_event_at ON access_log (event, at DESC);
    `);
  });

  const insertStmt = db.prepare(`
    INSERT INTO access_log (at, event, username, ip, user_agent)
    VALUES (@at, @event, @username, @ip, @user_agent)
  `);

  const lastSiteAccessStmt = db.prepare(`
    SELECT at FROM access_log
    WHERE event = 'site_access' AND username = @username AND ip = @ip
    ORDER BY at DESC
    LIMIT 1
  `);

  return {
    /**
     * @param {{ event: string; username?: string | null; ip: string; userAgent?: string | null }} entry
     */
    record(entry) {
      const at = Date.now();
      const row = {
        at,
        event: String(entry.event).slice(0, 64),
        username: entry.username != null ? String(entry.username).slice(0, MAX_USERNAME_LEN) : null,
        ip: String(entry.ip || "unknown").slice(0, MAX_IP_LEN),
        user_agent:
          entry.userAgent != null ? String(entry.userAgent).slice(0, MAX_UA_LEN) : null,
      };
      insertStmt.run(row);
      console.log(
        JSON.stringify({
          audit: true,
          at: new Date(at).toISOString(),
          event: row.event,
          username: row.username,
          ip: row.ip,
          userAgent: row.user_agent,
        }),
      );
    },

    /**
     * @param {{ username: string; ip: string; userAgent?: string | null }} entry
     */
    recordSiteAccess(entry) {
      const username = String(entry.username).slice(0, MAX_USERNAME_LEN);
      const ip = String(entry.ip || "unknown").slice(0, MAX_IP_LEN);
      const last = lastSiteAccessStmt.get({ username, ip });
      if (last && Date.now() - last.at < SITE_ACCESS_DEDUPE_MS) return false;
      this.record({
        event: "site_access",
        username,
        ip,
        userAgent: entry.userAgent,
      });
      return true;
    },

    close() {
      db.close();
    },
  };
}

/** Client IP, honoring X-Forwarded-For when behind nginx on EC2. */
export function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff[0]) {
    return String(xff[0]).trim();
  }
  const addr = req.socket?.remoteAddress ?? req.ip;
  if (typeof addr === "string" && addr.startsWith("::ffff:")) {
    return addr.slice(7);
  }
  return typeof addr === "string" ? addr : "unknown";
}

export function getUserAgent(req) {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua : null;
}
