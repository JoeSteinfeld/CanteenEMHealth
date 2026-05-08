import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type Tag = { id: string | number; name: string };
type Row = {
  id: string;
  name: string;
  tagValue: string;
  lastConnectedTime: string | null;
  batteryVoltage: string;
  batteryVoltageLow: string;
  temperature: string;
  note: string;
};

type SortKey = keyof Row | "action";
type SortDir = "asc" | "desc";

type TempHistoryPoint = { at: string; fahrenheit: number };
type TempHistoryStats = {
  maxF: number;
  minF: number;
  avgF: number;
  latestF: number | null;
  count: number;
};
type TempHistoryPayload = {
  sensorId: string;
  readingId: string;
  startTime: string;
  endTime: string;
  points: TempHistoryPoint[];
  stats: TempHistoryStats | null;
};

type HealthCategory = "never" | "stale" | "recentLow" | "recentOk";

const HEALTH_CATEGORY_CONFIG: { key: HealthCategory; label: string; aria: string }[] = [
  { key: "never", label: "# never connected", aria: "Filter list by: never connected" },
  { key: "stale", label: "# not connected in 7 days", aria: "Filter list by: not connected in 7 days" },
  { key: "recentLow", label: "# connected but low battery", aria: "Filter list by: connected with low battery" },
  { key: "recentOk", label: "# connected in 7 days", aria: "Filter list by: connected in 7 days" },
];

/** Table columns: sort keys + labels (single source for header, filters, CSV order is separate). */
const TABLE_COLUMNS = [
  { key: "tagValue" as const, label: "Tag value" },
  { key: "id" as const, label: "ID" },
  { key: "name" as const, label: "Name" },
  { key: "lastConnectedTime" as const, label: "Last connected time" },
  { key: "batteryVoltageLow" as const, label: "Battery voltage level" },
  { key: "batteryVoltage" as const, label: "Battery voltage" },
  { key: "temperature" as const, label: "Temperature" },
  { key: "action" as const, label: "Action" },
  { key: "note" as const, label: "Notes" },
] as const;

type TableColumnKey = (typeof TABLE_COLUMNS)[number]["key"];

function emptyColumnSearch(): Record<TableColumnKey, string> {
  const o = {} as Record<TableColumnKey, string>;
  for (const c of TABLE_COLUMNS) o[c.key] = "";
  return o;
}

/** Window length for fleet/environment deep links (seconds). */
const SAMSARA_ENV_WINDOW_SEC = 30 * 24 * 60 * 60;

/** Opens Environment → Sensors for this org/name in Samsara Cloud (last 30 days ending now). */
function buildSamsaraSensorEnvironmentUrl(orgId: string, sensorName: string): string {
  const endMs = Date.now();
  const q = encodeURIComponent(sensorName);
  return `https://cloud.samsara.com/o/${encodeURIComponent(orgId)}/fleet/environment?q=${q}&view=sensors&duration=${SAMSARA_ENV_WINDOW_SEC}&end_ms=${endMs}`;
}

/** Opens Fleet → Config → Sensors in Samsara Cloud; `q` is the sensor name. */
function buildSamsaraSensorConfigSensorsUrl(orgId: string, sensorName: string): string {
  const q = encodeURIComponent(sensorName);
  return `https://cloud.samsara.com/o/${encodeURIComponent(orgId)}/fleet/config/sensors?q=${q}`;
}

function hasColumnSearch(filters: Record<TableColumnKey, string>): boolean {
  return TABLE_COLUMNS.some((c) => filters[c.key].trim() !== "");
}

async function parseJsonSafe(r: Response): Promise<Record<string, unknown>> {
  const t = await r.text();
  if (!t) return {};
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    throw new Error(`Not JSON (HTTP ${r.status}): ${t.slice(0, 200)}`);
  }
}

