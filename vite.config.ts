import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    allowedHosts: [".trycloudflare.com"],
  },
  // playwright.config.ts hardcodes this port; without strictPort a clash would
  // silently move preview to 4174 and surface as a Playwright timeout.
  preview: {
    port: 4173,
    strictPort: true,
  },
});
