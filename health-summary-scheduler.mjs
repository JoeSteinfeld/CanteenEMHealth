/** Eastern Time — EDT/EST via IANA zone (user-facing label: 12:00 AM EDT). */
export const HEALTH_SUMMARY_SNAPSHOT_TZ = "America/New_York";
export const HEALTH_SUMMARY_SNAPSHOT_LABEL = "12:00 AM Eastern Time (EDT/EST)";

const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * @param {number} ms
 * @param {string} timeZone
 */
export function getZonedYmd(ms, timeZone = HEALTH_SUMMARY_SNAPSHOT_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * @param {number} ms
 * @param {string} timeZone
 */
function getZonedHms(ms, timeZone = HEALTH_SUMMARY_SNAPSHOT_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Next calendar YMD after `ymd` (YYYY-MM-DD), date-arithmetic in UTC components. */
function nextYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * UTC ms of local midnight for `ymd` in America/New_York.
 * @param {string} ymd YYYY-MM-DD
 */
export function utcMsAtZoneMidnight(ymd, timeZone = HEALTH_SUMMARY_SNAPSHOT_TZ) {
  const [y, m, d] = ymd.split("-").map(Number);
  const lo = Date.UTC(y, m - 1, d) - 6 * 60 * 60 * 1000;
  const hi = Date.UTC(y, m - 1, d) + 6 * 60 * 60 * 1000;
  for (let t = lo; t <= hi; t += 60 * 1000) {
    if (getZonedYmd(t, timeZone) === ymd && getZonedHms(t, timeZone) === "00:00:00") {
      return t;
    }
  }
  for (let t = lo; t <= hi; t += 60 * 1000) {
    if (getZonedYmd(t, timeZone) === ymd) return t;
  }
  throw new Error(`Could not resolve midnight for ${ymd} in ${timeZone}`);
}

/**
 * @param {number} [fromMs]
 * @returns {number} UTC ms of the next 12:00 AM Eastern
 */
export function nextEasternMidnightUtc(fromMs = Date.now()) {
  const today = getZonedYmd(fromMs);
  const tomorrow = nextYmd(today);
  let next = utcMsAtZoneMidnight(tomorrow);
  if (next <= fromMs) {
    next = utcMsAtZoneMidnight(nextYmd(tomorrow));
  }
  return next;
}

/**
 * @param {{ dataRetrievedAt: number } | null | undefined} snapshot
 * @param {number} [nowMs]
 */
export function snapshotCoversEasternDay(snapshot, nowMs = Date.now()) {
  if (!snapshot || !Number.isFinite(snapshot.dataRetrievedAt)) return false;
  return getZonedYmd(snapshot.dataRetrievedAt) === getZonedYmd(nowMs);
}

/**
 * Public schedule payload for Health Summary / Trends UI.
 * @param {{ getLatestSnapshot: () => { dataRetrievedAt: number } | null }} store
 */
export function getHealthSummaryScheduleInfo(store) {
  const now = Date.now();
  const nextScheduledAt = nextEasternMidnightUtc(now);
  const latest = store.getLatestSnapshot?.() ?? null;
  return {
    timezone: HEALTH_SUMMARY_SNAPSHOT_TZ,
    dailyAtLabel: HEALTH_SUMMARY_SNAPSHOT_LABEL,
    nextScheduledAt,
    latestSnapshotAt: latest?.dataRetrievedAt ?? null,
    hasSnapshotForToday: snapshotCoversEasternDay(latest, now),
  };
}

/**
 * Schedules a daily health-summary snapshot at 12:00 AM Eastern.
 * On startup, runs once if today's Eastern day has no snapshot yet (catch-up).
 *
 * @param {{
 *   hasToken: () => boolean,
 *   runSnapshot: () => Promise<unknown>,
 *   getLatestSnapshot: () => { dataRetrievedAt: number } | null,
 *   log?: (msg: string) => void,
 * }} options
 */
export function startDailyHealthSummaryScheduler(options) {
  const log = options.log ?? ((msg) => console.log(msg));
  let timer = null;
  let running = false;

  async function runJob(reason) {
    if (running) {
      log(`Health summary daily snapshot skipped (${reason}): already running`);
      return;
    }
    if (!options.hasToken()) {
      log(`Health summary daily snapshot skipped (${reason}): SAMSARA_API_TOKEN not set`);
      return;
    }
    running = true;
    try {
      log(`Health summary daily snapshot starting (${reason})…`);
      await options.runSnapshot();
      log(`Health summary daily snapshot saved (${reason})`);
    } catch (e) {
      console.error(
        `Health summary daily snapshot failed (${reason}):`,
        e instanceof Error ? e.message : e,
      );
    } finally {
      running = false;
    }
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    const now = Date.now();
    const nextAt = nextEasternMidnightUtc(now);
    const delay = Math.max(1000, nextAt - now);
    log(
      `Health summary next daily snapshot at ${new Date(nextAt).toISOString()} (in ${Math.round(delay / 60000)} min, ${HEALTH_SUMMARY_SNAPSHOT_LABEL})`,
    );
    timer = setTimeout(() => {
      void (async () => {
        await runJob("scheduled-midnight-eastern");
        scheduleNext();
      })();
    }, delay);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  }

  async function maybeCatchUp() {
    const latest = options.getLatestSnapshot();
    if (snapshotCoversEasternDay(latest)) {
      log("Health summary daily snapshot: today's Eastern day already has a snapshot");
      return;
    }
    await runJob("startup-catch-up");
  }

  void (async () => {
    await maybeCatchUp();
    scheduleNext();
  })();

  return {
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Keep unused constant referenced for callers that want a soft upper bound. */
export const HEALTH_SUMMARY_SCHEDULER_MAX_DRIFT_MS = DAY_MS;
