import "dotenv/config";
import cors from "cors";
import express from "express";
import { join } from "node:path";
import { getClientIp, getUserAgent, openAuditDb } from "./audit-db.mjs";
import {
  clearSessionCookie,
  createSessionToken,
  getSession,
  isAuthEnabled,
  isAuthenticated,
  protectApiRoutes,
  setSessionCookie,
  validateCredentials,
} from "./auth.mjs";
import { MAX_NOTE_LENGTH, openSensorNotesDb } from "./notes-db.mjs";
import { openHealthSummaryDb } from "./health-summary-db.mjs";
import { buildHealthSummaryTrends } from "./health-summary-trends.mjs";
import {
  getHealthSummaryScheduleInfo,
  startDailyHealthSummaryScheduler,
} from "./health-summary-scheduler.mjs";
import {
  EM_WIDGET_READING_IDS,
  hasEmWidgetReadings,
  isDeactivatedTagSensor,
  isEmHealthTagSensor,
} from "./sensorFilter.mjs";
import { isSqliteIoError, resolveSqliteDbPath } from "./sqlite-open.mjs";

const PORT = Number(process.env.PORT ?? 3001);
const BASE = (process.env.SAMSARA_API_BASE ?? "https://api.samsara.com").replace(/\/$/, "");
const TOKEN = process.env.SAMSARA_API_TOKEN;
/** Readings snapshot entity type for EM widget fields (use `sensor` for hardware from List tags → sensors). */
const READINGS_ENTITY_TYPE = process.env.SAMSARA_READINGS_ENTITY_TYPE ?? "sensor";

/** Match public Samsara URLs: https://api.samsara.com/tags, /assets, /readings/latest (no /v1). Override with SAMSARA_PATH_STYLE=v1 if needed. */
const DEFAULT_PATH_STYLE = process.env.SAMSARA_PATH_STYLE === "v1" ? "v1" : "root";

const READING_IDS = EM_WIDGET_READING_IDS.join(",");

/** Single reading for GET /readings/history (query uses `readingId`, not `readingIds`). */
const TEMP_BLE_READING_ID = "environmentMonitorAmbientTemperatureBLEConnection";

const ENTITY_BATCH = 50;

/** Parallel waves when fetching /readings/latest (default 4 batches at a time). */
const READINGS_BATCH_CONCURRENCY = Math.max(
  1,
  Number(process.env.SAMSARA_READINGS_BATCH_CONCURRENCY ?? 4) || 4,
);

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Guard very deep pagination for one-sensor history (30 days). */
const READINGS_HISTORY_MAX_PAGES = 500;

/** Parallel sensors when computing 30-day temp max/min/avg (history is per-sensor). */
const TEMP_STATS_CONCURRENCY = Math.max(
  1,
  Number(process.env.SAMSARA_TEMP_STATS_CONCURRENCY ?? 4) || 4,
);

const NOTES_DB_PATH = resolveSqliteDbPath(
  process.env.NOTES_DB_PATH,
  "sensor-notes.sqlite",
  join(process.cwd(), "data", "sensor-notes.sqlite"),
);
const AUDIT_DB_PATH = resolveSqliteDbPath(
  process.env.AUDIT_DB_PATH,
  "access-audit.sqlite",
  join(process.cwd(), "data", "access-audit.sqlite"),
);
const HEALTH_SUMMARY_DB_PATH = resolveSqliteDbPath(
  process.env.HEALTH_SUMMARY_DB_PATH,
  "health-summary.sqlite",
  join(process.cwd(), "data", "health-summary.sqlite"),
);
const notesStore = openSensorNotesDb(NOTES_DB_PATH);
const auditLog = openAuditDb(AUDIT_DB_PATH);
const healthSummaryStore = openHealthSummaryDb(HEALTH_SUMMARY_DB_PATH);

function auditFromRequest(req, event, username = null) {
  auditLog.record({
    event,
    username,
    ip: getClientIp(req),
    userAgent: getUserAgent(req),
  });
}

function messageFromSamsaraBody(body, fallback) {
  if (!body || typeof body !== "object" || "raw" in body) return fallback;
  if (body.message) return String(body.message);
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object" && "message" in body.error) return String(body.error.message);
  if (Array.isArray(body.errors) && body.errors[0]?.message) return String(body.errors[0].message);
  return fallback;
}

function requireToken(res) {
  if (!TOKEN) {
    res.status(500).json({
      error: "Set SAMSARA_API_TOKEN in a .env file in the project root (see .env.example).",
    });
    return false;
  }
  return true;
}

/** Pull organization id from GET /me (see https://developers.samsara.com/reference/me). */
function extractOrgIdFromMe(body) {
  if (!body || typeof body !== "object") return null;
  const data = body.data;
  if (data && typeof data === "object") {
    if (data.organization?.id != null) return String(data.organization.id);
    if (data.organizationId != null) return String(data.organizationId);
    if (data.orgId != null) return String(data.orgId);
    if (data.id != null) return String(data.id);
  }
  if (body.organization?.id != null) return String(body.organization.id);
  return null;
}

