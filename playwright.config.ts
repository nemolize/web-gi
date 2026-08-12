import { defineConfig, devices } from "@playwright/test";

import { isPreviewTarget } from "./e2e-tests/target";
import { localServerURL } from "./port";

const isCI = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "./e2e-tests",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: "list",
  use: {
    baseURL: localServerURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Only `vite preview` goes through the Workers runtime, so only it
    // exercises wrangler.json asset serving and SPA fallback. Building here
    // rather than in a separate step keeps `dist/` from going stale under it.
    command: isPreviewTarget
      ? "pnpm run build && pnpm run preview"
      : "pnpm run dev",
    url: localServerURL,
    // Only the preview command builds first; the dev server should surface a
    // hang at Playwright's default instead of three minutes later.
    ...(isPreviewTarget ? { timeout: 180_000 } : {}),
    // Dev and preview now share the port; reusing one would test the wrong
    // runtime, on top of the foreign-server risk the override addresses.
    reuseExistingServer: false,
  },
});