function SensorNoteField({
  sensorId,
  value,
  onPersisted,
}: {
  sensorId: string;
  value: string;
  onPersisted: (sensorId: string, note: string) => void;
}) {
  const [text, setText] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(value);

  useEffect(() => {
    setText(value);
    lastSavedRef.current = value;
  }, [value, sensorId]);

  const persist = useCallback(
    async (note: string) => {
      try {
        const res = await fetch(`/api/sensor-notes/${encodeURIComponent(sensorId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }),
        });
        const j = await parseJsonSafe(res);
        if (!res.ok) {
          throw new Error([j.error, j.hint].filter(Boolean).join(" — ") || res.statusText);
        }
        lastSavedRef.current = note;
        onPersisted(sensorId, note);
      } catch (e) {
        console.error(e);
      }
    },
    [sensorId, onPersisted],
  );

  const schedulePersist = useCallback(
    (note: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void persist(note);
      }, 800);
    },
    [persist],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <textarea
      className="sensor-note-input"
      rows={2}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        schedulePersist(v);
      }}
      onBlur={() => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (text !== lastSavedRef.current) void persist(text);
      }}
      aria-label={`Notes for sensor ${sensorId}`}
    />
  );
}

function formatTempF(n: number): string {
  return `${n.toFixed(1)}°F`;
}

/** Index of the sample whose time is closest to `t` (unix ms). Assumes `ts` sorted ascending. */
function nearestIndexByTime(ts: number[], t: number): number {
  const n = ts.length;
  if (n === 0) return -1;
  if (n === 1) return 0;
  if (t <= ts[0]) return 0;
  if (t >= ts[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - ts[lo] <= ts[hi] - t ? lo : hi;
}

function formatHoverDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const datePart = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${datePart} ${timePart}`;
}

function TemperatureHistoryChart({ points }: { points: TempHistoryPoint[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const vbW = 690;
  const vbH = 240;
  const padL = 44;
  const padR = 16;
  /** Extra top inset so hover temperature (above crosshair) clears the grid */
  const padT = 22;
  const padB = 32;
  const innerW = vbW - padL - padR;
  const innerH = vbH - padT - padB;

  if (points.length === 0) {
    return (
      <div className="temp-history-chart-empty muted">No temperature samples in this window.</div>
    );
  }

  const ts = points.map((p) => new Date(p.at).getTime());
  const fs = points.map((p) => p.fahrenheit);
  let tMin = Math.min(...ts);
  let tMax = Math.max(...ts);
  let fMin = Math.min(...fs);
  let fMax = Math.max(...fs);
  if (tMax <= tMin) {
    tMax = tMin + 1;
  }
  const fPad = Math.max((fMax - fMin) * 0.08, 1);
  fMin -= fPad;
  fMax += fPad;

  const toX = (t: number) => padL + ((t - tMin) / (tMax - tMin)) * innerW;
  const toY = (f: number) => padT + innerH - ((f - fMin) / (fMax - fMin)) * innerH;

  const lineD = points
    .map((p, i) => {
      const x = toX(new Date(p.at).getTime());
      const y = toY(p.fahrenheit);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const last = points[points.length - 1];
  const lx = toX(new Date(last.at).getTime());
  const ly = toY(last.fahrenheit);

  const clientToSvg = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = svgRef.current;
    if (!el) return null;
    const pt = el.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = el.getScreenCTM();
    if (!ctm) return null;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const updateHoverFromEvent = (e: React.MouseEvent<SVGRectElement>) => {
    const p = clientToSvg(e.clientX, e.clientY);
    if (!p) return;
    const { x: sx, y: sy } = p;
    if (sx < padL || sx > padL + innerW || sy < padT || sy > padT + innerH) {
      setHoverIdx(null);
      return;
    }
    const tHover = tMin + ((sx - padL) / innerW) * (tMax - tMin);
    setHoverIdx(nearestIndexByTime(ts, tHover));
  };

  const hi = hoverIdx != null && hoverIdx >= 0 && hoverIdx < points.length ? hoverIdx : null;
  const hp = hi != null ? points[hi] : null;
  const hx = hp ? toX(new Date(hp.at).getTime()) : 0;
  const hy = hp ? toY(hp.fahrenheit) : 0;
  const timeStr = hp ? formatHoverDateTime(hp.at) : "";
  const timeBoxW = Math.min(innerW, Math.max(140, timeStr.length * 5.6 + 20));
  const timeBoxX = Math.max(padL + 2, Math.min(hx - timeBoxW / 2, vbW - padR - timeBoxW - 2));
  /** Top of viewBox, above plot (starts at padT); centered on crosshair — matches dashboard hover pattern */
  const tempLabelY = 2;

  const yTicks = 5;
  const gridLines = [];
  const yLabels = [];
  for (let i = 0; i <= yTicks; i += 1) {
    const f = fMin + (i / yTicks) * (fMax - fMin);
    const y = toY(f);
    gridLines.push(
      <line
        key={`h-${i}`}
        x1={padL}
        y1={y}
        x2={padL + innerW}
        y2={y}
        className="temp-history-grid"
      />,
    );
    yLabels.push(
      <text key={`yl-${i}`} x={padL - 6} y={y + 4} className="temp-history-axis-text" textAnchor="end">
        {Math.round(f)}
      </text>,
    );
  }

  const labelIdx = [0, Math.floor((points.length - 1) / 4), Math.floor((points.length - 1) / 2), Math.floor((3 * (points.length - 1)) / 4), points.length - 1].filter(
    (i, j, a) => i >= 0 && a.indexOf(i) === j,
  );
  const xLabels = labelIdx.map((i) => {
    const p = points[i];
    const x = toX(new Date(p.at).getTime());
    const d = new Date(p.at);
    const txt =
      d.getFullYear() === new Date().getFullYear()
        ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
    return (
      <text key={`xl-${i}`} x={x} y={vbH - 8} className="temp-history-axis-text" textAnchor="middle">
        {txt}
      </text>
    );
  });

  return (
    <svg
      ref={svgRef}
      className="temp-history-chart"
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Temperature over the last 30 days. Hover the chart to read values."
    >
      {gridLines}
      <path d={lineD} className="temp-history-line" fill="none" pointerEvents="none" />
      {hoverIdx === null && <circle cx={lx} cy={ly} r={4} className="temp-history-dot" pointerEvents="none" />}
      {yLabels}
      {xLabels}
      <rect
        className="temp-history-hit"
        x={padL}
        y={padT}
        width={innerW}
        height={innerH}
        fill="transparent"
        pointerEvents="all"
        onMouseMove={updateHoverFromEvent}
        onMouseLeave={() => setHoverIdx(null)}
      />
      {hp != null && (
        <g className="temp-history-hover" pointerEvents="none">
          <line x1={hx} y1={padT} x2={hx} y2={padT + innerH} className="temp-history-crosshair" />
          <circle cx={hx} cy={hy} r={5} className="temp-history-hover-dot" />
          <text
            x={hx}
            y={tempLabelY}
            className="temp-history-hover-temp"
            textAnchor="middle"
            dominantBaseline="hanging"
          >
            {formatTempF(hp.fahrenheit)}
          </text>
          <rect
            x={timeBoxX}
            y={vbH - 26}
            width={timeBoxW}
            height={20}
            rx={3}
            className="temp-history-time-bg"
          />
          <text x={timeBoxX + timeBoxW / 2} y={vbH - 11} className="temp-history-time-text" textAnchor="middle">
            {timeStr}
          </text>
        </g>
      )}
    </svg>
  );
}

function TemperatureHistoryModal({
  open,
  sensorId,
  sensorName,
  onClose,
}: {
  open: boolean;
  sensorId: string | null;
  sensorName: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<TempHistoryPayload | null>(null);

  useEffect(() => {
    if (!open || !sensorId) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    void (async () => {
      try {
        const r = await fetch(`/api/sensor-temperature-history?sensorId=${encodeURIComponent(sensorId)}`);
        const j = (await parseJsonSafe(r)) as Record<string, unknown>;
        if (!r.ok) {
          const msg = [j.error, j.hint].filter(Boolean).join(" — ");
          throw new Error(msg || r.statusText);
        }
        if (!cancelled) setData(j as unknown as TempHistoryPayload);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sensorId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const titleId = "temp-history-modal-title";
  const st = data?.stats;

  return (
    <div
      className="temp-history-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="temp-history-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="temp-history-head">
          <div>
            <h2 id={titleId} className="temp-history-title">
              Temperature history
            </h2>
            <p className="temp-history-sub muted">
              {sensorName || "—"} <span className="mono">({sensorId})</span> · last 30 days ·{" "}
              <code>GET /readings/history</code>
            </p>
          </div>
          <button type="button" className="temp-history-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {loading && <p className="temp-history-status muted">Loading history…</p>}
        {err && !loading && <div className="banner err temp-history-err">{err}</div>}

        {!loading && !err && data && (
          <div className="temp-history-body">
            <div className="temp-history-chart-wrap">
              <TemperatureHistoryChart points={data.points} />
            </div>
            <div className="temp-history-side">
              <div className="temp-history-stats">
                <div className="temp-history-stat">
                  <span className="temp-history-stat-label" aria-hidden>
                    ↑
                  </span>
                  <span className="temp-history-stat-value">{st ? formatTempF(st.maxF) : "—"}</span>
                  <span className="temp-history-stat-caption muted">Max</span>
                </div>
                <div className="temp-history-stat temp-history-stat-avg">
                  <span className="temp-history-stat-label" aria-hidden>
                    ·
                  </span>
                  <span className="temp-history-stat-value">{st ? formatTempF(st.avgF) : "—"}</span>
                  <span className="temp-history-stat-caption muted">Avg</span>
                </div>
                <div className="temp-history-stat">
                  <span className="temp-history-stat-label" aria-hidden>
                    ↓
                  </span>
                  <span className="temp-history-stat-value">{st ? formatTempF(st.minF) : "—"}</span>
                  <span className="temp-history-stat-caption muted">Min</span>
                </div>
              </div>
              <div className="temp-history-current">
                <span className="temp-history-current-heading">Latest</span>
                <span className="temp-history-current-when muted">
                  {data.points.length > 0
                    ? formatHoverDateTime(data.points[data.points.length - 1].at)
                    : "—"}
                </span>
                <span className="temp-history-current-value">{st?.latestF != null ? formatTempF(st.latestF) : "—"}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [tagSource, setTagSource] = useState<"list" | "assets" | "empty" | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  /** Wall-clock ms when /api/sensor-records last succeeded; used for stale (last connected over 7 days ago). */
  const [dataRetrievedAt, setDataRetrievedAt] = useState<number | null>(null);
  const [tagSearch, setTagSearch] = useState("");
  /** Empty set = no filter; otherwise table shows rows in any selected category. */
  const [healthCategoryFilters, setHealthCategoryFilters] = useState<Set<HealthCategory>>(new Set());
  /** Per-column substring filters (AND). */
  const [columnSearch, setColumnSearch] = useState<Record<TableColumnKey, string>>(emptyColumnSearch());
  /** From GET /api/org-id → Samsara GET /me; used for cloud deep links on sensor names. */
  const [samsaraOrgId, setSamsaraOrgId] = useState<string | null>(null);
  /** Row for which the temperature history modal is open (on-demand /readings/history). */
  const [tempHistoryRow, setTempHistoryRow] = useState<{ id: string; name: string } | null>(null);

  const loadTags = useCallback(async () => {
    setLoadingTags(true);
    setTagError(null);
    try {
      const r = await fetch("/api/tags");
      const j: { data?: unknown; source?: "list" | "assets" | "empty"; error?: string; hint?: string } =
        await parseJsonSafe(r);
      if (!r.ok) {
        const msg = [j.error, j.hint].filter(Boolean).join(" — ");
        throw new Error(msg || r.statusText);
      }
      setTags(Array.isArray(j.data) ? (j.data as Tag[]) : []);
      setTagSource(j.source ?? null);
    } catch (e) {
      setTagError(e instanceof Error ? e.message : "Failed to load tags");
      setTagSource(null);
    } finally {
      setLoadingTags(false);
    }
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      if (!j.hasToken) {
        setConfigError("Server is running without SAMSARA_API_TOKEN. Add it to a .env file and restart.");
      } else {
        setConfigError(null);
      }
    } catch {
      setConfigError("Cannot reach the API server. Run npm run dev and ensure the proxy is up.");
    }
  }, []);

  const loadSamsaraOrgId = useCallback(async () => {
    try {
      const r = await fetch("/api/org-id");
      const j = await parseJsonSafe(r);
      if (!r.ok) {
        setSamsaraOrgId(null);
        return;
      }
      const id = j.orgId;
      setSamsaraOrgId(typeof id === "string" || typeof id === "number" ? String(id) : null);
    } catch {
      setSamsaraOrgId(null);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    void loadTags();
    void loadSamsaraOrgId();
  }, [checkHealth, loadTags, loadSamsaraOrgId]);

  const toggleTag = (id: string) => {
    setSelectedTagIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const loadRecords = async () => {
    setLoadingData(true);
    setDataError(null);
    setRows(null);
    setDataRetrievedAt(null);
    setColumnSearch(emptyColumnSearch());
    try {
      const q = selectedTagIds.size
        ? `?tagIds=${Array.from(selectedTagIds).map(encodeURIComponent).join(",")}`
        : "";
      const r = await fetch(`/api/sensor-records${q}`);
      const j: { data?: unknown; error?: string; hint?: string } = await parseJsonSafe(r);
      if (!r.ok) {
        const msg = [j.error, j.hint].filter(Boolean).join(" — ");
        throw new Error(msg || r.statusText);
      }
      const retrievedAt = Date.now();
      setRows(Array.isArray(j.data) ? (j.data as Row[]) : []);
      setDataRetrievedAt(retrievedAt);
    } catch (e) {
      setDataError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoadingData(false);
    }
  };

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedRows = useMemo(() => {
    if (!rows) return null;
    const list = [...rows];
    const mul = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => compareRows(a, b, sortKey, mul, dataRetrievedAt));
    return list;
  }, [rows, sortKey, sortDir, dataRetrievedAt]);

  const displayRows = useMemo(() => {
    if (!sortedRows) return null;
    let list = sortedRows;
    if (healthCategoryFilters.size > 0) {
      list = list.filter((r) => {
        const c = categorizeSensorHealth(r, dataRetrievedAt);
        return healthCategoryFilters.has(c);
      });
    }
    if (hasColumnSearch(columnSearch)) {
      list = list.filter((r) => rowMatchesColumnSearch(r, columnSearch, dataRetrievedAt));
    }
    return list;
  }, [sortedRows, dataRetrievedAt, healthCategoryFilters, columnSearch]);

  const toggleHealthCategoryFilter = (key: HealthCategory) => {
    setHealthCategoryFilters((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  const handleNotePersisted = useCallback((sensorId: string, note: string) => {
    setRows((prev) => (prev ? prev.map((r) => (r.id === sensorId ? { ...r, note } : r)) : prev));
  }, []);

  const exportCsv = useCallback(() => {
    if (!displayRows?.length) return;
    const text = buildEmSensorExportCsv(displayRows, dataRetrievedAt);
    const blob = new Blob([`\uFEFF${text}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `em-sensor-health-${fileStampForExport()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [displayRows, dataRetrievedAt]);

  const tagSelectSummary = useMemo(() => {
    if (loadingTags) return "Loading tags…";
    if (tags.length === 0) return "No tags available";
    if (selectedTagIds.size === 0) return "All tags (no filter)";
    const names = tags.filter((t) => selectedTagIds.has(String(t.id))).map((t) => t.name);
    const head = names.slice(0, 4).join(", ");
    const more = names.length > 4 ? "…" : "";
    return `${selectedTagIds.size} selected: ${head}${more}`;
  }, [loadingTags, tags, selectedTagIds]);

  const clearTagSelection = () => setSelectedTagIds(new Set());

  const filteredTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter(
      (t) =>
        String(t.name).toLowerCase().includes(q) || String(t.id).toLowerCase().includes(q),
    );
  }, [tags, tagSearch]);

  const healthSummary = useMemo(() => {
    if (rows == null) {
      const headers = (
        selectedTagIds.size > 0
          ? tags.filter((t) => selectedTagIds.has(String(t.id))).map((t) => t.name)
          : ["—"]
      ) as string[];
      return {
        headers: headers.length > 0 ? headers : ["—"],
        never: [] as number[],
        stale: [] as number[],
        recentLow: [] as number[],
        recentOk: [] as number[],
        loaded: false,
      };
    }
    if (dataRetrievedAt == null) {
      return {
        headers: [] as string[],
        never: [] as number[],
        stale: [] as number[],
        recentLow: [] as number[],
        recentOk: [] as number[],
        loaded: false,
      };
    }

    let headers: string[];
    if (selectedTagIds.size > 0) {
      headers = tags.filter((t) => selectedTagIds.has(String(t.id))).map((t) => t.name);
    } else {
      const s = new Set<string>();
      for (const r of rows) for (const n of tagNamesForRow(r)) s.add(n);
      headers = Array.from(s).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    }

    if (headers.length === 0) {
      headers = ["—"];
    }

    const idx = new Map(headers.map((h, i) => [h, i] as const));
    const never = new Array(headers.length).fill(0) as number[];
    const stale = new Array(headers.length).fill(0) as number[];
    const recentLow = new Array(headers.length).fill(0) as number[];
    const recentOk = new Array(headers.length).fill(0) as number[];

    for (const r of rows) {
      const cat = categorizeSensorHealth(r, dataRetrievedAt);
      const tnames = tagNamesForRow(r);
      if (tnames.length === 0) continue;
      for (const t of tnames) {
        if (!idx.has(t)) continue;
        const i = idx.get(t)!;
        if (cat === "never") never[i] += 1;
        else if (cat === "stale") stale[i] += 1;
        else if (cat === "recentLow") recentLow[i] += 1;
        else recentOk[i] += 1;
      }
    }

    return { headers, never, stale, recentLow, recentOk, loaded: true };
  }, [rows, dataRetrievedAt, selectedTagIds, tags]);

  return (
    <div className="app">
      <header className="header">
        <h1>Canteen EM Sensor Health</h1>
        <p className="lede">
          Sensors come from each tag’s <code>sensors</code> list on <strong>List tags</strong> (
          <code>GET /tags</code>). Readings use the <strong>Get Readings Snapshot</strong> API (
          <code>GET /readings/latest</code> with <code>entityType=sensor</code>) for widget and environmental
          monitor fields. Click a <strong>temperature</strong> value to load a 30-day chart from{" "}
          <code>GET /readings/history</code> for that sensor only.
        </p>
      </header>

      {configError && <div className="banner warn">{configError}</div>}

      <section className="panel">
        <div className="row">
          <div className="field">
            <span className="label">Filter by tag</span>
            <p className="hint">
              Open the list, use search to find tags, then check one or more to limit which tags’ sensors are
              included. Leave none selected to include sensors from every tag.
            </p>
            {tagSource === "assets" && (
              <p className="hint source-note">
                Tags are inferred from assets (GET <code>/v1/assets</code> with <code>includeTags</code>) because
                the List all tags API (<a href="https://developers.samsara.com/reference/tags">GET /tags</a> at
                <code> https://api.samsara.com/tags</code>) was empty or not available. Grant <strong>Read Tags</strong>{" "}
                for the full tag list.
              </p>
            )}
            <div className="tag-filter-row">
              <div className="tag-filter">
                {loadingTags && <span className="muted">Loading tags…</span>}
                {!loadingTags && !tagError && tags.length === 0 && (
                  <span className="muted">No tags found. Add the <strong>Read Tags</strong> API scope, or tag assets in the Samsara dashboard.</span>
                )}
                {!loadingTags && tags.length > 0 && (
                  <details className="tag-filter-details">
                    <summary className="tag-filter-summary">{tagSelectSummary}</summary>
                    <div className="tag-filter-panel">
                      <div className="tag-search-wrap">
                        <input
                          type="search"
                          className="tag-search-input"
                          value={tagSearch}
                          onChange={(e) => setTagSearch(e.target.value)}
                          placeholder="Search tags…"
                          aria-label="Search tags by name or ID"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        />
                      </div>
                      <ul className="tag-list" role="list" aria-label="Tag list">
                        {filteredTags.length === 0 && (
                          <li className="tag-list-empty">No tags match your search</li>
                        )}
                        {filteredTags.map((t) => {
                          const id = String(t.id);
                          return (
                            <li key={id} className="tag-row">
                              <label className="tag-row-label">
                                <input
                                  type="checkbox"
                                  checked={selectedTagIds.has(id)}
                                  onChange={() => toggleTag(id)}
                                />
                                <span className="tag-row-text">{t.name}</span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                      {selectedTagIds.size > 0 && (
                        <div className="tag-filter-foot">
                          <button type="button" className="linkish" onClick={clearTagSelection}>
                            Clear selection
                          </button>
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
              <div className="health-summary-block" aria-label="Health summary by tag">
                <h3 className="health-summary-title">Health summary</h3>
                <div className="health-summary-scroll">
                  <table className="health-summary">
                    <thead>
                      <tr>
                        <th scope="col" className="health-summary-corner" />
                        {healthSummary.headers.map((h, col) => (
                          <th key={`${h}-${col}`} scope="col" className="health-summary-th-tag">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {HEALTH_CATEGORY_CONFIG.map((cfg) => {
                        const values = (
                          {
                            never: healthSummary.never,
                            stale: healthSummary.stale,
                            recentLow: healthSummary.recentLow,
                            recentOk: healthSummary.recentOk,
                          } as const
                        )[cfg.key];
                        const rowClass =
                          cfg.key === "never" || cfg.key === "stale"
                            ? "health-summary-row-danger"
                            : cfg.key === "recentLow"
                              ? "health-summary-row-warn"
                              : "health-summary-row-ok";
                        return (
                          <tr key={cfg.key} className={`health-summary-row ${rowClass}`}>
                            <th scope="row" className="health-summary-cat">
                              <span className="health-summary-cat-inner">
                                <input
                                  type="checkbox"
                                  className="health-summary-filter-cb"
                                  checked={healthCategoryFilters.has(cfg.key)}
                                  onChange={() => {
                                    toggleHealthCategoryFilter(cfg.key);
                                  }}
                                  disabled={!healthSummary.loaded}
                                  aria-label={cfg.aria}
                                />
                                <span className="health-summary-cat-text">{cfg.label}</span>
                              </span>
                            </th>
                            {healthSummary.headers.map((h, i) => (
                              <td key={`${cfg.key}-${h}-${i}`} className="health-summary-n">
                                {healthSummary.loaded ? (values[i] ?? 0) : "—"}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                      <tr className="health-summary-row health-summary-row-total">
                        <th scope="row" className="health-summary-cat">Total</th>
                        {healthSummary.headers.map((h, i) => (
                          <td key={`total-${h}-${i}`} className="health-summary-n health-summary-total-n">
                            {healthSummary.loaded
                              ? (healthSummary.never[i] ?? 0) +
                                (healthSummary.stale[i] ?? 0) +
                                (healthSummary.recentLow[i] ?? 0) +
                                (healthSummary.recentOk[i] ?? 0)
                              : "—"}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                {!healthSummary.loaded && (
                  <p className="hint health-summary-hint">Load sensor data to show counts by tag.</p>
                )}
                {healthSummary.loaded && healthCategoryFilters.size > 0 && (
                  <p className="hint health-summary-hint">Checked rows filter the sensor table (no checks = show all).</p>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="primary" onClick={() => void loadRecords()} disabled={loadingData}>
            {loadingData ? "Loading…" : "Load sensor data"}
          </button>
          <button type="button" onClick={() => void loadTags()} disabled={loadingTags}>
            Refresh tags
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!rows || rows.length === 0 || (displayRows != null && displayRows.length === 0)}
            title="Download current table as CSV (current sort; respects health summary filters if any)"
          >
            Export CSV
          </button>
        </div>
        {tagError && <div className="banner err">Tags: {tagError}</div>}
        {dataError && <div className="banner err">Sensor data: {dataError}</div>}
      </section>

      <section className="table-wrap">
        {rows && (
          <div className="summary summary-with-actions">
            <span>
              {healthCategoryFilters.size === 0 && !hasColumnSearch(columnSearch) ? (
                <>
                  {rows.length} sensor{rows.length === 1 ? "" : "s"}
                </>
              ) : displayRows == null ? (
                <>
                  {rows.length} sensor{rows.length === 1 ? "" : "s"}
                </>
              ) : displayRows.length === 0 ? (
                <>No sensors match the current filters ({rows.length} loaded)</>
              ) : displayRows.length === rows.length ? (
                <>
                  {rows.length} sensor{rows.length === 1 ? "" : "s"} (all match filters)
                </>
              ) : (
                <>
                  {displayRows.length} of {rows.length} sensor{rows.length === 1 ? "" : "s"} (filtered)
                </>
              )}
            </span>
            {hasColumnSearch(columnSearch) && (
              <button type="button" className="linkish" onClick={() => setColumnSearch(emptyColumnSearch())}>
                Clear column search
              </button>
            )}
          </div>
        )}
        <div className="scroll">
          <table className="grid">
            <thead>
              <tr className="th-filter-row">
                {TABLE_COLUMNS.map(({ key, label }) => (
                  <th key={`filter-${key}`} className="th-filter" scope="col">
                    <label className="col-filter-label" htmlFor={`col-filter-${key}`}>
                      Search {label}
                    </label>
                    <input
                      id={`col-filter-${key}`}
                      type="search"
                      className="col-filter-input"
                      placeholder={
                        key === "temperature" ? ">72, <40, =68 (°F)" : "Search…"
                      }
                      title={
                        key === "temperature"
                          ? "Compare in °F: greater than (e.g. >72), less than (e.g. <40), or equal (e.g. =68). Other text matches as a normal search."
                          : undefined
                      }
                      value={columnSearch[key]}
                      onChange={(e) =>
                        setColumnSearch((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      aria-label={
                        key === "temperature"
                          ? "Filter by temperature in degrees Fahrenheit: use greater than, less than, or equals with a number, or plain text to search the cell"
                          : `Filter by ${label}`
                      }
                    />
                  </th>
                ))}
              </tr>
              <tr className="th-sort-row">
                {TABLE_COLUMNS.map(({ key, label }) => {
                  const batteryVoltageHeaderTitle =
                    key === "batteryVoltageLow" || key === "batteryVoltage"
                      ? "Battery Voltage >1.5 Volts means battery is healthy and < 1.5 volts that battery is low and needs to be replaced"
                      : undefined;
                  return (
                    <th key={key} className="th-sort" scope="col" aria-sort={getAriaSort(key, sortKey, sortDir)}>
                      <button
                        type="button"
                        className="th-sort-btn"
                        onClick={() => onSort(key)}
                        title={batteryVoltageHeaderTitle}
                      >
                        <span>{label}</span>
                        {sortKey === key ? <span className="th-sort-ind">{sortDir === "asc" ? "▲" : "▼"}</span> : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr>
                  <td colSpan={9} className="muted">
                    Run <strong>Load sensor data</strong> to query Samsara.
                  </td>
                </tr>
              )}
              {rows &&
                rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="muted">
                      No sensors for the current tag filter, or tag payloads have no <code>sensors</code> list.
                    </td>
                  </tr>
                )}
              {displayRows &&
                displayRows.map((r) => {
                  const missingLast = isMissingLastConnected(r.lastConnectedTime);
                  const stale = isLastConnectedStale(r.lastConnectedTime, dataRetrievedAt);
                  const action = getSensorAction(r, dataRetrievedAt);
                  const recentLowBattery =
                    !missingLast &&
                    !stale &&
                    dataRetrievedAt != null &&
                    isBatteryVoltageLowIndicated(r.batteryVoltageLow);
                  const rowClass = [
                    stale && "row-stale",
                    missingLast && "row-missing-last-connected",
                    recentLowBattery && "row-battery-low-recent",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined;
                  return (
                  <tr
                    key={r.id}
                    className={rowClass}
                    title={
                      missingLast
                        ? "No last connected time was returned for this sensor"
                        : stale
                          ? "Last connected was more than 7 days before this data was loaded"
                          : recentLowBattery
                            ? "Connected within the last 7 days, but battery voltage is low"
                            : undefined
                    }
                  >
                    <td className="tags-cell">{r.tagValue}</td>
                    <td className="mono">
                      {samsaraOrgId != null && r.name.trim() !== "" ? (
                        <a
                          className="sensor-cloud-link"
                          href={buildSamsaraSensorConfigSensorsUrl(samsaraOrgId, r.name)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open sensor configuration in Samsara Cloud (search by name)"
                        >
                          {r.id}
                        </a>
                      ) : (
                        r.id
                      )}
                    </td>
                    <td>
                      {samsaraOrgId != null && r.name.trim() !== "" ? (
                        <a
                          className="sensor-cloud-link"
                          href={buildSamsaraSensorEnvironmentUrl(samsaraOrgId, r.name)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open this sensor in Samsara Cloud (Environment, last 30 days)"
                        >
                          {r.name}
                        </a>
                      ) : (
                        r.name
                      )}
                    </td>
                    <td className="mono">
                      {missingLast ? "—" : formatTime(r.lastConnectedTime as string)}
                    </td>
                    <td>{r.batteryVoltageLow}</td>
                    <td className="mono">{r.batteryVoltage}</td>
                    <td className="mono">
                      <button
                        type="button"
                        className="linkish temp-history-btn"
                        onClick={() => setTempHistoryRow({ id: r.id, name: r.name })}
                        title="Open 30-day temperature history for this sensor"
                      >
                        {r.temperature}
                      </button>
                    </td>
                    <td>{action || "—"}</td>
                    <td className="notes-cell">
                      <SensorNoteField sensorId={r.id} value={r.note} onPersisted={handleNotePersisted} />
                    </td>
                  </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>

      <TemperatureHistoryModal
        open={tempHistoryRow != null}
        sensorId={tempHistoryRow?.id ?? null}
        sensorName={tempHistoryRow?.name ?? ""}
        onClose={() => setTempHistoryRow(null)}
      />
    </div>
  );
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** No usable last-connected timestamp (null, empty, or unparseable). */
function isMissingLastConnected(lastConnectedIso: string | null): boolean {
  if (lastConnectedIso == null) return true;
  const s = String(lastConnectedIso).trim();
  if (!s) return true;
  const t = new Date(s).getTime();
  return Number.isNaN(t);
}

/** True if last connected is strictly more than 7 days before `retrievedAt`. */
function isLastConnectedStale(lastConnectedIso: string | null, retrievedAt: number | null): boolean {
  if (isMissingLastConnected(lastConnectedIso) || retrievedAt == null) return false;
  const t = new Date(lastConnectedIso).getTime();
  return retrievedAt - t > STALE_MS;
}

/**
 * True if the display value from widgetBatteryVoltageLow indicates a low battery
 * (boolean true, common string enums, or substring "low").
 */
function isBatteryVoltageLowIndicated(batteryVoltageLowDisplay: string): boolean {
  const s = batteryVoltageLowDisplay.trim().toLowerCase();
  if (!s || s === "—") return false;
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  if (s.includes("low")) return true;
  return false;
}

/** Server joins tag names with ", " — one sensor may be counted in multiple tag columns. */
function tagNamesForRow(r: Row): string[] {
  const s = r.tagValue.trim();
  if (!s) return [];
  return s.split(", ")
    .map((x) => x.trim())
    .filter(Boolean);
}

function categorizeSensorHealth(r: Row, dataRetrievedAt: number | null): HealthCategory {
  if (dataRetrievedAt == null) return "never";
  if (isMissingLastConnected(r.lastConnectedTime)) return "never";
  if (isLastConnectedStale(r.lastConnectedTime, dataRetrievedAt)) return "stale";
  if (
    isBatteryVoltageLowIndicated(r.batteryVoltageLow) &&
    !isMissingLastConnected(r.lastConnectedTime) &&
    !isLastConnectedStale(r.lastConnectedTime, dataRetrievedAt)
  ) {
    return "recentLow";
  }
  return "recentOk";
}

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    const datePart = d.toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    });
    const timePart = d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `${datePart} ${timePart}`;
  } catch {
    return iso;
  }
}

function escapeCsvField(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\r") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildEmSensorExportCsv(records: Row[], dataRetrievedAt: number | null): string {
  const headers = [
    "Tag value",
    "ID",
    "Name",
    "Last connected time",
    "Battery voltage level",
    "Battery voltage",
    "Temperature",
    "Action",
    "Notes",
  ];
  const lines = [headers.map(escapeCsvField).join(",")];
  for (const r of records) {
    const missing = isMissingLastConnected(r.lastConnectedTime);
    const lastCell = missing ? "—" : formatTime(r.lastConnectedTime as string);
    const action = getSensorAction(r, dataRetrievedAt);
    lines.push(
      [
        r.tagValue,
        r.id,
        r.name,
        lastCell,
        r.batteryVoltageLow,
        r.batteryVoltage,
        r.temperature,
        action || "—",
        r.note || "",
      ]
        .map(escapeCsvField)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

function fileStampForExport(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function getAriaSort(
  col: SortKey,
  sortKey: SortKey,
  sortDir: SortDir,
): "ascending" | "descending" | "none" {
  if (col !== sortKey) return "none";
  return sortDir === "asc" ? "ascending" : "descending";
}

/** Parse a leading number from a display string like "3.20 V" or "70.0°F" */
function parseDisplayNumber(s: string): number | null {
  if (s === "—" || !s.trim()) return null;
  const m = s.match(/-?\d+(\.\d+)?/);
  if (m) return parseFloat(m[0]);
  return null;
}

/**
 * Recommended action from connectivity and battery signals.
 * Precedence: never connected → check equipment; stale or low voltage → replace battery.
 */
function getSensorAction(r: Row, dataRetrievedAt: number | null): string {
  if (isMissingLastConnected(r.lastConnectedTime)) {
    return "Check on EM";
  }
  if (dataRetrievedAt != null && isLastConnectedStale(r.lastConnectedTime, dataRetrievedAt)) {
    return "Replace Battery";
  }
  const volts = parseDisplayNumber(r.batteryVoltage);
  if (volts != null && volts < 1.5) {
    return "Replace Battery";
  }
  if (isBatteryVoltageLowIndicated(r.batteryVoltageLow)) {
    return "Replace Battery";
  }
  return "";
}

/** Text used for substring search per column (includes formatted / derived values). */
function columnSearchHaystack(
  r: Row,
  key: TableColumnKey,
  dataRetrievedAt: number | null,
): string {
  switch (key) {
    case "lastConnectedTime":
      return isMissingLastConnected(r.lastConnectedTime)
        ? "—"
        : `${formatTime(r.lastConnectedTime as string)} ${r.lastConnectedTime}`;
    case "action":
      return getSensorAction(r, dataRetrievedAt) || "—";
    case "note":
      return r.note;
    default:
      return r[key];
  }
}

/** Matches optional spaces, one of > < =, spaces, then a signed decimal (temperature in °F). */
const TEMPERATURE_COMPARE_RE = /^\s*([><=])\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Half the typical display precision (0.1°F) so "=" matches the rounded reading. */
const TEMPERATURE_EQUAL_EPS = 0.05;

/**
 * Temperature filter: use `>72`, `<40`, `=68` (°F, same unit as the column).
 * Otherwise substring search on the cell text (e.g. part of "70.0°F").
 */
function temperatureSearchMatches(r: Row, rawQuery: string): boolean {
  const trimmed = rawQuery.trim();
  if (!trimmed) return true;

  const m = trimmed.match(TEMPERATURE_COMPARE_RE);
  if (!m) {
    const hay = columnSearchHaystack(r, "temperature", null).toLowerCase();
    return hay.includes(trimmed.toLowerCase());
  }

  const op = m[1];
  const threshold = parseFloat(m[2]);
  if (!Number.isFinite(threshold)) return false;

  const val = parseDisplayNumber(r.temperature);
  if (val == null) return false;

  switch (op) {
    case ">":
      return val > threshold;
    case "<":
      return val < threshold;
    case "=":
      return Math.abs(val - threshold) <= TEMPERATURE_EQUAL_EPS;
    default:
      return false;
  }
}

function rowMatchesColumnSearch(
  r: Row,
  filters: Record<TableColumnKey, string>,
  dataRetrievedAt: number | null,
): boolean {
  for (const c of TABLE_COLUMNS) {
    const q = filters[c.key].trim().toLowerCase();
    if (!q) continue;
    if (c.key === "temperature") {
      if (!temperatureSearchMatches(r, filters[c.key])) return false;
      continue;
    }
    const hay = columnSearchHaystack(r, c.key, dataRetrievedAt).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function compareRows(
  a: Row,
  b: Row,
  key: SortKey,
  mul: 1 | -1,
  dataRetrievedAt: number | null,
): number {
  switch (key) {
    case "tagValue":
    case "name":
    case "id":
    case "batteryVoltageLow": {
      const c = a[key].localeCompare(b[key], undefined, { numeric: true, sensitivity: "base" });
      return mul * c;
    }
    case "lastConnectedTime": {
      const at = isMissingLastConnected(a.lastConnectedTime)
        ? Number.NEGATIVE_INFINITY
        : new Date(a.lastConnectedTime as string).getTime();
      const bt = isMissingLastConnected(b.lastConnectedTime)
        ? Number.NEGATIVE_INFINITY
        : new Date(b.lastConnectedTime as string).getTime();
      if (at === bt) return 0;
      return mul * (at < bt ? -1 : 1);
    }
    case "batteryVoltage":
    case "temperature": {
      const na = parseDisplayNumber(a[key]);
      const nb = parseDisplayNumber(b[key]);
      if (na != null && nb != null && na !== nb) return mul * (na < nb ? -1 : 1);
      if (na != null && nb == null) return -1;
      if (na == null && nb != null) return 1;
      return mul * a[key].localeCompare(b[key], undefined, { numeric: true, sensitivity: "base" });
    }
    case "action": {
      const sa = getSensorAction(a, dataRetrievedAt) || "—";
      const sb = getSensorAction(b, dataRetrievedAt) || "—";
      return mul * sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
    }
    case "note": {
      return mul * a.note.localeCompare(b.note, undefined, { sensitivity: "base" });
    }
    default:
      return 0;
  }
}
