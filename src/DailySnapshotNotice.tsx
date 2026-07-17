import { useEffect, useState } from "react";
import { apiFetch } from "./auth";
import { parseJsonSafe } from "./apiUtils";

type ScheduleInfo = {
  timezone: string;
  dailyAtLabel: string;
  nextScheduledAt: number;
  latestSnapshotAt: number | null;
  hasSnapshotForToday: boolean;
};

function formatScheduleWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function DailySnapshotNotice() {
  const [info, setInfo] = useState<ScheduleInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiFetch("/api/health-summary/schedule");
        const j = (await parseJsonSafe(r)) as ScheduleInfo & { error?: string };
        if (cancelled || !r.ok) return;
        if (
          typeof j.nextScheduledAt === "number" &&
          typeof j.dailyAtLabel === "string" &&
          typeof j.timezone === "string"
        ) {
          setInfo({
            timezone: j.timezone,
            dailyAtLabel: j.dailyAtLabel,
            nextScheduledAt: j.nextScheduledAt,
            latestSnapshotAt: typeof j.latestSnapshotAt === "number" ? j.latestSnapshotAt : null,
            hasSnapshotForToday: Boolean(j.hasSnapshotForToday),
          });
        }
      } catch {
        /* banner stays on static fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <p className="daily-snapshot-notice" role="status">
      Automatic health summary snapshots run daily at <strong>12:00 AM EDT</strong>
      {info ? (
        <>
          {" "}
          ({info.dailyAtLabel}). Next scheduled:{" "}
          <time dateTime={new Date(info.nextScheduledAt).toISOString()}>
            {formatScheduleWhen(info.nextScheduledAt)}
          </time>
          {info.latestSnapshotAt != null && (
            <>
              {" "}
              · Latest saved:{" "}
              <time dateTime={new Date(info.latestSnapshotAt).toISOString()}>
                {formatScheduleWhen(info.latestSnapshotAt)}
              </time>
              {info.hasSnapshotForToday ? " (today)" : ""}
            </>
          )}
          .
        </>
      ) : (
        <> (America/New_York). Keep the API server running so the daily job can save.</>
      )}
    </p>
  );
}
