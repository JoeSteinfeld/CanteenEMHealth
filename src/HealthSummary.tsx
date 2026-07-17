import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "./auth";
import { parseJsonSafe } from "./apiUtils";
import { useHealthSummaryCache } from "./healthSummaryCache";
import {
  compareTagHealthSummaryRows,
  emptySummaryColumnSearch,
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
];

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
    setColumnSearch(emptySummaryColumnSearch());
    try {
      const r = await apiFetch("/api/health-summary");
      const j = (await parseJsonSafe(r)) as {
        data?: unknown;
        fleetTotals?: unknown;
        dataRetrievedAt?: unknown;
        error?: string;
        hint?: string;
      };
      if (!r.ok) {
        const msg = [j.error, j.hint].filter(Boolean).join(" — ");
        throw new Error(msg || r.statusText);
      }
      const list = Array.isArray(j.data) ? (j.data as TagHealthSummaryRow[]) : [];
      const totals = j.fleetTotals as FleetHealthTotals | undefined;
      const retrievedAt =
        typeof j.dataRetrievedAt === "number" && Number.isFinite(j.dataRetrievedAt)
          ? j.dataRetrievedAt
          : Date.now();
      setSummaryRows(list.filter((r) => r.totalSensors > 0));
      setFleetTotals(
        totals &&
          typeof totals.totalSensors === "number" &&
          typeof totals.connectedLast7Days === "number" &&
          typeof totals.neverConnected === "number" &&
          typeof totals.notConnected7Days === "number" &&
          typeof totals.pctHealthy === "number"
          ? totals
          : {
              totalSensors: 0,
              connectedLast7Days: 0,
              neverConnected: 0,
              notConnected7Days: 0,
              pctHealthy: 0,
            },
      );
      setDataRetrievedAt(retrievedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load health summary");
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
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
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
          Per-tag EM sensor health based on last-connected time from{" "}
          <code>GET /readings/latest</code>. A sensor counts as <strong>connected in the last 7 days</strong> if it
          reported within 7 days of when data was loaded. Totals include EM environment monitors only
          (deactivated placeholders and non-EM devices on tags are excluded). Fleet totals count each sensor once; the table below may
          count sensors under multiple tags. You can also refresh manually anytime; Trends uses the daily snapshots for
          org health over time.
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
            disabled={!canExportCsv}
            title="Download org and tag summary as CSV (current sort and column filters)"
          >
            Export CSV
          </button>
          {snapshotLoading && summaryRows == null && (
            <p className="summary-last-refreshed" role="status">
              Loading saved health summary…
            </p>
          )}
          {dataRetrievedAt != null && summaryRows != null && (
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
              <span>
                <strong>Total sensors:</strong> {fleetTotals.totalSensors.toLocaleString()}
              </span>
              <span className="fleet-summary-sep" aria-hidden>
                ·
              </span>
              <span>
                <strong>Connected in last 7 days:</strong>{" "}
                <span className="health-summary-ok">{fleetTotals.connectedLast7Days.toLocaleString()}</span>
              </span>
              <span className="fleet-summary-sep" aria-hidden>
                ·
              </span>
              <span>
                <strong>Not connected in last 7 days:</strong>{" "}
                <span className="health-summary-warn">{fleetTotals.notConnected7Days.toLocaleString()}</span>
              </span>
              <span className="fleet-summary-sep" aria-hidden>
                ·
              </span>
              <span>
                <strong>Never connected:</strong>{" "}
                <span className="health-summary-danger">{fleetTotals.neverConnected.toLocaleString()}</span>
              </span>
              <span className="fleet-summary-sep" aria-hidden>
                ·
              </span>
              <span>
                <strong>% healthy:</strong> {formatPctHealthy(fleetTotals.pctHealthy)}
              </span>
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
              {summaryRows === null && !snapshotLoading && (
                <tr>
                  <td colSpan={SUMMARY_COLUMNS.length} className="muted">
                    Run <strong>Load health summary</strong> to query Samsara.
                  </td>
                </tr>
              )}
              {summaryRows === null && snapshotLoading && (
                <tr>
                  <td colSpan={SUMMARY_COLUMNS.length} className="muted">
                    Loading saved health summary…
                  </td>
                </tr>
              )}
              {summaryRowsWithSensors && summaryRowsWithSensors.length === 0 && (
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
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
