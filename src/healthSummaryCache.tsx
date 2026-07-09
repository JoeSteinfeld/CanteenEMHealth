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
import { loadPersistedHealthSummaryUi, savePersistedHealthSummary } from "./healthSummaryStorage";

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
  return (
    typeof o.totalSensors === "number" &&
    typeof o.connectedLast7Days === "number" &&
    typeof o.neverConnected === "number" &&
    typeof o.notConnected7Days === "number" &&
    typeof o.pctHealthy === "number"
  );
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
    typeof r.pctHealthy === "number"
  );
}

export function HealthSummaryCacheProvider({ children }: { children: ReactNode }) {
  const ui = loadPersistedHealthSummaryUi();
  const [summaryRows, setSummaryRows] = useState<TagHealthSummaryRow[] | null>(null);
  const [fleetTotals, setFleetTotals] = useState<FleetHealthTotals | null>(null);
  const [dataRetrievedAt, setDataRetrievedAt] = useState<number | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [sortKey, setSortKey] = useState<TagHealthSummarySortKey>(ui.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(ui.sortDir);
  const [columnSearch, setColumnSearch] = useState(ui.columnSearch);

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

        const retrievedAt =
          typeof j.dataRetrievedAt === "number" && Number.isFinite(j.dataRetrievedAt) ? j.dataRetrievedAt : null;
        const list = Array.isArray(j.data) ? j.data.filter(isTagHealthSummaryRow) : null;
        const totals = isFleetHealthTotals(j.fleetTotals) ? j.fleetTotals : null;

        if (retrievedAt != null && list != null && totals != null) {
          setSummaryRows(list.filter((row) => row.totalSensors > 0));
          setFleetTotals(totals);
          setDataRetrievedAt(retrievedAt);
        }
      } catch {
        /* server snapshot unavailable — user can refresh manually */
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
