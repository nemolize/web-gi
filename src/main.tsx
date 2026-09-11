import "@/styles/globals.css";

import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Failed to find the root element");

const Application = new URLSearchParams(location.search).has("bdptDiagnostics")
  ? lazy(() => import("@/components/BdptDiagnostics"))
  : App;

createRoot(rootElement).render(
  <StrictMode>
    <Suspense fallback={<p>Loading diagnostics…</p>}>
      <Application />
    </Suspense>
  </StrictMode>,
);
