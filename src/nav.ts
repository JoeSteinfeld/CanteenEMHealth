export type NavItem = {
  path: string;
  label: string;
};

export const NAV_ITEMS: NavItem[] = [
  { path: "/health-summary", label: "Health Summary" },
  { path: "/detailed-sensor-health", label: "Detailed Sensor Health" },
];
