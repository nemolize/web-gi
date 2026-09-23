import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { localServerPort } from "./port.ts";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    tsconfigPaths: true,
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
