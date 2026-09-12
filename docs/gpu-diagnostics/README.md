# GPU diagnostics

Open the **GPU diagnostics** link in the renderer controls, or use
`?diagnostics=core` and `?diagnostics=bdpt`. The older `?bdptDiagnostics=1` link
still selects BDPT. No renderer mounts on the diagnostics route.

Select a suite, run it, and copy the report. Reports include the browser user
agent, adapter details, suite/version, and each probe's result and compilation
time. Nothing is uploaded automatically. A failed probe normally allows the
next one to run; device loss, cancellation, or a 30-second probe timeout stops
the suite and retains partial results. Compilation success does not establish
rendering correctness or performance.

`src/gi/diagnostics/runner.ts` owns adapter/device lifetime, cancellation,
timeouts, compilation, and reporting. Suites provide compute shader source,
binding layouts, optional override constants, and stable probe labels through
`DiagnosticSuite`. Register suites in `src/gi/diagnostics/suites.ts`; the selector
and report use the registry. Suite definitions must not access WebGPU globals
at import time, so unsupported browsers can still open the page.

Core WebGPU covers storage writes, dynamic array access, and arrays within
structures. The BDPT suite lives in `src/gi/bdpt/diagnostics.ts` and uses the
production shader prefix with isolated stages. Its smaller arrays and omitted
MIS are diagnostic variants, never rendering modes. Increment a suite's version
when changing probe meaning, and retain meaningful labels in reports.

Browser checks cover suite selection, the legacy URL, compilation on a real
adapter, retained failures, cancellation, and device loss. Add a real-device
check for new shader probes; capability-gated CI may skip GPU execution.