function extractListData(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body)) return body;
  const d = body.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(body.data?.data)) return body.data.data;
  if (Array.isArray(body.data?.items)) return body.data.items;
  if (Array.isArray(body.list)) return body.list;
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.items)) return body.items;
  return [];
}

/**
 * @param {"v1" | "root"} [opts.pathStyle] - "root" = https://api.samsara.com/assets. "v1" = /v1/assets
 */
async function samsaraFetch(path, searchParams, opts) {
  const pathStyle = opts && opts.pathStyle != null ? opts.pathStyle : DEFAULT_PATH_STYLE;
  const q = searchParams ? `?${searchParams.toString()}` : "";
  const p = path.startsWith("/") ? path : `/${path}`;
  const prefix = pathStyle === "v1" ? "/v1" : "";
  const url = `${BASE}${prefix}${p}${q}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
    },
  });
  const text = await r.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!r.ok) {
    const msg = messageFromSamsaraBody(body, r.statusText);
    const err = new Error(msg);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * POST to Samsara (legacy endpoints like /v1/sensors/temperature).
 * Pass a full path including /v1 when needed; uses root host (no extra pathStyle prefix).
 */
async function samsaraPost(path, jsonBody) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${BASE}${p}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jsonBody ?? {}),
  });
  const text = await r.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!r.ok) {
    const msg = typeof body === "string" ? body : messageFromSamsaraBody(body, r.statusText);
    const err = new Error(msg);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Legacy GetTemperature accepts at most 40 sensor IDs per request. */
const SENSOR_TEMPERATURE_BATCH = 40;

/**
 * From POST /v1/sensors/temperature:
 * - connectedTo: AG/VG host name via trailerId/vehicleId → GET /assets
 * - lastConnectedTime: ambientTemperatureTime (last report of ambient temp)
 * Soft-fails so sensor list still loads if scope/API unavailable.
 * @param {string[]} sensorIds
 * @returns {Promise<{ connectedToById: Map<string, string>, lastConnectedById: Map<string, string> }>}
 */
async function fetchGetTemperatureMetaBySensorId(sensorIds) {
  const connectedToById = new Map();
  const lastConnectedById = new Map();
  const numericIds = [];
  for (const id of sensorIds) {
    const n = Number(id);
    if (Number.isFinite(n) && Number.isSafeInteger(n)) numericIds.push(n);
  }
  if (numericIds.length === 0) return { connectedToById, lastConnectedById };

  /** @type {Map<string, string>} sensorId → trailer/host asset id */
  const hostIdBySensor = new Map();
  try {
    for (let i = 0; i < numericIds.length; i += SENSOR_TEMPERATURE_BATCH) {
      const chunk = numericIds.slice(i, i + SENSOR_TEMPERATURE_BATCH);
      const body = await samsaraPost("/v1/sensors/temperature", { sensors: chunk });
      const rows = Array.isArray(body?.sensors) ? body.sensors : [];
      for (const row of rows) {
        if (row == null || row.id == null) continue;
        const sid = String(row.id);
        if (row.ambientTemperatureTime != null && String(row.ambientTemperatureTime).trim() !== "") {
          lastConnectedById.set(sid, String(row.ambientTemperatureTime));
        }
        if (row.trailerId == null && row.vehicleId == null) continue;
        const hostId = row.trailerId != null ? String(row.trailerId) : String(row.vehicleId);
        hostIdBySensor.set(sid, hostId);
      }
    }
  } catch (e) {
    console.warn(
      "GetTemperature unavailable:",
      e instanceof Error ? e.message : e,
    );
    return { connectedToById, lastConnectedById };
  }

  const uniqueHostIds = [...new Set(hostIdBySensor.values())];
  /** @type {Map<string, string>} host asset id → name */
  const hostNameById = new Map();
  try {
    for (let i = 0; i < uniqueHostIds.length; i += 50) {
      const chunk = uniqueHostIds.slice(i, i + 50);
      const params = new URLSearchParams();
      params.set("ids", chunk.join(","));
      const body = await samsaraFetch("/assets", params, { pathStyle: "root" });
      for (const asset of extractListData(body)) {
        if (asset?.id == null) continue;
        const name = asset.name != null && String(asset.name).trim() !== "" ? String(asset.name) : String(asset.id);
        hostNameById.set(String(asset.id), name);
      }
    }
  } catch (e) {
    console.warn(
      "Connected To (assets lookup) unavailable:",
      e instanceof Error ? e.message : e,
    );
  }

  for (const [sensorId, hostId] of hostIdBySensor) {
    connectedToById.set(sensorId, hostNameById.get(hostId) ?? hostId);
  }
  return { connectedToById, lastConnectedById };
}

async function paginateList(path, baseParams, samsaraOpts) {
  const out = [];
  let after = null;
  for (;;) {
    const p = new URLSearchParams(baseParams);
    if (after) p.set("after", after);
    const data = await samsaraFetch(path, p, samsaraOpts);
    out.push(...extractListData(data));
    const hasNext = data.pagination?.hasNextPage;
    if (hasNext === false) break;
    if (hasNext == null) break;
    const end = data.pagination?.endCursor;
    if (end == null || end === "") break;
    const next = String(end);
    if (next === after) break;
    after = next;
  }
  return out;
}

async function extractTagsFromAssets() {
  const m = new Map();
  const assets = await paginateList("/assets", new URLSearchParams({ includeTags: "true", limit: "300" }));
  for (const a of assets) {
    if (!a || !Array.isArray(a.tags)) continue;
    for (const t of a.tags) {
      if (t?.id == null) continue;
      m.set(String(t.id), { id: String(t.id), name: String(t.name ?? "—") });
    }
  }
  return m;
}

async function paginateReadingsSnapshot(params) {
  const out = [];
  let after = null;
  for (;;) {
    const p = new URLSearchParams(params);
    if (after) p.set("after", after);
    const data = await samsaraFetch("/readings/latest", p);
    out.push(...extractListData(data));
    const hasNext = data.pagination?.hasNextPage;
    if (hasNext === false) break;
    if (hasNext == null) break;
    const end = data.pagination?.endCursor;
    if (end == null || end === "") break;
    const next = String(end);
    if (next === after) break;
    after = next;
  }
  return out;
}

async function paginateReadingsHistory(params) {
  const out = [];
  let after = null;
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > READINGS_HISTORY_MAX_PAGES) break;
    const p = new URLSearchParams(params);
    if (after) p.set("after", after);
    const data = await samsaraFetch("/readings/history", p);
    out.push(...extractListData(data));
    const hasNext = data.pagination?.hasNextPage;
    if (hasNext === false) break;
    if (hasNext == null) break;
    const end = data.pagination?.endCursor;
    if (end == null || end === "") break;
    const next = String(end);
    if (next === after) break;
    after = next;
  }
  return out;
}

function chunk(arr, n) {
  const res = [];
  for (let i = 0; i < arr.length; i += n) res.push(arr.slice(i, i + n));
  return res;
}

/** Fetch readings snapshot for many sensors; batches run in parallel waves. */
async function fetchReadingsSnapshotBatched(entityIds, readingIds = READING_IDS) {
  const ids = [...new Set(entityIds.map(String))];
  if (ids.length === 0) return [];
  const batches = chunk(ids, ENTITY_BATCH);
  const readingRows = [];
  for (let i = 0; i < batches.length; i += READINGS_BATCH_CONCURRENCY) {
    const wave = batches.slice(i, i + READINGS_BATCH_CONCURRENCY);
    const parts = await Promise.all(
      wave.map((batch) => {
        const p = new URLSearchParams();
        p.set("entityType", READINGS_ENTITY_TYPE);
        p.set("readingIds", readingIds);
        p.set("entityIds", batch.join(","));
        return paginateReadingsSnapshot(p);
      }),
    );
    for (const part of parts) readingRows.push(...part);
  }
  return readingRows;
}

function indexReadingsByEntity(readingRows) {
  const readingsByEntity = new Map();
  for (const row of readingRows) {
    const eid = String(row.entityId);
    if (!readingsByEntity.has(eid)) readingsByEntity.set(eid, new Map());
    readingsByEntity.get(eid).set(row.readingId, {
      value: row.value,
      happenedAtTime: row.happenedAtTime,
    });
  }
  return readingsByEntity;
}

function connectivityCategory(lastConnectedIso, retrievedAt) {
  if (lastConnectedIso == null || String(lastConnectedIso).trim() === "") return "never";
  const t = new Date(lastConnectedIso).getTime();
  if (Number.isNaN(t)) return "never";
  if (retrievedAt - t > STALE_MS) return "stale";
  return "connected";
}

function uniqueSensorIdsFromTagRows(tagRows) {
  const ids = new Set();
  for (const tag of tagRows) {
    if (!Array.isArray(tag?.sensors)) continue;
    for (const s of tag.sensors) {
      if (s?.id == null || isDeactivatedTagSensor(s)) continue;
      ids.add(String(s.id));
    }
  }
  return [...ids];
}

function buildTagHealthSummaryFromTagRows(tagRows, readingsByEntity, retrievedAt, lastConnectedById) {
  const rows = [];
  for (const tag of tagRows) {
    if (!tag || tag.id == null) continue;
    const tagName = tag.name != null ? String(tag.name) : "—";
    const sensors = Array.isArray(tag.sensors) ? tag.sensors : [];
    let totalSensors = 0;
    let connectedLast7Days = 0;
    let notConnected7Days = 0;
    let neverConnected = 0;
    for (const s of sensors) {
      if (!s || s.id == null || !isEmHealthTagSensor(s, readingsByEntity)) continue;
      totalSensors += 1;
      const sid = String(s.id);
      // GetTemperature ambientTemperatureTime (same as Detailed Sensor Health).
      const lastConnected = lastConnectedById?.get(sid) ?? null;
      const cat = connectivityCategory(lastConnected, retrievedAt);
      if (cat === "never") neverConnected += 1;
      else if (cat === "stale") notConnected7Days += 1;
      else connectedLast7Days += 1;
    }
    if (totalSensors === 0) continue;
    const pctHealthy = (connectedLast7Days / totalSensors) * 100;
    rows.push({
      tagId: String(tag.id),
      tagName,
      totalSensors,
      connectedLast7Days,
      notConnected7Days,
      neverConnected,
      pctHealthy,
    });
  }
  rows.sort((a, b) => a.tagName.localeCompare(b.tagName, undefined, { sensitivity: "base" }));
  return rows;
}

function buildFleetHealthTotals(tagRows, readingsByEntity, retrievedAt, lastConnectedById) {
  const seen = new Set();
  let totalSensors = 0;
  let connectedLast7Days = 0;
  let neverConnected = 0;
  let notConnected7Days = 0;

  for (const tag of tagRows) {
    if (!Array.isArray(tag?.sensors)) continue;
    for (const s of tag.sensors) {
      if (!s || s.id == null || !isEmHealthTagSensor(s, readingsByEntity)) continue;
      const sid = String(s.id);
      if (seen.has(sid)) continue;
      seen.add(sid);
      totalSensors += 1;
      const lastConnected = lastConnectedById?.get(sid) ?? null;
      const cat = connectivityCategory(lastConnected, retrievedAt);
      if (cat === "never") neverConnected += 1;
      else if (cat === "stale") notConnected7Days += 1;
      else if (cat === "connected") connectedLast7Days += 1;
    }
  }

  const pctHealthy = totalSensors > 0 ? (connectedLast7Days / totalSensors) * 100 : 0;
  return { totalSensors, connectedLast7Days, neverConnected, notConnected7Days, pctHealthy };
}

function sortTagMap(tagMap) {
  return Array.from(tagMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * Build one row per sensor from GET /tags: each tag may include a `sensors` array.
 * When `filterTagIds` is set, only tags in that list contribute their sensors.
 */
function collectSensorsFromTagRows(tagRows, filterTagIds) {
  const filter = filterTagIds.length ? new Set(filterTagIds.map(String)) : null;
  const bySensor = new Map();
  for (const tag of tagRows) {
    if (!tag || tag.id == null) continue;
    const tagId = String(tag.id);
    const tagName = tag.name != null ? String(tag.name) : "—";
    if (filter && !filter.has(tagId)) continue;
    const sensors = Array.isArray(tag.sensors) ? tag.sensors : [];
    for (const s of sensors) {
      if (!s || s.id == null || isDeactivatedTagSensor(s)) continue;
      const sid = String(s.id);
      const sname = s.name != null ? String(s.name) : "—";
      if (!bySensor.has(sid)) {
        bySensor.set(sid, { id: sid, name: sname, tagNames: new Set() });
      }
      const entry = bySensor.get(sid);
      entry.tagNames.add(tagName);
      if (entry.name === "—" && sname !== "—") entry.name = sname;
    }
  }
  return Array.from(bySensor.values()).map((e) => ({
    id: e.id,
    name: e.name,
    tagValue: Array.from(e.tagNames)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .join(", "),
  }));
}

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());
app.use(protectApiRoutes);

app.post("/api/auth/login", (req, res) => {
  if (!isAuthEnabled()) {
    res.json({ ok: true, authRequired: false });
    return;
  }
  const username = req.body?.username != null ? String(req.body.username) : "";
  const password = req.body?.password != null ? String(req.body.password) : "";
  if (!validateCredentials(username, password)) {
    auditFromRequest(req, "login_failed", username || null);
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }
  setSessionCookie(res, createSessionToken(username));
  auditFromRequest(req, "login_success", username);
  res.json({ ok: true, authRequired: true });
});

app.post("/api/auth/logout", (req, res) => {
  const session = getSession(req);
  auditFromRequest(req, "logout", session?.username ?? null);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/session", (req, res) => {
  const authenticated = isAuthenticated(req);
  const authRequired = isAuthEnabled();
  if (authenticated && authRequired) {
    const session = getSession(req);
    if (session) {
      auditLog.recordSiteAccess({
        username: session.username,
        ip: getClientIp(req),
        userAgent: getUserAgent(req),
      });
    }
  }
  res.json({
    authenticated,
    authRequired,
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasToken: Boolean(TOKEN),
    base: BASE,
    samsaraPathStyle: DEFAULT_PATH_STYLE,
    notesDbPath: NOTES_DB_PATH,
    auditDbPath: AUDIT_DB_PATH,
  });
});

/** Organization id from Samsara GET /me (for deep links to cloud.samsara.com). */
app.get("/api/org-id", async (_req, res) => {
  if (!requireToken(res)) return;
  try {
    const body = await samsaraFetch("/me", null);
    const orgId = extractOrgIdFromMe(body);
    if (!orgId) {
      return res.status(502).json({
        error: "Could not parse organization id from GET /me",
        hint: "Confirm the token can access GET /me and the response includes organization id.",
      });
    }
    res.json({ orgId });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      details: e.body,
      hint: "Ensure SAMSARA_API_BASE matches your org region and the token is valid.",
    });
  }
});

app.get("/api/tags", async (_req, res) => {
  if (!requireToken(res)) return;
  const tagMap = new Map();
  let fromList = 0;
  let listErr = null;
  try {
    for (const row of await paginateList("/tags", new URLSearchParams({ limit: "512" }))) {
      if (row?.id == null) continue;
      fromList += 1;
      tagMap.set(String(row.id), { id: String(row.id), name: String(row.name ?? "—") });
    }
  } catch (e) {
    listErr = e;
  }
  if (tagMap.size === 0) {
    try {
      for (const t of (await extractTagsFromAssets()).values()) tagMap.set(t.id, t);
    } catch (e) {
      if (listErr) {
        return res.status(listErr.status || 500).json({
          error: listErr.message,
          details: listErr.body,
          hint: "Tried /tags, then /assets. Ensure the token has Read Tags and Read Assets, and that SAMSARA_API_BASE matches your org region (US / EU / CA).",
        });
      }
      return res.status(e.status || 500).json({ error: e.message, details: e.body });
    }
  }
  return res.json({
    data: sortTagMap(tagMap),
    source: fromList > 0 ? "list" : tagMap.size > 0 ? "assets" : "empty",
  });
});

/** Per-tag connectivity summary; aggregates on the server (one tags fetch + parallel readings). */
app.get("/api/health-summary/snapshot", (_req, res) => {
  try {
    const snapshot = healthSummaryStore.getLatestSnapshot();
    if (!snapshot) {
      return res.json({ data: null, fleetTotals: null, dataRetrievedAt: null, storedAt: null });
    }
    res.json({
      data: snapshot.summaryRows,
      fleetTotals: snapshot.fleetTotals,
      dataRetrievedAt: snapshot.dataRetrievedAt,
      storedAt: snapshot.storedAt,
    });
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "Failed to load health summary snapshot",
    });
  }
});

/** Restore a snapshot from browser cache when SQLite is empty (e.g. after WAL loss on Google Drive). */
app.post("/api/health-summary/snapshot", (req, res) => {
  try {
    const dataRetrievedAt = Number(req.body?.dataRetrievedAt);
    const fleetTotals = req.body?.fleetTotals;
    const summaryRows = req.body?.summaryRows;
    if (!Number.isFinite(dataRetrievedAt)) {
      return res.status(400).json({ error: "Invalid dataRetrievedAt" });
    }
    if (!Array.isArray(summaryRows)) {
      return res.status(400).json({ error: "summaryRows must be an array" });
    }
    if (
      !fleetTotals ||
      typeof fleetTotals !== "object" ||
      typeof fleetTotals.totalSensors !== "number" ||
      typeof fleetTotals.connectedLast7Days !== "number" ||
      typeof fleetTotals.neverConnected !== "number" ||
      typeof fleetTotals.notConnected7Days !== "number" ||
      typeof fleetTotals.pctHealthy !== "number"
    ) {
      return res.status(400).json({ error: "Invalid fleetTotals" });
    }
    const latest = healthSummaryStore.getLatestSnapshot();
    if (latest && latest.dataRetrievedAt >= dataRetrievedAt) {
      return res.json({ restored: false, reason: "server_already_has_newer_snapshot" });
    }
    healthSummaryStore.saveSnapshot({ dataRetrievedAt, fleetTotals, summaryRows });
    healthSummaryStore.checkpoint();
    res.json({ restored: true, dataRetrievedAt });
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "Failed to restore health summary snapshot",
    });
  }
});

/** Org/tag trends from saved snapshot history (comparison + time series). */
app.get("/api/health-summary/trends", (req, res) => {
  try {
    const modeRaw = req.query.mode != null ? String(req.query.mode).trim() : String(req.query.baseline ?? "baseline").trim();
    const mode = modeRaw === "dates" ? "dates" : "baseline";
    const startDate = req.query.startDate != null ? String(req.query.startDate).trim() : null;
    const endDate = req.query.endDate != null ? String(req.query.endDate).trim() : null;
    const historyLimit = req.query.historyLimit != null ? Number(req.query.historyLimit) : 14;
    const snapshots = healthSummaryStore.listSnapshots(120);
    const trends = buildHealthSummaryTrends(snapshots, { mode, startDate, endDate, historyLimit });
    res.json(trends);
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "Failed to load health summary trends",
    });
  }
});

/** Per-tag connectivity summary; aggregates on the server (one tags fetch + parallel readings). */
async function fetchAndSaveHealthSummary() {
  const retrievedAt = Date.now();
  const tagRows = await paginateList("/tags", new URLSearchParams({ limit: "512" }));
  const sensorIds = uniqueSensorIdsFromTagRows(tagRows);
  if (sensorIds.length === 0) {
    const payload = {
      dataRetrievedAt: retrievedAt,
      data: [],
      fleetTotals: {
        totalSensors: 0,
        connectedLast7Days: 0,
        neverConnected: 0,
        notConnected7Days: 0,
        pctHealthy: 0,
      },
    };
    healthSummaryStore.saveSnapshot({
      dataRetrievedAt: retrievedAt,
      fleetTotals: payload.fleetTotals,
      summaryRows: payload.data,
    });
    healthSummaryStore.checkpoint();
    return payload;
  }

  const readingRows = await fetchReadingsSnapshotBatched(sensorIds);
  const readingsByEntity = indexReadingsByEntity(readingRows);

  const emSensorIds = [];
  for (const id of sensorIds) {
    const rmap = readingsByEntity.get(String(id)) || new Map();
    if (hasEmWidgetReadings(rmap)) emSensorIds.push(String(id));
  }
  const { lastConnectedById } = await fetchGetTemperatureMetaBySensorId(emSensorIds);

  const data = buildTagHealthSummaryFromTagRows(tagRows, readingsByEntity, retrievedAt, lastConnectedById);
  const fleetTotals = buildFleetHealthTotals(tagRows, readingsByEntity, retrievedAt, lastConnectedById);

  healthSummaryStore.saveSnapshot({
    dataRetrievedAt: retrievedAt,
    fleetTotals,
    summaryRows: data,
  });
  healthSummaryStore.checkpoint();

  return { dataRetrievedAt: retrievedAt, data, fleetTotals };
}

/** Schedule info for daily 12:00 AM Eastern snapshots (Health Summary / Trends banners). */
app.get("/api/health-summary/schedule", (_req, res) => {
  try {
    res.json(getHealthSummaryScheduleInfo(healthSummaryStore));
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "Failed to load health summary schedule",
    });
  }
});

/** Per-tag connectivity summary; aggregates on the server (one tags fetch + parallel readings). */
app.get("/api/health-summary", async (_req, res) => {
  if (!requireToken(res)) return;
  try {
    const payload = await fetchAndSaveHealthSummary();
    res.json(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const io = isSqliteIoError(e) || /disk I\/O error/i.test(msg);
    res.status(e.status || 500).json({
      error: msg,
      details: e.body,
      hint: io
        ? "SQLite could not write the health-summary database (common when the project folder is on Google Drive). Restart the server so DBs move to ~/Library/Application Support/CanteenEMHealth/, or set HEALTH_SUMMARY_DB_PATH to a local path."
        : "Confirm Read Tags, Read Readings, and Write Sensors (GetTemperature) on the API token. Tags must return a sensors list.",
    });
  }
});

app.get("/api/sensor-records", async (req, res) => {
  if (!requireToken(res)) return;
  const tagIds = req.query.tagIds
    ? String(req.query.tagIds)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  try {
    const tagRows = await paginateList("/tags", new URLSearchParams({ limit: "512" }));
    const sensorList = collectSensorsFromTagRows(tagRows, tagIds);
    if (!sensorList.length) {
      return res.json({ data: [] });
    }

    const readingRows = await fetchReadingsSnapshotBatched(sensorList.map((s) => s.id));
    const readingsByEntity = indexReadingsByEntity(readingRows);

    const emSensorIds = [];
    for (const s of sensorList) {
      const rmap = readingsByEntity.get(s.id) || new Map();
      if (hasEmWidgetReadings(rmap)) emSensorIds.push(s.id);
    }
    const { connectedToById, lastConnectedById } = await fetchGetTemperatureMetaBySensorId(emSensorIds);

    const records = [];
    for (const s of sensorList) {
      const id = s.id;
      const rmap = readingsByEntity.get(id) || new Map();
      if (!hasEmWidgetReadings(rmap)) continue;
      // Prefer GetTemperature ambientTemperatureTime — last time the sensor reported ambient temp.
      const lastTime = lastConnectedById.get(id) ?? null;

      const wbv = rmap.get("widgetBatteryVoltage")?.value;
      const wbl = rmap.get("widgetBatteryVoltageLow")?.value;
      const temp = rmap.get("environmentMonitorAmbientTemperatureBLEConnection")?.value;

      records.push({
        id,
        name: s.name,
        tagValue: s.tagValue,
        lastConnectedTime: lastTime,
        connectedTo: connectedToById.get(id) ?? "—",
        batteryVoltage: formatReadingValue("widgetBatteryVoltage", wbv),
        batteryVoltageLow: formatReadingValue("widgetBatteryVoltageLow", wbl),
        temperature: formatReadingValue("environmentMonitorAmbientTemperatureBLEConnection", temp),
      });
    }

    records.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    const noteMap = notesStore.getMany(records.map((r) => r.id));
    for (const r of records) {
      r.note = noteMap.get(r.id) ?? "";
    }

    res.json({ data: records });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      details: e.body,
      hint: "Confirm Read Tags and Read Readings on the API token. Tags must return a sensors list. SAMSARA_READINGS_ENTITY_TYPE can override entityType (default sensor).",
    });
  }
});

/**
 * On-demand 30-day ambient temperature history for one sensor (GET /readings/history).
 * Does not run during /api/sensor-records — only when the UI opens the temperature chart.
 */
app.get("/api/sensor-temperature-history", async (req, res) => {
  if (!requireToken(res)) return;
  const rawId = req.query.sensorId != null ? String(req.query.sensorId).trim() : "";
  if (!rawId || !/^[\w-]{1,128}$/.test(rawId)) {
    res.status(400).json({ error: "Missing or invalid sensorId query parameter" });
    return;
  }

  const endMs = Date.now();
  const startMs = endMs - 30 * 24 * 60 * 60 * 1000;
  const endTime = new Date(endMs).toISOString();
  const startTime = new Date(startMs).toISOString();

  const params = new URLSearchParams();
  params.set("entityType", READINGS_ENTITY_TYPE);
  params.set("entityIds", rawId);
  params.set("readingId", TEMP_BLE_READING_ID);
  params.set("startTime", startTime);
  params.set("endTime", endTime);

  try {
    const rows = await paginateReadingsHistory(params);
    const points = [];
    for (const row of rows) {
      if (!row || row.entityId == null) continue;
      if (String(row.entityId) !== rawId) continue;
      const at = row.happenedAtTime != null ? String(row.happenedAtTime) : "";
      if (!at) continue;
      const f = readingCelsiusToFahrenheit(row.value);
      if (f == null) continue;
      points.push({ at, fahrenheit: f });
    }
    points.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    let maxF = -Infinity;
    let minF = Infinity;
    let sum = 0;
    let n = 0;
    for (const p of points) {
      maxF = Math.max(maxF, p.fahrenheit);
      minF = Math.min(minF, p.fahrenheit);
      sum += p.fahrenheit;
      n += 1;
    }
    const latestF = n > 0 ? points[n - 1].fahrenheit : null;

    res.json({
      sensorId: rawId,
      readingId: TEMP_BLE_READING_ID,
      startTime,
      endTime,
      points,
      stats:
        n > 0
          ? {
              maxF,
              minF,
              avgF: sum / n,
              latestF,
              count: n,
            }
          : null,
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      details: e.body,
      hint: "Requires Read Readings scope and GET /readings/history access. SAMSARA_READINGS_ENTITY_TYPE must match your sensors (default sensor).",
    });
  }
});

/**
 * Batch 30-day max/min/avg ambient temperature (°F) for many sensors.
 * Body: { sensorIds: string[] }. Runs with limited concurrency; soft-fails per sensor.
 */
app.post("/api/sensor-temperature-stats", async (req, res) => {
  if (!requireToken(res)) return;
  const raw = req.body?.sensorIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    res.status(400).json({ error: "Request body must include a non-empty sensorIds array" });
    return;
  }
  const sensorIds = [];
  for (const id of raw) {
    const s = id != null ? String(id).trim() : "";
    if (s && /^[\w-]{1,128}$/.test(s)) sensorIds.push(s);
  }
  if (!sensorIds.length) {
    res.status(400).json({ error: "No valid sensorIds provided" });
    return;
  }
  /** Cap one request so a full-org load stays intentional via multiple calls if needed. */
  const capped = sensorIds.slice(0, 500);

  try {
    const byId = await fetchTempStatsBySensorId(capped);
    const data = {};
    for (const id of capped) {
      const stats = byId.get(id) ?? null;
      data[id] = stats
        ? {
            max: formatTempFDisplay(stats.maxF),
            min: formatTempFDisplay(stats.minF),
            avg: formatTempFDisplay(stats.avgF),
            maxF: stats.maxF,
            minF: stats.minF,
            avgF: stats.avgF,
            count: stats.count,
          }
        : null;
    }
    res.json({ data, readingId: TEMP_BLE_READING_ID, windowDays: 30 });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      details: e.body,
      hint: "Requires Read Readings scope and GET /readings/history access.",
    });
  }
});

app.put("/api/sensor-notes/:sensorId", (req, res) => {
  try {
    const sensorId = req.params.sensorId != null ? String(req.params.sensorId).trim() : "";
    if (!sensorId) {
      res.status(400).json({ error: "Missing sensor id" });
      return;
    }
    const raw = req.body?.note;
    const note = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    if (note.length > MAX_NOTE_LENGTH) {
      res.status(400).json({
        error: `Note exceeds maximum length (${MAX_NOTE_LENGTH} characters)`,
      });
      return;
    }
    notesStore.upsert(sensorId, note);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to save note" });
  }
});

function formatReadingValue(readingId, value) {
  const v = unwrapValue(value);
  if (v === undefined || v === null) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    if (readingId === "widgetBatteryVoltage" && typeof v === "number") {
      if (v > 50) return `${(v / 1000).toFixed(2)} V`;
      return `${v.toFixed(2)} V`;
    }
    if (typeof v === "number" && readingId === "environmentMonitorAmbientTemperatureBLEConnection") {
      const f = (v * 9) / 5 + 32;
      return `${f.toFixed(1)}°F`;
    }
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "—";
  }
}

/** Numeric °F from a history `value` object (Samsara reports °C for this reading). */
function readingCelsiusToFahrenheit(value) {
  const v = unwrapValue(value);
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return (v * 9) / 5 + 32;
}

function formatTempFDisplay(f) {
  if (typeof f !== "number" || !Number.isFinite(f)) return "—";
  return `${f.toFixed(1)}°F`;
}

/**
 * 30-day ambient BLE temperature max/min/avg for one sensor (no point payload).
 * @returns {Promise<{ maxF: number, minF: number, avgF: number, count: number } | null>}
 */
async function computeTempStatsForSensor(sensorId) {
  const endMs = Date.now();
  const startMs = endMs - 30 * 24 * 60 * 60 * 1000;
  const params = new URLSearchParams();
  params.set("entityType", READINGS_ENTITY_TYPE);
  params.set("entityIds", sensorId);
  params.set("readingId", TEMP_BLE_READING_ID);
  params.set("startTime", new Date(startMs).toISOString());
  params.set("endTime", new Date(endMs).toISOString());

  const rows = await paginateReadingsHistory(params);
  let maxF = -Infinity;
  let minF = Infinity;
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    if (!row || row.entityId == null) continue;
    if (String(row.entityId) !== sensorId) continue;
    const f = readingCelsiusToFahrenheit(row.value);
    if (f == null) continue;
    maxF = Math.max(maxF, f);
    minF = Math.min(minF, f);
    sum += f;
    n += 1;
  }
  if (n === 0) return null;
  return { maxF, minF, avgF: sum / n, count: n };
}

/**
 * @param {string[]} sensorIds
 * @returns {Promise<Map<string, { maxF: number, minF: number, avgF: number, count: number } | null>>}
 */
async function fetchTempStatsBySensorId(sensorIds) {
  const ids = [...new Set(sensorIds.map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += TEMP_STATS_CONCURRENCY) {
    const wave = ids.slice(i, i + TEMP_STATS_CONCURRENCY);
    await Promise.all(
      wave.map(async (id) => {
        try {
          out.set(id, await computeTempStatsForSensor(id));
        } catch (e) {
          console.warn("Temp stats (30d) unavailable for sensor", id, e instanceof Error ? e.message : e);
          out.set(id, null);
        }
      }),
    );
  }
  return out;
}

function unwrapValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  if ("value" in value && value.value !== undefined) return unwrapValue(value.value);
  if ("doubleValue" in value && typeof value.doubleValue === "number") return value.doubleValue;
  if ("stringValue" in value && typeof value.stringValue === "string") return value.stringValue;
  return value;
}

const server = app.listen(PORT, () => {
  console.log(`Samsara proxy on http://127.0.0.1:${PORT} → ${BASE}`);
  console.log(`Sensor notes DB: ${NOTES_DB_PATH}`);
  console.log(`Access audit DB: ${AUDIT_DB_PATH}`);
  console.log(`Health summary DB: ${HEALTH_SUMMARY_DB_PATH}`);
  const snapshotCount = healthSummaryStore.getSnapshotCount();
  const latest = healthSummaryStore.getLatestSnapshot();
  if (latest) {
    console.log(
      `Health summary snapshots: ${snapshotCount} (latest ${new Date(latest.dataRetrievedAt).toISOString()})`,
    );
  } else {
    console.log("Health summary snapshots: none saved yet — daily 12:00 AM Eastern job or Refresh will save one.");
  }
  if (isAuthEnabled()) {
    console.log("Site login: enabled (SITE_PASSWORD is set)");
  } else {
    console.warn("Site login: disabled. Set SITE_PASSWORD in .env to require sign-in.\n");
  }
  if (!TOKEN) console.warn("SAMSARA_API_TOKEN is not set. Add it to .env to load data.\n");
});

const dailyHealthSummaryScheduler = startDailyHealthSummaryScheduler({
  hasToken: () => Boolean(TOKEN),
  runSnapshot: () => fetchAndSaveHealthSummary(),
  getLatestSnapshot: () => healthSummaryStore.getLatestSnapshot(),
});

function shutdownDatabases() {
  try {
    dailyHealthSummaryScheduler.stop();
  } catch {
    /* ignore */
  }
  try {
    healthSummaryStore.close();
  } catch {
    /* ignore */
  }
  try {
    notesStore.close();
  } catch {
    /* ignore */
  }
  try {
    auditLog.close();
  } catch {
    /* ignore */
  }
}

function shutdown(signal) {
  console.log(`\n${signal} received — checkpointing databases…`);
  shutdownDatabases();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.on("error", (err) => {
  if (err && "code" in err && err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use. Stop the other process or set PORT in .env.\n` +
        `  lsof -i :${PORT}\n` +
        `  kill <pid>\n`,
    );
    process.exit(1);
  }
  throw err;
});
