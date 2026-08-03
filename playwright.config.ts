import { defineConfig, devices } from "@playwright/test";

import { devPort, isPreviewTarget, previewPort } from "./e2e-tests/target";

const isCI = Boolean(process.env["CI"]);

// Only `vite preview` goes through the Workers runtime, so only it exercises
// wrangler.json asset serving and SPA fallback.
const baseURL = isPreviewTarget
  ? `http://localhost:${previewPort}`
  : `http://localhost:${devPort}`;

export default defineConfig({
  testDir: "./e2e-tests",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Building here rather than in a separate step keeps `dist/` from going
    // stale under the preview server.
    command: isPreviewTarget
      ? "pnpm run build && pnpm run preview"
      : "pnpm run dev",
    url: baseURL,
    // Only the preview command builds first; the dev server should surface a
    // hang at Playwright's default instead of three minutes later.
    ...(isPreviewTarget ? { timeout: 180_000 } : {}),
    reuseExistingServer: !isCI,
  },
});
