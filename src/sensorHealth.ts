export type SensorRow = {
  id: string;
  name: string;
  tagValue: string;
  /** From GetTemperature ambientTemperatureTime; null if never reported */
  lastConnectedTime: string | null;
  /** AG/VG host name from GetTemperature trailerId → assets; "—" if unknown */
  connectedTo: string;
  batteryVoltage: string;
  batteryVoltageLow: string;
  temperature: string;
  /** 30-day ambient BLE temp max/min/avg display (°F); "…" while loading, "—" if none */
  tempMax30d: string;
  tempMin30d: string;
  tempAvg30d: string;
  note: string;
};

export type HealthCategory = "never" | "stale" | "recentLow" | "recentOk";

export type TagHealthSummaryRow = {
  tagId: string;
  tagName: string;
  totalSensors: number;
  connectedLast7Days: number;
  notConnected7Days: number;
  neverConnected: number;
  pctHealthy: number;
};

/** Unique sensors fleet-wide (each sensor counted once, even if on multiple tags). */
export type FleetHealthTotals = {
  totalSensors: number;
  connectedLast7Days: number;
  neverConnected: number;
  notConnected7Days: number;
  pctHealthy: number;
};

export type TagHealthSummarySortKey = keyof TagHealthSummaryRow;

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** No usable last-connected timestamp (null, empty, or unparseable). */
export function isMissingLastConnected(lastConnectedIso: string | null): boolean {
  if (lastConnectedIso == null) return true;
  const s = String(lastConnectedIso).trim();
  if (!s) return true;
  const t = new Date(s).getTime();
  return Number.isNaN(t);
}

/** True if last connected is strictly more than 7 days before `retrievedAt`. */
export function isLastConnectedStale(lastConnectedIso: string | null, retrievedAt: number | null): boolean {
  if (isMissingLastConnected(lastConnectedIso) || retrievedAt == null) return false;
  const t = new Date(lastConnectedIso).getTime();
  return retrievedAt - t > STALE_MS;
}

export function isBatteryVoltageLowIndicated(batteryVoltageLowDisplay: string): boolean {
  const s = batteryVoltageLowDisplay.trim().toLowerCase();
  if (!s || s === "—") return false;
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  if (s.includes("low")) return true;
  return false;
}

/** Server joins tag names with ", " — one sensor may be counted in multiple tag columns. */
export function tagNamesForRow(r: SensorRow): string[] {
  const s = r.tagValue.trim();
  if (!s) return [];
  return s
    .split(", ")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function categorizeSensorHealth(r: SensorRow, dataRetrievedAt: number | null): HealthCategory {
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

export function buildTagHealthSummaryRows(
  tagNames: string[],
  rows: SensorRow[],
  dataRetrievedAt: number,
): TagHealthSummaryRow[] {
  const uniqueTags = [...new Set(tagNames.map((n) => n.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  return uniqueTags
    .map((tagName) => {
      let totalSensors = 0;
      let connectedLast7Days = 0;
      let notConnected7Days = 0;
      let neverConnected = 0;

      for (const r of rows) {
        if (!tagNamesForRow(r).includes(tagName)) continue;
        totalSensors += 1;
        const cat = categorizeSensorHealth(r, dataRetrievedAt);
        if (cat === "never") neverConnected += 1;
        else if (cat === "stale") notConnected7Days += 1;
        else connectedLast7Days += 1;
      }

      const pctHealthy = totalSensors > 0 ? (connectedLast7Days / totalSensors) * 100 : 0;

      return {
        tagId: tagName,
        tagName,
        totalSensors,
        connectedLast7Days,
        notConnected7Days,
        neverConnected,
        pctHealthy,
      };
    })
    .filter((row) => row.totalSensors > 0);
}

export function formatPctHealthy(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

export function summaryCellText(row: TagHealthSummaryRow, key: TagHealthSummarySortKey): string {
  if (key === "pctHealthy") return formatPctHealthy(row.pctHealthy);
  if (key === "tagName") return row.tagName;
  if (key === "tagId") return row.tagId;
  return String(row[key]);
}

export function compareTagHealthSummaryRows(
  a: TagHealthSummaryRow,
  b: TagHealthSummaryRow,
  key: TagHealthSummarySortKey,
  mul: 1 | -1,
): number {
  if (key === "tagName") {
    return mul * a.tagName.localeCompare(b.tagName, undefined, { sensitivity: "base" });
  }
  return mul * (a[key] - b[key]);
}

/** Matches optional spaces, one of > < =, spaces, then a number (optional trailing %). */
const PCT_HEALTHY_COMPARE_RE = /^\s*([><=])\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/;

/** Half of 0.1% display precision so "=" matches the rounded percentage. */
const PCT_HEALTHY_EQUAL_EPS = 0.05;

function pctHealthyCompareMatches(val: number, op: string, threshold: number): boolean {
  switch (op) {
    case ">":
      return val > threshold;
    case "<":
      return val < threshold;
    case "=":
      return Math.abs(val - threshold) <= PCT_HEALTHY_EQUAL_EPS;
    default:
      return false;
  }
}

function pctHealthyClauseMatches(row: TagHealthSummaryRow, clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed) return true;

  const m = trimmed.match(PCT_HEALTHY_COMPARE_RE);
  if (!m) {
    return summaryCellText(row, "pctHealthy").toLowerCase().includes(trimmed.toLowerCase());
  }

  const threshold = parseFloat(m[2]);
  if (!Number.isFinite(threshold)) return false;

  const val = row.pctHealthy;
  if (!Number.isFinite(val)) return false;

  return pctHealthyCompareMatches(val, m[1], threshold);
}

/**
 * % healthy filter: one or more comma-separated clauses, all must match (AND).
 * Comparisons: `>80`, `<50`, `=100` (with or without %). Example: `>80, <100`.
 * Non-comparison clauses use substring search on the cell text.
 */
export function pctHealthySearchMatches(row: TagHealthSummaryRow, rawQuery: string): boolean {
  const trimmed = rawQuery.trim();
  if (!trimmed) return true;

  const clauses = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  if (clauses.length === 0) return true;

  return clauses.every((clause) => pctHealthyClauseMatches(row, clause));
}

export function rowMatchesSummarySearch(
  row: TagHealthSummaryRow,
  filters: Record<TagHealthSummarySortKey, string>,
): boolean {
  const keys: TagHealthSummarySortKey[] = [
    "tagId",
    "tagName",
    "totalSensors",
    "connectedLast7Days",
    "notConnected7Days",
    "neverConnected",
    "pctHealthy",
  ];
  for (const key of keys) {
    const q = filters[key].trim();
    if (!q) continue;
    if (key === "pctHealthy") {
      if (!pctHealthySearchMatches(row, filters[key])) return false;
      continue;
    }
    if (!summaryCellText(row, key).toLowerCase().includes(q.toLowerCase())) return false;
  }
  return true;
}

export function emptySummaryColumnSearch(): Record<TagHealthSummarySortKey, string> {
  return {
    tagId: "",
    tagName: "",
    totalSensors: "",
    connectedLast7Days: "",
    notConnected7Days: "",
    neverConnected: "",
    pctHealthy: "",
  };
}

export function hasSummaryColumnSearch(filters: Record<TagHealthSummarySortKey, string>): boolean {
  return Object.values(filters).some((v) => v.trim() !== "");
}
