import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "./auth";
import { parseJsonSafe } from "./apiUtils";
import { useHealthSummaryCache } from "./healthSummaryCache";
import type { HealthSummaryTrendsResponse, TrendsCompareMode } from "./healthSummaryTrends";
import { isHealthSummaryTrendsResponse, loadPersistedTrends, savePersistedTrends } from "./trendsStorage";

const DEFAULT_MODE: TrendsCompareMode = "baseline";
/** Max stacks/points on Org health over time; denser ranges are evenly sampled. */
const HISTORY_LIMIT = 14;

type TrendsCacheValue = {
  compareMode: TrendsCompareMode;
  startDate: string;
  endDate: string;
  data: HealthSummaryTrendsResponse | null;
  loading: boolean;
  error: string | null;
  setCompareMode: (mode: TrendsCompareMode) => void;
  setStartDate: (ymd: string) => void;
  setEndDate: (ymd: string) => void;
  reloadTrends: () => Promise<void>;
};

const TrendsCacheContext = createContext<TrendsCacheValue | null>(null);

function ymdOrEmpty(value: string | null | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

export function TrendsCacheProvider({ children }: { children: ReactNode }) {
  const persisted = loadPersistedTrends();
  const { dataRetrievedAt } = useHealthSummaryCache();
  const [compareMode, setCompareModeState] = useState<TrendsCompareMode>(
    persisted?.compareMode ?? DEFAULT_MODE,
  );
  const [startDate, setStartDateState] = useState(ymdOrEmpty(persisted?.startDate));
  const [endDate, setEndDateState] = useState(ymdOrEmpty(persisted?.endDate));
  const [data, setData] = useState<HealthSummaryTrendsResponse | null>(persisted?.data ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastFetchedForAt = useRef<number | null>(null);
  const fetchId = useRef(0);
  const startDateRef = useRef(startDate);
  const endDateRef = useRef(endDate);
  startDateRef.current = startDate;
  endDateRef.current = endDate;

  const fetchTrends = useCallback(
    async (
      mode: TrendsCompareMode,
      range: { startDate: string; endDate: string },
      { silent = false } = {},
    ) => {
      const id = ++fetchId.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          mode,
          historyLimit: String(HISTORY_LIMIT),
        });
        if (mode === "dates") {
          if (range.startDate) params.set("startDate", range.startDate);
          if (range.endDate) params.set("endDate", range.endDate);
        }
        const r = await apiFetch(`/api/health-summary/trends?${params.toString()}`);
        const j = (await parseJsonSafe(r)) as HealthSummaryTrendsResponse & { error?: string };
        if (fetchId.current !== id) return;
        if (!r.ok) throw new Error(j.error || r.statusText);
        if (!isHealthSummaryTrendsResponse(j)) throw new Error("Invalid trends response");
        setData(j);
        if (mode === "dates") {
          const nextStart = ymdOrEmpty(j.startDate) || range.startDate || ymdOrEmpty(j.availableStartDate);
          const nextEnd = ymdOrEmpty(j.endDate) || range.endDate || ymdOrEmpty(j.availableEndDate);
          if (nextStart && nextStart !== startDateRef.current) setStartDateState(nextStart);
          if (nextEnd && nextEnd !== endDateRef.current) setEndDateState(nextEnd);
          savePersistedTrends(mode, nextStart || null, nextEnd || null, j);
        } else {
          savePersistedTrends(mode, range.startDate || null, range.endDate || null, j);
        }
      } catch (e) {
        if (fetchId.current !== id) return;
        setError(e instanceof Error ? e.message : "Failed to load trends");
      } finally {
        if (fetchId.current === id && !silent) setLoading(false);
      }
    },
    [],
  );

  const reloadTrends = useCallback(async () => {
    await fetchTrends(compareMode, { startDate, endDate });
  }, [compareMode, startDate, endDate, fetchTrends]);

  const setCompareMode = useCallback((mode: TrendsCompareMode) => {
    setCompareModeState(mode);
  }, []);

  const setStartDate = useCallback((ymd: string) => {
    setStartDateState(ymd);
  }, []);

  const setEndDate = useCallback((ymd: string) => {
    setEndDateState(ymd);
  }, []);

  useEffect(() => {
    if (compareMode === "dates") {
      void fetchTrends("dates", { startDate, endDate });
      return;
    }
    void fetchTrends("baseline", { startDate: "", endDate: "" });
  }, [compareMode, startDate, endDate, fetchTrends]);

  useEffect(() => {
    if (dataRetrievedAt == null) return;
    if (lastFetchedForAt.current === dataRetrievedAt) return;
    lastFetchedForAt.current = dataRetrievedAt;
    if (compareMode === "dates") {
      void fetchTrends("dates", { startDate, endDate }, { silent: data?.canCompare === true });
      return;
    }
    void fetchTrends("baseline", { startDate: "", endDate: "" }, { silent: data?.canCompare === true });
  }, [dataRetrievedAt, compareMode, startDate, endDate, fetchTrends, data?.canCompare]);

  const value = useMemo(
    () => ({
      compareMode,
      startDate,
      endDate,
      data,
      loading,
      error,
      setCompareMode,
      setStartDate,
      setEndDate,
      reloadTrends,
    }),
    [
      compareMode,
      startDate,
      endDate,
      data,
      loading,
      error,
      setCompareMode,
      setStartDate,
      setEndDate,
      reloadTrends,
    ],
  );

  return <TrendsCacheContext.Provider value={value}>{children}</TrendsCacheContext.Provider>;
}

export function useTrendsCache(): TrendsCacheValue {
  const ctx = useContext(TrendsCacheContext);
  if (!ctx) {
    throw new Error("useTrendsCache must be used within TrendsCacheProvider");
  }
  return ctx;
}
