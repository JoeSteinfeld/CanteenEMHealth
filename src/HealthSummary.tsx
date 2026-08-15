import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "./auth";
import { parseJsonSafe } from "./apiUtils";
import { useHealthSummaryCache } from "./healthSummaryCache";
import {
  compareTagHealthSummaryRows,
  emptySummaryColumnSearch,
  formatAvgTemp30d,
  formatPctHealthy,
  hasSummaryColumnSearch,
  rowMatchesSummarySearch,
  type TagHealthSummaryRow,
  type TagHealthSummarySortKey,
  type FleetHealthTotals,
} from "./sensorHealth";
import { downloadHealthSummaryCsv } from "./healthSummaryExport";
import { DailySnapshotNotice } from "./DailySnapshotNotice";

type SortDir = "asc" | "desc";

const SUMMARY_COLUMNS: { key: TagHealthSummarySortKey; label: string }[] = [
  { key: "tagName", label: "Tag name" },
  { key: "totalSensors", label: "Number of sensors" },
  { key: "connectedLast7Days", label: "Connected in last 7 days" },
  { key: "notConnected7Days", label: "Not connected 7 days" },
  { key: "neverConnected", label: "Never connected" },
  { key: "pctHealthy", label: "% healthy" },
  { key: "avgCoolerTemp30d", label: "Avg Cooler Temp (30d)" },
  { key: "avgFreezerTemp30d", label: "Avg Freezer Temp (30d)" },
];

const AVG_TEMP_30D_GROUP_KEYS = new Set<TagHealthSummarySortKey>([
  "avgCoolerTemp30d",
  "avgFreezerTemp30d",
]);

type SummaryGroupHeaderCell =
  | { kind: "empty"; key: string }
  | { kind: "group"; key: string; colSpan: number; label: string };

function buildAvgTemp30dGroupHeaderCells(
  columns: { key: TagHealthSummarySortKey }[],
): SummaryGroupHeaderCell[] {
  const cells: SummaryGroupHeaderCell[] = [];
  let i = 0;
  while (i < columns.length) {
    const col = columns[i];
    if (AVG_TEMP_30D_GROUP_KEYS.has(col.key)) {
      let colSpan = 0;
      const start = i;
      while (i < columns.length && AVG_TEMP_30D_GROUP_KEYS.has(columns[i].key)) {
        colSpan += 1;
        i += 1;
      }
      cells.push({
        kind: "group",
        key: `avg-temp30d-group-${start}`,
        colSpan,
        label: "Connected in last 7 days only",
      });
    } else {
      cells.push({ kind: "empty", key: `group-pad-${col.key}` });
      i += 1;
    }
  }
  return cells;
}

function getAriaSort(
  col: TagHealthSummarySortKey,
  sortKey: TagHealthSummarySortKey,
  sortDir: SortDir,
): "ascending" | "descending" | "none" {
  if (col !== sortKey) return "none";
  return sortDir === "asc" ? "ascending" : "descending";
}

