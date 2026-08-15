import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteDb, checkpointSqliteDb, isSqliteIoError, recoverStaleWalSidecars } from "./sqlite-open.mjs";

/**
 * Local store of per-sensor daily ambient temperatures (°F).
 * Used for rolling 30-day max/min/avg without re-fetching full history from Samsara.
 *
 * @param {string} dbPath
 */
export function openSensorDailyTempDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openSqliteDb(dbPath, (conn) => {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS sensor_daily_temps (
        sensor_id TEXT NOT NULL,
        day TEXT NOT NULL,
        temp_f REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (sensor_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_sensor_daily_temps_day
        ON sensor_daily_temps (day);
      CREATE TABLE IF NOT EXISTS sensor_daily_temps_meta (
        sensor_id TEXT PRIMARY KEY NOT NULL,
        last_synced_day TEXT,
        last_sync_at INTEGER NOT NULL
      );
    `);
  });

  const upsertStmt = db.prepare(`
    INSERT INTO sensor_daily_temps (sensor_id, day, temp_f, updated_at)
    VALUES (@sensor_id, @day, @temp_f, @updated_at)
    ON CONFLICT(sensor_id, day) DO UPDATE SET
      temp_f = excluded.temp_f,
      updated_at = excluded.updated_at
  `);

  const upsertMany = db.transaction((rows) => {
    for (const row of rows) upsertStmt.run(row);
  });

  const upsertMetaStmt = db.prepare(`
    INSERT INTO sensor_daily_temps_meta (sensor_id, last_synced_day, last_sync_at)
    VALUES (@sensor_id, @last_synced_day, @last_sync_at)
    ON CONFLICT(sensor_id) DO UPDATE SET
      last_synced_day = excluded.last_synced_day,
      last_sync_at = excluded.last_sync_at
  `);

  const upsertMetaMany = db.transaction((rows) => {
    for (const row of rows) upsertMetaStmt.run(row);
  });

  const selectMetaStmt = db.prepare(`
    SELECT sensor_id, last_synced_day FROM sensor_daily_temps_meta WHERE sensor_id = ?
  `);

  const selectMetaMany = (ids) => {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT sensor_id, last_synced_day FROM sensor_daily_temps_meta WHERE sensor_id IN (${placeholders})`,
      )
      .all(...ids);
  };

  const selectEarliestMany = (ids) => {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT sensor_id, MIN(day) AS first_day
         FROM sensor_daily_temps
         WHERE sensor_id IN (${placeholders})
         GROUP BY sensor_id`,
      )
      .all(...ids);
  };

  const selectStatsStmt = db.prepare(`
    SELECT
      MAX(temp_f) AS max_f,
      MIN(temp_f) AS min_f,
      AVG(temp_f) AS avg_f,
      COUNT(*) AS n
    FROM sensor_daily_temps
    WHERE sensor_id = ? AND day >= ? AND day <= ?
  `);

  const pruneStmt = db.prepare(`DELETE FROM sensor_daily_temps WHERE day < ?`);

  function runWrite(fn) {
    try {
      return fn();
    } catch (e) {
      if (!isSqliteIoError(e)) throw e;
      recoverStaleWalSidecars(dbPath);
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        /* ignore */
      }
      return fn();
    }
  }

  return {
    /**
     * @param {string[]} sensorIds
     * @returns {Map<string, string | null>} sensorId → last_synced_day (YYYY-MM-DD) or null
     */
    getLastSyncedDays(sensorIds) {
      const unique = [...new Set(sensorIds.map(String))];
      const out = new Map();
      for (const id of unique) out.set(id, null);
      if (unique.length === 0) return out;
      for (const row of selectMetaMany(unique)) {
        const day =
          row.last_synced_day != null && String(row.last_synced_day).trim() !== ""
            ? String(row.last_synced_day)
            : null;
        out.set(String(row.sensor_id), day);
      }
      return out;
    },

    /**
     * Per-sensor baseline = earliest stored day in the daily temps table.
     * @param {string[]} sensorIds
     * @returns {Map<string, string | null>} sensorId → first day (YYYY-MM-DD) or null if none
     */
    getBaselineDays(sensorIds) {
      const unique = [...new Set(sensorIds.map(String))];
      const out = new Map();
      for (const id of unique) out.set(id, null);
      if (unique.length === 0) return out;
      for (const row of selectEarliestMany(unique)) {
        const day =
          row.first_day != null && String(row.first_day).trim() !== "" ? String(row.first_day) : null;
        out.set(String(row.sensor_id), day);
      }
      return out;
    },

    /** @param {string} sensorId */
    getLastSyncedDay(sensorId) {
      const row = selectMetaStmt.get(String(sensorId));
      if (!row?.last_synced_day) return null;
      const day = String(row.last_synced_day).trim();
      return day || null;
    },

    /**
     * @param {{ sensorId: string, day: string, tempF: number }[]} points
     */
    upsertDailyTemps(points) {
      if (!points.length) return;
      const now = Date.now();
      const rows = [];
      for (const p of points) {
        if (!p?.sensorId || !p?.day) continue;
        if (typeof p.tempF !== "number" || !Number.isFinite(p.tempF)) continue;
        rows.push({
          sensor_id: String(p.sensorId),
          day: String(p.day),
          temp_f: p.tempF,
          updated_at: now,
        });
      }
      if (!rows.length) return;
      runWrite(() => upsertMany(rows));
    },

    /**
     * @param {string[]} sensorIds
     * @param {string} lastSyncedDay YYYY-MM-DD
     */
    markSyncedThrough(sensorIds, lastSyncedDay) {
      const unique = [...new Set(sensorIds.map(String))];
      if (!unique.length || !lastSyncedDay) return;
      const now = Date.now();
      const rows = unique.map((sensor_id) => ({
        sensor_id,
        last_synced_day: String(lastSyncedDay),
        last_sync_at: now,
      }));
      runWrite(() => upsertMetaMany(rows));
    },

    /**
     * Rolling window stats from stored daily points.
     * @param {string} sensorId
     * @param {string} startDay inclusive YYYY-MM-DD
     * @param {string} endDay inclusive YYYY-MM-DD
     * @returns {{ maxF: number, minF: number, avgF: number, count: number } | null}
     */
    getStatsForWindow(sensorId, startDay, endDay) {
      const row = selectStatsStmt.get(String(sensorId), String(startDay), String(endDay));
      const n = row ? Number(row.n) : 0;
      if (!n) return null;
      const maxF = Number(row.max_f);
      const minF = Number(row.min_f);
      const avgF = Number(row.avg_f);
      if (![maxF, minF, avgF].every((x) => Number.isFinite(x))) return null;
      return { maxF, minF, avgF, count: n };
    },

    /**
     * @param {string[]} sensorIds
     * @param {string} startDay
     * @param {string} endDay
     * @returns {Map<string, { maxF: number, minF: number, avgF: number, count: number } | null>}
     */
    getStatsForWindowMany(sensorIds, startDay, endDay) {
      const out = new Map();
      for (const id of [...new Set(sensorIds.map(String))]) {
        out.set(id, this.getStatsForWindow(id, startDay, endDay));
      }
      return out;
    },

    /** Drop daily rows older than `beforeDay` (exclusive). */
    pruneBeforeDay(beforeDay) {
      if (!beforeDay) return 0;
      const info = runWrite(() => pruneStmt.run(String(beforeDay)));
      return info?.changes ?? 0;
    },

    checkpoint() {
      checkpointSqliteDb(db);
    },

    close() {
      checkpointSqliteDb(db);
      db.close();
    },
  };
}
