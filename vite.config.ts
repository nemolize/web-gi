import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { localServerPort } from "./port";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Without strictPort a clash would silently move the server up one and
  // surface as a Playwright timeout.
  server: {
    allowedHosts: [".trycloudflare.com"],
    port: localServerPort,
    strictPort: true,
  },
  preview: {
    port: localServerPort,
    strictPort: true,
  },
});
