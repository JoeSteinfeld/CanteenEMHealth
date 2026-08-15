import { useEffect, useId, type ReactNode } from "react";

type ApiDocLink = {
  label: string;
  href: string;
};

type ApiInfoRow = {
  metric: string;
  source: string;
  apiLinks: ApiDocLink[];
  detail: string;
};

const API_INFO_ROWS: ApiInfoRow[] = [
  {
    metric: "Tag value",
    source: "List tags",
    apiLinks: [{ label: "GET /tags", href: "https://developers.samsara.com/reference/listtags" }],
    detail: "Tag names from each tag’s sensors list; multiple tags joined with commas.",
  },
  {
    metric: "ID",
    source: "List tags",
    apiLinks: [{ label: "GET /tags", href: "https://developers.samsara.com/reference/listtags" }],
    detail: "Sensor id from the tag’s sensors array. Links to Samsara Cloud sensor config when org id is available.",
  },
  {
    metric: "Name",
    source: "List tags",
    apiLinks: [{ label: "GET /tags", href: "https://developers.samsara.com/reference/listtags" }],
    detail: "Sensor name from the tag’s sensors array. Links to Samsara Cloud Environment sensors view.",
  },
  {
    metric: "Last connected",
    source: "GetTemperature",
    apiLinks: [
      {
        label: "POST /v1/sensors/temperature",
        href: "https://developers.samsara.com/reference/v1getsensorstemperature",
      },
    ],
    detail: "Field ambientTemperatureTime — last time the sensor reported ambient temperature (true last report).",
  },
  {
    metric: "Connected To",
    source: "GetTemperature + List assets",
    apiLinks: [
      {
        label: "POST /v1/sensors/temperature",
        href: "https://developers.samsara.com/reference/v1getsensorstemperature",
      },
      { label: "GET /assets", href: "https://developers.samsara.com/reference/listassets" },
    ],
    detail: "Host from trailerId or vehicleId on the temperature response, resolved to AG/VG name via assets.",
  },
  {
    metric: "Battery level",
    source: "Get Readings Snapshot",
    apiLinks: [
      { label: "GET /readings/latest", href: "https://developers.samsara.com/reference/getreadingssnapshot" },
    ],
    detail: "readingId widgetBatteryVoltageLow (entityType=sensor).",
  },
  {
    metric: "Battery volts",
    source: "Get Readings Snapshot",
    apiLinks: [
      { label: "GET /readings/latest", href: "https://developers.samsara.com/reference/getreadingssnapshot" },
    ],
    detail: "readingId widgetBatteryVoltage (entityType=sensor), displayed in volts.",
  },
  {
    metric: "Temperature",
    source: "Get Readings Snapshot",
    apiLinks: [
      { label: "GET /readings/latest", href: "https://developers.samsara.com/reference/getreadingssnapshot" },
    ],
    detail:
      "readingId environmentMonitorAmbientTemperatureBLEConnection (°C converted to °F). Click opens 30-day history.",
  },
  {
    metric: "Max / Min / Avg",
    source: "Local daily temps + Get Sensor History",
    apiLinks: [
      { label: "POST /v1/sensors/history", href: "https://developers.samsara.com/reference/v1getsensorshistory" },
    ],
    detail:
      "Temperature (30d): daily ambientTemperature points stored in SQLite (first run backfills ~30 days; later runs sync new days only). Max/min/avg computed from the local rolling window.",
  },
  {
    metric: "Action",
    source: "Derived",
    apiLinks: [],
    detail:
      "From Last connected time and battery voltage level: never connected → check equipment; stale (>7 days) or low battery → replace battery.",
  },
  {
    metric: "Notes",
    source: "Local app storage",
    apiLinks: [],
    detail: "Saved in this app’s SQLite notes database (not a Samsara API field).",
  },
];

function renderApiLinks(links: ApiDocLink[]): ReactNode {
  if (links.length === 0) return <span className="muted">—</span>;
  return (
    <span className="sensor-api-info-links">
      {links.map((link, i) => (
        <span key={link.href + link.label}>
          {i > 0 ? <span className="sensor-api-info-link-sep"> → </span> : null}
          <a
            className="sensor-api-doc-link"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${link.label} docs on developers.samsara.com`}
          >
            <code>{link.label}</code>
          </a>
        </span>
      ))}
    </span>
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
};

export function SensorApiInfoDialog({ open, onClose }: Props) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="temp-history-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="temp-history-panel sensor-api-info-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="temp-history-head">
          <div>
            <h2 id={titleId} className="temp-history-title">
              Sensor API Information
            </h2>
            <p className="temp-history-sub muted">
              How each Detailed Sensor Health column is populated. API paths link to{" "}
              <a
                href="https://developers.samsara.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="sensor-api-doc-link"
              >
                developers.samsara.com
              </a>
              . Token scopes typically needed: <strong>Read Tags</strong>, <strong>Read Readings</strong>,{" "}
              <strong>Read Assets</strong>, and <strong>Write Sensors</strong> (legacy GetTemperature).
            </p>
          </div>
          <button type="button" className="temp-history-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="sensor-api-info-scroll">
          <table className="sensor-api-info-table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Source</th>
                <th scope="col">API</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {API_INFO_ROWS.map((row) => (
                <tr key={row.metric}>
                  <th scope="row">{row.metric}</th>
                  <td>{row.source}</td>
                  <td>{renderApiLinks(row.apiLinks)}</td>
                  <td>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
