import type { FleetHealthTotals } from "./sensorHealth";
import type { HealthSummaryTrendsResponse, TrendsCompareMode } from "./healthSummaryTrends";

const STORAGE_KEY = "canteen-em-health-trends-v2";

export type PersistedTrends = {
  compareMode: TrendsCompareMode;
  startDate: string | null;
  endDate: string | null;
  data: HealthSummaryTrendsResponse;
};

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

function isTrendsCompareMode(value: unknown): value is TrendsCompareMode {
  return value === "baseline" || value === "dates";
}

function isYmd(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isHealthSummaryTrendsResponse(value: unknown): value is HealthSummaryTrendsResponse {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (typeof o.canCompare !== "boolean" || typeof o.snapshotCount !== "number") return false;
  const mode = o.compareMode ?? o.baseline;
  if (!isTrendsCompareMode(mode) || typeof o.baselineLabel !== "string") return false;
  if (!Array.isArray(o.history) || !Array.isArray(o.tagRows)) return false;
  if (!Array.isArray(o.topImprovers) || !Array.isArray(o.topDecliners)) return false;
  if (o.current != null) {
    const c = o.current as Record<string, unknown>;
    if (typeof c.dataRetrievedAt !== "number" || !isFleetHealthTotals(c.fleetTotals)) return false;
  }
  return true;
}

export function loadPersistedTrends(): PersistedTrends | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isTrendsCompareMode(parsed.compareMode) || !isHealthSummaryTrendsResponse(parsed.data)) {
      return null;
    }
    return {
      compareMode: parsed.compareMode,
      startDate: isYmd(parsed.startDate) ? parsed.startDate : null,
      endDate: isYmd(parsed.endDate) ? parsed.endDate : null,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

export function savePersistedTrends(
  compareMode: TrendsCompareMode,
  startDate: string | null,
  endDate: string | null,
  data: HealthSummaryTrendsResponse,
): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ compareMode, startDate, endDate, data }),
    );
  } catch {
    /* quota or private browsing — ignore */
  }
}
