import {
  emptySummaryColumnSearch,
  type FleetHealthTotals,
  type TagHealthSummaryRow,
  type TagHealthSummarySortKey,
} from "./sensorHealth";

const STORAGE_KEY = "canteen-em-health-summary-v3";

type SortDir = "asc" | "desc";

export type PersistedHealthSummary = {
  summaryRows: TagHealthSummaryRow[];
  fleetTotals: FleetHealthTotals;
  dataRetrievedAt: number;
  sortKey: TagHealthSummarySortKey;
  sortDir: SortDir;
  columnSearch: Record<TagHealthSummarySortKey, string>;
};

function isTagHealthSummaryRow(value: unknown): value is TagHealthSummaryRow {
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
}

function isSortKey(value: unknown): value is TagHealthSummarySortKey {
  return (
    value === "tagId" ||
    value === "tagName" ||
    value === "totalSensors" ||
    value === "connectedLast7Days" ||
    value === "notConnected7Days" ||
    value === "neverConnected" ||
    value === "pctHealthy"
  );
}

function parseColumnSearch(value: unknown): Record<TagHealthSummarySortKey, string> {
  const base = emptySummaryColumnSearch();
  if (!value || typeof value !== "object") return base;
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(base) as TagHealthSummarySortKey[]) {
    if (typeof o[key] === "string") base[key] = o[key];
  }
  return base;
}

function isFleetHealthTotals(value: unknown): value is FleetHealthTotals {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.totalSensors === "number" &&
    typeof o.connectedLast7Days === "number" &&
    typeof o.neverConnected === "number" &&
    typeof o.notConnected7Days === "number" &&
    typeof o.pctHealthy === "number"
  );
}

export function loadPersistedHealthSummary(): PersistedHealthSummary | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!Array.isArray(parsed.summaryRows) || !parsed.summaryRows.every(isTagHealthSummaryRow)) {
      return null;
    }
    if (typeof parsed.dataRetrievedAt !== "number" || !Number.isFinite(parsed.dataRetrievedAt)) {
      return null;
    }
    if (!isFleetHealthTotals(parsed.fleetTotals)) {
      return null;
    }
    const sortKey = isSortKey(parsed.sortKey) ? parsed.sortKey : "tagName";
    const sortDir = parsed.sortDir === "desc" ? "desc" : "asc";
    return {
      summaryRows: parsed.summaryRows,
      fleetTotals: parsed.fleetTotals,
      dataRetrievedAt: parsed.dataRetrievedAt,
      sortKey,
      sortDir,
      columnSearch: parseColumnSearch(parsed.columnSearch),
    };
  } catch {
    return null;
  }
}

export function savePersistedHealthSummary(data: PersistedHealthSummary): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota or private browsing — ignore */
  }
}

export function clearPersistedHealthSummary(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
