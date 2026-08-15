import type { FleetHealthTotals, TagHealthSummaryRow } from "./sensorHealth";
import { formatPctHealthy, pctHealthySearchMatches } from "./sensorHealth";

export type TrendsCompareMode = "baseline" | "dates";

/** @deprecated use TrendsCompareMode */
export type TrendsBaseline = TrendsCompareMode;

export type OrgHistoryPoint = {
  dataRetrievedAt: number;
  pctHealthy: number;
  connectedLast7Days: number;
  notConnected7Days: number;
  neverConnected: number;
  totalSensors: number;
  avgCoolerTemp30d: number | null;
  avgFreezerTemp30d: number | null;
};

export type OrgFleetDelta = {
  pctHealthy: number;
  connectedLast7Days: number;
  notConnected7Days: number;
  neverConnected: number;
  totalSensors: number;
  avgCoolerTemp30d: number | null;
  avgFreezerTemp30d: number | null;
};

export type TagTrendRow = {
  tagId: string;
  tagName: string;
  totalSensors: number;
  /** % healthy at end (recent) snapshot */
  pctHealthy: number;
  /** % healthy at baseline/start snapshot; null if tag is new */
  pctHealthyStart: number | null;
  connectedLast7Days: number;
  deltaPctHealthy: number | null;
  deltaConnected: number | null;
  isNewTag: boolean;
  trendLabel: string;
};

export type HealthSummaryTrendsResponse = {
  canCompare: boolean;
  snapshotCount: number;
  compareMode: TrendsCompareMode;
  /** Same as compareMode; kept for older cached payloads. */
  baseline: TrendsCompareMode;
  baselineLabel: string;
  startDate?: string | null;
  endDate?: string | null;
  availableStartDate?: string | null;
  availableEndDate?: string | null;
  current?: {
    dataRetrievedAt: number;
    storedAt: number;
    fleetTotals: FleetHealthTotals;
  };
  baselineSnapshot?: {
    dataRetrievedAt: number;
    storedAt: number;
    fleetTotals: FleetHealthTotals;
  };
  orgDelta?: OrgFleetDelta;
  history: OrgHistoryPoint[];
  tagRows: TagTrendRow[];
  topImprovers: TagTrendRow[];
  topDecliners: TagTrendRow[];
};

export function formatRefreshedAt(at: number): string {
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

export function formatTrendCompareAt(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function formatShortChartDate(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function formatDelta(value: number | null, suffix = "", decimals = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return `0${suffix}`;
  const sign = value > 0 ? "+" : "";
  const n = suffix === "%" || suffix === "°F" ? value.toFixed(decimals) : String(value);
  return `${sign}${n}${suffix}`;
}

export function deltaTone(
  value: number | null,
  goodWhenHigher = true,
): "ok" | "warn" | "flat" | "muted" {
  if (value == null || !Number.isFinite(value) || value === 0) return "flat";
  const good = goodWhenHigher ? value > 0 : value < 0;
  return good ? "ok" : "warn";
}

export type TagTrendSearchKey =
  | "tagName"
  | "pctHealthyStart"
  | "pctHealthy"
  | "deltaPctHealthy"
  | "deltaConnected"
  | "trendLabel";

export function tagTrendCellText(row: TagTrendRow, key: TagTrendSearchKey): string {
  switch (key) {
    case "tagName":
      return row.tagName;
    case "pctHealthyStart":
      return row.pctHealthyStart == null ? "—" : formatPctHealthy(row.pctHealthyStart);
    case "pctHealthy":
      return formatPctHealthy(row.pctHealthy);
    case "deltaPctHealthy":
      return formatDelta(row.deltaPctHealthy, "%");
    case "deltaConnected":
      return formatDelta(row.deltaConnected);
    case "trendLabel":
      return row.trendLabel;
  }
}

export function rowMatchesTagTrendSearch(
  row: TagTrendRow,
  filters: Record<TagTrendSearchKey, string>,
): boolean {
  const keys: TagTrendSearchKey[] = [
    "tagName",
    "pctHealthyStart",
    "pctHealthy",
    "deltaPctHealthy",
    "deltaConnected",
    "trendLabel",
  ];
  for (const key of keys) {
    const q = filters[key].trim();
    if (!q) continue;
    if (key === "pctHealthy") {
      if (!pctHealthySearchMatches({ pctHealthy: row.pctHealthy } as TagHealthSummaryRow, filters[key])) {
        return false;
      }
      continue;
    }
    if (key === "pctHealthyStart") {
      if (row.pctHealthyStart == null) {
        if (!tagTrendCellText(row, key).toLowerCase().includes(q.toLowerCase())) return false;
        continue;
      }
      if (
        !pctHealthySearchMatches({ pctHealthy: row.pctHealthyStart } as TagHealthSummaryRow, filters[key])
      ) {
        return false;
      }
      continue;
    }
    if (!tagTrendCellText(row, key).toLowerCase().includes(q.toLowerCase())) return false;
  }
  return true;
}

export function emptyTagTrendColumnSearch(): Record<TagTrendSearchKey, string> {
  return {
    tagName: "",
    pctHealthyStart: "",
    pctHealthy: "",
    deltaPctHealthy: "",
    deltaConnected: "",
    trendLabel: "",
  };
}

export function hasTagTrendColumnSearch(filters: Record<TagTrendSearchKey, string>): boolean {
  return Object.values(filters).some((v) => v.trim() !== "");
}
