// Single source of truth for which server the E2E suite targets, and the port
// that server binds.
const isEnabled = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value !== "false";

export const isPreviewTarget =
  isEnabled(process.env["CI"]) || isEnabled(process.env["E2E_PREVIEW"]);

export const previewPort = 4173;
export const devPort = 5173;
