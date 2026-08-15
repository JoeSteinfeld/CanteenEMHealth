import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { apiFetch } from "./auth";
import { parseJsonSafe } from "./apiUtils";
import {
  type FleetHealthTotals,
  type TagHealthSummaryRow,
  type TagHealthSummarySortKey,
} from "./sensorHealth";
import {
  loadPersistedHealthSummary,
  loadPersistedHealthSummaryUi,
  savePersistedHealthSummary,
} from "./healthSummaryStorage";

type SortDir = "asc" | "desc";

type HealthSummaryCacheValue = {
  summaryRows: TagHealthSummaryRow[] | null;
  fleetTotals: FleetHealthTotals | null;
  dataRetrievedAt: number | null;
  snapshotLoading: boolean;
  sortKey: TagHealthSummarySortKey;
  sortDir: SortDir;
  columnSearch: Record<TagHealthSummarySortKey, string>;
  setSummaryRows: (rows: TagHealthSummaryRow[] | null) => void;
  setFleetTotals: (totals: FleetHealthTotals | null) => void;
  setDataRetrievedAt: (at: number | null) => void;
  setSortKey: (key: TagHealthSummarySortKey) => void;
  setSortDir: (dir: SortDir) => void;
  setColumnSearch: Dispatch<SetStateAction<Record<TagHealthSummarySortKey, string>>>;
};

const HealthSummaryCacheContext = createContext<HealthSummaryCacheValue | null>(null);

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

function normalizeSummaryRows(rows: TagHealthSummaryRow[]): TagHealthSummaryRow[] {
  return rows.filter((row) => row.totalSensors > 0).map(normalizeTagHealthSummaryRow);
}

type SnapshotPayload = {
  summaryRows: TagHealthSummaryRow[];
  fleetTotals: FleetHealthTotals;
  dataRetrievedAt: number;
};

function parseSnapshotResponse(j: {
  data?: unknown;
  fleetTotals?: unknown;
  dataRetrievedAt?: unknown;
}): SnapshotPayload | null {
  const retrievedAt =
    typeof j.dataRetrievedAt === "number" && Number.isFinite(j.dataRetrievedAt) ? j.dataRetrievedAt : null;
  const list = Array.isArray(j.data) ? j.data.filter(isTagHealthSummaryRow) : null;
  const totals = isFleetHealthTotals(j.fleetTotals) ? normalizeFleetHealthTotals(j.fleetTotals) : null;
  if (retrievedAt == null || list == null || totals == null) return null;
  return {
    summaryRows: normalizeSummaryRows(list),
    fleetTotals: totals,
    dataRetrievedAt: retrievedAt,
  };
}

async function restoreSnapshotToServer(payload: SnapshotPayload): Promise<void> {
  try {
    await apiFetch("/api/health-summary/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataRetrievedAt: payload.dataRetrievedAt,
        fleetTotals: payload.fleetTotals,
        summaryRows: payload.summaryRows,
      }),
    });
  } catch {
    /* best effort — browser cache still shows the summary */
  }
}

export function HealthSummaryCacheProvider({ children }: { children: ReactNode }) {
  const persisted = loadPersistedHealthSummary();
  const ui = loadPersistedHealthSummaryUi();
  const [summaryRows, setSummaryRows] = useState<TagHealthSummaryRow[] | null>(
    persisted ? normalizeSummaryRows(persisted.summaryRows) : null,
  );
  const [fleetTotals, setFleetTotals] = useState<FleetHealthTotals | null>(persisted?.fleetTotals ?? null);
  const [dataRetrievedAt, setDataRetrievedAt] = useState<number | null>(persisted?.dataRetrievedAt ?? null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [sortKey, setSortKey] = useState<TagHealthSummarySortKey>(persisted?.sortKey ?? ui.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(persisted?.sortDir ?? ui.sortDir);
  const [columnSearch, setColumnSearch] = useState(persisted?.columnSearch ?? ui.columnSearch);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/health-summary/snapshot");
        const j = (await parseJsonSafe(r)) as {
          data?: unknown;
          fleetTotals?: unknown;
          dataRetrievedAt?: unknown;
          error?: string;
        };
        if (cancelled || !r.ok) return;

        const serverSnapshot = parseSnapshotResponse(j);
        const localSnapshot = persisted ? parseSnapshotResponse(persisted) : null;

        if (serverSnapshot && localSnapshot) {
          const useServer = serverSnapshot.dataRetrievedAt >= localSnapshot.dataRetrievedAt;
          const chosen = useServer ? serverSnapshot : localSnapshot;
          setSummaryRows(chosen.summaryRows);
          setFleetTotals(chosen.fleetTotals);
          setDataRetrievedAt(chosen.dataRetrievedAt);
          if (!useServer) void restoreSnapshotToServer(localSnapshot);
          return;
        }

        if (serverSnapshot) {
          setSummaryRows(serverSnapshot.summaryRows);
          setFleetTotals(serverSnapshot.fleetTotals);
          setDataRetrievedAt(serverSnapshot.dataRetrievedAt);
          return;
        }

        if (localSnapshot) {
          setSummaryRows(localSnapshot.summaryRows);
          setFleetTotals(localSnapshot.fleetTotals);
          setDataRetrievedAt(localSnapshot.dataRetrievedAt);
          void restoreSnapshotToServer(localSnapshot);
        }
      } catch {
        /* server snapshot unavailable — browser cache (if any) remains visible */
      } finally {
        if (!cancelled) setSnapshotLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (summaryRows == null || fleetTotals == null || dataRetrievedAt == null) return;
    savePersistedHealthSummary({
      summaryRows,
      fleetTotals,
      dataRetrievedAt,
      sortKey,
      sortDir,
      columnSearch,
    });
  }, [summaryRows, fleetTotals, dataRetrievedAt, sortKey, sortDir, columnSearch]);

  const value = useMemo(
    () => ({
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
    }),
    [summaryRows, fleetTotals, dataRetrievedAt, snapshotLoading, sortKey, sortDir, columnSearch],
  );

  return <HealthSummaryCacheContext.Provider value={value}>{children}</HealthSummaryCacheContext.Provider>;
}

export function useHealthSummaryCache(): HealthSummaryCacheValue {
  const ctx = useContext(HealthSummaryCacheContext);
  if (!ctx) {
    throw new Error("useHealthSummaryCache must be used within HealthSummaryCacheProvider");
  }
  return ctx;
}
