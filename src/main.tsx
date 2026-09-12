import "@/styles/globals.css";

import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Failed to find the root element");

const params = new URLSearchParams(location.search);
const Application =
  params.has("diagnostics") || params.has("bdptDiagnostics")
    ? lazy(() => import("@/components/GpuDiagnostics"))
    : App;

createRoot(rootElement).render(
  <StrictMode>
    <Suspense fallback={<p>Loading diagnostics…</p>}>
      <Application />
    </Suspense>
  </StrictMode>,
);
