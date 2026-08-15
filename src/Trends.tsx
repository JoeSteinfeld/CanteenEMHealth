import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatAvgTemp30d, formatPctHealthy } from "./sensorHealth";
import {
  deltaTone,
  emptyTagTrendColumnSearch,
  formatDelta,
  formatRefreshedAt,
  formatTrendCompareAt,
  hasTagTrendColumnSearch,
  rowMatchesTagTrendSearch,
  type TagTrendRow,
  type TagTrendSearchKey,
  type TrendsCompareMode,
} from "./healthSummaryTrends";
import { TrendOrgComboChart } from "./TrendCharts";
import { useTrendsCache } from "./trendsCache";
import { DailySnapshotNotice } from "./DailySnapshotNotice";

type TagSortKey = "tagName" | "pctHealthyStart" | "pctHealthy" | "deltaPctHealthy" | "deltaConnected";
type SortDir = "asc" | "desc";

const COMPARE_MODE_OPTIONS: { value: TrendsCompareMode; label: string }[] = [
  { value: "baseline", label: "Baseline" },
  { value: "dates", label: "Dates" },
];

const TAG_TREND_COLUMNS: { key: TagTrendSearchKey; label: string; sortKey?: TagSortKey }[] = [
  { key: "tagName", label: "Tag name", sortKey: "tagName" },
  { key: "pctHealthyStart", label: "% Start healthy", sortKey: "pctHealthyStart" },
  { key: "pctHealthy", label: "% End Healthy", sortKey: "pctHealthy" },
  { key: "deltaPctHealthy", label: "Δ % vs baseline", sortKey: "deltaPctHealthy" },
  { key: "deltaConnected", label: "Δ connected", sortKey: "deltaConnected" },
  { key: "trendLabel", label: "Trend" },
];

const TREND_COLUMN_TITLE =
  "Up: connected devices and health % both increased. Flat: no change in connected devices or health %. Down: connected devices or health % decreased.";

function getAriaSort(col: TagSortKey, sortKey: TagSortKey, sortDir: SortDir): "ascending" | "descending" | "none" {
  if (col !== sortKey) return "none";
  return sortDir === "asc" ? "ascending" : "descending";
}

function DeltaCell({
  value,
  suffix = "",
  goodWhenHigher = true,
  variant = "default",
}: {
  value: number | null;
  suffix?: string;
  goodWhenHigher?: boolean;
  variant?: "default" | "baseline";
}) {
  if (variant === "baseline") {
    const className =
      value == null || !Number.isFinite(value) || value === 0
        ? "trend-delta-flat"
        : value > 0
          ? "trend-delta-baseline-up"
          : "trend-delta-baseline-down";
    return <span className={className}>{formatDelta(value, suffix)}</span>;
  }

  const tone = deltaTone(value, goodWhenHigher);
  const className =
    tone === "ok"
      ? "trend-delta-ok"
      : tone === "warn"
        ? "trend-delta-warn"
        : "trend-delta-flat";
  return <span className={className}>{formatDelta(value, suffix)}</span>;
}

function TrendsCompareDates({
  baselineAt,
  recentAt,
  className = "trends-compare-range",
}: {
  baselineAt: number;
  recentAt: number;
  className?: string;
}) {
  return (
    <p className={className} role="status">
      <span className="trends-compare-date">
        <strong className="trends-compare-date-label">Baseline:</strong>{" "}
        <time className="trends-compare-date-value" dateTime={new Date(baselineAt).toISOString()}>
          {formatTrendCompareAt(baselineAt)}
        </time>
      </span>
      <span className="trends-compare-date">
        <strong className="trends-compare-date-label">Recent refresh:</strong>{" "}
        <time className="trends-compare-date-value" dateTime={new Date(recentAt).toISOString()}>
          {formatTrendCompareAt(recentAt)}
        </time>
      </span>
    </p>
  );
}

