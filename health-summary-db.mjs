import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteDb, checkpointSqliteDb } from "./sqlite-open.mjs";

function isTagHealthSummaryRow(value) {
  if (!value || typeof value !== "object") return false;
  const r = value;
  return (
    typeof r.tagId === "string" &&
    typeof r.tagName === "string" &&
    typeof r.totalSensors === "number" &&
    typeof r.connectedLast7Days === "number" &&
    typeof r.notConnected7Days === "number" &&
    typeof r.neverConnected === "number" &&
    typeof r.pctHealthy === "number"
  );
}

function isFleetHealthTotals(value) {
  if (!value || typeof value !== "object") return false;
  const o = value;
  return (
    typeof o.totalSensors === "number" &&
    typeof o.connectedLast7Days === "number" &&
    typeof o.neverConnected === "number" &&
    typeof o.notConnected7Days === "number" &&
    typeof o.pctHealthy === "number"
  );
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} dbPath Absolute or cwd-relative path to the SQLite file.
 */
export function openHealthSummaryDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openSqliteDb(dbPath, (conn) => {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS health_summary_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data_retrieved_at INTEGER NOT NULL,
        fleet_totals_json TEXT NOT NULL,
        summary_rows_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_health_summary_snapshots_retrieved_at
        ON health_summary_snapshots (data_retrieved_at DESC);
    `);
  });

  const insertStmt = db.prepare(`
    INSERT INTO health_summary_snapshots (data_retrieved_at, fleet_totals_json, summary_rows_json, created_at)
    VALUES (@data_retrieved_at, @fleet_totals_json, @summary_rows_json, @created_at)
  `);

  const selectLatestStmt = db.prepare(`
    SELECT id, data_retrieved_at, fleet_totals_json, summary_rows_json, created_at
    FROM health_summary_snapshots
    ORDER BY data_retrieved_at DESC, id DESC
    LIMIT 1
  `);

  const selectListStmt = db.prepare(`
    SELECT id, data_retrieved_at, fleet_totals_json, summary_rows_json, created_at
    FROM health_summary_snapshots
    ORDER BY data_retrieved_at DESC, id DESC
    LIMIT ?
  `);

  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM health_summary_snapshots`);

  function parseSnapshotRow(row) {
    if (!row) return null;
    const dataRetrievedAt = Number(row.data_retrieved_at);
    if (!Number.isFinite(dataRetrievedAt)) return null;
    const summaryRows = parseJsonArray(row.summary_rows_json);
    const fleetTotals = parseJsonObject(row.fleet_totals_json);
    if (!summaryRows || !summaryRows.every(isTagHealthSummaryRow)) return null;
    if (!isFleetHealthTotals(fleetTotals)) return null;
    return {
      id: Number(row.id),
      dataRetrievedAt,
      fleetTotals,
      summaryRows,
      storedAt: Number(row.created_at),
    };
  }

  return {
    /**
     * @param {{ dataRetrievedAt: number, fleetTotals: object, summaryRows: object[] }} snapshot
     */
    saveSnapshot(snapshot) {
      const dataRetrievedAt = Number(snapshot.dataRetrievedAt);
      if (!Number.isFinite(dataRetrievedAt)) {
        throw new Error("Invalid dataRetrievedAt for health summary snapshot");
      }
      insertStmt.run({
        data_retrieved_at: dataRetrievedAt,
        fleet_totals_json: JSON.stringify(snapshot.fleetTotals),
        summary_rows_json: JSON.stringify(snapshot.summaryRows),
        created_at: Date.now(),
      });
    },

    getLatestSnapshot() {
      return parseSnapshotRow(selectLatestStmt.get());
    },

    /** @param {number} [limit] */
    listSnapshots(limit = 30) {
      const n = Math.max(1, Math.min(120, Number(limit) || 30));
      return selectListStmt.all(n).map(parseSnapshotRow).filter(Boolean);
    },

    getSnapshotCount() {
      const row = countStmt.get();
      return row ? Number(row.n) : 0;
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
