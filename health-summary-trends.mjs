import { getZonedYmd, utcMsAtZoneMidnight } from "./health-summary-scheduler.mjs";

/**
 * @param {string} ymd YYYY-MM-DD
 */
function nextYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function parseYmd(value) {
  if (value == null || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map(Number);
  if (!Number.isFinite(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return trimmed;
}

/**
 * @param {Array<{ dataRetrievedAt: number }>} snapshots newest first
 * @param {number} targetAt
 */
function closestSnapshot(snapshots, targetAt) {
  let best = null;
  let bestDist = Infinity;
  for (const s of snapshots) {
    const dist = Math.abs(s.dataRetrievedAt - targetAt);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

/**
 * Resolve the two snapshots being compared.
 * - baseline mode: newest vs oldest in the database
 * - dates mode: nearest snapshots to start/end calendar days (Eastern)
 *
 * @param {Array<{ id: number, dataRetrievedAt: number }>} snapshots newest first
 * @param {{ mode?: string, startDate?: string | null, endDate?: string | null }} options
 */
export function resolveCompareSnapshots(snapshots, options = {}) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    return { mode: "baseline", current: null, baseline: null, startDate: null, endDate: null };
  }

  const mode = options.mode === "dates" ? "dates" : "baseline";
  const newest = snapshots[0];
  const oldest = snapshots[snapshots.length - 1];

  if (mode === "baseline") {
    return {
      mode,
      current: newest,
      baseline: oldest,
      startDate: getZonedYmd(oldest.dataRetrievedAt),
      endDate: getZonedYmd(newest.dataRetrievedAt),
    };
  }

  let startDate = parseYmd(options.startDate) ?? getZonedYmd(oldest.dataRetrievedAt);
  let endDate = parseYmd(options.endDate) ?? getZonedYmd(newest.dataRetrievedAt);
  if (startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }

  const startTarget = utcMsAtZoneMidnight(startDate);
  const endTarget = utcMsAtZoneMidnight(nextYmd(endDate)) - 1;
  let baseline = closestSnapshot(snapshots, startTarget);
  let current = closestSnapshot(snapshots, endTarget);

  if (!baseline || !current) {
    return { mode, current: null, baseline: null, startDate, endDate };
  }

  if (baseline.dataRetrievedAt > current.dataRetrievedAt) {
    const tmp = baseline;
    baseline = current;
    current = tmp;
  }

  if (baseline.id === current.id) {
    // Same nearest snap — try distinct neighbors around the range.
    const older = snapshots.find((s) => s.dataRetrievedAt < current.dataRetrievedAt);
    if (older) baseline = older;
  }

  if (baseline.id === current.id) {
    return { mode, current: null, baseline: null, startDate, endDate };
  }

  return { mode, current, baseline, startDate, endDate };
}

function tagMapFromRows(rows) {
  const m = new Map();
  for (const row of rows) {
    if (!row || row.tagId == null) continue;
    m.set(String(row.tagId), row);
  }
  return m;
}

function optionalNumDelta(current, baseline) {
  if (typeof current !== "number" || !Number.isFinite(current)) return null;
  if (typeof baseline !== "number" || !Number.isFinite(baseline)) return null;
  return current - baseline;
}

function fleetDelta(current, baseline) {
  const c = current.fleetTotals;
  const b = baseline.fleetTotals;
  return {
    pctHealthy: c.pctHealthy - b.pctHealthy,
    connectedLast7Days: c.connectedLast7Days - b.connectedLast7Days,
    notConnected7Days: c.notConnected7Days - b.notConnected7Days,
    neverConnected: c.neverConnected - b.neverConnected,
    totalSensors: c.totalSensors - b.totalSensors,
    avgCoolerTemp30d: optionalNumDelta(c.avgCoolerTemp30d, b.avgCoolerTemp30d),
    avgFreezerTemp30d: optionalNumDelta(c.avgFreezerTemp30d, b.avgFreezerTemp30d),
  };
}

/**
 * Trend vs the selected baseline/start snapshot.
 * - Up: connected devices and % healthy both increased
 * - Flat: connected devices and % healthy unchanged
 * - Down: connected devices or % healthy decreased
 * @param {number | null} deltaConnected
 * @param {number | null} deltaPctHealthy
 */
function trendLabelForDeltas(deltaConnected, deltaPctHealthy) {
  if (
    deltaConnected == null ||
    deltaPctHealthy == null ||
    !Number.isFinite(deltaConnected) ||
    !Number.isFinite(deltaPctHealthy)
  ) {
    return "—";
  }
  const pctEps = 0.05;
  const connectedUp = deltaConnected > 0;
  const connectedDown = deltaConnected < 0;
  const connectedFlat = deltaConnected === 0;
  const pctUp = deltaPctHealthy > pctEps;
  const pctDown = deltaPctHealthy < -pctEps;
  const pctFlat = Math.abs(deltaPctHealthy) <= pctEps;

  if (connectedUp && pctUp) return "Up";
  if (connectedDown || pctDown) return "Down";
  if (connectedFlat && pctFlat) return "Flat";
  return "Flat";
}

function compareModeLabel(mode) {
  return mode === "dates" ? "Custom date range" : "Baseline (oldest → newest)";
}

/**
 * @param {Array<{
 *   id: number,
 *   dataRetrievedAt: number,
 *   fleetTotals: object,
 *   summaryRows: object[],
 *   storedAt: number,
 * }>} snapshots newest first
 */
export function buildHealthSummaryTrends(snapshots, options = {}) {
  const mode = options.mode === "dates" ? "dates" : "baseline";
  const historyLimit = Math.max(2, Math.min(60, Number(options.historyLimit) || 14));
  const minTagSensors = Math.max(1, Number(options.minTagSensors) || 10);
  const topN = Math.max(1, Math.min(20, Number(options.topN) || 5));

  const snapshotCount = snapshots.length;
  const availableStartDate =
    snapshotCount > 0 ? getZonedYmd(snapshots[snapshots.length - 1].dataRetrievedAt) : null;
  const availableEndDate = snapshotCount > 0 ? getZonedYmd(snapshots[0].dataRetrievedAt) : null;

  const empty = {
    canCompare: false,
    snapshotCount,
    compareMode: mode,
    baseline: mode,
    baselineLabel: compareModeLabel(mode),
    startDate: parseYmd(options.startDate),
    endDate: parseYmd(options.endDate),
    availableStartDate,
    availableEndDate,
    history: [],
    tagRows: [],
    topImprovers: [],
    topDecliners: [],
  };

  if (snapshotCount < 2) {
    return empty;
  }

  const resolved = resolveCompareSnapshots(snapshots, {
    mode,
    startDate: options.startDate,
    endDate: options.endDate,
  });
  const current = resolved.current;
  const baselineSnap = resolved.baseline;

  const historyRangeStartAt = baselineSnap?.dataRetrievedAt ?? null;
  const historyRangeEndAt = current?.dataRetrievedAt ?? null;

  if (!baselineSnap || !current) {
    return {
      ...empty,
      startDate: resolved.startDate,
      endDate: resolved.endDate,
      current: snapshots[0] ? pickCurrentPayload(snapshots[0]) : undefined,
      history: buildOrgHistory(snapshots, historyLimit, historyRangeStartAt, historyRangeEndAt),
    };
  }

  const baselineTags = tagMapFromRows(baselineSnap.summaryRows);
  const tagRows = [];

  for (const row of current.summaryRows) {
    if (!row || row.totalSensors <= 0) continue;
    const prev = baselineTags.get(String(row.tagId));
    const deltaPctHealthy = prev ? row.pctHealthy - prev.pctHealthy : null;
    const deltaConnected = prev ? row.connectedLast7Days - prev.connectedLast7Days : null;
    tagRows.push({
      tagId: row.tagId,
      tagName: row.tagName,
      totalSensors: row.totalSensors,
      pctHealthy: row.pctHealthy,
      pctHealthyStart: prev ? prev.pctHealthy : null,
      connectedLast7Days: row.connectedLast7Days,
      deltaPctHealthy,
      deltaConnected,
      isNewTag: !prev,
      trendLabel: trendLabelForDeltas(deltaConnected, deltaPctHealthy),
    });
  }

  tagRows.sort((a, b) => a.tagName.localeCompare(b.tagName, undefined, { sensitivity: "base" }));

  const ranked = tagRows.filter(
    (r) => r.totalSensors >= minTagSensors && r.deltaPctHealthy != null && Number.isFinite(r.deltaPctHealthy),
  );
  const topImprovers = [...ranked]
    .sort((a, b) => b.deltaPctHealthy - a.deltaPctHealthy)
    .filter((r) => r.deltaPctHealthy > 0)
    .slice(0, topN);
  const topDecliners = [...ranked]
    .sort((a, b) => a.deltaPctHealthy - b.deltaPctHealthy)
    .filter((r) => r.deltaPctHealthy < 0)
    .slice(0, topN);

  return {
    canCompare: true,
    snapshotCount,
    compareMode: mode,
    baseline: mode,
    baselineLabel: compareModeLabel(mode),
    startDate: resolved.startDate,
    endDate: resolved.endDate,
    availableStartDate,
    availableEndDate,
    current: pickCurrentPayload(current),
    baselineSnapshot: {
      dataRetrievedAt: baselineSnap.dataRetrievedAt,
      storedAt: baselineSnap.storedAt,
      fleetTotals: baselineSnap.fleetTotals,
    },
    orgDelta: fleetDelta(current, baselineSnap),
    history: buildOrgHistory(snapshots, historyLimit, historyRangeStartAt, historyRangeEndAt),
    tagRows,
    topImprovers,
    topDecliners,
  };
}

function pickCurrentPayload(snapshot) {
  return {
    dataRetrievedAt: snapshot.dataRetrievedAt,
    storedAt: snapshot.storedAt,
    fleetTotals: snapshot.fleetTotals,
  };
}

/** Local calendar day key so chart points are one-per-day, not per refresh. */
function localDayKey(at) {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Evenly sample points across a series, always including first and last.
 * @template T
 * @param {T[]} points chronological
 * @param {number} maxStacks
 * @returns {T[]}
 */
function evenlySamplePoints(points, maxStacks) {
  const n = points.length;
  if (n <= maxStacks) return points;
  if (maxStacks <= 1) return [points[n - 1]];

  const out = [];
  const used = new Set();
  for (let i = 0; i < maxStacks; i += 1) {
    const idx = Math.round((i * (n - 1)) / (maxStacks - 1));
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(points[idx]);
  }
  return out;
}

/**
 * One org history point per calendar day (latest snapshot that day).
 * If the range has more than `maxStacks` daily points, evenly sample to that count.
 * @param {Array<{ dataRetrievedAt: number, fleetTotals: object }>} snapshots newest first
 * @param {number} maxStacks max bars/points to show on the chart
 * @param {number | null} rangeStartAt inclusive start of comparison window
 * @param {number | null} rangeEndAt inclusive end of comparison window
 */
function buildOrgHistory(snapshots, maxStacks, rangeStartAt = null, rangeEndAt = null) {
  const byDay = new Map();
  for (const s of snapshots) {
    if (rangeStartAt != null && s.dataRetrievedAt < rangeStartAt) continue;
    if (rangeEndAt != null && s.dataRetrievedAt > rangeEndAt) continue;
    const key = localDayKey(s.dataRetrievedAt);
    if (byDay.has(key)) continue;
    byDay.set(key, s);
  }

  const chronological = [...byDay.values()].reverse().map((s) => ({
    dataRetrievedAt: s.dataRetrievedAt,
    pctHealthy: s.fleetTotals.pctHealthy,
    connectedLast7Days: s.fleetTotals.connectedLast7Days,
    notConnected7Days: s.fleetTotals.notConnected7Days,
    neverConnected: s.fleetTotals.neverConnected,
    totalSensors: s.fleetTotals.totalSensors,
    avgCoolerTemp30d:
      typeof s.fleetTotals.avgCoolerTemp30d === "number" && Number.isFinite(s.fleetTotals.avgCoolerTemp30d)
        ? s.fleetTotals.avgCoolerTemp30d
        : null,
    avgFreezerTemp30d:
      typeof s.fleetTotals.avgFreezerTemp30d === "number" && Number.isFinite(s.fleetTotals.avgFreezerTemp30d)
        ? s.fleetTotals.avgFreezerTemp30d
        : null,
  }));

  return evenlySamplePoints(chronological, maxStacks);
}