function MoversTable({ title, rows, variant }: { title: string; rows: TagTrendRow[]; variant: "up" | "down" }) {
  return (
    <div className="trends-movers-card">
      <h3 className="trends-movers-title">{title}</h3>
      {rows.length === 0 ? (
        <p className="muted trends-movers-empty">No tags in this list for the selected baseline.</p>
      ) : (
        <table className="grid trends-movers-grid">
          <thead>
            <tr>
              <th scope="col">Tag</th>
              <th scope="col">Start %</th>
              <th scope="col">End %</th>
              <th scope="col">Δ %</th>
              <th scope="col">Δ connected</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tagId} className={variant === "up" ? "trends-row-up" : "trends-row-down"}>
                <td>
                  <Link
                    to={`/detailed-sensor-health?tagId=${encodeURIComponent(r.tagId)}`}
                    className="tag-detail-link"
                  >
                    {r.tagName}
                  </Link>
                </td>
                <td className="mono num-cell">
                  {r.pctHealthyStart == null ? "—" : formatPctHealthy(r.pctHealthyStart)}
                </td>
                <td className="mono num-cell">{formatPctHealthy(r.pctHealthy)}</td>
                <td className="mono num-cell">
                  <DeltaCell value={r.deltaPctHealthy} suffix="%" />
                </td>
                <td className="mono num-cell">
                  <DeltaCell value={r.deltaConnected} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Trends() {
  const {
    compareMode,
    startDate,
    endDate,
    data,
    loading,
    error,
    setCompareMode,
    setStartDate,
    setEndDate,
  } = useTrendsCache();
  const [sortKey, setSortKey] = useState<TagSortKey>("deltaPctHealthy");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [columnSearch, setColumnSearch] = useState(emptyTagTrendColumnSearch());

  useEffect(() => {
    setColumnSearch(emptyTagTrendColumnSearch());
  }, [compareMode, startDate, endDate]);

  const showLoadingBanner = loading && data == null;

  const historyLine = useMemo(
    () =>
      (data?.history ?? []).map((h) => ({
        at: h.dataRetrievedAt,
        value: h.pctHealthy,
      })),
    [data?.history],
  );

  const historyStack = useMemo(
    () =>
      (data?.history ?? []).map((h) => ({
        at: h.dataRetrievedAt,
        totalSensors: h.totalSensors,
        connectedLast7Days: h.connectedLast7Days,
        notConnected7Days: h.notConnected7Days,
        neverConnected: h.neverConnected,
      })),
    [data?.history],
  );

  const filteredTagRows = useMemo(() => {
    if (!data?.tagRows) return [];
    let list = [...data.tagRows];
    if (hasTagTrendColumnSearch(columnSearch)) {
      list = list.filter((row) => rowMatchesTagTrendSearch(row, columnSearch));
    }
    return list;
  }, [data?.tagRows, columnSearch]);

  const sortedTagRows = useMemo(() => {
    const mul = sortDir === "asc" ? 1 : -1;
    return [...filteredTagRows].sort((a, b) => {
      if (sortKey === "tagName") return mul * a.tagName.localeCompare(b.tagName, undefined, { sensitivity: "base" });
      const av =
        sortKey === "pctHealthyStart"
          ? (a.pctHealthyStart ?? (sortDir === "asc" ? Infinity : -Infinity))
          : (a[sortKey] ?? (sortDir === "asc" ? Infinity : -Infinity));
      const bv =
        sortKey === "pctHealthyStart"
          ? (b.pctHealthyStart ?? (sortDir === "asc" ? Infinity : -Infinity))
          : (b[sortKey] ?? (sortDir === "asc" ? Infinity : -Infinity));
      if (typeof av === "number" && typeof bv === "number") return mul * (av - bv);
      return 0;
    });
  }, [filteredTagRows, sortKey, sortDir]);

  const onSort = (key: TagSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "tagName" ? "asc" : "desc");
    }
  };

  const current = data?.current;
  const baselineSnap = data?.baselineSnapshot;
  const orgDelta = data?.orgDelta;
  const fleet = current?.fleetTotals;
  const dateMin = data?.availableStartDate ?? undefined;
  const dateMax = data?.availableEndDate ?? undefined;

  return (
    <div className="app">
      <header className="header">
        <h1>Trends</h1>
        <DailySnapshotNotice />
        <p className="lede">
          Compare saved Health Summary snapshots over time. Daily snapshots are taken automatically at 12:00 AM EDT.
          <strong> Baseline</strong> compares the most recent refresh to the oldest snapshot in the database.{" "}
          <strong>Dates</strong> lets you pick a start and end date. Manual refreshes on Health Summary also create
          snapshots.
        </p>
      </header>

      <section className="panel trends-baseline-panel">
        <div className="trends-baseline-controls">
          <label className="trends-control-field" htmlFor="trends-compare-mode">
            <span className="trends-control-field-label">Compare to</span>
            <select
              id="trends-compare-mode"
              className="trends-baseline-select"
              value={compareMode}
              onChange={(e) => setCompareMode(e.target.value as TrendsCompareMode)}
              disabled={loading && data == null}
            >
              {COMPARE_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {compareMode === "dates" && (
            <>
              <label className="trends-control-field" htmlFor="trends-start-date">
                <span className="trends-control-field-label">Start date</span>
                <input
                  id="trends-start-date"
                  type="date"
                  className="trends-date-input"
                  value={startDate}
                  min={dateMin}
                  max={endDate || dateMax}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={loading && data == null}
                />
              </label>
              <label className="trends-control-field" htmlFor="trends-end-date">
                <span className="trends-control-field-label">End date</span>
                <input
                  id="trends-end-date"
                  type="date"
                  className="trends-date-input"
                  value={endDate}
                  min={startDate || dateMin}
                  max={dateMax}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={loading && data == null}
                />
              </label>
            </>
          )}
        </div>
        <div className="trends-baseline-status">
          {current && baselineSnap && (
            <TrendsCompareDates
              baselineAt={baselineSnap.dataRetrievedAt}
              recentAt={current.dataRetrievedAt}
              className="summary-last-refreshed trends-compare-range trends-compare-range-inline"
            />
          )}
          {current && !baselineSnap && (
            <p className="summary-last-refreshed" role="status">
              Current snapshot:{" "}
              <time dateTime={new Date(current.dataRetrievedAt).toISOString()}>
                {formatRefreshedAt(current.dataRetrievedAt)}
              </time>
              {loading && data != null && <span className="trends-refreshing"> · Updating…</span>}
            </p>
          )}
          {current && baselineSnap && loading && data != null && (
            <span className="trends-refreshing">Updating…</span>
          )}
          {!current && loading && (
            <p className="summary-last-refreshed" role="status">
              Loading trends from saved snapshots…
            </p>
          )}
        </div>
      </section>

      {showLoadingBanner && <div className="banner">Loading trends…</div>}
      {error && <div className="banner err">{error}</div>}

      {!loading && data && !data.canCompare && (
        <section className="panel trends-empty-panel">
          <p>
            <strong>{data.snapshotCount}</strong> snapshot{data.snapshotCount === 1 ? "" : "s"} saved. Run{" "}
            <strong>Refresh health summary</strong> at least twice to compare org and tag improvement.
          </p>
          <Link to="/health-summary" className="trends-go-summary">
            Go to Health Summary
          </Link>
        </section>
      )}

      {!loading && data?.canCompare && fleet && orgDelta && baselineSnap && (
        <>
          <section className="trends-chart-card trends-baseline-card trends-baseline-card-full">
            <div className="trends-chart-card-head">
              <h2 className="trends-chart-card-title">Change vs baseline</h2>
              <span className="trends-chart-badge">org delta</span>
            </div>
            <TrendsCompareDates
              baselineAt={baselineSnap.dataRetrievedAt}
              recentAt={current.dataRetrievedAt}
            />
            <div className="trends-org-delta-stats">
              <div className="trends-stat">
                <span className="trends-stat-value">{formatPctHealthy(fleet.pctHealthy)}</span>
                <span className="trends-stat-label">% healthy now</span>
              </div>
              <div className="trends-stat">
                <span className="trends-stat-value">
                  <DeltaCell value={orgDelta.pctHealthy} suffix="%" variant="baseline" />
                </span>
                <span className="trends-stat-label">Δ % healthy</span>
              </div>
              <div className="trends-stat">
                <span className="trends-stat-value">
                  <DeltaCell value={orgDelta.connectedLast7Days} variant="baseline" />
                </span>
                <span className="trends-stat-label">Δ connected</span>
              </div>
              <div className="trends-stat" title="Connected in last 7 days only">
                <span className="trends-stat-value">
                  <DeltaCell value={orgDelta.avgCoolerTemp30d} suffix="°F" variant="baseline" />
                </span>
                <span className="trends-stat-label">Δ Cooler Temp (30d)</span>
              </div>
              <div className="trends-stat" title="Connected in last 7 days only">
                <span className="trends-stat-value">
                  <DeltaCell value={orgDelta.avgFreezerTemp30d} suffix="°F" variant="baseline" />
                </span>
                <span className="trends-stat-label">Δ Freezer Temp (30d)</span>
              </div>
            </div>
            <div className="trends-org-counts-grid">
              <div className="trends-count-stat">
                <span className="trends-count-value trends-count-connected">
                  {fleet.connectedLast7Days.toLocaleString()}
                </span>
                <span className="trends-count-label">Connected</span>
              </div>
              <div className="trends-count-stat">
                <span className="trends-count-value trends-count-not-connected">
                  {fleet.notConnected7Days.toLocaleString()}
                </span>
                <span className="trends-count-label">Not conn. 7d</span>
              </div>
              <div className="trends-count-stat">
                <span className="trends-count-value trends-count-never">
                  {fleet.neverConnected.toLocaleString()}
                </span>
                <span className="trends-count-label">Never</span>
              </div>
              <div className="trends-count-stat">
                <span className="trends-count-value trends-count-total">
                  {fleet.totalSensors.toLocaleString()}
                </span>
                <span className="trends-count-label">Total sensors</span>
              </div>
              <div className="trends-count-stat" title="Connected in last 7 days only">
                <span className="trends-count-value trends-count-total mono">
                  {formatAvgTemp30d(fleet.avgCoolerTemp30d)}
                </span>
                <span className="trends-count-label">Avg Cooler Temp (30d)</span>
              </div>
              <div className="trends-count-stat" title="Connected in last 7 days only">
                <span className="trends-count-value trends-count-total mono">
                  {formatAvgTemp30d(fleet.avgFreezerTemp30d)}
                </span>
                <span className="trends-count-label">Avg Freezer Temp (30d)</span>
              </div>
            </div>
          </section>

          <section className="trends-chart-card trends-chart-card-wide">
            <div className="trends-chart-card-head">
              <h2 className="trends-chart-card-title">Org health over time</h2>
              <span className="trends-chart-badge">org</span>
            </div>
            <TrendsCompareDates
              baselineAt={baselineSnap.dataRetrievedAt}
              recentAt={current.dataRetrievedAt}
            />
            <div className="trends-chart-legend" aria-hidden>
              <span className="trends-chart-legend-item">
                <span className="trends-chart-legend-swatch trends-chart-legend-swatch-line" />
                % healthy (line)
              </span>
              <span className="trends-chart-legend-item">
                <span className="trends-chart-legend-swatch trends-chart-legend-swatch-total" />
                Total sensors
              </span>
              <span className="trends-chart-legend-item">
                <span className="trends-chart-legend-swatch trends-chart-legend-swatch-connected" />
                Connected
              </span>
              <span className="trends-chart-legend-item">
                <span className="trends-chart-legend-swatch trends-chart-legend-swatch-not-connected" />
                Not conn. 7d
              </span>
              <span className="trends-chart-legend-item">
                <span className="trends-chart-legend-swatch trends-chart-legend-swatch-never" />
                never conn.
              </span>
            </div>
            <TrendOrgComboChart
              linePoints={historyLine}
              stackPoints={historyStack}
              ariaLabel="Percent healthy line with stacked sensor totals by connectivity"
            />
            <p className="hint trends-chart-caption">
              Source: health_summary_snapshots · up to {data.history.length} stack
              {data.history.length === 1 ? "" : "s"} (1/day; evenly sampled if the range has more) · line: % healthy
              (right axis) · bars: total sensors stacked by connectivity (left axis)
            </p>
          </section>

          <section className="trends-movers-section">
            <h2 className="health-summary-section-heading">Tag movers</h2>
            <TrendsCompareDates
              baselineAt={baselineSnap.dataRetrievedAt}
              recentAt={current.dataRetrievedAt}
            />
            <p className="hint trends-movers-hint">Tags with at least 10 sensors, ranked by Δ % healthy vs baseline.</p>
            <div className="trends-movers-grid-wrap">
              <MoversTable title="Top improvers" rows={data.topImprovers} variant="up" />
              <MoversTable title="Top decliners" rows={data.topDecliners} variant="down" />
            </div>
          </section>

          <section className="table-wrap">
            <h2 className="health-summary-section-heading">Tag trend table</h2>
            <TrendsCompareDates
              baselineAt={baselineSnap.dataRetrievedAt}
              recentAt={current.dataRetrievedAt}
            />
            <p className="hint trends-movers-hint">
              Trend: <strong>Up</strong> = connected and health % both up · <strong>Flat</strong> = no change in
              connected or health % · <strong>Down</strong> = connected or health % down.
            </p>
            <div className="summary summary-with-actions">
              <span>
                {hasTagTrendColumnSearch(columnSearch) ? (
                  sortedTagRows.length === 0 ? (
                    <>No tags match the current filters ({data.tagRows.length} tags loaded)</>
                  ) : (
                    <>
                      {sortedTagRows.length} of {data.tagRows.length} tag
                      {data.tagRows.length === 1 ? "" : "s"} (filtered)
                    </>
                  )
                ) : (
                  <>
                    {data.tagRows.length} tag{data.tagRows.length === 1 ? "" : "s"}
                  </>
                )}
              </span>
              {hasTagTrendColumnSearch(columnSearch) && (
                <button type="button" className="linkish" onClick={() => setColumnSearch(emptyTagTrendColumnSearch())}>
                  Clear column search
                </button>
              )}
            </div>
            <div className="scroll">
              <table className="grid health-summary-grid trends-tag-grid">
                <thead>
                  <tr className="th-filter-row">
                    {TAG_TREND_COLUMNS.map(({ key, label }) => (
                      <th key={`filter-${key}`} className="th-filter" scope="col">
                        <label className="col-filter-label" htmlFor={`trends-filter-${key}`}>
                          Search {label}
                        </label>
                        <input
                          id={`trends-filter-${key}`}
                          type="search"
                          className="col-filter-input"
                          placeholder={
                            key === "pctHealthy" || key === "pctHealthyStart" ? ">80, <100" : "Search…"
                          }
                          title={
                            key === "pctHealthy" || key === "pctHealthyStart"
                              ? "Compare in % with comma-separated AND clauses, e.g. >80, <100 for values between 80 and 100. Use >, <, or = with a number; plain text matches as a normal search."
                              : undefined
                          }
                          value={columnSearch[key]}
                          onChange={(e) => setColumnSearch((prev) => ({ ...prev, [key]: e.target.value }))}
                          aria-label={
                            key === "pctHealthy" || key === "pctHealthyStart"
                              ? `Filter by ${label}: comma-separated clauses all must match, e.g. greater than 80 and less than 100`
                              : `Filter by ${label}`
                          }
                        />
                      </th>
                    ))}
                  </tr>
                  <tr className="th-sort-row">
                    {TAG_TREND_COLUMNS.map(({ key, label, sortKey: colSortKey }) => (
                      <th
                        key={key}
                        className={colSortKey ? "th-sort" : undefined}
                        scope="col"
                        aria-sort={colSortKey ? getAriaSort(colSortKey, sortKey, sortDir) : undefined}
                      >
                        {colSortKey ? (
                          <button type="button" className="th-sort-btn" onClick={() => onSort(colSortKey)}>
                            <span>{label}</span>
                            {sortKey === colSortKey ? (
                              <span className="th-sort-ind">{sortDir === "asc" ? "▲" : "▼"}</span>
                            ) : null}
                          </button>
                        ) : (
                          <span className="th-sort-btn th-sort-btn-static" title={key === "trendLabel" ? TREND_COLUMN_TITLE : undefined}>
                            {label}
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedTagRows.length === 0 && hasTagTrendColumnSearch(columnSearch) && (
                    <tr>
                      <td colSpan={TAG_TREND_COLUMNS.length} className="muted">
                        No tags match the current column filters.
                      </td>
                    </tr>
                  )}
                  {sortedTagRows.map((r) => (
                    <tr key={r.tagId}>
                      <td>
                        <Link
                          to={`/detailed-sensor-health?tagId=${encodeURIComponent(r.tagId)}`}
                          className="tag-detail-link"
                        >
                          {r.tagName}
                        </Link>
                        {r.isNewTag && <span className="trends-new-tag">New</span>}
                      </td>
                      <td className="mono num-cell">
                        {r.pctHealthyStart == null ? "—" : formatPctHealthy(r.pctHealthyStart)}
                      </td>
                      <td className="mono num-cell">{formatPctHealthy(r.pctHealthy)}</td>
                      <td className="mono num-cell">
                        <DeltaCell value={r.deltaPctHealthy} suffix="%" />
                      </td>
                      <td className="mono num-cell">
                        <DeltaCell value={r.deltaConnected} />
                      </td>
                      <td
                        className={`trends-trend-label${
                          r.trendLabel === "Up"
                            ? " trends-trend-up"
                            : r.trendLabel === "Down"
                              ? " trends-trend-down"
                              : r.trendLabel === "Flat"
                                ? " trends-trend-flat"
                                : ""
                        }`}
                        title={
                          r.trendLabel === "Up"
                            ? "Connected devices and health % both increased"
                            : r.trendLabel === "Down"
                              ? "Connected devices or health % decreased"
                              : r.trendLabel === "Flat"
                                ? "No change in connected devices or health %"
                                : undefined
                        }
                      >
                        {r.trendLabel}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
