import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const basePath = process.env.VITE_BASE_PATH || "/mux/";

export default defineConfig({
  base: basePath,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/mux/api": "http://127.0.0.1:7683",
      "/mux/ws": {
        target: "ws://127.0.0.1:7683",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
