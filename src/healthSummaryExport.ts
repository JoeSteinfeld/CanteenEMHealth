import { formatAvgTemp30d, formatPctHealthy, type FleetHealthTotals, type TagHealthSummaryRow } from "./sensorHealth";

function escapeCsvField(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\r") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: (string | number)[]): string {
  return values.map((v) => escapeCsvField(String(v))).join(",");
}

function fileStampForExport(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatLastRefreshedForExport(at: number): string {
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

export function buildHealthSummaryExportCsv(
  fleetTotals: FleetHealthTotals,
  tagRows: TagHealthSummaryRow[],
  dataRetrievedAt: number,
): string {
  const lines: string[] = [
    csvRow(["Last refreshed", formatLastRefreshedForExport(dataRetrievedAt)]),
    "",
    csvRow([
      "Org Summary",
      "Total sensors",
      "Connected in last 7 days",
      "Not connected in last 7 days",
      "Never connected",
      "% healthy",
      "Avg Cooler Temp (30d) — connected in last 7 days only",
      "Avg Freezer Temp (30d) — connected in last 7 days only",
    ]),
    csvRow([
      "Org Summary",
      fleetTotals.totalSensors,
      fleetTotals.connectedLast7Days,
      fleetTotals.notConnected7Days,
      fleetTotals.neverConnected,
      formatPctHealthy(fleetTotals.pctHealthy),
      formatAvgTemp30d(fleetTotals.avgCoolerTemp30d),
      formatAvgTemp30d(fleetTotals.avgFreezerTemp30d),
    ]),
    "",
    csvRow(["Tag Summary"]),
    csvRow([
      "Tag name",
      "Number of sensors",
      "Connected in last 7 days",
      "Not connected 7 days",
      "Never connected",
      "% healthy",
      "Avg Cooler Temp (30d) — connected in last 7 days only",
      "Avg Freezer Temp (30d) — connected in last 7 days only",
    ]),
  ];

  for (const row of tagRows) {
    lines.push(
      csvRow([
        row.tagName,
        row.totalSensors,
        row.connectedLast7Days,
        row.notConnected7Days,
        row.neverConnected,
        formatPctHealthy(row.pctHealthy),
        formatAvgTemp30d(row.avgCoolerTemp30d),
        formatAvgTemp30d(row.avgFreezerTemp30d),
      ]),
    );
  }

  return lines.join("\r\n");
}

export function downloadHealthSummaryCsv(
  fleetTotals: FleetHealthTotals,
  tagRows: TagHealthSummaryRow[],
  dataRetrievedAt: number,
): void {
  const text = buildHealthSummaryExportCsv(fleetTotals, tagRows, dataRetrievedAt);
  const blob = new Blob([`\uFEFF${text}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `health-summary-${fileStampForExport()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
