# GPU diagnostics

Open the **GPU diagnostics** link in the renderer controls, or use
`?diagnostics=core` and `?diagnostics=bdpt`. The older `?bdptDiagnostics=1` link
still selects BDPT. No application renderer mounts on the diagnostics route.

Select a suite, run it, and copy the report. Reports include the browser user
agent, adapter details, suite/version, and each probe's result and compilation
time. Each displayed line includes elapsed seconds since Run, including errors
and Stop. Pending probes emit a WAIT line every five seconds; this confirms the
page timer is active, not that GPU work is progressing. Nothing is uploaded automatically. A failed probe normally allows the
next one to run; device loss, cancellation, or a probe timeout stops
the suite and retains partial results. Compiler probes time out after 30 seconds;
execution probes after 120 seconds. The limit is printed when each probe starts. Compilation success does not establish
rendering correctness or performance.

`src/gi/diagnostics/runner.ts` owns adapter/device lifetime, cancellation,
timeouts, compilation, and reporting. Suites provide compute shader source,
binding layouts, optional override constants, and stable probe labels through
`DiagnosticSuite`. Execution probes instead supply an asynchronous `run(device, report)`
callback; the runner derives the execution label from probe types and owns device cleanup
and cancellation. Register suites in `src/gi/diagnostics/suites.ts`; the selector
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

The `?diagnostics=bdpt-execution` suite runs three 39x31 glass frames using
production BDPT passes, then reads initial/reused reservoirs and rgba16float
resolve output. Each stage reports finite/positive channel counts and mean
radiance. This is a smoke test, not a convergence or full-resolution performance
check, and excludes denoising and canvas presentation.

BDPT execution v2 reports shader validation and each production pipeline
compilation attempt, including the selected workgroup size or retry failure.
A ten-second wait alone does not establish a compiler hang. Inspect the last
COMPILE START without a matching PASS/FAIL; the 120-second limit applies to the
entire execution probe, including compilation and all three frames.
