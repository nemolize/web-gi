import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { devPort, previewPort } from "./e2e-tests/target";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Playwright targets both ports; without strictPort a clash would silently
  // move the server up one and surface as a Playwright timeout.
  server: {
    allowedHosts: [".trycloudflare.com"],
    port: devPort,
    strictPort: true,
  },
  preview: {
    port: previewPort,
    strictPort: true,
  },
});
