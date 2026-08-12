// Single source of truth for which server the E2E suite targets. The port both
// servers bind lives in `port.ts`.
const isEnabled = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value !== "false";

export const isPreviewTarget =
  isEnabled(process.env["CI"]) || isEnabled(process.env["E2E_PREVIEW"]);
