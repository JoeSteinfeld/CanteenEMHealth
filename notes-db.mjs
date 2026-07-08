import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteDb } from "./sqlite-open.mjs";

/** Max UTF-8 length for a single note (reasonable bound for UI + DB). */
export const MAX_NOTE_LENGTH = 32_000;

/**
 * @param {string} dbPath Absolute or cwd-relative path to the SQLite file.
 */
export function openSensorNotesDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openSqliteDb(dbPath, (conn) => {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS sensor_notes (
        sensor_id TEXT PRIMARY KEY NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
    `);
  });

  const selectManyIn = (ids) => {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return db.prepare(`SELECT sensor_id, note FROM sensor_notes WHERE sensor_id IN (${placeholders})`).all(...ids);
  };

  const upsertStmt = db.prepare(`
    INSERT INTO sensor_notes (sensor_id, note, updated_at)
    VALUES (@sensor_id, @note, @updated_at)
    ON CONFLICT(sensor_id) DO UPDATE SET
      note = excluded.note,
      updated_at = excluded.updated_at
  `);

  return {
    /** @param {string[]} sensorIds */
    getMany(sensorIds) {
      const unique = [...new Set(sensorIds.map(String))];
      if (unique.length === 0) return new Map();
      const rows = selectManyIn(unique);
      const m = new Map();
      for (const row of rows) {
        m.set(String(row.sensor_id), row.note ?? "");
      }
      return m;
    },

    /** @param {string} sensorId @param {string} note */
    upsert(sensorId, note) {
      upsertStmt.run({
        sensor_id: sensorId,
        note,
        updated_at: Date.now(),
      });
    },

    close() {
      db.close();
    },
  };
}
