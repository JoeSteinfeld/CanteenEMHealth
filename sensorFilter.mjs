/** EM widget reading IDs used to identify environment-monitor sensors. */
export const EM_WIDGET_READING_IDS = [
  "widgetBatteryVoltage",
  "widgetBatteryVoltageLow",
  "environmentMonitorAmbientTemperatureBLEConnection",
];

/** Placeholder rows Samsara leaves on tags after a sensor is deactivated. */
const DEACTIVATED_SENSOR_NAME_RE = /deactivated|previously paired with sensor/i;

export function isDeactivatedTagSensor(sensor) {
  const name = sensor?.name != null ? String(sensor.name).trim() : "";
  return DEACTIVATED_SENSOR_NAME_RE.test(name);
}

export function hasEmWidgetReadings(readingsMap) {
  if (!readingsMap || typeof readingsMap.get !== "function") return false;
  return EM_WIDGET_READING_IDS.some((id) => readingsMap.has(id));
}

/** Tag-attached sensor eligible for EM health reporting (requires readings snapshot). */
export function isEmHealthTagSensor(sensor, readingsByEntity) {
  if (!sensor || sensor.id == null) return false;
  if (isDeactivatedTagSensor(sensor)) return false;
  const rmap = readingsByEntity?.get(String(sensor.id));
  return hasEmWidgetReadings(rmap);
}