function formatLastRefreshed(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function HealthSummary() {
  const {
    summaryRows,
    fleetTotals,
    dataRetrievedAt,
    snapshotLoading,
    sortKey,
    sortDir,
    columnSearch,
    setSummaryRows,
    setFleetTotals,
    setDataRetrievedAt,
    setSortKey,
    setSortDir,
    setColumnSearch,
  } = useHealthSummaryCache();

  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const r = await apiFetch("/api/health");
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

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const loadSummary = async () => {
    setLoading(true);
    setError(null);
    setLoadProgress("Starting…");
    setColumnSearch(emptySummaryColumnSearch());
    setSummaryRows([]);
    setFleetTotals(null);

    const isFleetTotals = (value: unknown): value is FleetHealthTotals => {
      if (!value || typeof value !== "object") return false;
      const o = value as Record<string, unknown>;
      const optionalNum = (v: unknown) => v == null || (typeof v === "number" && Number.isFinite(v));
      return (
        typeof o.totalSensors === "number" &&
        typeof o.connectedLast7Days === "number" &&
        typeof o.neverConnected === "number" &&
        typeof o.notConnected7Days === "number" &&
        typeof o.pctHealthy === "number" &&
        optionalNum(o.avgCoolerTemp30d) &&
        optionalNum(o.avgFreezerTemp30d)
      );
    };

    const isTagRow = (value: unknown): value is TagHealthSummaryRow => {
      if (!value || typeof value !== "object") return false;
      const r = value as Record<string, unknown>;
      return (
        typeof r.tagId === "string" &&
        typeof r.tagName === "string" &&
        typeof r.totalSensors === "number" &&
        typeof r.connectedLast7Days === "number" &&
        typeof r.notConnected7Days === "number" &&
        typeof r.neverConnected === "number" &&
        typeof r.pctHealthy === "number"
      );
    };

    try {
      const r = await apiFetch("/api/health-summary/stream");
      if (!r.ok) {
        const j = (await parseJsonSafe(r)) as { error?: string; hint?: string };
        const msg = [j.error, j.hint].filter(Boolean).join(" — ");
        throw new Error(msg || r.statusText);
      }
      if (!r.body) throw new Error("No response body from health summary stream");

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      /** Accumulates streamed rows so each tag can paint without setState updater typing. */
      const streamedRows: TagHealthSummaryRow[] = [];

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = typeof ev.type === "string" ? ev.type : "";
          if (type === "phase") {
            const message = typeof ev.message === "string" ? ev.message : "Working…";
            const detail = typeof ev.detail === "string" ? ev.detail : "";
            setLoadProgress(detail ? `${message} (${detail})` : message);
          } else if (type === "start") {
            const total = typeof ev.total === "number" ? ev.total : 0;
            const retrievedAt =
              typeof ev.dataRetrievedAt === "number" && Number.isFinite(ev.dataRetrievedAt)
                ? ev.dataRetrievedAt
                : Date.now();
            setDataRetrievedAt(retrievedAt);
            streamedRows.length = 0;
            setSummaryRows([]);
            setLoadProgress(total > 0 ? `Calculating tags… 0 of ${total}` : "No tags with EM sensors");
          } else if (type === "tag") {
            const index = typeof ev.index === "number" ? ev.index : 0;
            const total = typeof ev.total === "number" ? ev.total : 0;
            const row = ev.row;
            if (isTagRow(row) && row.totalSensors > 0) {
              const existing = streamedRows.findIndex((x) => x.tagId === row.tagId);
              if (existing >= 0) streamedRows[existing] = row;
              else streamedRows.push(row);
              setSummaryRows([...streamedRows]);
            }
            setLoadProgress(
              total > 0 ? `Calculating tags… ${index} of ${total}` : `Calculating tags… ${index}`,
            );
          } else if (type === "done") {
            sawDone = true;
            const list = Array.isArray(ev.data)
              ? (ev.data as TagHealthSummaryRow[]).filter((row) => isTagRow(row) && row.totalSensors > 0)
              : streamedRows.filter((row) => row.totalSensors > 0);
            setSummaryRows(list);
            if (isFleetTotals(ev.fleetTotals)) {
              setFleetTotals({
                ...ev.fleetTotals,
                avgCoolerTemp30d:
                  typeof ev.fleetTotals.avgCoolerTemp30d === "number" &&
                  Number.isFinite(ev.fleetTotals.avgCoolerTemp30d)
                    ? ev.fleetTotals.avgCoolerTemp30d
                    : null,
                avgFreezerTemp30d:
                  typeof ev.fleetTotals.avgFreezerTemp30d === "number" &&
                  Number.isFinite(ev.fleetTotals.avgFreezerTemp30d)
                    ? ev.fleetTotals.avgFreezerTemp30d
                    : null,
              });
            }
            if (typeof ev.dataRetrievedAt === "number" && Number.isFinite(ev.dataRetrievedAt)) {
              setDataRetrievedAt(ev.dataRetrievedAt);
            }
            setLoadProgress(null);
          } else if (type === "error") {
            const msg = [ev.error, ev.hint].filter((x) => typeof x === "string" && x).join(" — ");
            throw new Error(msg || "Health summary stream failed");
          }
        }
      }

      if (!sawDone) {
        throw new Error("Health summary stream ended before completion");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load health summary");
      setLoadProgress(null);
    } finally {
      setLoading(false);
    }
  };

  const summaryRowsWithSensors = useMemo(
    () => (summaryRows ? summaryRows.filter((r) => r.totalSensors > 0) : null),
    [summaryRows],
  );

  const displayRows = useMemo(() => {
    if (!summaryRowsWithSensors) return null;
    let list = [...summaryRowsWithSensors];
    if (hasSummaryColumnSearch(columnSearch)) {
      list = list.filter((row) => rowMatchesSummarySearch(row, columnSearch));
    }
    const mul = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => compareTagHealthSummaryRows(a, b, sortKey, mul));
    return list;
  }, [summaryRowsWithSensors, columnSearch, sortKey, sortDir]);

  const onSort = (key: TagHealthSummarySortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "tagName" ? "asc" : "desc");
    }
  };

  const exportCsv = useCallback(() => {
    if (fleetTotals == null || dataRetrievedAt == null || summaryRows == null) return;
    downloadHealthSummaryCsv(fleetTotals, displayRows ?? [], dataRetrievedAt);
  }, [fleetTotals, dataRetrievedAt, summaryRows, displayRows]);

  const canExportCsv = fleetTotals != null && dataRetrievedAt != null && summaryRows != null;

  return (
    <div className="app">
      <header className="header">
        <h1>Health Summary</h1>
        <DailySnapshotNotice />
        <p className="lede">
          Per-tag EM sensor health based on last-connected time from GetTemperature{" "}
          <code>ambientTemperatureTime</code> (<code>POST /v1/sensors/temperature</code>). A sensor counts as{" "}
          <strong>connected in the last 7 days</strong> if that time is within 7 days of when data was loaded.{" "}
          <strong>Avg Cooler/Freezer Temp (30d)</strong> uses daily ambient temperatures stored in SQLite (backfilled
          once from <code>POST /v1/sensors/history</code>, then updated incrementally each run), averaged only for
          Cooler- or Freezer-named sensors that connected in the last 7 days, and is stored with each daily snapshot.
          Totals include EM environment monitors only (deactivated placeholders and non-EM devices on tags are
          excluded). Fleet totals count each sensor once; the table below may count sensors under multiple tags. You
          can also refresh manually anytime; Trends uses the daily snapshots for org health over time.
        </p>
      </header>

      {configError && <div className="banner warn">{configError}</div>}

      <section className="panel">
        <div className="actions summary-actions">
          <button type="button" className="primary" onClick={() => void loadSummary()} disabled={loading}>
            {loading ? "Loading…" : summaryRows ? "Refresh health summary" : "Load health summary"}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!canExportCsv || loading}
            title="Download org and tag summary as CSV (current sort and column filters)"
          >
            Export CSV
          </button>
          {loading && loadProgress && (
            <p className="summary-last-refreshed" role="status" aria-live="polite">
              {loadProgress}
            </p>
          )}
          {snapshotLoading && summaryRows == null && !loading && (
            <p className="summary-last-refreshed" role="status">
              Loading saved health summary…
            </p>
          )}
          {dataRetrievedAt != null && summaryRows != null && !loading && (
            <p className="summary-last-refreshed" role="status">
              Last refreshed: <time dateTime={new Date(dataRetrievedAt).toISOString()}>{formatLastRefreshed(dataRetrievedAt)}</time>
            </p>
          )}
        </div>
        {error && <div className="banner err">{error}</div>}
        {dataRetrievedAt != null && summaryRows != null && (
          <p className="hint summary-loaded-at">
            Connectivity counts use a 7-day window ending at the last refresh time above.
          </p>
        )}
      </section>

      {fleetTotals != null && dataRetrievedAt != null && (
        <section className="health-summary-block">
          <div className="fleet-summary-line" role="status">
            <h2 className="health-summary-section-heading">Org Summary</h2>
            <div className="fleet-summary-metrics">
              <div className="fleet-summary-metric">
                <span className="fleet-summary-metric-label">Total sensors</span>
                <span className="fleet-summary-metric-value mono">{fleetTotals.totalSensors.toLocaleString()}</span>
              </div>
              <div className="fleet-summary-metric">
                <span className="fleet-summary-metric-label">Connected in last 7 days</span>
                <span className="fleet-summary-metric-value mono health-summary-ok">
                  {fleetTotals.connectedLast7Days.toLocaleString()}
                </span>
              </div>
              <div className="fleet-summary-metric">
                <span className="fleet-summary-metric-label">Not connected in last 7 days</span>
                <span className="fleet-summary-metric-value mono health-summary-warn">
                  {fleetTotals.notConnected7Days.toLocaleString()}
                </span>
              </div>
              <div className="fleet-summary-metric">
                <span className="fleet-summary-metric-label">Never connected</span>
                <span className="fleet-summary-metric-value mono health-summary-danger">
                  {fleetTotals.neverConnected.toLocaleString()}
                </span>
              </div>
              <div className="fleet-summary-metric">
                <span className="fleet-summary-metric-label">% healthy</span>
                <span className="fleet-summary-metric-value mono">{formatPctHealthy(fleetTotals.pctHealthy)}</span>
              </div>
              <div className="fleet-summary-metric" title="Connected in last 7 days only">
                <span className="fleet-summary-metric-label">Avg Cooler Temp (30d)</span>
                <span className="fleet-summary-metric-value mono">{formatAvgTemp30d(fleetTotals.avgCoolerTemp30d)}</span>
              </div>
              <div className="fleet-summary-metric" title="Connected in last 7 days only">
                <span className="fleet-summary-metric-label">Avg Freezer Temp (30d)</span>
                <span className="fleet-summary-metric-value mono">{formatAvgTemp30d(fleetTotals.avgFreezerTemp30d)}</span>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="table-wrap">
        {summaryRows != null && <h2 className="health-summary-section-heading">Tag Summary</h2>}
        {summaryRowsWithSensors && (
          <div className="summary summary-with-actions">
            <span>
              {hasSummaryColumnSearch(columnSearch) ? (
                displayRows?.length === 0 ? (
                  <>No tags match the current filters ({summaryRowsWithSensors.length} tags loaded)</>
                ) : (
                  <>
                    {displayRows?.length} of {summaryRowsWithSensors.length} tag
                    {summaryRowsWithSensors.length === 1 ? "" : "s"} (filtered)
                  </>
                )
              ) : (
                <>
                  {summaryRowsWithSensors.length} tag{summaryRowsWithSensors.length === 1 ? "" : "s"}
                </>
              )}
            </span>
            {hasSummaryColumnSearch(columnSearch) && (
              <button type="button" className="linkish" onClick={() => setColumnSearch(emptySummaryColumnSearch())}>
                Clear column search
              </button>
            )}
          </div>
        )}
        <div className="scroll">
          <table className="grid health-summary-grid">
            <thead>
              <tr className="th-group-row">
                {buildAvgTemp30dGroupHeaderCells(SUMMARY_COLUMNS).map((cell) =>
                  cell.kind === "group" ? (
                    <th
                      key={cell.key}
                      className="th-group th-group-avg-temp30d"
                      colSpan={cell.colSpan}
                      scope="colgroup"
                      title="30-day cooler/freezer averages include only sensors connected in the last 7 days"
                    >
                      <span className="th-group-avg-temp30d-label">{cell.label}</span>
                    </th>
                  ) : (
                    <th key={cell.key} className="th-group th-group-empty" scope="col" aria-hidden />
                  ),
                )}
              </tr>
              <tr className="th-filter-row">
                {SUMMARY_COLUMNS.map(({ key, label }) => (
                  <th key={`filter-${key}`} className="th-filter" scope="col">
                    <label className="col-filter-label" htmlFor={`summary-filter-${key}`}>
                      Search {label}
                    </label>
                    <input
                      id={`summary-filter-${key}`}
                      type="search"
                      className="col-filter-input"
                      placeholder={key === "pctHealthy" ? ">80, <100" : "Search…"}
                      title={
                        key === "pctHealthy"
                          ? "Compare in % with comma-separated AND clauses, e.g. >80, <100 for values between 80 and 100. Use >, <, or = with a number; plain text matches as a normal search."
                          : undefined
                      }
                      value={columnSearch[key]}
                      onChange={(e) => setColumnSearch((prev) => ({ ...prev, [key]: e.target.value }))}
                      disabled={summaryRows == null}
                      aria-label={
                        key === "pctHealthy"
                          ? "Filter by percent healthy: comma-separated clauses all must match, e.g. greater than 80 and less than 100"
                          : `Filter by ${label}`
                      }
                    />
                  </th>
                ))}
              </tr>
              <tr className="th-sort-row">
                {SUMMARY_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="th-sort" scope="col" aria-sort={getAriaSort(key, sortKey, sortDir)}>
                    <button type="button" className="th-sort-btn" onClick={() => onSort(key)}>
                      <span>{label}</span>
                      {sortKey === key ? <span className="th-sort-ind">{sortDir === "asc" ? "▲" : "▼"}</span> : null}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows === null && !snapshotLoading && !loading && (
                <tr>
                  <td colSpan={SUMMARY_COLUMNS.length} className="muted">
                    Run <strong>Load health summary</strong> to query Samsara.
                  </td>
                </tr>
              )}
              {summaryRows === null && snapshotLoading && !loading && (
                <tr>
                  <td colSpan={SUMMARY_COLUMNS.length} className="muted">
                    Loading saved health summary…
                  </td>
                </tr>
              )}
              {loading && summaryRowsWithSensors && summaryRowsWithSensors.length === 0 && (
                <tr>
                  <td colSpan={SUMMARY_COLUMNS.length} className="muted">
                    {loadProgress ?? "Calculating tags…"}
                  </td>
                </tr>
              )}
              {!loading && summaryRowsWithSensors && summaryRowsWithSensors.length === 0 && (
                <tr>
                  <td colSpan={SUMMARY_COLUMNS.length} className="muted">
                    No tags found, or tag payloads have no <code>sensors</code> list.
                  </td>
                </tr>
              )}
              {displayRows &&
                displayRows.map((r) => (
                  <tr key={r.tagId || r.tagName}>
                    <td>
                      <Link
                        to={`/detailed-sensor-health?tagId=${encodeURIComponent(r.tagId)}`}
                        className="tag-detail-link"
                        title="Open detailed sensor health for this tag"
                      >
                        {r.tagName}
                      </Link>
                    </td>
                    <td className="mono num-cell">{r.totalSensors}</td>
                    <td className="mono num-cell health-summary-ok">{r.connectedLast7Days}</td>
                    <td className="mono num-cell health-summary-warn">{r.notConnected7Days}</td>
                    <td className="mono num-cell health-summary-danger">{r.neverConnected}</td>
                    <td className="mono num-cell">{formatPctHealthy(r.pctHealthy)}</td>
                    <td className="mono num-cell">{formatAvgTemp30d(r.avgCoolerTemp30d)}</td>
                    <td className="mono num-cell">{formatAvgTemp30d(r.avgFreezerTemp30d)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
