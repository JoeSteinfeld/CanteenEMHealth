import { useMemo, useRef, useState } from "react";
import { formatShortChartDate } from "./healthSummaryTrends";

type LineChartProps = {
  points: { at: number; value: number }[];
  valueSuffix?: string;
  valueLabel?: string;
  height?: number;
  minValue?: number;
  maxValue?: number;
  ariaLabel: string;
  interactive?: boolean;
};

type BarChartProps = {
  points: { at: number; value: number }[];
  height?: number;
  ariaLabel: string;
  interactive?: boolean;
  valueLabel?: string;
};

type ComboChartProps = {
  linePoints: { at: number; value: number }[];
  stackPoints: {
    at: number;
    totalSensors: number;
    connectedLast7Days: number;
    notConnected7Days: number;
    neverConnected: number;
  }[];
  height?: number;
  ariaLabel: string;
};

const STACK_SEGMENTS = [
  { key: "connectedLast7Days" as const, label: "Connected", className: "trend-chart-stack-connected" },
  { key: "notConnected7Days" as const, label: "Not conn. 7d", className: "trend-chart-stack-not-connected" },
  { key: "neverConnected" as const, label: "never conn.", className: "trend-chart-stack-never" },
];

function stackSegmentHeight(value: number, totalSensors: number, totalBarH: number): number {
  if (totalSensors <= 0 || totalBarH <= 0) return 0;
  return (value / totalSensors) * totalBarH;
}

const CHART_WIDTH = 560;

function formatCompactCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) {
    const k = n / 1000;
    const rounded = Math.round(k * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}K` : `${rounded.toFixed(1)}K`;
  }
  return String(Math.round(n));
}

function buildCountYTicks(maxValue: number): number[] {
  const max = Math.max(maxValue, 1);
  let step = 500;
  if (max <= 500) step = 100;
  else if (max <= 1500) step = 500;
  else if (max <= 4000) step = 1000;
  else step = Math.ceil(max / 4 / 1000) * 1000;

  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

function buildYTicks(yMin: number, yMax: number, suffix: string): number[] {
  if (suffix !== "%") return [yMin, yMax];
  const lo = Math.floor(yMin);
  const hi = Math.ceil(yMax);
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += 1) ticks.push(v);
  return ticks.length >= 2 ? ticks : [yMin, yMax];
}

function pickNearestIndex(
  clientX: number,
  wrapEl: HTMLDivElement,
  pointCount: number,
  padLeft: number,
  innerW: number,
): number | null {
  if (pointCount <= 0) return null;
  const rect = wrapEl.getBoundingClientRect();
  const relX = ((clientX - rect.left) / rect.width) * CHART_WIDTH;
  const chartX = relX - padLeft;
  if (chartX < 0 || chartX > innerW) return null;
  if (pointCount === 1) return 0;
  const ratio = chartX / innerW;
  const idx = Math.round(ratio * (pointCount - 1));
  return Math.max(0, Math.min(pointCount - 1, idx));
}

type ChartTooltipProps = {
  date: number;
  label: string;
  value: string;
  leftPct: number;
  topPct: number;
  onRight: boolean;
  swatchClassName: string;
};

function ChartTooltip({ date, label, value, leftPct, topPct, onRight, swatchClassName }: ChartTooltipProps) {
  return (
    <div
      className={`trend-chart-tooltip${onRight ? " trend-chart-tooltip-right" : " trend-chart-tooltip-left"}`}
      style={{ left: `${leftPct}%`, top: `${topPct}%` }}
      role="tooltip"
    >
      <div className="trend-chart-tooltip-date">{formatShortChartDate(date)}</div>
      <div className="trend-chart-tooltip-row">
        <span className="trend-chart-tooltip-legend">
          <span className={`trend-chart-tooltip-swatch ${swatchClassName}`} aria-hidden />
          {label}
        </span>
        <span className="trend-chart-tooltip-value">{value}</span>
      </div>
    </div>
  );
}

type ComboTooltipProps = {
  date: number;
  rows: { label: string; value: string; swatchClassName: string }[];
  barRows?: { label: string; value: string; swatchClassName: string }[];
  leftPct: number;
  topPct: number;
  onRight: boolean;
};

function ComboTooltip({ date, rows, barRows = [], leftPct, topPct, onRight }: ComboTooltipProps) {
  return (
    <div
      className={`trend-chart-tooltip trend-chart-tooltip-combo${onRight ? " trend-chart-tooltip-right" : " trend-chart-tooltip-left"}`}
      style={{ left: `${leftPct}%`, top: `${topPct}%` }}
      role="tooltip"
    >
      <div className="trend-chart-tooltip-date">{formatShortChartDate(date)}</div>
      {rows.map((row) => (
        <div key={row.label} className="trend-chart-tooltip-row">
          <span className="trend-chart-tooltip-legend">
            <span className={`trend-chart-tooltip-swatch ${row.swatchClassName}`} aria-hidden />
            {row.label}
          </span>
          <span className="trend-chart-tooltip-value">{row.value}</span>
        </div>
      ))}
      {barRows.length > 0 && <div className="trend-chart-tooltip-divider" />}
      {barRows.map((row) => (
        <div key={row.label} className="trend-chart-tooltip-row">
          <span className="trend-chart-tooltip-legend">
            <span className={`trend-chart-tooltip-swatch ${row.swatchClassName}`} aria-hidden />
            {row.label}
          </span>
          <span className="trend-chart-tooltip-value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function TrendLineChart({
  points,
  valueSuffix = "",
  valueLabel = "Value",
  height = 200,
  minValue,
  maxValue,
  ariaLabel,
  interactive = false,
}: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const layout = useMemo(() => {
    const pad = { top: 20, right: 24, bottom: 32, left: 44 };
    const innerW = CHART_WIDTH - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const values = points.map((p) => p.value);
    const autoMin = Math.min(...values);
    const autoMax = Math.max(...values);
    let yMin = minValue ?? autoMin - Math.max(0.5, (autoMax - autoMin) * 0.1);
    let yMax = maxValue ?? autoMax + Math.max(0.5, (autoMax - autoMin) * 0.1);
    if (valueSuffix === "%") {
      yMin = minValue ?? Math.floor(autoMin - 0.5);
      yMax = maxValue ?? Math.ceil(autoMax + 0.5);
      if (yMax - yMin < 2) {
        yMin = Math.floor(autoMin) - 1;
        yMax = Math.ceil(autoMax) + 1;
      }
    }
    const yRange = yMax - yMin || 1;

    const coords = points.map((p, i) => {
      const x = pad.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
      const y = pad.top + innerH - ((p.value - yMin) / yRange) * innerH;
      return { x, y, ...p };
    });

    const yTicks = buildYTicks(yMin, yMax, valueSuffix);

    return { pad, innerW, innerH, yMin, yMax, yRange, coords, yTicks };
  }, [points, height, minValue, maxValue, valueSuffix]);

  if (points.length === 0) return null;

  const { pad, innerW, innerH, yMin, yMax, coords, yTicks } = layout;
  const polyline = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const active = hoverIndex != null ? coords[hoverIndex] : null;

  const handleMouseMove = (clientX: number) => {
    if (!interactive || !wrapRef.current) return;
    setHoverIndex(pickNearestIndex(clientX, wrapRef.current, points.length, pad.left, innerW));
  };

  const tooltipLeftPct = active ? (active.x / CHART_WIDTH) * 100 : 0;
  const tooltipTopPct = active ? (active.y / height) * 100 : 0;
  const tooltipOnRight = active ? active.x < CHART_WIDTH * 0.55 : true;

  return (
    <div
      ref={wrapRef}
      className={`trend-chart-wrap trend-chart-surface${interactive ? " trend-chart-wrap-interactive" : ""}`}
      onMouseMove={(e) => handleMouseMove(e.clientX)}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <svg
        className="trend-chart"
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
      >
        {yTicks.map((tick) => {
          const y = pad.top + innerH - ((tick - yMin) / (yMax - yMin || 1)) * innerH;
          return (
            <g key={tick}>
              <line x1={pad.left} y1={y} x2={pad.left + innerW} y2={y} className="trend-chart-grid" />
              <text x={pad.left - 8} y={y + 3} textAnchor="end" className="trend-chart-label">
                {valueSuffix === "%" ? `${tick}%` : `${tick.toFixed(1)}${valueSuffix}`}
              </text>
            </g>
          );
        })}

        <line
          x1={pad.left}
          y1={pad.top + innerH}
          x2={pad.left + innerW}
          y2={pad.top + innerH}
          className="trend-chart-axis"
        />

        {coords.map((c) => (
          <text key={`x-${c.at}`} x={c.x} y={height - 10} textAnchor="middle" className="trend-chart-label">
            {formatShortChartDate(c.at)}
          </text>
        ))}

        <polyline points={polyline} className="trend-chart-line" fill="none" />

        {active && (
          <line
            x1={active.x}
            y1={pad.top}
            x2={active.x}
            y2={pad.top + innerH}
            className="trend-chart-crosshair trend-chart-crosshair-line"
          />
        )}

        {coords.map((c, i) => (
          <circle
            key={c.at}
            cx={c.x}
            cy={c.y}
            r={hoverIndex === i ? 5 : 4}
            className={`trend-chart-dot${hoverIndex === i ? " trend-chart-dot-active" : ""}`}
          />
        ))}
      </svg>

      {interactive && active && (
        <ChartTooltip
          date={active.at}
          label={valueLabel}
          value={`${active.value.toFixed(1)}${valueSuffix}`}
          leftPct={tooltipLeftPct}
          topPct={tooltipTopPct}
          onRight={tooltipOnRight}
          swatchClassName="trend-chart-tooltip-swatch-line"
        />
      )}
    </div>
  );
}

export function TrendBarChart({
  points,
  height = 128,
  ariaLabel,
  interactive = true,
  valueLabel = "Connected",
}: BarChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const layout = useMemo(() => {
    const pad = { top: 18, right: 24, bottom: 22, left: 44 };
    const innerW = CHART_WIDTH - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const maxValue = Math.max(...points.map((p) => p.value), 1);
    const yTicks = buildCountYTicks(maxValue);
    const yMax = yTicks[yTicks.length - 1] || maxValue;
    const barW = points.length === 1 ? 52 : Math.min(52, innerW / Math.max(points.length * 1.45, 2));
    const barInset = barW / 2 + 12;
    const plotStart = pad.left + barInset;
    const plotW = Math.max(0, innerW - 2 * barInset);

    const coords = points.map((p, i) => {
      const xCenter =
        plotStart + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
      const barH = (p.value / yMax) * innerH;
      const y = pad.top + innerH - barH;
      return { xCenter, y, barH, ...p };
    });

    return { pad, innerW, innerH, yMax, yTicks, barW, coords, plotStart, plotW };
  }, [points, height]);

  if (points.length === 0) return null;

  const { pad, innerW, innerH, yMax, yTicks, barW, coords, plotStart, plotW } = layout;
  const active = hoverIndex != null ? coords[hoverIndex] : null;

  const handleMouseMove = (clientX: number) => {
    if (!interactive || !wrapRef.current) return;
    setHoverIndex(pickNearestIndex(clientX, wrapRef.current, points.length, plotStart, plotW));
  };

  const tooltipLeftPct = active ? (active.xCenter / CHART_WIDTH) * 100 : 0;
  const tooltipTopPct = active ? (active.y / height) * 100 : 0;
  const tooltipOnRight = active ? active.xCenter < CHART_WIDTH * 0.55 : true;

  return (
    <div
      ref={wrapRef}
      className={`trend-chart-wrap trend-chart-surface${interactive ? " trend-chart-wrap-interactive" : ""}`}
      onMouseMove={(e) => handleMouseMove(e.clientX)}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <svg
        className="trend-chart"
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
      >
        {yTicks.map((tick) => {
          const y = pad.top + innerH - (tick / yMax) * innerH;
          return (
            <g key={tick}>
              <line x1={pad.left} y1={y} x2={pad.left + innerW} y2={y} className="trend-chart-grid" />
              <text x={pad.left - 8} y={y + 3} textAnchor="end" className="trend-chart-label">
                {formatCompactCount(tick)}
              </text>
            </g>
          );
        })}

        <line
          x1={pad.left}
          y1={pad.top + innerH}
          x2={pad.left + innerW}
          y2={pad.top + innerH}
          className="trend-chart-axis"
        />

        {active && (
          <line
            x1={active.xCenter}
            y1={pad.top}
            x2={active.xCenter}
            y2={pad.top + innerH}
            className="trend-chart-crosshair trend-chart-crosshair-bar"
          />
        )}

        {coords.map((c, i) => {
          const x = c.xCenter - barW / 2;
          const isActive = hoverIndex === i;
          return (
            <g key={c.at}>
              <rect
                x={x}
                y={c.y}
                width={barW}
                height={c.barH}
                className={`trend-chart-bar${isActive ? " trend-chart-bar-active" : ""}`}
                rx={4}
              />
              <text x={c.xCenter} y={c.y - 4} textAnchor="middle" className="trend-chart-bar-value">
                {formatCompactCount(c.value)}
              </text>
              <text x={c.xCenter} y={height - 8} textAnchor="middle" className="trend-chart-label">
                {formatShortChartDate(c.at)}
              </text>
            </g>
          );
        })}
      </svg>

      {interactive && active && (
        <ChartTooltip
          date={active.at}
          label={valueLabel}
          value={active.value.toLocaleString()}
          leftPct={tooltipLeftPct}
          topPct={tooltipTopPct}
          onRight={tooltipOnRight}
          swatchClassName="trend-chart-tooltip-swatch-bar"
        />
      )}
    </div>
  );
}

export function TrendOrgComboChart({
  linePoints,
  stackPoints,
  height = 156,
  ariaLabel,
}: ComboChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const pointCount = Math.min(linePoints.length, stackPoints.length);

  const layout = useMemo(() => {
    const pad = { top: 24, right: 52, bottom: 22, left: 44 };
    const innerW = CHART_WIDTH - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const pctValues = linePoints.slice(0, pointCount).map((p) => p.value);
    const pctMinRaw = pctValues.length ? Math.min(...pctValues) : 0;
    const pctMaxRaw = pctValues.length ? Math.max(...pctValues) : 100;
    let pctMin = Math.floor(pctMinRaw - 0.5);
    let pctMax = Math.ceil(pctMaxRaw + 0.5);
    if (pctMax - pctMin < 2) {
      pctMin = Math.floor(pctMinRaw) - 1;
      pctMax = Math.ceil(pctMaxRaw) + 1;
    }
    const pctRange = pctMax - pctMin || 1;
    const pctTicks = buildYTicks(pctMin, pctMax, "%");

    const totalValues = stackPoints.slice(0, pointCount).map((p) => p.totalSensors);
    const countMaxValue = Math.max(...totalValues, 1);
    const countTicks = buildCountYTicks(countMaxValue);
    const countMax = countTicks[countTicks.length - 1] || countMaxValue;

    const barW =
      pointCount === 1 ? 52 : Math.min(52, innerW / Math.max(pointCount * 1.45, 2));
    const barInset = barW / 2 + 12;
    const plotStart = pad.left + barInset;
    const plotW = Math.max(0, innerW - 2 * barInset);
    const baselineY = pad.top + innerH;

    const coords = Array.from({ length: pointCount }, (_, i) => {
      const xCenter =
        plotStart + (pointCount === 1 ? plotW / 2 : (i / (pointCount - 1)) * plotW);
      const stack = stackPoints[i];
      const pct = linePoints[i]?.value ?? 0;
      const at = linePoints[i]?.at ?? stack?.at ?? 0;
      const lineY = pad.top + innerH - ((pct - pctMin) / pctRange) * innerH;
      const totalSensors = stack?.totalSensors ?? 0;
      const totalBarH = countMax > 0 ? (totalSensors / countMax) * innerH : 0;
      const stackTopY = baselineY - totalBarH;

      const segments = STACK_SEGMENTS.map((seg) => {
        const value = stack?.[seg.key] ?? 0;
        const segH = stackSegmentHeight(value, totalSensors, totalBarH);
        return { ...seg, value, segH };
      });

      let segY = baselineY;
      const segmentRects = segments
        .filter((seg) => seg.segH > 0)
        .map((seg) => {
          segY -= seg.segH;
          return { ...seg, y: segY };
        });

      return {
        xCenter,
        lineY,
        stackTopY,
        totalBarH,
        pct,
        at,
        totalSensors,
        connectedLast7Days: stack?.connectedLast7Days ?? 0,
        notConnected7Days: stack?.notConnected7Days ?? 0,
        neverConnected: stack?.neverConnected ?? 0,
        segmentRects,
      };
    });

    return {
      pad,
      innerW,
      innerH,
      pctMin,
      pctMax,
      pctTicks,
      countTicks,
      countMax,
      barW,
      coords,
      plotStart,
      plotW,
      baselineY,
    };
  }, [linePoints, stackPoints, pointCount, height]);

  if (pointCount === 0) return null;

  const {
    pad,
    innerW,
    innerH,
    pctMin,
    pctMax,
    pctTicks,
    countTicks,
    countMax,
    barW,
    coords,
    plotStart,
    plotW,
    baselineY,
  } = layout;
  const active = hoverIndex != null ? coords[hoverIndex] : null;
  const polyline = coords.map((c) => `${c.xCenter},${c.lineY}`).join(" ");

  const handleMouseMove = (clientX: number) => {
    if (!wrapRef.current) return;
    setHoverIndex(pickNearestIndex(clientX, wrapRef.current, pointCount, plotStart, plotW));
  };

  const tooltipLeftPct = active ? (active.xCenter / CHART_WIDTH) * 100 : 0;
  const tooltipTopPct = active ? (Math.min(active.lineY, active.stackTopY) / height) * 100 : 0;
  const tooltipOnRight = active ? active.xCenter < CHART_WIDTH * 0.55 : true;

  return (
    <div
      ref={wrapRef}
      className="trend-chart-wrap trend-chart-surface trend-chart-wrap-interactive"
      onMouseMove={(e) => handleMouseMove(e.clientX)}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <svg
        className="trend-chart"
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
      >
        {countTicks.map((tick) => {
          const y = pad.top + innerH - (tick / countMax) * innerH;
          return (
            <line
              key={`grid-${tick}`}
              x1={pad.left}
              y1={y}
              x2={pad.left + innerW}
              y2={y}
              className="trend-chart-grid"
            />
          );
        })}

        {pctTicks.map((tick) => {
          const y = pad.top + innerH - ((tick - pctMin) / (pctMax - pctMin || 1)) * innerH;
          return (
            <line
              key={`pct-grid-${tick}`}
              x1={pad.left}
              y1={y}
              x2={pad.left + innerW}
              y2={y}
              className="trend-chart-grid-pct"
            />
          );
        })}

        {pctTicks.map((tick) => {
          const y = pad.top + innerH - ((tick - pctMin) / (pctMax - pctMin || 1)) * innerH;
          return (
            <text
              key={`pct-${tick}`}
              x={pad.left + innerW + 8}
              y={y + 3}
              textAnchor="start"
              className="trend-chart-label trend-chart-label-right"
            >
              {tick}%
            </text>
          );
        })}

        {countTicks.map((tick) => {
          const y = pad.top + innerH - (tick / countMax) * innerH;
          return (
            <text key={`count-${tick}`} x={pad.left - 8} y={y + 3} textAnchor="end" className="trend-chart-label">
              {formatCompactCount(tick)}
            </text>
          );
        })}

        <line
          x1={pad.left}
          y1={baselineY}
          x2={pad.left + innerW}
          y2={baselineY}
          className="trend-chart-axis"
        />

        {coords.map((c) => (
          <text key={`x-${c.at}`} x={c.xCenter} y={height - 8} textAnchor="middle" className="trend-chart-label">
            {formatShortChartDate(c.at)}
          </text>
        ))}

        {coords.map((c, i) => {
          const x = c.xCenter - barW / 2;
          const isActive = hoverIndex === i;
          const stackBottom = baselineY - c.totalBarH;
          return (
            <g
              key={`stack-${c.at}`}
              className={`trend-chart-stack${isActive ? " trend-chart-stack-active" : ""}`}
            >
              {c.totalBarH > 0 && (
                <rect
                  x={x}
                  y={stackBottom}
                  width={barW}
                  height={c.totalBarH}
                  className="trend-chart-stack-total"
                  rx={3}
                />
              )}
              {c.segmentRects.map((seg) => (
                <rect
                  key={`${c.at}-${seg.key}`}
                  x={x}
                  y={seg.y}
                  width={barW}
                  height={seg.segH}
                  className={seg.className}
                  rx={0}
                />
              ))}
              {c.totalBarH > 0 && (
                <text x={c.xCenter} y={c.stackTopY - 4} textAnchor="middle" className="trend-chart-bar-value">
                  {formatCompactCount(c.totalSensors)}
                </text>
              )}
            </g>
          );
        })}

        <polyline points={polyline} className="trend-chart-line" fill="none" />

        {active && (
          <line
            x1={active.xCenter}
            y1={pad.top}
            x2={active.xCenter}
            y2={baselineY}
            className="trend-chart-crosshair trend-chart-crosshair-combo"
          />
        )}

        {coords.map((c, i) => (
          <circle
            key={`dot-${c.at}`}
            cx={c.xCenter}
            cy={c.lineY}
            r={hoverIndex === i ? 5 : 4}
            className={`trend-chart-dot${hoverIndex === i ? " trend-chart-dot-active" : ""}`}
          />
        ))}
      </svg>

      {active && (
        <ComboTooltip
          date={active.at}
          rows={[
            {
              label: "% healthy",
              value: `${active.pct.toFixed(1)}%`,
              swatchClassName: "trend-chart-tooltip-swatch-line",
            },
          ]}
          barRows={[
            {
              label: "Total sensors",
              value: active.totalSensors.toLocaleString(),
              swatchClassName: "trend-chart-tooltip-swatch-total",
            },
            {
              label: "Connected",
              value: active.connectedLast7Days.toLocaleString(),
              swatchClassName: "trend-chart-tooltip-swatch-connected",
            },
            {
              label: "Not conn. 7d",
              value: active.notConnected7Days.toLocaleString(),
              swatchClassName: "trend-chart-tooltip-swatch-not-connected",
            },
            {
              label: "never conn.",
              value: active.neverConnected.toLocaleString(),
              swatchClassName: "trend-chart-tooltip-swatch-never",
            },
          ]}
          leftPct={tooltipLeftPct}
          topPct={tooltipTopPct}
          onRight={tooltipOnRight}
        />
      )}
    </div>
  );
}
