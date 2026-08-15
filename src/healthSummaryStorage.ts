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

export type PersistedHealthSummaryUi = {
  sortKey: TagHealthSummarySortKey;
  sortDir: SortDir;
  columnSearch: Record<TagHealthSummarySortKey, string>;
};

function optionalFiniteNumberOrNull(value: unknown): boolean {
  if (value == null) return true;
  return typeof value === "number" && Number.isFinite(value);
}

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
    typeof r.pctHealthy === "number" &&
    optionalFiniteNumberOrNull(r.avgCoolerTemp30d) &&
    optionalFiniteNumberOrNull(r.avgFreezerTemp30d)
  );
}

function normalizeTagHealthSummaryRow(row: TagHealthSummaryRow): TagHealthSummaryRow {
  return {
    ...row,
    avgCoolerTemp30d:
      typeof row.avgCoolerTemp30d === "number" && Number.isFinite(row.avgCoolerTemp30d)
        ? row.avgCoolerTemp30d
        : null,
    avgFreezerTemp30d:
      typeof row.avgFreezerTemp30d === "number" && Number.isFinite(row.avgFreezerTemp30d)
        ? row.avgFreezerTemp30d
        : null,
  };
}

function isSortKey(value: unknown): value is TagHealthSummarySortKey {
  return (
    value === "tagId" ||
    value === "tagName" ||
    value === "totalSensors" ||
    value === "connectedLast7Days" ||
    value === "notConnected7Days" ||
    value === "neverConnected" ||
    value === "pctHealthy" ||
    value === "avgCoolerTemp30d" ||
    value === "avgFreezerTemp30d"
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
}

function normalizeFleetHealthTotals(totals: FleetHealthTotals): FleetHealthTotals {
  return {
    ...totals,
    avgCoolerTemp30d:
      typeof totals.avgCoolerTemp30d === "number" && Number.isFinite(totals.avgCoolerTemp30d)
        ? totals.avgCoolerTemp30d
        : null,
    avgFreezerTemp30d:
      typeof totals.avgFreezerTemp30d === "number" && Number.isFinite(totals.avgFreezerTemp30d)
        ? totals.avgFreezerTemp30d
        : null,
  };
}

export function loadPersistedHealthSummaryUi(): PersistedHealthSummaryUi {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { sortKey: "tagName", sortDir: "asc", columnSearch: emptySummaryColumnSearch() };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sortKey: isSortKey(parsed.sortKey) ? parsed.sortKey : "tagName",
      sortDir: parsed.sortDir === "desc" ? "desc" : "asc",
      columnSearch: parseColumnSearch(parsed.columnSearch),
    };
  } catch {
    return { sortKey: "tagName", sortDir: "asc", columnSearch: emptySummaryColumnSearch() };
  }
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
      summaryRows: parsed.summaryRows.map(normalizeTagHealthSummaryRow),
      fleetTotals: normalizeFleetHealthTotals(parsed.fleetTotals),
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
