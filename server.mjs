import "dotenv/config";
import cors from "cors";
import express from "express";
import { join } from "node:path";
import { MAX_NOTE_LENGTH, openSensorNotesDb } from "./notes-db.mjs";

const PORT = Number(process.env.PORT ?? 3001);
const BASE = (process.env.SAMSARA_API_BASE ?? "https://api.samsara.com").replace(/\/$/, "");
const TOKEN = process.env.SAMSARA_API_TOKEN;
/** Readings snapshot entity type for EM widget fields (use `sensor` for hardware from List tags → sensors). */
const READINGS_ENTITY_TYPE = process.env.SAMSARA_READINGS_ENTITY_TYPE ?? "sensor";

/** Match public Samsara URLs: https://api.samsara.com/tags, /assets, /readings/latest (no /v1). Override with SAMSARA_PATH_STYLE=v1 if needed. */
const DEFAULT_PATH_STYLE = process.env.SAMSARA_PATH_STYLE === "v1" ? "v1" : "root";

const READING_IDS = [
  "widgetBatteryVoltage",
  "widgetBatteryVoltageLow",
  "environmentMonitorAmbientTemperatureBLEConnection",
].join(",");

const ENTITY_BATCH = 50;

const NOTES_DB_PATH = process.env.NOTES_DB_PATH ?? join(process.cwd(), "data", "sensor-notes.sqlite");
const notesStore = openSensorNotesDb(NOTES_DB_PATH);

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

function chunk(arr, n) {
  const res = [];
  for (let i = 0; i < arr.length; i += n) res.push(arr.slice(i, i + n));
  return res;
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
      if (!s || s.id == null) continue;
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
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasToken: Boolean(TOKEN),
    base: BASE,
    samsaraPathStyle: DEFAULT_PATH_STYLE,
    notesDbPath: NOTES_DB_PATH,
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

    const readingRows = [];
    for (const batch of chunk(
      sensorList.map((s) => s.id),
      ENTITY_BATCH,
    )) {
      const p = new URLSearchParams();
      p.set("entityType", READINGS_ENTITY_TYPE);
      p.set("readingIds", READING_IDS);
      p.set("entityIds", batch.join(","));
      const part = await paginateReadingsSnapshot(p);
      readingRows.push(...part);
    }

    const readingsByEntity = new Map();
    for (const row of readingRows) {
      const eid = String(row.entityId);
      if (!readingsByEntity.has(eid)) readingsByEntity.set(eid, new Map());
      readingsByEntity.get(eid).set(row.readingId, {
        value: row.value,
        happenedAtTime: row.happenedAtTime,
      });
    }

    const records = [];
    for (const s of sensorList) {
      const id = s.id;
      const rmap = readingsByEntity.get(id) || new Map();
      const t1 = rmap.get("widgetBatteryVoltage")?.happenedAtTime;
      const t2 = rmap.get("widgetBatteryVoltageLow")?.happenedAtTime;
      const t3 = rmap.get("environmentMonitorAmbientTemperatureBLEConnection")?.happenedAtTime;
      const times = [t1, t2, t3].filter(Boolean);
      const lastTime =
        times.length > 0
          ? times.reduce((best, t) => (new Date(t) > new Date(best) ? t : best), times[0])
          : null;

      const wbv = rmap.get("widgetBatteryVoltage")?.value;
      const wbl = rmap.get("widgetBatteryVoltageLow")?.value;
      const temp = rmap.get("environmentMonitorAmbientTemperatureBLEConnection")?.value;

      records.push({
        id,
        name: s.name,
        tagValue: s.tagValue,
        lastConnectedTime: lastTime,
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

function unwrapValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  if ("value" in value && value.value !== undefined) return unwrapValue(value.value);
  if ("doubleValue" in value && typeof value.doubleValue === "number") return value.doubleValue;
  if ("stringValue" in value && typeof value.stringValue === "string") return value.stringValue;
  return value;
}

app.listen(PORT, () => {
  console.log(`Samsara proxy on http://127.0.0.1:${PORT} → ${BASE}`);
  console.log(`Sensor notes DB: ${NOTES_DB_PATH}`);
  if (!TOKEN) console.warn("SAMSARA_API_TOKEN is not set. Add it to .env to load data.\n");
});
