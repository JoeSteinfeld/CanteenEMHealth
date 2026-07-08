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
import {
  emptySummaryColumnSearch,
  type FleetHealthTotals,
  type TagHealthSummaryRow,
  type TagHealthSummarySortKey,
} from "./sensorHealth";
import { loadPersistedHealthSummary, savePersistedHealthSummary } from "./healthSummaryStorage";

type SortDir = "asc" | "desc";

type HealthSummaryCacheValue = {
  summaryRows: TagHealthSummaryRow[] | null;
  fleetTotals: FleetHealthTotals | null;
  dataRetrievedAt: number | null;
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

function initialCacheState() {
  const saved = loadPersistedHealthSummary();
  if (!saved) {
    return {
      summaryRows: null as TagHealthSummaryRow[] | null,
      fleetTotals: null as FleetHealthTotals | null,
      dataRetrievedAt: null as number | null,
      sortKey: "tagName" as TagHealthSummarySortKey,
      sortDir: "asc" as SortDir,
      columnSearch: emptySummaryColumnSearch(),
    };
  }
  return {
    summaryRows: saved.summaryRows,
    fleetTotals: saved.fleetTotals,
    dataRetrievedAt: saved.dataRetrievedAt,
    sortKey: saved.sortKey,
    sortDir: saved.sortDir,
    columnSearch: saved.columnSearch,
  };
}

export function HealthSummaryCacheProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(initialCacheState);
  const [summaryRows, setSummaryRows] = useState<TagHealthSummaryRow[] | null>(initial.summaryRows);
  const [fleetTotals, setFleetTotals] = useState<FleetHealthTotals | null>(initial.fleetTotals);
  const [dataRetrievedAt, setDataRetrievedAt] = useState<number | null>(initial.dataRetrievedAt);
  const [sortKey, setSortKey] = useState<TagHealthSummarySortKey>(initial.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(initial.sortDir);
  const [columnSearch, setColumnSearch] = useState(initial.columnSearch);

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
    [summaryRows, fleetTotals, dataRetrievedAt, sortKey, sortDir, columnSearch],
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
