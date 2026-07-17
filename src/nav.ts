export type NavItem = {
  path: string;
  label: string;
};

export const NAV_ITEMS: NavItem[] = [
  { path: "/health-summary", label: "Health Summary" },
  { path: "/trends", label: "Trends" },
  { path: "/detailed-sensor-health", label: "Detailed Sensor Health" },
];
