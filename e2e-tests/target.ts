// Single source of truth for the E2E target: playwright.config.ts picks the
// server from it, and build-only specs skip on it.
export const isPreviewTarget =
  Boolean(process.env["CI"]) || Boolean(process.env["E2E_PREVIEW"]);
