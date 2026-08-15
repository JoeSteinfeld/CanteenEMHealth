import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        // Keep NDJSON health-summary streams flowing without proxy buffering.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            const ct = proxyRes.headers["content-type"];
            if (typeof ct === "string" && ct.includes("application/x-ndjson")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
});
